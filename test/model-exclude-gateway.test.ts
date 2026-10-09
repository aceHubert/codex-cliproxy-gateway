import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayHandler } from "../src/gateway.ts";
import { handleWebUiRequest } from "../src/webui.ts";
import type { AgyDependencies } from "../src/agy/index.ts";
import type { AgyCredentials } from "../src/agy/credentials.ts";
import type { GatewayConfig, ResolvedPaths } from "../src/types.ts";

type Json = Record<string, any>;
const TIMEOUT = { timeout: 60_000 };

/** 直连上游模型（catalogPath 落盘产物，不带前缀）。 */
const CPA_MODELS = [
  { slug: "test-cpa", display_name: "Test CPA", priority: 0 },
  { slug: "gamma", display_name: "Gamma", priority: 1 },
];
/** 官方 /models 返回的本地原生模型。 */
const NATIVE_MODELS = [{ slug: "gpt-native", priority: 0 }];

interface GatewayFixture {
  directory: string;
  config: GatewayConfig;
  create: (overrides?: Partial<GatewayConfig>) => ReturnType<typeof createGatewayHandler>;
  /** 非 /models 的上游调用记录（responses 等），用于断言被排除模型未被转发。 */
  upstreamCalls: string[];
}

async function gatewayFixture(
  run: (fixture: GatewayFixture) => Promise<void>,
  overrides: Partial<GatewayConfig> = {},
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-exclude-gw-"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
    ...overrides,
  };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: CPA_MODELS }));
  const upstreamCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (target.includes("official.invalid") && target.includes("/models")) {
      return Response.json({ models: NATIVE_MODELS });
    }
    upstreamCalls.push(target);
    return new Response(JSON.stringify({ ok: true, target }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const handlers: Array<ReturnType<typeof createGatewayHandler>> = [];
  try {
    await run({
      directory, config, upstreamCalls,
      create(extra = {}) {
        const handler = createGatewayHandler({ ...config, ...extra }, "fake-cpa-key", "invalid",
          new Set<string>(), new Set<string>(), path.join(directory, "models-cache.json"),
          undefined, { file: path.join(directory, "gateway.log"), maxBytes: 100_000 });
        handlers.push(handler);
        return handler;
      },
    });
  } finally {
    handlers.forEach((handler) => handler.close());
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function responsesRequest(model: string): Request {
  return new Request("http://127.0.0.1:8327/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer inbound-oauth" },
    body: JSON.stringify({ model, input: "hello" }),
  });
}

test("out-of-scope exclusion rules never filter upstream or official models from /v1/models", TIMEOUT, async () => {
  await gatewayFixture(async ({ create }) => {
    // 排除仅对本地兼容端生效：上游 cliproxy/* 与官方模型的可选性由 selectedModels
    // 与 Codex 自身管理，历史规则点名它们也不参与过滤。
    const handler = create({ excludedModels: ["cliproxy/gamma", "gpt-native", "cliproxy/*"] });
    const codex = await handler(new Request("http://127.0.0.1:8327/v1/models?client_version=0.150.0"));
    const models = ((await codex.json()) as Json).models as Json[];
    assert.deepEqual(models.map((model) => model.slug).sort(), ["cliproxy/gamma", "cliproxy/test-cpa", "gpt-native"]);
    const list = await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const data = ((await list.json()) as Json).data as Json[];
    assert.deepEqual(data.map((item) => item.id).sort(), ["cliproxy/gamma", "cliproxy/test-cpa", "gpt-native"]);
  });
});

test("out-of-scope exclusion rules never block upstream or official inference requests", TIMEOUT, async () => {
  await gatewayFixture(async ({ create, upstreamCalls }) => {
    const handler = create({ excludedModels: ["cliproxy/gamma", "gpt-native"] });
    const upstream = await handler(responsesRequest("cliproxy/gamma"));
    assert.equal(upstream.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.match(upstreamCalls[0], /cpa\.invalid/);
    const official = await handler(responsesRequest("gpt-native"));
    assert.equal(official.status, 200);
    assert.equal(upstreamCalls.length, 2);
  });
});

test("upstream-only mode leaves the catalog and requests untouched by exclusion rules", TIMEOUT, async () => {
  await gatewayFixture(async ({ create, upstreamCalls }) => {
    // upstream-only 没有本地兼容端：排除规则整体不生效。
    const handler = create({ upstreamOnly: true, excludedModels: ["gamma", "test-cpa", "agy/x"] });
    const codex = await handler(new Request("http://127.0.0.1:8327/v1/models?client_version=0.150.0"));
    const models = ((await codex.json()) as Json).models as Json[];
    assert.deepEqual(models.map((model) => model.slug).sort(), ["gamma", "test-cpa"]);
    const response = await handler(responsesRequest("gamma"));
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
  });
});

/* ---------------- agy 适配器：合并过滤与转发前拦截 ---------------- */

const AGY_MODEL = "agy/gemini-3.8-flash";

function agyCredential(): AgyCredentials {
  return {
    accessToken: "ya29.fake-agy-token",
    expiryMs: Date.now() + 3_600_000,
    identity: "identity-test",
    authMethod: "consumer",
  };
}

test("agy adapter models honor excludedModels in /v1/models and inference routing", TIMEOUT, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-exclude-agy-"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/", agy: true,
    excludedModels: [AGY_MODEL, "cliproxy/gamma"],
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
  };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: CPA_MODELS }));
  const inferBodies: Json[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (target.includes("official.invalid") && target.includes("/models")) {
      return Response.json({ models: NATIVE_MODELS });
    }
    if (target.includes(":fetchAvailableModels")) {
      return Response.json({ models: { "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash", supportsThinking: true, maxTokens: 1_000_000 } } });
    }
    if (target.includes(":streamGenerateContent")) {
      inferBodies.push(JSON.parse(String(init?.body)));
      const frame = { response: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] } }] } };
      return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`未模拟的上游调用：${target}`);
  }) as typeof fetch;
  try {
    const agyDependencies: AgyDependencies = {
      cacheDirectory: directory,
      refreshCatalogOnStart: false,
      credentials: async () => agyCredential(),
    };
    const handler = createGatewayHandler(config, "fake-cpa-key", "invalid",
      new Set<string>(), new Set<string>(), path.join(directory, "models-cache.json"),
      undefined, { file: path.join(directory, "gateway.log"), maxBytes: 100_000 },
      undefined, undefined, agyDependencies);
    try {
      // 合并目录过滤：agy 条目被排除；作用域外规则（cliproxy/gamma）不影响上游条目。
      const codex = await handler(new Request("http://127.0.0.1:8327/v1/models?client_version=0.150.0"));
      const models = ((await codex.json()) as Json).models as Json[];
      assert.deepEqual(models.map((model) => model.slug).sort(), ["cliproxy/gamma", "cliproxy/test-cpa", "gpt-native"]);

      // 被排除的 agy 模型在适配器转发前被 404 拦截，不触达上游。
      const blocked = await handler(responsesRequest(AGY_MODEL));
      assert.equal(blocked.status, 404);
      assert.equal(blocked.headers.get("x-codex-cliproxy-gateway"), "model-excluded");
      assert.equal(inferBodies.length, 0);
    } finally {
      handler.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/* ---------------- Web UI 配置接口的 excludedModels 读写 ---------------- */

const UI_TOKEN = "ccp_test_token_0123456789abcdef";

function webUiFixture(): { handler: (request: Request) => Promise<Response>; paths: ResolvedPaths; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-exclude-ui-"));
  const runtimeHome = path.join(home, ".codex-cliproxy-gateway");
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const paths: ResolvedPaths = {
    home, codexHome, runtimeHome,
    instanceSuffix: "",
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
  };
  const config: GatewayConfig = {
    configVersion: "0.0.0-test",
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    excludedModels: ["qoder-cn/qoder-code", "zcode-team-coding-plan/glm-5.3"],
  };
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify(config, null, 2));
  fs.writeFileSync(paths.uiTokenFile, `${UI_TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.modelsCacheFile, JSON.stringify({
    fetched_at: new Date().toISOString(), client_version: "0.150.0", models: [{ slug: "qoder-cn/x" }],
  }));
  const uiHtmlPath = path.join(home, "ui-index.html");
  fs.writeFileSync(uiHtmlPath, "<!doctype html><html><body><div id=\"root\"></div></body></html>");
  const handler = (request: Request) =>
    handleWebUiRequest(request, config, { paths, uiHtmlPath }, config.port);
  return { handler, paths, home };
}

function uiRequest(pathname: string, options: { method?: string; json?: unknown } = {}): Request {
  const headers = new Headers({ "x-ccp-ui-token": UI_TOKEN });
  let body: string | undefined;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  return new Request(`http://127.0.0.1:8320${pathname}`, {
    method: options.method ?? (body ? "POST" : "GET"), headers, body,
  });
}

