import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import { startGateway } from "../src/gateway.ts";
import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } from "../src/config.ts";
import { runCli } from "../src/cli.ts";
import { instanceMarker, resolvePaths, runWithInstancePaths } from "../src/paths.ts";
import { requestLogDir } from "../src/request-log.ts";
import { ensureUiToken, handleWebUiRequest, startWebUiServer, webUiContextForInstance } from "../src/webui.ts";
import { codexCatalogFile, updateCodexModelCatalog } from "../src/model-state.ts";
import type { WebUiContext } from "../src/webui.ts";
import type { GatewayConfig, ResolvedPaths } from "../src/types.ts";

const TOKEN = "ccp_test_token_0123456789abcdef";
const BASE = "http://127.0.0.1:8320";
// mock.module 无法撤销，mock 前先捕获真实 execFileSync，供委托式 mock 转发。
const realExecFileSync = childProcess.execFileSync;

/** 最小形状的 JWT（iss + 可选展示声明）；CodeBuddy 凭据解析只依赖 issuer 与三段形状。 */
function jwt(iss: string, claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss, exp: 1893456000, ...claims })}.${encode({ sig: "test" })}`;
}

/** 挑一个当前空闲的端口：bind(0) 拿到后立即释放。真实 socket 用例不能写死端口——
 * 本机生产网关与 webui 服务就运行在 8320/8321 上。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

interface Fixture {
  paths: ResolvedPaths;
  config: GatewayConfig;
  handler: (request: Request) => Promise<Response>;
  home: string;
  uiHtmlPath: string;
}

function makePaths(home: string): ResolvedPaths {
  const runtimeHome = path.join(home, ".codex-cliproxy-gateway");
  const codexHome = path.join(home, ".codex");
  return {
    home,
    codexHome,
    runtimeHome,
    configToml: path.join(codexHome, "config.toml"),
    gatewayConfig: path.join(runtimeHome, "config.json"),
    stateFile: path.join(runtimeHome, "state.json"),
    catalogFile: path.join(runtimeHome, "cliproxy-catalog.json"),
    modelMergeFile: path.join(runtimeHome, "models.json"),
    upstreamModelsCacheFile: path.join(runtimeHome, "models-cache.json"),
    modelsCacheFile: path.join(codexHome, "models_cache.json"),
    stdoutLog: path.join(runtimeHome, "gateway.log"),
    logDir: path.join(runtimeHome, "logs"),
    uiTokenFile: path.join(runtimeHome, "ui-token"),
    credentialsFile: path.join(runtimeHome, "credentials.json"),
    launchAgent: path.join(home, "Library", "LaunchAgents", "codex-cliproxy-gateway.plist"),
    webUiLaunchAgent: path.join(home, "Library", "LaunchAgents", "codex-cliproxy-webui.plist"),
    instanceSuffix: "",
  };
}

function makeConfig(paths: ResolvedPaths, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: "0.0.0-test",
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    requestLogging: true,
    logDir: paths.logDir,
    zcode: false,
    maxRequestLogs: 0,
    maxGatewayLogBytes: 0,
    selectedModels: ["glm-5.3", "kimi-k2"],
    ...overrides,
  } as GatewayConfig;
}

async function makeFixture(overrides: {
  config?: Partial<GatewayConfig>;
  webUi?: Partial<WebUiContext>;
} = {}): Promise<Fixture> {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccp-webui-"));
  const paths = makePaths(home);
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const config = makeConfig(paths, overrides.config);
  fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(paths.uiTokenFile, `${TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.stdoutLog, "--2026-09-13 10:00:00.000-- gateway booted\n");
  const uiHtmlPath = path.join(home, "ui-index.html");
  fs.writeFileSync(uiHtmlPath, "<!doctype html><html><body><div id=\"root\"></div></body></html>");
  const webUi: WebUiContext = { paths, uiHtmlPath,
    modelDeps: {
      reloadModels: async () => ({ loaded: true, revision: "fixture" }),
      wait: async () => {},
      // 默认只测共享合成与 TOML；agent 网络和真实本机配置通过专门用例注入。
      updateCodexCatalog: (modelPaths, next, deps, options) => updateCodexModelCatalog(modelPaths, {
        ...next, zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
      }, deps, options),
    },
    ...overrides.webUi };
  // UI 运行在独立端口上，这里直接构造 UI 处理器（不经模型网关的路由与日志包装）；
  // 测试沿用网关端口 8320 做 Host 校验。
  const handler = (request: Request) => handleWebUiRequest(request, config, webUi, config.port);
  return { paths, config, handler, home, uiHtmlPath };
}

