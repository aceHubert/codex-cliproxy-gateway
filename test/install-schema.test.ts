import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function installSchemaScenario(options: { schema?: string; failInstall?: boolean }): void {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-proxy-install-schema-")));
  try {
    // 每个安装场景独立模拟系统服务、凭据和网络，避免污染其他测试或访问真实主机。
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { mock } from "bun:test";
      import { resolvePaths, instanceMarker } from "./apps/gateway/src/paths.ts";
      import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } from "./apps/gateway/src/config.ts";
      import { configuredCatalogFile } from "./apps/gateway/src/upstream-catalog.ts";

      const paths = resolvePaths();
      const previousSchema = ${JSON.stringify(options.schema) ?? "undefined"};
      const failInstall = ${options.failInstall === true};
      const serviceCalls = [];
      const keyWrites = [];
      const systemCalls = [];
      const requests = [];
      const printed = [];
      console.log = (...values) => printed.push(values.join(" "));

      const keychain = await import("./apps/gateway/src/keychain.ts");
      mock.module("./apps/gateway/src/keychain.ts", () => ({
        ...keychain,
        readApiKey: () => "fixture-key",
        saveApiKey: (key) => { keyWrites.push(key); },
        deleteApiKey: () => { throw new Error("测试禁止删除已有密钥"); },
      }));
      const launchd = await import("./apps/gateway/src/launchd.ts");
      mock.module("./apps/gateway/src/launchd.ts", () => ({
        ...launchd,
        launchAgentStatus: () => null,
        installLaunchAgent: () => {
          serviceCalls.push("install");
          assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).$schema, GATEWAY_CONFIG_SCHEMA_URL);
          assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).config.$schema, GATEWAY_CONFIG_SCHEMA_URL);
          if (failInstall) throw new Error("模拟安装服务失败");
        },
        restartLaunchAgent: () => { serviceCalls.push("restart"); },
        startLaunchAgent: () => { throw new Error("测试禁止启动系统服务"); },
        uninstallLaunchAgent: () => { throw new Error("测试禁止卸载系统服务"); },
        reloadLaunchAgent: () => { throw new Error("测试禁止重载系统服务"); },
        stopLaunchAgent: () => { throw new Error("测试禁止停止系统服务"); },
      }));
      const codexVersion = await import("./apps/gateway/src/codex-version.ts");
      mock.module("./apps/gateway/src/codex-version.ts", () => ({
        ...codexVersion, resolveCodexClientVersion: () => "0.0.0",
      }));
      mock.module("node:child_process", () => ({
        execFileSync: (...args) => {
          systemCalls.push(args);
          throw new Error("测试禁止系统命令或密钥提示");
        },
      }));

      fs.mkdirSync(paths.runtimeHome, { recursive: true });
      fs.mkdirSync(paths.codexHome, { recursive: true });
      const originalToml = 'custom_setting = "manual"\\n';
      fs.writeFileSync(paths.configToml, originalToml);
      const config = {
        ...(previousSchema === undefined ? {} : { $schema: previousSchema }),
        configVersion: GATEWAY_CONFIG_VERSION,
        host: "127.0.0.1", port: 8399, mountPath: "/v1",
        officialBaseUrl: "https://official.invalid/v1",
        upstreamBaseUrl: "https://upstream.invalid/v1", upstreamType: "cliproxy",
        selectedModels: ["test-model"], excludedModels: ["other-model"],
        requestLogging: true, maxRequestLogs: 42,
        zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
        futureUserSetting: { value: "保留用户扩展配置" },
      };
      const originalConfig = JSON.stringify(config);
      const originalState = JSON.stringify({
        version: 4, installedAt: "existing-install", codexConfigManaged: false,
        codexHome: paths.codexHome, config, futureStateSetting: "保留状态扩展字段",
      });
      fs.writeFileSync(paths.gatewayConfig, originalConfig);
      fs.writeFileSync(paths.stateFile, originalState);
      const catalogFile = configuredCatalogFile(paths, config);
      const originalCatalog = JSON.stringify({ models: [{ slug: "test-model" }] });
      fs.writeFileSync(catalogFile, originalCatalog);
      process.argv[1] = path.join(paths.runtimeHome, "entry.ts");
      fs.writeFileSync(process.argv[1], "");

      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.origin + url.pathname);
        if (url.origin === "https://upstream.invalid" && url.pathname === "/v1/models") {
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
          return Response.json({ models: [{ slug: "test-model" }] });
        }
        if (url.origin === "http://127.0.0.1:8399" && url.pathname === "/healthz") {
          return Response.json({ ok: true }, { headers: { "x-ccp-instance": instanceMarker(paths.runtimeHome) } });
        }
        throw new Error("测试禁止未模拟的网络请求: " + url.origin + url.pathname);
      };

      const { runCli } = await import("./apps/gateway/src/cli.ts");
      if (failInstall) {
        await assert.rejects(runCli(["install", "--yes"]), /模拟安装服务失败/);
        assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), originalConfig, "失败必须恢复安装前的 schema 与配置");
        assert.equal(fs.readFileSync(paths.stateFile, "utf8"), originalState, "失败必须恢复安装前的状态快照");
        assert.deepEqual(serviceCalls, ["install", "restart"]);
        assert.deepEqual(keyWrites, ["fixture-key", "fixture-key"]);
      } else {
        await runCli(["install", "--yes"]);
        const installedConfig = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
        const installedState = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
        assert.equal(installedConfig.$schema, GATEWAY_CONFIG_SCHEMA_URL);
        assert.equal(installedState.config.$schema, GATEWAY_CONFIG_SCHEMA_URL);
        assert.deepEqual(installedState.config, installedConfig);
        for (const [key, value] of Object.entries(config)) {
          if (key !== "$schema") assert.deepEqual(installedConfig[key], value, "安装应保留用户配置 " + key);
        }
        assert.equal(installedState.installedAt, "existing-install");
        assert.equal(installedState.futureStateSetting, "保留状态扩展字段");
        assert.deepEqual(serviceCalls, ["install"]);
        assert.deepEqual(keyWrites, ["fixture-key"]);
      }
      assert.deepEqual(systemCalls, [], "测试不得执行系统命令或真实凭据操作");
      assert.deepEqual(requests, ["https://upstream.invalid/v1/models", "http://127.0.0.1:8399/healthz"]);
      assert.equal(fs.readFileSync(paths.configToml, "utf8"), originalToml);
      assert.equal(fs.readFileSync(catalogFile, "utf8"), originalCatalog);
      assert.equal(printed.some((line) => line.includes("fixture-key")), false, "日志不得包含密钥");
    `], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: undefined,
        CODEX_CLIPROXY_HOME: path.join(home, "runtime"),
        CODEX_CLIPROXY_UI_SERVICE: undefined,
        API_KEY: undefined,
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

for (const [name, schema] of [
  ["旧地址", "https://raw.githubusercontent.com/aceHubert/codex-cliproxy-gateway/main/schemas/gateway-config.schema.json"],
  ["schemas 目录时代的规范地址", "https://raw.githubusercontent.com/aceHubert/codex-cliproxy-gateway/main/apps/gateway/schemas/gateway-config.schema.json"],
  ["用户自定义地址", "https://custom.invalid/gateway-config.schema.json"],
  ["缺失地址", undefined],
] as const) {
  test(`install 将${name}更新为当前程序的 schema 地址，并保留用户配置`, installTestOptions, () => {
    installSchemaScenario({ schema });
  });
}

test("install 失败后恢复旧 schema 地址和安装状态", installTestOptions, () => {
  installSchemaScenario({ schema: "https://custom.invalid/gateway-config.schema.json", failInstall: true });
});
