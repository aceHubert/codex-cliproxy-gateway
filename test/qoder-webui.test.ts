import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GATEWAY_CONFIG_VERSION } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import { handleWebUiRequest } from "../src/webui.ts";
import type { GatewayConfig } from "../src/types.ts";
import type { UiConfig } from "../src/ui/api.ts";

const TOKEN = "qoder-ui-test-token";

function fixture(qoder = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-webui-"));
  const paths = resolvePaths({ HOME: home });
  const qoderConfigDir = path.join(home, "qoder-config");
  const config: GatewayConfig = {
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    qoder,
  };
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify(config));
  fs.writeFileSync(paths.uiTokenFile, TOKEN);
  const request = (json?: unknown, token = TOKEN) => handleWebUiRequest(new Request(
    "http://127.0.0.1:8320/ui/api/config",
    {
      method: json === undefined ? "GET" : "POST",
      headers: { "x-ccp-ui-token": token, "content-type": "application/json" },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    },
  ), config, {
    paths,
    instanceOnly: true,
    providerDeps: {
      zcodeHome: path.join(home, ".zcode"),
      codebuddyAuthDir: path.join(home, "codebuddy-auth"),
      qoderConfigDir,
      // 桌面版检测注入空目录，避免测试命中真机桌面登录。
      qoderDesktopDir: path.join(home, "qoder-desktop"),
      qoderCnConfigDir: path.join(home, "qoder-cn-config"),
      qoderCnDesktopDir: path.join(home, "qoder-cn-desktop"),
    },
  }, config.port);
  return { home, paths, qoderConfigDir, request };
}

test("Qoder UI 仅探测国际版登录文件存在性，不解析或回显凭据", async () => {
  const { home, qoderConfigDir, request } = fixture();
  try {
    const absent = await (await request()).json() as UiConfig;
    assert.equal(absent.editable.qoder, false);
    assert.equal(absent.detected.qoder, false);
    assert.deepEqual(absent.detected.qoderSources, []);

    const authDir = path.join(qoderConfigDir, ".auth");
    fs.mkdirSync(authDir, { recursive: true });
    // 无效 JSON 和伪造令牌用于证明 UI 不依赖认证内容解析。
    fs.writeFileSync(path.join(authDir, "user"), "invalid-json:qoder-secret-token");
    const partial = await (await request()).json() as UiConfig;
    assert.equal(partial.detected.qoder, false, "缺少机器标识时不显示开关");
    assert.deepEqual(partial.detected.qoderSources, []);

    fs.writeFileSync(path.join(authDir, "machine_id"), "qoder-secret-machine");
    const readyResponse = await request();
    assert.equal(readyResponse.status, 200);
    const text = await readyResponse.text();
    const ready = JSON.parse(text) as UiConfig;
    assert.equal(ready.detected.qoder, true);
    assert.deepEqual(ready.detected.qoderSources, ["CLI-INTL"], "CLI 存在时只显示 CLI");
    assert.equal(ready.editable.qoder, false, "发现登录不能自动修改开关");
    assert.ok(!text.includes("qoder-secret"));
    assert.ok(!text.includes(qoderConfigDir), "认证目录也不能进入响应");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Qoder UI 桌面版登录文件同样触发检测，无需 CLI 登录", async () => {
  const { home, request } = fixture();
  try {
    const desktop = path.join(home, "qoder-desktop");
    fs.mkdirSync(desktop, { recursive: true });
    fs.writeFileSync(path.join(desktop, "auth.v1.dat"), "v10-binary-opaque");
    fs.writeFileSync(path.join(desktop, "auth.machine-id"), "uuid-desktop-only");
    const payload = await (await request()).json() as UiConfig;
    assert.equal(payload.detected.qoder, true, "仅桌面版登录也应显示开关");
    assert.deepEqual(payload.detected.qoderSources, ["DESKTOP-INTL"], "CLI 缺失时回退桌面版");
    const text = JSON.stringify(payload);
    assert.ok(!text.includes("uuid-desktop-only"), "桌面机器标识不能进入响应");
    assert.ok(!text.includes(desktop), "桌面数据目录不能进入响应");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Qoder UI 保留已开启但登录文件缺失的配置，允许用户关闭", async () => {
  const { home, paths, request } = fixture(true);
  try {
    const payload = await (await request()).json() as UiConfig;
    assert.equal(payload.editable.qoder, true);
    assert.equal(payload.detected.qoder, false);
    const response = await request({ qoder: false });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { restarting: false, applied: ["qoder"] });
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.equal(saved.qoder, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Qoder UI 单开关受令牌保护，拒绝非布尔值且支持启用", async () => {
  const { home, paths, request } = fixture();
  try {
    assert.equal((await request({ qoder: true }, "wrong-token")).status, 401);
    const original = fs.readFileSync(paths.gatewayConfig, "utf8");
    const invalid = await request({ qoder: "intl" });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /qoder expects a boolean/);
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), original);

    const response = await request({ qoder: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { restarting: false, applied: ["qoder"] });
    const updated = await (await request()).json() as UiConfig;
    assert.equal(updated.editable.qoder, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
