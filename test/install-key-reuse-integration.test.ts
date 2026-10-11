import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";

function installFailureScenario(options: { withState: boolean; apiKey?: string }): void {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-proxy-install-key-")));
  try {
    // 模块模拟隔离在子进程，禁止访问真实凭据、系统服务及网络。
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { mock } from "bun:test";
      import { resolvePaths, instanceMarker } from "./apps/gateway/src/paths.ts";
      import { GATEWAY_CONFIG_VERSION } from "./apps/gateway/src/config.ts";

      const paths = resolvePaths();
      const withState = ${options.withState};
      const expectedInstallKey = ${JSON.stringify(options.apiKey ?? "old-key")};
      const keyReads = [];
      const keyWrites = [];
      const serviceCalls = [];
      const systemCalls = [];
      const requests = [];
      const printed = [];
      const originalLog = console.log;
      console.log = (...values) => printed.push(values.join(" "));
      const keychain = await import("./apps/gateway/src/keychain.ts");
      mock.module("./apps/gateway/src/keychain.ts", () => ({
        ...keychain,
        readApiKey: (optional) => { keyReads.push(optional); return "old-key"; },
        saveApiKey: (key) => { keyWrites.push(key); },
        deleteApiKey: () => { throw new Error("测试禁止删除已有密钥"); },
      }));
      const launchd = await import("./apps/gateway/src/launchd.ts");
      mock.module("./apps/gateway/src/launchd.ts", () => ({
        ...launchd,
        launchAgentStatus: () => null,
        installLaunchAgent: () => { serviceCalls.push("install"); throw new Error("模拟安装服务失败"); },
        restartLaunchAgent: () => { serviceCalls.push("restart"); },
        startLaunchAgent: () => { throw new Error("测试禁止启动系统服务"); },
        uninstallLaunchAgent: () => { serviceCalls.push("uninstall"); },
        reloadLaunchAgent: () => { throw new Error("测试禁止重载系统服务"); },
        stopLaunchAgent: () => { throw new Error("测试禁止停止系统服务"); },
      }));
      const codexVersion = await import("./apps/gateway/src/codex-version.ts");
      mock.module("./apps/gateway/src/codex-version.ts", () => ({
        ...codexVersion, resolveCodexClientVersion: () => "0.0.0",
      }));
      mock.module("node:child_process", () => ({
        execFileSync: (...args) => { systemCalls.push(args); throw new Error("测试禁止系统命令或密钥提示"); },
      }));

      fs.mkdirSync(paths.runtimeHome, { recursive: true });
      fs.mkdirSync(paths.codexHome, { recursive: true });
      const originalToml = 'custom_setting = "manual"\\n';
      fs.writeFileSync(paths.configToml, originalToml);
      const config = {
        configVersion: GATEWAY_CONFIG_VERSION,
        host: "127.0.0.1", port: 8399, mountPath: "/v1", prefix: "cliproxy/",
        officialBaseUrl: "https://official.invalid/v1",
        upstreamBaseUrl: "https://upstream.invalid/v1", upstreamType: "cliproxy",
        catalogPath: paths.catalogFile,
        selectedModels: ["test-model"],
        zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
      };
      const originalConfig = JSON.stringify(config);
      const originalState = JSON.stringify({ version: 4, codexConfigManaged: false, codexHome: paths.codexHome, config });
      fs.writeFileSync(paths.gatewayConfig, originalConfig);
      if (withState) fs.writeFileSync(paths.stateFile, originalState);
      fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [{ slug: "test-model" }] }));
      process.argv[1] = path.join(paths.runtimeHome, "entry.ts");
      fs.writeFileSync(process.argv[1], "");

      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === "https://upstream.invalid" && url.pathname === "/v1/models") {
          requests.push(new Headers(init?.headers).get("authorization"));
          return Response.json({ models: [{ slug: "test-model" }] });
        }
        if (url.origin === "http://127.0.0.1:8399" && url.pathname === "/healthz") {
          return Response.json({ ok: true }, { headers: { "x-ccp-instance": instanceMarker(paths.runtimeHome) } });
        }
        throw new Error("测试禁止未模拟的网络请求");
      };

      const { runCli } = await import("./apps/gateway/src/cli.ts");
      const installArgs = withState
        ? ["install", "--yes"]
        : ["install", "--yes", "--manual-codex-config", "--select", "test-model"];
      await assert.rejects(runCli(installArgs), /模拟安装服务失败/);
      assert.deepEqual(systemCalls, [], "重装不能提示输入密钥或执行系统命令");
      assert.ok(keyReads.length > 0, "重装应通过凭据抽象读取已有密钥");
      assert.deepEqual(requests, ["Bearer " + expectedInstallKey], "目录认证必须使用本次解析的密钥");
      assert.deepEqual(keyWrites, [expectedInstallKey, "old-key"], "失败回滚应恢复安装前的旧密钥");
      assert.deepEqual(serviceCalls, withState ? ["install", "restart"] : ["install", "uninstall"]);
      assert.equal(fs.readFileSync(paths.configToml, "utf8"), originalToml);
      assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), originalConfig);
      if (withState) assert.equal(fs.readFileSync(paths.stateFile, "utf8"), originalState);
      else assert.equal(fs.existsSync(paths.stateFile), false, "失败后不能留下本次安装的状态文件");
      assert.equal(printed.some((line) => line.includes("old-key") || line.includes(expectedInstallKey)), false, "日志不能包含密钥");
      console.log = originalLog;
    `], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: undefined,
        CODEX_CLIPROXY_HOME: path.join(home, "runtime"),
        CODEX_CLIPROXY_UI_SERVICE: undefined,
        API_KEY: options.apiKey,
        TEST_UPSTREAM_KEY: undefined,
      },
      timeout: 50_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const installTestOptions = { timeout: 60_000, skip: process.platform !== "darwin" };

test("同一上游重装复用已有密钥，通过目录认证且安装失败后恢复旧密钥", installTestOptions, () => {
  installFailureScenario({ withState: true });
});

test("重装显式提供新 API_KEY 优先用于认证，安装失败后恢复旧密钥", installTestOptions, () => {
  installFailureScenario({ withState: true, apiKey: "new-key" });
});

test("同一上游已有配置却缺少 state 时仍复用旧密钥，安装失败不得删除旧密钥", installTestOptions, () => {
  installFailureScenario({ withState: false });
});