function authedRequest(
  pathname: string,
  options: { method?: string; token?: string | null; json?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.token !== null) headers.set("x-ccp-ui-token", options.token ?? TOKEN);
  let body: string | undefined;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  return new Request(`${BASE}${pathname}`, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
}

/** 本机假上游：记录收到的请求行与 authorization 头，按 handler 注入响应。 */
interface FakeUpstream {
  url: string;
  requests: Array<{ url: string; authorization: string | null }>;
  close: () => Promise<void>;
}

async function startFakeUpstream(
  respond: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<FakeUpstream> {
  const requests: FakeUpstream["requests"] = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url ?? "/", authorization: request.headers.authorization ?? null });
    respond(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("GET /ui serves the single-file SPA shell with hardening headers", async () => {
  const { handler, home } = await makeFixture();
  try {
    const response = await handler(new Request(`${BASE}/ui`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'unsafe-inline'/);
    assert.match(csp, /connect-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const html = await response.text();
    assert.ok(html.includes("<div id=\"root\">"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui reports how to restore a missing Vite production asset", async () => {
  const { handler, uiHtmlPath, home } = await makeFixture();
  try {
    fs.unlinkSync(uiHtmlPath);
    const response = await handler(new Request(`${BASE}/ui`));
    assert.equal(response.status, 500);
    const body = await response.json() as { error?: { message?: string; hint?: string } };
    assert.match(body.error?.message ?? "", /Web UI asset is unavailable/);
    assert.match(body.error?.hint ?? "", /bun run build:ui/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("UI APIs reject missing or wrong tokens", async () => {
  const { handler, home } = await makeFixture();
  try {
    assert.equal((await handler(new Request(`${BASE}/ui/api/status`))).status, 401);
    assert.equal((await handler(authedRequest("/ui/api/status", { token: "ccp_wrong" }))).status, 401);
    const ok = await handler(authedRequest("/ui/api/status"));
    assert.equal(ok.status, 200);
    const status = await ok.json() as { ok: boolean; upstreamType: string; routing: string[] };
    assert.equal(status.ok, true);
    assert.equal(status.upstreamType, "cliproxy");
    assert.equal(status.routing.length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("requests with a non-whitelisted Host header get 404 for page and API", async () => {
  const { handler, home } = await makeFixture();
  try {
    assert.equal((await handler(new Request("http://evil.example:8320/ui"))).status, 404);
    assert.equal((await handler(new Request("http://evil.example:8320/ui/api/status", {
      headers: { "x-ccp-ui-token": TOKEN },
    }))).status, 404);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cross-origin Origin headers are rejected", async () => {
  const { handler, home } = await makeFixture();
  try {
    const response = await handler(new Request(`${BASE}/ui/api/status`, {
      headers: { "x-ccp-ui-token": TOKEN, origin: "http://evil.example" },
    }));
    assert.equal(response.status, 404);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("same-origin Origin headers are accepted", async () => {
  const { handler, home } = await makeFixture();
  try {
    const response = await handler(new Request(`${BASE}/ui/api/status`, {
      headers: { "x-ccp-ui-token": TOKEN, origin: BASE },
    }));
    assert.equal(response.status, 200);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the UI is disabled entirely when the gateway host is not loopback", async () => {
  const { handler, home } = await makeFixture({ config: { host: "0.0.0.0" } });
  try {
    assert.equal((await handler(new Request("http://0.0.0.0:8320/ui"))).status, 404);
    assert.equal((await handler(authedRequest("/ui/api/status"))).status, 404);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui/api/config returns editable and readonly groups", async () => {
  const { handler, home } = await makeFixture();
  try {
    const response = await handler(authedRequest("/ui/api/config"));
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      editable: {
        zcode: boolean;
        codebuddy: boolean;
        maxRequestLogs: number;
        selectedModels: string[];
      };
      readonly: { upstreamBaseUrl: string; upstreamOnly: boolean; routerMode: string };
    };
    assert.equal(payload.editable.zcode, false);
    assert.equal(payload.editable.codebuddy, false);
    assert.equal(payload.editable.maxRequestLogs, 0);
    // 模型选择已迁入可编辑分组（保存走 /ui/api/upstream/models，同步重建目录文件）。
    assert.deepEqual(payload.editable.selectedModels, ["glm-5.3", "kimi-k2"]);
    assert.equal(Object.hasOwn(payload.editable, "upstreamOnly"), false);
    assert.equal(payload.readonly.upstreamBaseUrl, "http://127.0.0.1:8317/v1");
    // 路由模式按 upstreamOnly 取反导出，不直接暴露布尔值。
    assert.equal(payload.readonly.upstreamOnly, false);
    assert.equal(payload.readonly.routerMode, "dynamic");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui/api/config 只读展示 upstreamOnly 与对应路由模式", async () => {
  const { handler, home } = await makeFixture({ config: { upstreamOnly: true } });
  try {
    const payload = await (await handler(authedRequest("/ui/api/config"))).json() as {
      editable: Record<string, unknown>;
      readonly: { upstreamOnly: boolean; routerMode: string };
    };
    assert.equal(Object.hasOwn(payload.editable, "upstreamOnly"), false);
    assert.equal(payload.readonly.upstreamOnly, true);
    assert.equal(payload.readonly.routerMode, "upstream-only");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui/api/config 默认按托管展示，不返回手动配置指引", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    // 无 state 文件 / codexConfigManaged 缺省 / 显式 true 三种情况都等价于托管。
    for (const state of [undefined, { version: 4 }, { version: 4, codexConfigManaged: true }]) {
      if (state) fs.writeFileSync(paths.stateFile, JSON.stringify(state));
      else fs.rmSync(paths.stateFile, { force: true });
      const payload = await (await handler(authedRequest("/ui/api/config"))).json() as {
        readonly: { codexConfigManaged: boolean; manualCodexConfig?: unknown };
      };
      assert.equal(payload.readonly.codexConfigManaged, true);
      assert.equal(payload.readonly.manualCodexConfig, undefined, "托管模式不返回 manualCodexConfig");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui/api/config 手动模式返回逐键期望值与 config.toml 当前值比对", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 4, codexConfigManaged: false }));
    const gatewayBaseUrl = "http://127.0.0.1:8320/v1";
    fs.writeFileSync(paths.configToml, [
      `openai_base_url = "${gatewayBaseUrl}"`,
      'experimental_realtime_ws_base_url = "http://127.0.0.1:9999/v1?token=supersecret"',
      "",
      "[profiles.work]",
      'model = "gpt-5"',
      "",
    ].join("\n"));
    const payload = await (await handler(authedRequest("/ui/api/config"))).json() as {
      readonly: {
        codexConfigManaged: boolean;
        manualCodexConfig: {
          gatewayBaseUrl: string;
          staticCatalogActive: boolean;
          removeModelCatalogJson: boolean;
          keys: Array<{ key: string; expected: string; current: string | null; matches: boolean }>;
        };
      };
    };
    assert.equal(payload.readonly.codexConfigManaged, false);
    assert.equal(payload.readonly.manualCodexConfig.gatewayBaseUrl, gatewayBaseUrl);
    assert.equal(payload.readonly.manualCodexConfig.staticCatalogActive, false);
    assert.equal(payload.readonly.manualCodexConfig.removeModelCatalogJson, false);
    const byKey = new Map(payload.readonly.manualCodexConfig.keys.map((row) => [row.key, row]));
    // 匹配 / 不一致（URL 当前值过 sanitize，query 不外发）/ 未配置 三种状态齐全。
    assert.deepEqual(byKey.get("openai_base_url"), {
      key: "openai_base_url", expected: gatewayBaseUrl, current: gatewayBaseUrl, matches: true,
    });
    assert.deepEqual(byKey.get("experimental_realtime_ws_base_url"), {
      key: "experimental_realtime_ws_base_url",
      expected: gatewayBaseUrl,
      current: "http://127.0.0.1:9999/v1?…",
      matches: false,
    });
    assert.deepEqual(byKey.get("experimental_realtime_webrtc_call_base_url"), {
      key: "experimental_realtime_webrtc_call_base_url",
      expected: gatewayBaseUrl,
      current: null,
      matches: false,
    });
    // 静态目录未激活时不包含 model_catalog_json；toml 其他内容（profiles）不外发。
    assert.equal(byKey.has("model_catalog_json"), false);
    const text = JSON.stringify(payload);
    assert.ok(!text.includes("supersecret"), "config.toml 当前值里的 query token 不得外发");
    assert.ok(!text.includes("profiles.work"), "不得回显受管键之外的 config.toml 内容");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui/api/config 手动模式 static 目录激活时追加 model_catalog_json 指引", async () => {
  const { handler, paths, config, home } = await makeFixture({
    config: { upstreamOnly: true, selectedModels: ["glm-5.3"] },
  });
  try {
    fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 4, codexConfigManaged: false }));
    fs.writeFileSync(codexCatalogFile(paths), JSON.stringify({ models: [{ slug: "glm-5.3" }] }));
    type ManualPayload = {
      readonly: { manualCodexConfig: {
        staticCatalogActive: boolean;
        removeModelCatalogJson: boolean;
        keys: Array<{ key: string; expected: string }>;
      } };
    };
    let payload = await (await handler(authedRequest("/ui/api/config"))).json() as ManualPayload;
    assert.equal(payload.readonly.manualCodexConfig.staticCatalogActive, true);
    const catalogRow = payload.readonly.manualCodexConfig.keys.find((row) => row.key === "model_catalog_json");
    assert.equal(catalogRow?.expected, codexCatalogFile(paths));

    // 切回 split（upstreamOnly=false）但 config.toml 仍残留该键时提示删除。
    const live = { ...config, upstreamOnly: false } as GatewayConfig;
    fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(live, null, 2)}\n`);
    fs.writeFileSync(paths.configToml, `model_catalog_json = "${config.catalogPath}"\n`);
    const handlerLive = (request: Request) => handleWebUiRequest(request, live, { paths, uiHtmlPath: path.join(home, "ui-index.html") }, live.port);
    payload = await (await handlerLive(authedRequest("/ui/api/config"))).json() as ManualPayload;
    assert.equal(payload.readonly.manualCodexConfig.staticCatalogActive, false);
    assert.equal(payload.readonly.manualCodexConfig.removeModelCatalogJson, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui/api/config 手动模式 static 目录当前值遮蔽 URL 查询且保留本地路径比对", async () => {
  const { handler, paths, config, home } = await makeFixture({
    config: { upstreamOnly: true, selectedModels: ["glm-5.3"] },
  });
  try {
    fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 4, codexConfigManaged: false }));
    fs.writeFileSync(codexCatalogFile(paths), JSON.stringify({ models: [{ slug: "glm-5.3" }] }));
    const cases = [
      {
        current: "https://catalog.example/models.json?token=catalog-secret&session=query-secret#hash-secret",
        displayed: "https://catalog.example/models.json?…",
        matches: false,
      },
      { current: codexCatalogFile(paths), displayed: codexCatalogFile(paths), matches: true },
      { current: "/tmp/other-catalog.json", displayed: "/tmp/other-catalog.json", matches: false },
    ];
    for (const { current, displayed, matches } of cases) {
      fs.writeFileSync(paths.configToml, `model_catalog_json = "${current}"\n`);
      const response = await handler(authedRequest("/ui/api/config"));
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes("catalog-secret"), "目录 URL 的 token 不得进入响应");
      assert.ok(!text.includes("query-secret"), "目录 URL 的查询参数不得进入响应");
      assert.ok(!text.includes("hash-secret"), "目录 URL 的片段不得进入响应");
      const payload = JSON.parse(text) as {
        readonly: { manualCodexConfig: {
          keys: Array<{ key: string; expected: string; current: string | null; matches: boolean }>;
        } };
      };
      const row = payload.readonly.manualCodexConfig.keys.find((item) => item.key === "model_catalog_json");
      assert.deepEqual(row, {
        key: "model_catalog_json", expected: codexCatalogFile(paths), current: displayed, matches,
      });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("UI responses redact URL query strings that may carry tokens", async () => {
  const { handler, home } = await makeFixture({
    config: {
      upstreamBaseUrl: "http://127.0.0.1:8317/v1?token=supersecret",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex?session=abc",
    },
  });
  try {
    const configText = await (await handler(authedRequest("/ui/api/config"))).text();
    assert.ok(!configText.includes("supersecret"), "config response must not leak the upstream token");
    assert.ok(!configText.includes("session=abc"), "config response must not leak the official query");
    const payload = JSON.parse(configText) as { readonly: { upstreamBaseUrl: string } };
    assert.equal(payload.readonly.upstreamBaseUrl, "http://127.0.0.1:8317/v1?…");
    const statusText = await (await handler(authedRequest("/ui/api/status"))).text();
    assert.ok(!statusText.includes("supersecret"), "status routing must not leak the upstream token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui/api/config 的 provider 探测只看本机文件、不回显凭据内容", async () => {
  const fixture = await makeFixture();
  const { paths, config, home, uiHtmlPath } = fixture;
  // 探测路径显式注入到临时 home，绝不碰真机的 ~/.zcode 与认证目录。
  const authDir = path.join(home, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const infoFile = path.join(authDir, "Tencent-Cloud.coding-copilot.info");
  const agyCredentialFile = path.join(home, "antigravity-oauth-token");
  const handler = (request: Request) =>
    handleWebUiRequest(request, config, {
      paths,
      uiHtmlPath,
      providerDeps: { zcodeHome: path.join(home, ".zcode"), codebuddyAuthDir: authDir, agyCredentialFile },
    }, config.port);
  try {
    const absent = await (await handler(authedRequest("/ui/api/config"))).json() as {
      detected: { zcode: boolean; codebuddy: boolean; agy: boolean };
      editable: { agy: boolean; opencodeZen: boolean };
    };
    assert.equal(absent.detected.zcode, false, "无 ~/.zcode 时不显示 ZCode 开关");
    assert.equal(absent.detected.codebuddy, false, "无 .info 时不显示 CodeBuddy 开关");
    assert.equal(absent.detected.agy, false, "无凭据文件时不显示 Antigravity 开关");
    assert.equal(absent.editable.agy, false, "agy 开关缺省为关闭");
    // OpenCode Zen 无本机凭据依赖：开关值始终随配置返回（缺省关闭），不参与探测显隐。
    assert.equal(absent.editable.opencodeZen, false, "opencodeZen 开关缺省为关闭");

    fs.writeFileSync(agyCredentialFile, JSON.stringify({ token: { access_token: "ya29.fake" } }));
    const agyPresent = await (await handler(authedRequest("/ui/api/config"))).json() as {
      detected: { agy: boolean };
    };
    assert.equal(agyPresent.detected.agy, true, "凭据文件存在即显示 Antigravity 开关");

    fs.mkdirSync(path.join(home, ".zcode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".zcode", "setting.json"), "{}");
    // .info 写入伪造凭据正文：探测与账号标签解析不得读取或回显它；损坏文件无可解析
    // 账号，标签为 null（存在性探测仍算已登录）。
    fs.writeFileSync(infoFile, JSON.stringify({ auth: { accessToken: "ccp-secret-token" } }));
    const present = await (await handler(authedRequest("/ui/api/config"))).json() as {
      detected: { zcode: boolean; codebuddy: boolean; codebuddyAccountLabel: string | null };
    };
    assert.equal(present.detected.zcode, false, "缺 config.json 时仍不算就绪");
    assert.equal(present.detected.codebuddy, true, ".info 存在即视为已登录");
    assert.equal(present.detected.codebuddyAccountLabel, null, "损坏的 .info 解析不出账号标签");

    // 换成有效登录后：标签只含非敏感的昵称/邮箱与地域，token 绝不进响应。
    const accessToken = jwt("https://www.codebuddy.ai/auth/realms/copilot", { email: "web@example.com" });
    const refreshToken = jwt("https://refresh.example/auth/realms/x");
    fs.writeFileSync(infoFile, JSON.stringify({
      account: { uid: "uid-webui", nickname: "WebUser", enterpriseId: "" },
      auth: { accessToken, refreshToken, domain: "www.codebuddy.ai", expiresAt: Date.now() + 90 * 24 * 3600 * 1000 },
    }));
    const labeled = await handler(authedRequest("/ui/api/config"));
    const labeledText = await labeled.text();
    assert.ok(!labeledText.includes(accessToken), "账号标签响应不得包含 accessToken");
    assert.ok(!labeledText.includes(refreshToken), "账号标签响应不得包含 refreshToken");
    const labeledPayload = JSON.parse(labeledText) as { detected: { codebuddyAccountLabel: string | null } };
    assert.equal(labeledPayload.detected.codebuddyAccountLabel, "WebUser <web@example.com> / intl");

    fs.writeFileSync(path.join(home, ".zcode", "config.json"), "{}");
    const ready = await handler(authedRequest("/ui/api/config"));
    const readyText = await ready.text();
    assert.ok(!readyText.includes("ccp-secret-token"), "探测结果不得包含凭据内容");
    const readyPayload = JSON.parse(readyText) as { detected: { zcode: boolean } };
    assert.equal(readyPayload.detected.zcode, true, "两个配置文件齐备后算就绪");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /ui/api/config 的 CodeBuddy 账号标签随 codebuddyAccount 实时解析", async () => {
  const fixture = await makeFixture();
  const { paths, config, home, uiHtmlPath } = fixture;
  const authDir = path.join(home, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const writeLogin = (file: string, nickname: string, domain: string, issuer: string, lastRefreshTime: number, email?: string) => {
    fs.writeFileSync(path.join(authDir, file), JSON.stringify({
      account: { uid: `uid-${nickname}`, nickname, enterpriseId: "" },
      auth: {
        accessToken: jwt(issuer, email === undefined ? {} : { email }),
        refreshToken: jwt("https://refresh.example/auth/realms/x"),
        domain,
        expiresAt: Date.now() + 90 * 24 * 3600 * 1000,
        lastRefreshTime,
      },
    }));
  };
  writeLogin("fresh-cn.info", "CnUser", "www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", 5_000);
  writeLogin("stale-intl.info", "IntlUser", "www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", 1_000, "intl@example.com");
  const handler = (request: Request) =>
    handleWebUiRequest(request, config, { paths, uiHtmlPath, providerDeps: { codebuddyAuthDir: authDir } }, config.port);
  try {
    // 未设置（auto 语义）：解析最近刷新的登录，不落配置。
    let payload = await (await handler(authedRequest("/ui/api/config"))).json() as {
      detected: { codebuddyAccountLabel: string | null };
    };
    assert.equal(payload.detected.codebuddyAccountLabel, "CnUser / cn");
    // 锁定具体文件：标签随配置指向该文件。
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify({ ...config, codebuddyAccount: "stale-intl.info" }, null, 2));
    payload = await (await handler(authedRequest("/ui/api/config"))).json() as {
      detected: { codebuddyAccountLabel: string | null };
    };
    assert.equal(payload.detected.codebuddyAccountLabel, "IntlUser <intl@example.com> / intl");
    // 锁定文件缺失：标签回落 auto 真实命中的账号，不显示过期的锁定名。
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify({ ...config, codebuddyAccount: "gone.info" }, null, 2));
    payload = await (await handler(authedRequest("/ui/api/config"))).json() as {
      detected: { codebuddyAccountLabel: string | null };
    };
    assert.equal(payload.detected.codebuddyAccountLabel, "CnUser / cn");
    // 锁定文件存在但持续损坏：显示诊断标签（网关直读同样报错），不是「未选择」也不是 fallback 账号。
    fs.writeFileSync(path.join(authDir, "broken-locked.info"), "{ not json");
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify({ ...config, codebuddyAccount: "broken-locked.info" }, null, 2));
    payload = await (await handler(authedRequest("/ui/api/config"))).json() as {
      detected: { codebuddyAccountLabel: string | null };
    };
    assert.equal(payload.detected.codebuddyAccountLabel, "broken-locked.info（凭据无法读取）");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("POST /ui/api/config applies supported fields, syncs state, and writes an audit entry", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, pendingRestart: false, config: null }, null, 2)}\n`);
    const response = await handler(authedRequest("/ui/api/config", {
      json: {
        zcode: true,
        codebuddy: true,
        opencodeZen: true,
        maxRequestLogs: "5",
        maxGatewayLogBytes: "10MB",
      },
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { restarting: boolean; applied: string[] };
    // 临时目录里没有 LaunchAgent，因此只写配置不触发重启调度。
    assert.deepEqual(payload.applied, ["zcode", "codebuddy", "opencodeZen", "maxRequestLogs", "maxGatewayLogBytes"]);

    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as Record<string, unknown>;
    assert.equal(saved.zcode, true);
    assert.equal(saved.codebuddy, true);
    assert.equal(saved.opencodeZen, true);
    assert.equal(saved.maxRequestLogs, 5);
    assert.equal(saved.maxGatewayLogBytes, 10 * 1024 * 1024);

    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as { config?: { zcode?: boolean } };
    assert.equal(state.config?.zcode, true);

    const audit = fs.readFileSync(paths.stdoutLog, "utf8");
    assert.match(audit, /config changed by `webui config`/);
    assert.match(audit, /maxRequestLogs: 0 -> 5/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("POST /ui/api/config marks pendingRestart and schedules a restart when the LaunchAgent exists", async () => {
  const scheduled: string[] = [];
  const { handler, paths, home } = await makeFixture({
    webUi: { scheduleRestart: (ctx) => scheduled.push(ctx.launchAgent) },
  });
  try {
    fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true });
    fs.writeFileSync(paths.launchAgent, "# stub plist\n");
    fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, pendingRestart: false, config: null }, null, 2)}\n`);
    const response = await handler(authedRequest("/ui/api/config", { json: { requestLogging: false } }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { restarting: boolean };
    assert.equal(payload.restarting, true);
    assert.deepEqual(scheduled, [paths.launchAgent]);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as { pendingRestart?: boolean };
    assert.equal(state.pendingRestart, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("POST /ui/api/config rejects invalid values and unknown fields", async () => {
  const { handler, home } = await makeFixture();
  try {
    const cases: Array<{ json: unknown; message: RegExp }> = [
      { json: { maxRequestLogs: "-3" }, message: /non-negative integer/ },
      { json: { maxGatewayLogBytes: "abc" }, message: /byte size/ },
      { json: { zcode: "yes" }, message: /boolean/ },
      { json: { codebuddy: "on" }, message: /boolean/ },
      { json: { opencodeZen: "on" }, message: /boolean/ },
      ...[true, false, "on", 1, null, [], {}].map((value) => ({
        json: { upstreamOnly: value }, message: /Unsupported field: upstreamOnly/,
      })),
      // 账号选择只在 CLI：UI 提交 codebuddyAccount 一律按不支持字段拒绝。
      { json: { codebuddyAccount: "Tencent-Cloud.coding-copilot.info" }, message: /Unsupported field/ },
      { json: { codebuddyRegion: "cn" }, message: /Unsupported field/ },
      { json: { upstreamBaseUrl: "http://evil" }, message: /Unsupported field/ },
      { json: {}, message: /no supported fields/ },
    ];
    for (const testCase of cases) {
      const response = await handler(authedRequest("/ui/api/config", { json: testCase.json }));
      assert.equal(response.status, 400, JSON.stringify(testCase.json));
      const payload = await response.json() as { error: { message: string } };
      assert.match(payload.error.message, testCase.message);
    }
    // 非 JSON 请求体。
    const badBody = await handler(new Request(`${BASE}/ui/api/config`, {
      method: "POST",
      headers: { "x-ccp-ui-token": TOKEN },
      body: "not-json",
    }));
    assert.equal(badBody.status, 400);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Web UI 拒绝修改 upstreamOnly，混合提交也不写文件或触发模型与进程操作", async () => {
  const calls: string[] = [];
  const upstream = await startFakeUpstream((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [{ slug: "selected-one" }] }));
  });
  const { handler, paths, home } = await makeFixture({
    config: { upstreamBaseUrl: upstream.url, upstreamOnly: true },
    webUi: {
      scheduleRestart: () => { calls.push("gateway"); },
      upstreamDeps: {
        readKey: () => { calls.push("read-key"); return ""; },
        stopCodexServers: async () => { calls.push("codex"); return { scan: "ok", results: [] }; },
      },
      modelDeps: {
        reloadModels: async () => { calls.push("reload"); return { loaded: true, revision: "rejected" }; },
        updateCodexCatalog: async () => {
          calls.push("catalog");
          return { catalogPath: "fixture", count: 1, manual: false, tomlChanged: false };
        },
      },
    },
  });
  try {
    fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true });
    fs.writeFileSync(paths.launchAgent, "fixture");
    fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 4, pendingRestart: false, config: null }));
    fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [{ slug: "previous" }] }));
    fs.writeFileSync(paths.upstreamModelsCacheFile, JSON.stringify({ models: [{ slug: "previous-raw" }] }));
    fs.writeFileSync(codexCatalogFile(paths), JSON.stringify({ models: [{ slug: "previous-static" }] }));
    fs.writeFileSync(paths.configToml, "model = \"previous\"\n");
    const files = [paths.gatewayConfig, paths.stateFile, paths.catalogFile, paths.upstreamModelsCacheFile,
      codexCatalogFile(paths), paths.configToml, paths.stdoutLog];
    const before = files.map((file) => fs.readFileSync(file, "utf8"));
    for (const upstreamOnly of [true, false]) {
      for (const changes of [{}, { requestLogging: false }, { selectedModels: ["selected-one"] },
        { excludedModels: ["agy/hidden"], selectedModels: ["selected-one"], requestLogging: false }]) {
        const response = await handler(authedRequest("/ui/api/config", { json: { upstreamOnly, ...changes } }));
        assert.equal(response.status, 400);
        const body = await response.json() as { error: { message: string } };
        assert.match(body.error.message, /Unsupported field: upstreamOnly/);
        assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
        assert.deepEqual(calls, []);
        assert.equal(upstream.requests.length, 0);
      }
    }
  } finally { await upstream.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("GET /ui/api/upstream/models fetches the upstream catalog without exposing the key", async () => {
  const upstream = await startFakeUpstream((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [
      { slug: "glm-5.3", display_name: "GLM-5.3" },
      { slug: "kimi-k2", display_name: "Kimi K2" },
      { slug: "hidden-model", display_name: "Hidden Model", visibility: "hide" },
    ] }));
  });
  const { handler, paths, home } = await makeFixture({
    config: { upstreamBaseUrl: upstream.url },
    webUi: { upstreamDeps: { readKey: () => "test-secret-key" } },
  });
  try {
    // models-cache.json 记录的 client_version 是版本保真度最高来源，命中后不再探测 codex。
    fs.writeFileSync(
      paths.upstreamModelsCacheFile,
      `${JSON.stringify({ fetched_at: "2026-09-16T00:00:00.000Z", client_version: "0.153.0" })}\n`,
    );
    const response = await handler(authedRequest("/ui/api/upstream/models"));
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      upstreamType: string;
      models: Array<{ slug: string; displayName: string }>;
    };
    assert.equal(payload.upstreamType, "cliproxy");
    assert.deepEqual(payload.models.map((model) => model.slug), ["glm-5.3", "kimi-k2"]);
    assert.equal(payload.models[0].displayName, "CliProxy/GLM-5.3");
    assert.ok(!JSON.stringify(payload).includes("test-secret-key"), "model list must not carry the API key");
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].authorization, "Bearer test-secret-key");
    assert.match(upstream.requests[0].url, /^\/v1\/models\?client_version=0\.153\.0$/);
  } finally {
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("POST /ui/api/upstream/models rebuilds the catalog and persists the selection", async () => {
  const upstream = await startFakeUpstream((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [
      { slug: "glm-5.3", display_name: "GLM-5.3" },
      { slug: "kimi-k2", display_name: "Kimi K2" },
      { slug: "deepseek-chat", display_name: "DeepSeek Chat" },
    ] }));
  });
  const { handler, paths, home } = await makeFixture({
    config: { upstreamBaseUrl: upstream.url },
    webUi: { upstreamDeps: { readKey: () => "test-secret-key" } },
  });
  try {
    fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, config: null }, null, 2)}\n`);
    // 预置官方目录缓存：动态模式下保存后必须被重置（fetched_at 归零、models 保留）。
    fs.writeFileSync(paths.modelsCacheFile, `${JSON.stringify({
      fetched_at: "2026-09-16T00:00:00.000Z",
      client_version: "0.153.0",
      models: [{ slug: "gpt-5.5" }],
    }, null, 2)}\n`);
    const response = await handler(authedRequest("/ui/api/upstream/models", {
      json: { selectedModels: ["deepseek-chat", "kimi-k2"] },
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      applied: string[];
      selected: string[];
      count: number;
      upstreamOnly: boolean;
    };
    assert.deepEqual(payload.applied, ["selectedModels"]);
    // 返回按上游目录顺序排列的选择，而不是提交顺序。
    assert.deepEqual(payload.selected, ["kimi-k2", "deepseek-chat"]);
    assert.equal(payload.count, 2);
    assert.equal(payload.upstreamOnly, false);

    // 目录文件只含所选条目。
    const catalog = JSON.parse(fs.readFileSync(paths.catalogFile, "utf8")) as { models: Array<{ slug: string }> };
    assert.deepEqual(catalog.models.map((model) => model.slug), ["kimi-k2", "deepseek-chat"]);

    // config.json 与 state.json 同步更新。
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as { selectedModels?: string[] };
    assert.deepEqual(saved.selectedModels, ["kimi-k2", "deepseek-chat"]);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as { config?: { selectedModels?: string[] } };
    assert.deepEqual(state.config?.selectedModels, ["kimi-k2", "deepseek-chat"]);

    // 动态路由无需重启网关或 Codex：官方目录缓存被重置后 Codex 约在 5 分钟内自动刷新。
    const cache = JSON.parse(fs.readFileSync(paths.modelsCacheFile, "utf8")) as { fetched_at: string; models?: unknown[] };
    assert.equal(cache.fetched_at, "2000-01-01T00:00:00Z");
    assert.equal(Array.isArray(cache.models) && cache.models.length, 1);

    const audit = fs.readFileSync(paths.stdoutLog, "utf8");
    assert.match(audit, /config changed by `webui models`/);
    assert.match(audit, /selectedModels: \["glm-5\.3","kimi-k2"\] -> \["kimi-k2","deepseek-chat"\]/);
  } finally {
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("POST /ui/api/upstream/models rejects an empty combined static catalog and keeps the cache", async () => {
  const upstream = await startFakeUpstream((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [
      { slug: "glm-5.3", display_name: "GLM-5.3" },
      { slug: "kimi-k2", display_name: "Kimi K2" },
    ] }));
  });
  const { handler, paths, home } = await makeFixture({
    config: { upstreamBaseUrl: upstream.url, upstreamOnly: true },
    webUi: { upstreamDeps: { readKey: () => "test-secret-key" } },
  });
  try {
    fs.writeFileSync(paths.modelsCacheFile, `${JSON.stringify({
      fetched_at: "2026-09-16T00:00:00.000Z",
      client_version: "0.153.0",
      models: [{ slug: "gpt-5.5" }],
    }, null, 2)}\n`);

    // 合成静态目录不能为空；空上游选择不发请求，由共享合成检查 agent 是否补足。
    const empty = await handler(authedRequest("/ui/api/upstream/models", { json: { selectedModels: [] } }));
    assert.equal(empty.status, 400);
    const emptyBody = await empty.json() as { error: { message: string } };
    assert.match(emptyBody.error.message, /静态模型目录为空/);
    assert.equal(upstream.requests.length, 0);

    // 已选 ID 在上游全部消失时，过滤后的目录为空；upstream-only 仍拒绝保存。
    const stale = await handler(authedRequest("/ui/api/upstream/models", {
      json: { selectedModels: ["retired-upstream-model"] },
    }));
    assert.equal(stale.status, 400);
    const staleBody = await stale.json() as { error: { message: string } };
    assert.match(staleBody.error.message, /静态模型目录为空/);
    assert.equal(fs.existsSync(paths.catalogFile), false);

    const response = await handler(authedRequest("/ui/api/upstream/models", {
      json: { selectedModels: ["kimi-k2"] },
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { upstreamOnly: boolean; selected: string[] };
    assert.equal(payload.upstreamOnly, true);
    assert.deepEqual(payload.selected, ["kimi-k2"]);

    // upstream-only 由 Codex 静态加载目录文件，官方目录缓存不做无谓重置。
    const cache = JSON.parse(fs.readFileSync(paths.modelsCacheFile, "utf8")) as { fetched_at: string };
    assert.equal(cache.fetched_at, "2026-09-16T00:00:00.000Z");
  } finally {
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Web UI 空上游选择允许 agent 静态目录，手动配置不写 TOML", async () => {
  let upstreamReads = 0;
  let agentFetches = 0;
  const { handler, paths, home } = await makeFixture({
    config: { upstreamOnly: true, opencodeZen: true },
    webUi: {
      upstreamDeps: { readKey: () => { upstreamReads++; return ""; } },
      modelDeps: {
        reloadModels: async () => ({ loaded: true, revision: "agent-only" }),
        updateCodexCatalog: (modelPaths, config, _deps, options) => updateCodexModelCatalog(modelPaths, config, {
          opencodeZen: {
            fetch: async (url) => {
              if (url.endsWith("/models")) agentFetches++;
              return Response.json({ data: [{ id: "one-free" }] });
            },
            fetchMetadata: async () => ({ opencode: { models: {
              "one-free": { cost: { input: 0, output: 0 }, provider: { npm: "@ai-sdk/openai-compatible" } },
            } } }),
          },
        }, options),
      },
    },
  });
  try {
    fs.writeFileSync(paths.stateFile, JSON.stringify({ codexConfigManaged: false }));
    const originalToml = "model = \"user-model\"\n";
    fs.writeFileSync(paths.configToml, originalToml);
    const response = await handler(authedRequest("/ui/api/upstream/models", { json: { selectedModels: [] } }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(upstreamReads, 0);
    assert.equal(agentFetches, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")).models.map((m: { slug: string }) => m.slug), ["opencode-zen/one-free"]);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), originalToml);
    const guidance = await (await handler(authedRequest("/ui/api/config"))).json() as {
      readonly: { manualCodexConfig: { staticCatalogActive: boolean } };
    };
    assert.equal(guidance.readonly.manualCodexConfig.staticCatalogActive, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Web UI 排除变更热加载模型，不调度网关重启", async () => {
  const calls: string[] = [];
  const { handler, paths, home } = await makeFixture({ webUi: {
    scheduleRestart: () => calls.push("restart"),
    modelDeps: {
      updateCodexCatalog: async (_paths, config) => {
        calls.push(`update:${config.excludedModels?.join(",")}`);
        return { catalogPath: "fixture", count: 1, manual: false, tomlChanged: false };
      },
      reloadModels: async () => { calls.push("reload"); return { loaded: true, revision: "exclude" }; },
    },
  } });
  try {
    fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true });
    fs.writeFileSync(paths.launchAgent, "fixture");
    const response = await handler(authedRequest("/ui/api/config", { json: { excludedModels: ["agy/hidden"] } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { restarting: boolean }).restarting, false);
    assert.deepEqual(calls, ["update:agy/hidden", "reload"]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Web UI 按已保存的静态模式组合保存选择与配置，等待新网关就绪后更新 Codex", async () => {
  const calls: string[] = [];
  const upstream = await startFakeUpstream((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [{ slug: "selected-one" }] }));
  });
  const { handler, paths, home } = await makeFixture({
    config: { upstreamBaseUrl: upstream.url, upstreamOnly: true },
    webUi: {
      upstreamDeps: { readKey: () => "", stopCodexServers: async () => { calls.push("codex"); return { scan: "ok", results: [] }; } },
      scheduleRestart: () => { calls.push("gateway"); },
      modelDeps: {
        wait: async () => {},
        reloadModels: async (_paths, config) => {
          assert.equal(config.upstreamOnly, true);
          assert.deepEqual(config.selectedModels, ["selected-one"]);
          calls.push("ready"); return { loaded: true, revision: "combined" };
        },
        updateCodexCatalog: async (modelPaths, config, deps, options) => {
          calls.push(`static:${options?.refreshAdapters}`);
          return updateCodexModelCatalog(modelPaths, config, deps, options);
        },
      },
    },
  });
  try {
    fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true });
    fs.writeFileSync(paths.launchAgent, "fixture");
    const response = await handler(authedRequest("/ui/api/config", {
      json: { requestLogging: false, selectedModels: ["selected-one"], excludedModels: ["agy/hidden"] },
    }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { restarting: boolean }).restarting, false);
    assert.deepEqual(calls, ["gateway", "ready", "static:false"]);
    assert.ok(fs.readFileSync(paths.configToml, "utf8").includes(codexCatalogFile(paths)));
    assert.equal((await handler(authedRequest("/ui/api/codex/restart", { method: "POST" }))).status, 200);
    assert.deepEqual(calls, ["gateway", "ready", "static:false", "ready", "codex"]);
  } finally { await upstream.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("Web UI 静态合成失败恢复配置、状态、目录与 TOML", async () => {
  const { handler, paths, home } = await makeFixture({ config: { upstreamOnly: true } });
  try {
    fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [{ slug: "previous" }] }));
    fs.writeFileSync(codexCatalogFile(paths), JSON.stringify({ models: [{ slug: "previous-static" }] }));
    fs.writeFileSync(paths.configToml, "model = \"previous\"\n");
    fs.writeFileSync(paths.stateFile, JSON.stringify({ codexConfigManaged: true, config: null }));
    const files = [paths.gatewayConfig, paths.stateFile, paths.catalogFile, codexCatalogFile(paths), paths.configToml];
    const before = files.map((file) => fs.readFileSync(file, "utf8"));
    const response = await handler(authedRequest("/ui/api/config", { json: { selectedModels: [] } }));
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /静态模型目录为空/);
    assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Web UI 保存失败保留模型准备期间用户改写的 TOML", async () => {
  const { handler, paths, home } = await makeFixture({ webUi: { modelDeps: {
    updateCodexCatalog: async (modelPaths) => {
      fs.writeFileSync(modelPaths.configToml, "model = \"user-updated\"\n");
      throw new Error("模型刷新期间 Codex 配置发生变化");
    },
  } } });
  try {
    const configBefore = fs.readFileSync(paths.gatewayConfig, "utf8");
    fs.writeFileSync(paths.configToml, "model = \"previous\"\n");
    const response = await handler(authedRequest("/ui/api/config", { json: { excludedModels: ["agy/hidden"] } }));
    assert.equal(response.status, 400);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), "model = \"user-updated\"\n");
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), configBefore);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Web UI 网关未就绪时拒绝重启 Codex", async () => {
  let stopped = false;
  const { handler, home } = await makeFixture({ webUi: {
    upstreamDeps: { stopCodexServers: async () => { stopped = true; return { scan: "ok", results: [] }; } },
    modelDeps: { reloadModels: async () => ({ loaded: false, revision: "not-running" }) },
  } });
  try {
    const response = await handler(authedRequest("/ui/api/codex/restart", { method: "POST" }));
    assert.equal(response.status, 400);
    assert.equal(stopped, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("POST /ui/api/upstream/models drops stale IDs and still rejects malformed payloads", async () => {
  const upstream = await startFakeUpstream((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [
      { slug: "glm-5.3", display_name: "GLM-5.3" },
      { slug: "hidden-model", visibility: "hide" },
    ] }));
  });
  const { handler, paths, home } = await makeFixture({
    config: { upstreamBaseUrl: upstream.url },
    webUi: { upstreamDeps: { readKey: () => "test-secret-key" } },
  });
  try {
    const filtered = await handler(authedRequest("/ui/api/upstream/models", {
      json: { selectedModels: ["glm-5.3", "no-such-model", "hidden-model"] },
    }));
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.json() as { selected: string[]; count: number };
    assert.deepEqual(filteredBody.selected, ["glm-5.3"]);
    assert.equal(filteredBody.count, 1);
    const catalog = JSON.parse(fs.readFileSync(paths.catalogFile, "utf8")) as { models: Array<{ slug: string }> };
    assert.deepEqual(catalog.models.map((model) => model.slug), ["glm-5.3"]);
    const savedAfterFilter = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as { selectedModels?: string[] };
    assert.deepEqual(savedAfterFilter.selectedModels, ["glm-5.3"]);

    const notArray = await handler(authedRequest("/ui/api/upstream/models", {
      json: { selectedModels: "glm-5.3" },
    }));
    assert.equal(notArray.status, 400);
    assert.match(((await notArray.json()) as { error: { message: string } }).error.message, /array of model ID strings/);

    const duplicates = await handler(authedRequest("/ui/api/upstream/models", {
      json: { selectedModels: ["glm-5.3", "glm-5.3"] },
    }));
    assert.equal(duplicates.status, 400);
    assert.match(((await duplicates.json()) as { error: { message: string } }).error.message, /empty or duplicate/);

    // 校验失败不写盘：config.json 的选择保持原样。
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as { selectedModels?: string[] };
    assert.deepEqual(saved.selectedModels, ["glm-5.3"]);
  } finally {
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("upstream model fetch failures return 502 and never leak the configured query", async () => {
  const upstream = await startFakeUpstream((_request, response) => {
    response.statusCode = 500;
    response.end("boom");
  });
  const { handler, home } = await makeFixture({
    config: { upstreamBaseUrl: `${upstream.url}?token=supersecret` },
    webUi: { upstreamDeps: { readKey: () => "test-secret-key" } },
  });
  try {
    const failed = await handler(authedRequest("/ui/api/upstream/models"));
    assert.equal(failed.status, 502);
    const failedText = await failed.text();
    assert.ok(!failedText.includes("supersecret"), "error must not leak the upstream query");
    assert.ok(!failedText.includes("test-secret-key"), "error must not leak the API key");
  } finally {
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
  }

  // 上游直接不可达：同样 502 且不泄漏。
  const { handler: refusedHandler, home: refusedHome } = await makeFixture({
    config: { upstreamBaseUrl: "http://127.0.0.1:9/v1?token=supersecret" },
    webUi: { upstreamDeps: { readKey: () => "test-secret-key" } },
  });
  try {
    const refused = await refusedHandler(authedRequest("/ui/api/upstream/models"));
    assert.equal(refused.status, 502);
    const refusedText = await refused.text();
    assert.ok(!refusedText.includes("supersecret"));
  } finally {
    fs.rmSync(refusedHome, { recursive: true, force: true });
  }
});

test("POST /ui/api/codex/restart stops codex app servers through the injected runtime", async () => {
  const { handler, home } = await makeFixture({
    webUi: {
      upstreamDeps: {
        stopCodexServers: async () => ({ scan: "ok" as const, results: [{ pid: 4321, status: "stopped" as const }] }),
      },
    },
  });
  try {
    const ok = await handler(authedRequest("/ui/api/codex/restart", { method: "POST" }));
    assert.equal(ok.status, 200);
    const payload = await ok.json() as { results: Array<{ pid: number; status: string }> };
    assert.deepEqual(payload.results, [{ pid: 4321, status: "stopped" }]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  const failing = await makeFixture({
    webUi: {
      upstreamDeps: {
        stopCodexServers: async () => ({ scan: "unknown" as const, results: [], error: "ps failed" }),
      },
    },
  });
  try {
    const response = await failing.handler(authedRequest("/ui/api/codex/restart", { method: "POST" }));
    assert.equal(response.status, 500);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /unknown: ps failed/);
  } finally {
    fs.rmSync(failing.home, { recursive: true, force: true });
  }
});

test("gateway log tail returns at most the last 256KB from a line boundary", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    const line = "--2026-09-13 10:00:00.000-- POST /v1/responses -> 200 (12ms)\n";
    fs.writeFileSync(paths.stdoutLog, line.repeat(20000)); // ~1.5MB
    const response = await handler(authedRequest("/ui/api/logs/gateway"));
    assert.equal(response.status, 200);
    const payload = await response.json() as { text: string; truncated: boolean };
    assert.equal(payload.truncated, true);
    assert.ok(Buffer.byteLength(payload.text) <= 256 * 1024);
    assert.ok(payload.text.startsWith("--"), "tail must start at a whole line");
    assert.match(payload.text, /POST \/v1\/responses/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request log listing filters non-request-log files, marks ws files, and sorts newest first", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    // 落盘路径全部使用内联字面量，目录为 mkdtemp 临时目录。
    fs.writeFileSync(path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120000.log"), "a");
    fs.writeFileSync(path.join(paths.logDir, "cliproxy-v1-live-ws-3f2a9c1d.log"), "b");
    fs.writeFileSync(path.join(paths.logDir, "gateway.log"), "c");
    fs.writeFileSync(path.join(paths.logDir, "notes.txt"), "d");
    fs.utimesSync(
      path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120000.log"),
      new Date(1_000_000_000_000),
      new Date(1_000_000_000_000),
    );
    fs.utimesSync(
      path.join(paths.logDir, "cliproxy-v1-live-ws-3f2a9c1d.log"),
      new Date(2_000_000_000_000),
      new Date(2_000_000_000_000),
    );

    const response = await handler(authedRequest("/ui/api/logs/requests"));
    assert.equal(response.status, 200);
    const payload = await response.json() as { files: Array<{ name: string; type: string }>; total: number };
    assert.deepEqual(
      payload.files.map((file) => file.name),
      ["cliproxy-v1-live-ws-3f2a9c1d.log", "cliproxy-v1-responses-http-20260913120000.log"],
      "newest must come first",
    );
    assert.equal(payload.total, 2);
    assert.equal(payload.files[0].type, "ws");
    assert.equal(payload.files[1].type, "http");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request log listing paginates with offset/limit and defaults to 100 per page", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    // mtime 递增：…0003 最旧、…0005 最新；落盘路径全部内联字面量。
    fs.writeFileSync(path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120003.log"), "x");
    fs.writeFileSync(path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120004.log"), "x");
    fs.writeFileSync(path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120005.log"), "x");
    fs.utimesSync(path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120003.log"), new Date(1), new Date(1));
    fs.utimesSync(path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120004.log"), new Date(2), new Date(2));
    fs.utimesSync(path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120005.log"), new Date(3), new Date(3));

    const get = async (query: string) => {
      const response = await handler(authedRequest(`/ui/api/logs/requests${query}`));
      return response.json() as Promise<{ files: Array<{ name: string }>; total: number; offset: number; limit: number; logging: boolean }>;
    };
    const page1 = await get("?limit=2&offset=0");
    assert.deepEqual(page1.files.map((file) => file.name), [
      "cliproxy-v1-responses-http-20260913120005.log",
      "cliproxy-v1-responses-http-20260913120004.log",
    ]);
    assert.equal(page1.total, 3);
    assert.equal(page1.logging, true, "fixture enables request logging");

    const page2 = await get("?limit=2&offset=2");
    assert.deepEqual(page2.files.map((file) => file.name), ["cliproxy-v1-responses-http-20260913120003.log"]);
    assert.equal(page2.total, 3);

    // 缺省参数：默认每页 100、offset 0，小目录返回全部。
    const defaults = await get("");
    assert.equal(defaults.limit, 100);
    assert.equal(defaults.offset, 0);
    assert.equal(defaults.files.length, 3);

    // 非法参数按缺省处理；limit 超上限钳到 500。
    const clamped = await get("?limit=0&offset=-5");
    assert.equal(clamped.limit, 100);
    assert.equal(clamped.offset, 0);
    const capped = await get("?limit=9999");
    assert.equal(capped.limit, 500);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request log listing reports logging=false and lists nothing when request logging is off", async () => {
  const { handler, paths, home } = await makeFixture({ config: { requestLogging: false } });
  try {
    // 目录里即使有历史文件，关闭日志时也不列出——前端只显示「未开启」提示。
    fs.writeFileSync(
      path.join(paths.logDir, "cliproxy-v1-responses-http-20260913120000.log"),
      "legacy",
    );
    const response = await handler(authedRequest("/ui/api/logs/requests"));
    assert.equal(response.status, 200);
    const payload = await response.json() as { logging: boolean; total: number; files: unknown[] };
    assert.equal(payload.logging, false);
    assert.equal(payload.total, 0);
    assert.deepEqual(payload.files, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request log content rejects traversal, non-log names, and serves a valid tail", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    const name = "cliproxy-v1-responses-http-20260913120000.log";
    fs.writeFileSync(path.join(paths.logDir, name), "--- request payload ---\nhello\n");
    assert.equal(
      (await handler(authedRequest(`/ui/api/logs/requests/gateway.log`))).status,
      404,
    );
    assert.equal(
      (await handler(authedRequest("/ui/api/logs/requests/..%2F..%2Fconfig.json"))).status,
      404,
    );
    const response = await handler(authedRequest(`/ui/api/logs/requests/${encodeURIComponent(name)}`));
    assert.equal(response.status, 200);
    const payload = await response.json() as { name: string; text: string };
    assert.equal(payload.name, name);
    assert.match(payload.text, /request payload/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request log preview stays non-empty when the last line exceeds the tail window", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    const name = "cliproxy-v1-responses-ws-01a09e75-c906-7c73-afc9-3c52659d49c3.log";
    // 末行约 160KB，远超 REQUEST_LOG_TAIL_BYTES（64KB）。文件整体再垫到 >1MB，
    // 逼出「扩窗仍只拿到半行 → 必须对齐完整行」的路径，而不是整文件读回。
    const longPayload = "x".repeat(160 * 1024);
    const padding = "p".repeat(1024 * 1024);
    fs.writeFileSync(
      path.join(paths.logDir, name),
      "--2026-09-14 13:00:00.000-- [realtime] padding "
      + padding
      + "\n--2026-09-14 14:00:00.000-- [realtime] ws-dial ok\n"
      + `--2026-09-14 14:45:50.630-- [realtime] ws-recv {"payload":"${longPayload}"}\n`,
    );
    const response = await handler(authedRequest(`/ui/api/logs/requests/${encodeURIComponent(name)}`));
    assert.equal(response.status, 200);
    const payload = await response.json() as { name: string; text: string; truncated: boolean };
    assert.equal(payload.name, name);
    assert.equal(payload.truncated, true);
    assert.ok(payload.text.length > 0, "preview must not be an empty string");
    assert.match(payload.text, /\[realtime\] ws-recv/);
    assert.match(payload.text, /payload/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request log preview skips trailing blank lines after a long SSE data line", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    const name = "cliproxy-v1-responses-http-20260914175952.log";
    // 真机形态：一条超长 response.completed 数据行 + SSE/logExchange 尾部空白行。
    // 末尾 64KB 窗口会落在数据行中段，firstNewline 是行尾，rest 只有 \\n——
    // 不能把空白行当作有效 tail 返回。文件 <1MB 时扩窗会读回全文。
    const completed = JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_demo",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        pad: "x".repeat(90 * 1024),
      },
      sequence_number: 210,
    });
    fs.writeFileSync(
      path.join(paths.logDir, name),
      "--- request payload ---\n{\"model\":\"demo\"}\n"
      + "--- response body ---\n"
      + `data: ${completed}\n\n\n\n\n\n`,
    );
    const response = await handler(authedRequest(`/ui/api/logs/requests/${encodeURIComponent(name)}`));
    assert.equal(response.status, 200);
    const payload = await response.json() as { name: string; text: string; truncated: boolean };
    assert.equal(payload.name, name);
    assert.notEqual(payload.text.trim(), "", "preview must not be whitespace-only");
    assert.match(payload.text, /response\.completed/);
    assert.match(payload.text, /output_text/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("request log preview keeps the long SSE line when expand hits the 1MB cap", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    const name = "cliproxy-v1-responses-http-cap.log";
    // 整体 >1MB，末行也 >1MB：扩窗顶到 TAIL_EXPAND_CAP 后仍只能半行/整行，
    // 必须退回数据行本身，而不是行尾空白。
    const pad = "y".repeat(1200 * 1024);
    fs.writeFileSync(
      path.join(paths.logDir, name),
      "--- response body ---\n"
      + `data: {"type":"response.completed","pad":"${pad}","sequence_number":210}\n\n\n\n\n\n`,
    );
    const response = await handler(authedRequest(`/ui/api/logs/requests/${encodeURIComponent(name)}`));
    assert.equal(response.status, 200);
    const payload = await response.json() as { name: string; text: string; truncated: boolean };
    assert.equal(payload.truncated, true);
    assert.notEqual(payload.text.trim(), "", "preview must not be whitespace-only");
    // 顶到 1MB 上限时窗口可能仍落在超长行中段，拿到的是行后缀，但不能只剩空白。
    assert.match(payload.text, /sequence_number|pad/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("/ui requests are excluded from request logging", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      const response = await handler(authedRequest("/ui/api/status"));
      assert.equal(response.status, 200);
    }
    const leftovers = fs.readdirSync(paths.logDir).filter((name) => name.endsWith(".log"));
    assert.deepEqual(leftovers, [], "UI polling must not create request log files");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ensureUiToken reuses an existing token and generates a fresh one when missing", async () => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccp-token-"));
  try {
    const file = path.join(home, "ui-token");
    fs.writeFileSync(file, "ccp_existing\n", { mode: 0o600 });
    assert.equal(ensureUiToken(file), "ccp_existing");
    fs.rmSync(file);
    const generated = ensureUiToken(file);
    assert.match(generated, /^ccp_[0-9a-f]{48}$/);
    assert.equal(ensureUiToken(file), generated);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("POST /ui/api/config rejects combinations the restarted gateway would refuse to boot", async () => {
  const { handler, paths, home } = await makeFixture({ config: { prefix: "zcode/" } });
  try {
    const before = fs.readFileSync(paths.gatewayConfig, "utf8");
    const response = await handler(authedRequest("/ui/api/config", { json: { zcode: true } }));
    assert.equal(response.status, 400);
    const payload = await response.json() as { error: { message: string } };
    assert.match(payload.error.message, /前缀保留给 ZCode/);
    // 校验失败不写盘：原配置逐字节保留，运行中的服务不受影响。
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("POST /ui/api/config rejects codebuddy prefix conflicts before writing", async () => {
  const { handler, paths, home } = await makeFixture({ config: { prefix: "workbuddy/" } });
  try {
    const before = fs.readFileSync(paths.gatewayConfig, "utf8");
    const response = await handler(authedRequest("/ui/api/config", { json: { codebuddy: true } }));
    assert.equal(response.status, 400);
    const payload = await response.json() as { error: { message: string } };
    assert.match(payload.error.message, /前缀保留给 CodeBuddy\/WorkBuddy/);
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("webUiContextForInstance keeps the full config path and never manages the default service", async () => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccp-webui-ctx-"));
  try {
    const paths = makePaths(home);

    // 默认配置 → 生产上下文（全量管理）。
    const production = webUiContextForInstance(paths.gatewayConfig, paths);
    assert.equal(production.instanceOnly, undefined);
    assert.equal(production.paths, paths);

    // 默认运行目录里的 test.json：gatewayConfig 保留完整文件名，绝不回落到 config.json。
    const sibling = path.join(paths.runtimeHome, "test.json");
    const siblingContext = webUiContextForInstance(sibling, paths);
    assert.equal(siblingContext.instanceOnly, true);
    // 临时目录祖先可能经过 /var → /private/var 软链；配置文件名仍须完整保留。
    assert.equal(siblingContext.paths.gatewayConfig, path.join(fs.realpathSync(home), ".codex-cliproxy-gateway", "test.json"));
    assert.notEqual(siblingContext.paths.gatewayConfig, paths.gatewayConfig);
    assert.equal(siblingContext.paths.home, paths.home);
    assert.equal(siblingContext.paths.codexHome, paths.codexHome);

    // $HOME 下的配置：派生 LaunchAgent 绝不命中默认服务路径。
    const homeContext = webUiContextForInstance(path.join(home, "config.json"), paths);
    assert.equal(homeContext.instanceOnly, true);
    assert.notEqual(homeContext.paths.launchAgent, paths.launchAgent);

    // 文件软链指向默认 config.json：必须判为生产实例，否则写入会落到默认安装。
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.gatewayConfig, "{}\n");
    const fileLink = path.join(home, "link-config.json");
    fs.symlinkSync(paths.gatewayConfig, fileLink);
    const fileLinkContext = webUiContextForInstance(fileLink, paths);
    assert.equal(fileLinkContext.instanceOnly, undefined);
    assert.equal(fileLinkContext.paths, paths);

    // 目录软链指向默认 runtimeHome：config.json 同样视为生产实例。
    const dirLink = path.join(home, "link-runtime");
    fs.symlinkSync(paths.runtimeHome, dirLink);
    const dirLinkContext = webUiContextForInstance(path.join(dirLink, "config.json"), paths);
    assert.equal(dirLinkContext.instanceOnly, undefined);
    assert.equal(dirLinkContext.paths, paths);

    // 目录软链下的其他文件名：仍隔离，且 gatewayConfig 解析为真实路径。
    fs.writeFileSync(path.join(paths.runtimeHome, "test.json"), "{}\n");
    const dirLinkSibling = webUiContextForInstance(path.join(dirLink, "test.json"), paths);
    assert.equal(dirLinkSibling.instanceOnly, true);
    assert.equal(
      dirLinkSibling.paths.gatewayConfig,
      fs.realpathSync(path.join(paths.runtimeHome, "test.json")),
    );
    assert.notEqual(dirLinkSibling.paths.gatewayConfig, paths.gatewayConfig);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("temporary UI log display, listing, content and config backfill stay in its own instance", async () => {
  const { config, paths, home, uiHtmlPath } = await makeFixture();
  try {
    const fileA = "cliproxy-v1-responses-http-20261009120000.log";
    const fileB = "cliproxy-v1-responses-http-20261009120001.log";
    fs.writeFileSync(path.join(paths.logDir, fileA), "instance A\n");
    const configBPath = path.join(home, "instance-b", "custom.json");
    const ctx = { ...webUiContextForInstance(configBPath, paths), uiHtmlPath };
    fs.mkdirSync(ctx.paths.logDir, { recursive: true });
    fs.writeFileSync(ctx.paths.uiTokenFile, `${TOKEN}\n`);
    const configB = makeConfig(ctx.paths, { logDir: undefined });
    fs.writeFileSync(configBPath, JSON.stringify(configB));
    fs.writeFileSync(path.join(ctx.paths.logDir, fileB), "instance B\n");
    const request = (pathname: string, options: Parameters<typeof authedRequest>[1] = {}) =>
      runWithInstancePaths(paths, () => handleWebUiRequest(authedRequest(pathname, options), configB, ctx, config.port));

    const display = await request("/ui/api/config");
    assert.equal(display.status, 200);
    assert.equal((await display.json() as { editable: { logDir: string } }).editable.logDir, ctx.paths.logDir);
    const listing = await request("/ui/api/logs/requests");
    assert.deepEqual((await listing.json() as { files: Array<{ name: string }> }).files.map(({ name }) => name), [fileB]);
    const content = await request(`/ui/api/logs/requests/${fileB}`);
    assert.equal((await content.json() as { text: string }).text, "instance B\n");
    assert.equal((await request(`/ui/api/logs/requests/${fileA}`)).status, 404);

    const configABefore = fs.readFileSync(paths.gatewayConfig, "utf8");
    assert.equal((await request("/ui/api/config", { json: { requestLogging: false } })).status, 200);
    assert.equal((await request("/ui/api/config", { json: { requestLogging: true } })).status, 200);
    const saved = JSON.parse(fs.readFileSync(configBPath, "utf8")) as GatewayConfig;
    assert.equal(saved.logDir, ctx.paths.logDir);
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), configABefore);
    assert.equal(requestLogDir({ ...saved, logDir: paths.logDir }, ctx.paths), paths.logDir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("UI instance headers and async upstream lookups use request context while preserving authentication", async () => {
  const fixtureA = await makeFixture();
  const fixtureB = await makeFixture();
  const upstream = await startFakeUpstream((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "instance-test-model" }] }));
  });
  try {
    const seen: string[] = [];
    const handle = (fixture: Fixture, pathname: string, options: Parameters<typeof authedRequest>[1] = {}) => {
      const config = { ...fixture.config, upstreamType: "newapi" as const, upstreamBaseUrl: upstream.url };
      fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(config));
      return handleWebUiRequest(authedRequest(pathname, options), config, {
        paths: fixture.paths,
        uiHtmlPath: fixture.uiHtmlPath,
        upstreamDeps: {
          readKey: () => {
            seen.push(resolvePaths().runtimeHome);
            return "";
          },
        },
      }, fixture.config.port);
    };
    const [modelsA, modelsB] = await runWithInstancePaths(fixtureA.paths, () => Promise.all([
      handle(fixtureA, "/ui/api/upstream/models"),
      handle(fixtureB, "/ui/api/upstream/models"),
    ]));
    assert.equal(modelsA.status, 200);
    assert.equal(modelsB.status, 200);
    assert.deepEqual(seen.sort(), [fixtureA.paths.runtimeHome, fixtureB.paths.runtimeHome].sort());
    assert.equal(modelsA.headers.get("x-ccp-instance"), instanceMarker(fixtureA.paths.runtimeHome));
    assert.equal(modelsB.headers.get("x-ccp-instance"), instanceMarker(fixtureB.paths.runtimeHome));
    const uiB = await handle(fixtureB, "/ui");
    const statusB = await handle(fixtureB, "/ui/api/status");
    assert.equal(uiB.headers.get("x-ccp-instance"), instanceMarker(fixtureB.paths.runtimeHome));
    assert.equal(statusB.headers.get("x-ccp-instance"), instanceMarker(fixtureB.paths.runtimeHome));
    assert.equal((await handle(fixtureB, "/ui/api/status", { token: null })).status, 401);
    assert.equal((await handle(fixtureB, "/ui/api/status", { headers: { host: "attacker.example:8320" } })).status, 404);
    assert.equal((await handle(fixtureB, "/ui/api/status", { headers: { origin: "http://attacker.example" } })).status, 404);
  } finally {
    await upstream.close();
    fs.rmSync(fixtureA.home, { recursive: true, force: true });
    fs.rmSync(fixtureB.home, { recursive: true, force: true });
  }
});

test("instance-only UI edits only its own config and never restarts or syncs the default install", async () => {
  const { config, paths, home } = await makeFixture();
  try {
    // 复现 review 场景：默认运行目录里的 test.json——state 与 LaunchAgent 与默认安装
    // 同目录且两份 plist 都真实存在，验证 instanceOnly 的显式禁止先于路径判断生效。
    const testConfig = path.join(paths.runtimeHome, "test.json");
    fs.copyFileSync(paths.gatewayConfig, testConfig);
    const stateBefore = `${JSON.stringify({ version: 4, pendingRestart: false, config: null }, null, 2)}\n`;
    fs.writeFileSync(paths.stateFile, stateBefore);
    fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true });
    fs.writeFileSync(paths.launchAgent, "# default install plist\n");
    const scheduled: string[] = [];
    const context = webUiContextForInstance(testConfig, paths);
    fs.mkdirSync(path.dirname(context.paths.launchAgent), { recursive: true });
    fs.writeFileSync(context.paths.launchAgent, "# temp placeholder plist\n");
    const handler = (request: Request) => handleWebUiRequest(request, config,
      { ...context, scheduleRestart: (ctx) => scheduled.push(ctx.launchAgent) }, config.port);

    const before = fs.readFileSync(paths.gatewayConfig, "utf8");
    const response = await handler(authedRequest("/ui/api/config", { json: { zcode: true } }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { restarting: boolean; applied: string[] };
    assert.equal(payload.restarting, false);
    assert.deepEqual(payload.applied, ["zcode"]);

    // 只改 test.json：默认 config.json 与 state.json 逐字节不变，也不调度任何重启。
    assert.equal((JSON.parse(fs.readFileSync(testConfig, "utf8")) as { zcode?: boolean }).zcode, true);
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), before);
    assert.equal(fs.readFileSync(paths.stateFile, "utf8"), stateBefore);
    assert.deepEqual(scheduled, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("websocket upgrade requests to /ui never bridge upstream, on either port", async () => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccp-webui-ws-"));
  try {
    const paths = makePaths(home);
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    const config = makeConfig(paths, { port: await freePort() });
    fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config, null, 2)}\n`);
    fs.writeFileSync(paths.uiTokenFile, `${TOKEN}\n`, { mode: 0o600 });
    // 网关默认不启动 UI：两个服务显式分开启动，模拟生产形态。
    const server = startGateway(config, "invalid");
    const uiServer = startWebUiServer(config, { paths });
    assert.ok(uiServer, "loopback config must start the ui server");
    const requestStatus = (port: number, requestPath: string): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        // 带 Upgrade 头的 /ui 请求曾会被 responsesWebSocketTarget 桥接转发上游（426），
        // 绕过 loopback/Host/Origin/令牌检查。
        const request = http.request({
          host: "127.0.0.1",
          port,
          path: requestPath,
          headers: { connection: "Upgrade", upgrade: "websocket" },
        }, (response) => {
          resolve(response.statusCode ?? 0);
          response.resume();
        });
        request.on("error", reject);
        request.end();
      });
    try {
      const modelPort = server.port!;
      // 模型端口不服务 /ui：本地 404，绝不进入任何转发或 WebSocket 桥接路径。
      assert.equal(await requestStatus(modelPort, "/ui/api/config"), 404);
      // UI 端口（网关端口 + 1）上由 UI 处理器接管：按缺令牌回 401，而不是升级连接。
      assert.equal(await requestStatus(uiServer.port!, "/ui/api/config"), 401);
    } finally {
      uiServer?.stop(true);
      server.stop(true);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the web ui server reflects config file changes without restarting", async () => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccp-webui-reload-"));
  try {
    const paths = makePaths(home);
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    const config = makeConfig(paths, { port: await freePort() });
    fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config, null, 2)}\n`);
    fs.writeFileSync(paths.uiTokenFile, `${TOKEN}\n`, { mode: 0o600 });
    const server = startWebUiServer(config, { paths });
    assert.ok(server);
    const url = `http://127.0.0.1:${server.port}/ui/api/logs/requests`;
    try {
      const first = await fetch(url, { headers: { "x-ccp-ui-token": TOKEN } });
      assert.equal((await first.json() as { logging: boolean }).logging, true);
      // CLI 侧 config 写入（含 gateway 重启窗口）不应要求 webui 进程跟着重启。
      fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify({ ...config, requestLogging: false }, null, 2)}\n`);
      const second = await fetch(url, { headers: { "x-ccp-ui-token": TOKEN } });
      assert.equal((await second.json() as { logging: boolean }).logging, false);
    } finally {
      server.stop(true);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the web ui launch agent stays off by default (no RunAtLoad, no KeepAlive)", async () => {
  const { renderWebUiAgent, WEBUI_LAUNCHD_LABEL } = await import("../src/launchd.ts");
  const plist = renderWebUiAgent({
    bunPath: "/usr/local/bin/bun",
    cliPath: "/usr/local/lib/codex-cliproxy/index.js",
    codexHome: "/home/u/.codex",
    logPath: "/home/u/.codex-cliproxy-gateway/webui.log",
    label: WEBUI_LAUNCHD_LABEL,
  });
  assert.match(plist, new RegExp(`<string>${WEBUI_LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /<string>web<\/string>/);
  assert.doesNotMatch(plist, /<string>webui<\/string>/);
  assert.match(plist, /<key>CODEX_CLIPROXY_UI_SERVICE<\/key>\s*<string>1<\/string>/);
  // 后台复用 web 的服务模式，始终绑定默认安装配置。
  assert.doesNotMatch(plist, /--config/);
});

test("web service mode runs without installation state or a gateway and exits on SIGTERM", { timeout: 15000 }, async () => {
  const uiPort = await freePort();
  const fixture = await makeFixture({ config: { port: uiPort - 1 } });
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/index.ts"), "web"], {
    env: {
      ...process.env,
      HOME: fixture.home,
      CODEX_HOME: fixture.paths.codexHome,
      CODEX_CLIPROXY_UI_SERVICE: "1",
      // 服务模式必须优先于开发模式，避免后台进程再次启动 LaunchAgent。
      CODEX_CLIPROXY_UI_DEV: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    assert.equal(fs.existsSync(fixture.paths.stateFile), false);
    let ready = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 8000 && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${uiPort}/ui/api/config`, {
          headers: { "x-ccp-ui-token": TOKEN },
          signal: AbortSignal.timeout(500),
        });
        ready = response.ok;
        await response.text();
        if (ready) break;
      } catch {
        // 子进程尚未监听，继续等待；总超时保证失败时不会挂住测试。
      }
      await Bun.sleep(50);
    }
    assert.equal(ready, true, "UI 服务应在没有安装状态和网关的情况下就绪");
    child.kill("SIGTERM");
    assert.equal(await child.exited, 0);
    assert.match(await stdout, /web ui listening on/);
    assert.doesNotMatch(await stdout, /token=|Gateway started|Web UI API is ready/);
    assert.equal(await stderr, "");
    assert.equal(fs.existsSync(fixture.paths.webUiLaunchAgent), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    clearTimeout(deadline);
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("web opens the ui in the browser instead of failing when it is already running", { timeout: 15000, skip: process.platform !== "darwin" }, async () => {
  // UI 端口固定为网关端口 + 1（webUiPort），先成对占用两个相邻空闲端口。
  let marker = "";
  const gatewayHandler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "text/plain", "x-ccp-instance": marker });
    res.end("ok");
  };
  const uiHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/ui" || req.url?.startsWith("/ui?")) {
      res.writeHead(200, { "content-type": "text/html", "x-ccp-instance": marker });
      res.end("<!doctype html>");
    } else {
      res.writeHead(404);
      res.end();
    }
  };
  const listenOn = (port: number, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) =>
    new Promise<http.Server | undefined>((resolve) => {
      const server = http.createServer(handler);
      server.once("error", () => resolve(undefined));
      server.listen(port, "127.0.0.1", () => resolve(server));
    });
  let gatewayPort = 0;
  let gateway: http.Server | undefined;
  let ui: http.Server | undefined;
  for (let attempt = 0; attempt < 20 && gateway === undefined; attempt++) {
    const candidate = await freePort();
    const gw = await listenOn(candidate, gatewayHandler);
    if (!gw) continue;
    const uiServer = await listenOn(candidate + 1, uiHandler);
    if (!uiServer) {
      gw.close();
      continue;
    }
    gateway = gw;
    ui = uiServer;
    gatewayPort = candidate;
  }
  assert.ok(gateway !== undefined && ui !== undefined, "应能找到一对相邻空闲端口");

  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccp-web-cli-"));
  const previousHome = process.env.HOME;
  const previousService = process.env.CODEX_CLIPROXY_UI_SERVICE;
  const previousDev = process.env.CODEX_CLIPROXY_UI_DEV;
  const closeServer = (server: http.Server | undefined) =>
    new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  try {
    process.env.HOME = home;
    delete process.env.CODEX_CLIPROXY_UI_SERVICE;
    delete process.env.CODEX_CLIPROXY_UI_DEV;
    const paths = makePaths(home);
    marker = instanceMarker(paths.runtimeHome);
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.mkdirSync(paths.logDir, { recursive: true });
    fs.writeFileSync(paths.uiTokenFile, `${TOKEN}\n`, { mode: 0o600 });
    fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4 })}\n`);
    const config = makeConfig(paths, { port: gatewayPort, configVersion: GATEWAY_CONFIG_VERSION, codebuddy: false });
    fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config, null, 2)}\n`);

    // 委托式 mock：除记录 /usr/bin/open（不真弹浏览器）外全部转发真实实现，
    // 即使泄漏到同进程的其他测试也没有行为差异。
    const opened: string[] = [];
    mock.module("node:child_process", () => ({
      ...childProcess,
      execFileSync: ((cmd: string, args: readonly string[], options?: unknown) => {
        if (cmd === "/usr/bin/open") {
          opened.push(String(args[0] ?? ""));
          return "";
        }
        return realExecFileSync(cmd, args as string[], options as never);
      }) as typeof childProcess.execFileSync,
    }));

    // UI 已在运行时 web 不应报错要求 --stop，而是直接带令牌打开浏览器。
    await runCli(["web"]);
    assert.deepEqual(opened, [`http://127.0.0.1:${gatewayPort + 1}/ui?token=${TOKEN}`]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousService !== undefined) process.env.CODEX_CLIPROXY_UI_SERVICE = previousService;
    if (previousDev !== undefined) process.env.CODEX_CLIPROXY_UI_DEV = previousDev;
    await closeServer(gateway);
    await closeServer(ui);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /favicon.ico on the ui port serves an inline icon without logging", async () => {
  const { handler, paths, home } = await makeFixture();
  try {
    const response = await handler(new Request(`${BASE}/favicon.ico`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/);
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // UI 流量与模型请求日志物理隔离：UI 端口上的请求绝不进入请求日志目录。
    assert.deepEqual(fs.readdirSync(paths.logDir), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