test("web ui config api splits excluded rules into prefix groups and expands them on save", async () => {
  const { handler, paths, home } = webUiFixture();
  try {
    const read = await handler(uiRequest("/ui/api/config"));
    assert.equal(read.status, 200);
    const editable = ((await read.json()) as Json).editable as Json;
    // 分组定义：按用户可感知的产品归一（5 组），全部保存为产品级家族通配。
    const groups = editable.excludedGroups as Json[];
    assert.equal(groups.length, 5);
    assert.deepEqual(groups.map((group) => group.key), ["zcode", "codebuddy", "workbuddy", "qoder", "agy"]);
    assert.deepEqual(editable.excludedEntries, {
      zcode: ["glm-5.3"], codebuddy: [], workbuddy: [], qoder: ["qoder-code"], agy: [],
    });

    // 保存：分组条目由服务端补前缀，整组替换 excludedModels（产品级家族通配）。
    const posted = await handler(uiRequest("/ui/api/config", {
      json: {
        excludedModelGroups: { qoder: ["qoder-code-x", "  "], agy: ["gemini-2.5-flash"], zcode: ["glm-5.3"] },
      },
    }));
    assert.equal(posted.status, 200);
    const payload = (await posted.json()) as Json;
    assert.deepEqual(payload.applied, ["excludedModels"]);
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, ["qoder-*/qoder-code-x", "agy/gemini-2.5-flash", "zcode*/glm-5.3"]);
    // 排除规则改变目录内容：Codex 目录缓存被重置，下一次 /models 立即反映。
    const cache = JSON.parse(fs.readFileSync(paths.modelsCacheFile, "utf8")) as { fetched_at: string };
    assert.equal(cache.fetched_at, "2000-01-01T00:00:00Z");

    // 非法条目被拒绝且不落盘：裸 *、上游分组不存在。
    const rejected = await handler(uiRequest("/ui/api/config", { json: { excludedModelGroups: { agy: ["*"] } } }));
    assert.equal(rejected.status, 400);
    assert.match(JSON.stringify(await rejected.json()), /would exclude every model of this group/);
    const noUpstream = await handler(uiRequest("/ui/api/config", { json: { excludedModelGroups: { upstream: ["alpha"] } } }));
    assert.equal(noUpstream.status, 400);
    assert.match(JSON.stringify(await noUpstream.json()), /Unknown excluded model group/);
    const after = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(after.excludedModels, ["qoder-*/qoder-code-x", "agy/gemini-2.5-flash", "zcode*/glm-5.3"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
