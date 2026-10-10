import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 模块模拟只存在于子进程，避免污染其他测试；所有系统操作和网络都被替换。 */
function isolatedScenario(scenario: string): void {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-instance-regression-")));
  const setup = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { mock } from "bun:test";
    import { resolvePaths, runWithInstancePaths, instanceMarker } from "./src/paths.ts";
    import { GATEWAY_CONFIG_VERSION } from "./src/config.ts";
    const base = process.env.HOME;
    const rootA = process.env.CODEX_CLIPROXY_HOME;
    const rootB = path.join(base, "instance-b");
    const codexA = path.join(base, "codex-a");
    const pathsA = resolvePaths();
    const calls = [];
    let failInstall = true;
    const launchd = await import("./src/launchd.ts");
    mock.module("./src/launchd.ts", () => ({
      ...launchd,
      launchAgentStatus: () => null,
      startLaunchAgent: () => { calls.push("start"); },
      restartLaunchAgent: () => { calls.push("restart"); },
      uninstallLaunchAgent: () => { calls.push("uninstall"); },
      installLaunchAgent: () => { calls.push("install"); if (failInstall) throw new Error("模拟服务启动失败"); },
      startWebUiLaunchAgent: () => { calls.push("write-ui-plist"); }
    }));
    const keychain = await import("./src/keychain.ts");
    mock.module("./src/keychain.ts", () => ({ ...keychain,
      readApiKey: () => "", saveApiKey: () => {}, deleteApiKey: () => {}
    }));
    mock.module("node:child_process", () => ({
      execFileSync: () => { throw new Error("测试禁止执行系统命令"); }
    }));
    const { runCli } = await import("./src/cli.ts");
    const printed = [];
    console.log = (value) => printed.push(String(value));
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/healthz")) throw Object.assign(new Error("测试网关未启动"), { code: "ECONNREFUSED" });
      throw new Error("测试禁止未模拟的网络请求");
    };
    const configFor = (root) => ({
      configVersion: GATEWAY_CONFIG_VERSION, host: "127.0.0.1", port: 8399,
      mountPath: "/v1", prefix: "cliproxy/", officialBaseUrl: "https://official.invalid/v1",
      upstreamBaseUrl: "http://127.0.0.1:8317/v1", catalogPath: path.join(root, "catalog.json"),
      zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false, debug: false
    });
    for (const root of [rootA, rootB]) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(configFor(root)));
    }
  `;
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", setup + scenario], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, HOME: home, CODEX_HOME: undefined,
        CODEX_CLIPROXY_HOME: path.join(home, "instance-a"), CODEX_CLIPROXY_UI_SERVICE: undefined },
      timeout: 50_000,
      stdout: "pipe", stderr: "pipe",
    });
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("serve 失败后连续配置调用仍修改当前环境的实例，且不触碰服务", { timeout: 60_000 }, () => {
  isolatedScenario(`
    await assert.rejects(runCli(["serve", "--config", path.join(rootB, "missing.json")]), /Gateway config not found/);
    await runCli(["config", "--debug", "on"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootA, "config.json"))).debug, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootB, "config.json"))).debug, false);
    assert.deepEqual(calls, []);
  `);
});

test("模型排除命令使用当前实例配置和审计，不修改另一实例或默认服务", { timeout: 60_000 }, () => {
  isolatedScenario(`
    await assert.rejects(runCli(["serve", "--config", path.join(rootB, "missing.json")]), /Gateway config not found/);
    await runCli(["models", "--exclude", "agy/hidden-model"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rootA, "config.json"))).excludedModels, ["agy/hidden-model"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootB, "config.json"))).excludedModels, undefined);
    assert.match(fs.readFileSync(pathsA.stdoutLog, "utf8"), /models --exclude/);
    assert.deepEqual(calls, []);
  `);
});

test("status 与 web 拒绝异实例健康响应，不能启动服务或打开其他实例 UI", { timeout: 60_000 }, () => {
  isolatedScenario(`
    fs.writeFileSync(pathsA.stateFile, JSON.stringify({ codexConfigManaged: false, codexHome: codexA, config: configFor(rootA) }));
    globalThis.fetch = async () => Response.json({ ok: true }, { headers: { "x-ccp-instance": instanceMarker(rootB) } });
    await runCli(["status"]);
    assert.notEqual(JSON.parse(printed.at(-1)).health, "ok");
    await assert.rejects(runCli(["web", "--daemon"]), /different codex-cliproxy instance/);
    assert.deepEqual(calls, []);
  `);
});

test("web 拒绝已占用 UI 端口的异实例，不能改写 plist 或打开浏览器", { timeout: 60_000 }, () => {
  isolatedScenario(`
    fs.writeFileSync(pathsA.stateFile, JSON.stringify({ codexConfigManaged: false, codexHome: codexA, config: configFor(rootA) }));
    globalThis.fetch = async (url) => Response.json({ ok: true }, {
      headers: { "x-ccp-instance": instanceMarker(String(url).endsWith("/healthz") ? rootA : rootB) }
    });
    await assert.rejects(runCli(["web", "--daemon"]), /different codex-cliproxy instance/);
    assert.deepEqual(calls, []);
  `);
});

test("卸载恢复安装记录的独立客户端目录，省略 CODEX_HOME 也不修改默认配置", { timeout: 60_000 }, () => {
  isolatedScenario(`
    fs.mkdirSync(codexA, { recursive: true });
    fs.mkdirSync(pathsA.codexHome, { recursive: true });
    const original = 'openai_base_url = "https://original-a.invalid/v1"\\n';
    const installed = 'openai_base_url = "http://instance-a.invalid/v1"\\n';
    const defaultConfig = 'openai_base_url = "http://default.invalid/v1"\\ncustom = true\\n';
    const backup = path.join(codexA, "config.toml.bak-cliproxy-gateway-20261009000000");
    fs.writeFileSync(backup, original);
    fs.writeFileSync(path.join(codexA, "config.toml"), installed);
    fs.writeFileSync(pathsA.configToml, defaultConfig);
    fs.writeFileSync(pathsA.stateFile, JSON.stringify({
      codexHome: codexA, codexConfigManaged: true, config: configFor(rootA),
      configBackup: { existed: true, backup }, installedConfigHash: "different-hash"
    }));
    await runCli(["uninstall"]);
    assert.equal(fs.readFileSync(pathsA.configToml, "utf8"), defaultConfig);
    assert.equal(fs.readFileSync(path.join(codexA, "config.toml"), "utf8"), original);
    assert.deepEqual(calls, ["uninstall", "uninstall"]);
  `);
});

test("网关健康身份固定在构造时的上下文，后续异实例调用不会更换标记", { timeout: 60_000 }, () => {
  isolatedScenario(`
    const { createGatewayHandler } = await import("./src/gateway.ts");
    const pathsB = resolvePaths({ HOME: base, CODEX_CLIPROXY_HOME: rootB });
    const handler = runWithInstancePaths(pathsA, () => createGatewayHandler(configFor(rootA), ""));
    try {
      const response = await runWithInstancePaths(pathsB, () => handler(new Request("http://127.0.0.1:8399/healthz")));
      assert.equal(response.headers.get("x-ccp-instance"), instanceMarker(rootA));
    } finally { handler.close(); }
  `);
});

test("显式将 CODEX_HOME 设置为默认目录仍在安装写入前拒绝", { timeout: 60_000 }, () => {
  isolatedScenario(`
    process.env.CODEX_HOME = pathsA.codexHome;
    await assert.rejects(runCli(["install", "--port", "invalid-port"]), /distinct CODEX_HOME/);
    assert.equal(fs.existsSync(pathsA.codexHome), false);
    assert.deepEqual(calls, []);
  `);
});

test("托管切手动中断后卸载释放自己的遗留归属，保留客户端配置", { timeout: 60_000 }, () => {
  isolatedScenario(`
    const { claimCodexHome } = await import("./src/codex-ownership.ts");
    const clientPaths = resolvePaths({ HOME: base, CODEX_HOME: codexA, CODEX_CLIPROXY_HOME: rootA });
    claimCodexHome(clientPaths);
    const content = 'custom_setting = "manual"\\n';
    fs.writeFileSync(clientPaths.configToml, content);
    fs.writeFileSync(pathsA.stateFile, JSON.stringify({ codexConfigManaged: false, codexHome: codexA }));
    await runCli(["uninstall"]);
    assert.equal(fs.readFileSync(clientPaths.configToml, "utf8"), content);
    assert.equal(fs.existsSync(path.join(codexA, ".codex-cliproxy-owner.json")), false);
  `);
});

test("客户端恢复后的卸载重试不再修改已交给另一实例的配置或归属", { timeout: 60_000 }, () => {
  isolatedScenario(`
    const { claimCodexHome } = await import("./src/codex-ownership.ts");
    const pathsB = resolvePaths({ HOME: base, CODEX_HOME: codexA, CODEX_CLIPROXY_HOME: rootB });
    claimCodexHome(pathsB);
    const content = 'openai_base_url = "http://instance-b.invalid/v1"\\n';
    fs.writeFileSync(pathsB.configToml, content);
    fs.writeFileSync(pathsA.stateFile, JSON.stringify({
      codexConfigManaged: true, codexHome: codexA, uninstallClientRestored: true
    }));
    await assert.rejects(runCli(["restart"]), /uninstall is unfinished/);
    await runCli(["uninstall"]);
    assert.equal(fs.readFileSync(pathsB.configToml, "utf8"), content);
    assert.equal(JSON.parse(fs.readFileSync(path.join(codexA, ".codex-cliproxy-owner.json"))).runtimeHome, rootB);
    assert.equal(fs.existsSync(pathsA.stateFile), false);
  `);
});

test("服务安装失败恢复客户端配置并撤销本次归属声明", { timeout: 60_000 }, () => {
  isolatedScenario(`
    process.env.CODEX_HOME = codexA;
    process.env.TEST_UPSTREAM_KEY = "test-placeholder-key";
    process.argv[1] = path.join(base, "entry.ts");
    fs.writeFileSync(process.argv[1], "");
    fs.mkdirSync(codexA);
    const original = 'openai_base_url = "https://original.invalid/v1"\\n';
    fs.writeFileSync(path.join(codexA, "config.toml"), original);
    await assert.rejects(runCli(["install", "--select", "none", "--key-env", "TEST_UPSTREAM_KEY"]), /模拟服务启动失败/);
    assert.equal(fs.readFileSync(path.join(codexA, "config.toml"), "utf8"), original);
    assert.equal(fs.existsSync(path.join(codexA, ".codex-cliproxy-owner.json")), false);
    assert.equal(fs.existsSync(pathsA.stateFile), false);
    assert.ok(calls.includes("install"));
  `);
});

test("成功手动安装回收转换或卸载中断留下的自身声明，不改客户端配置", { timeout: 60_000 }, () => {
  for (const priorFlags of [
    { codexConfigManaged: false },
    { codexConfigManaged: true, uninstallClientRestored: true },
  ]) {
    isolatedScenario(`
      const { claimCodexHome } = await import("./src/codex-ownership.ts");
      const clientPaths = resolvePaths({ HOME: base, CODEX_HOME: codexA, CODEX_CLIPROXY_HOME: rootA });
      claimCodexHome(clientPaths);
      const content = 'custom_setting = "manual"\\n';
      fs.writeFileSync(clientPaths.configToml, content);
      fs.writeFileSync(pathsA.stateFile, JSON.stringify({ codexHome: codexA, ...${JSON.stringify(priorFlags)} }));
      process.argv[1] = path.join(base, "entry.ts");
      fs.writeFileSync(process.argv[1], "");
      process.env.TEST_UPSTREAM_KEY = "test-placeholder-key";
      failInstall = false;
      globalThis.fetch = async () => Response.json({ ok: true }, { headers: { "x-ccp-instance": instanceMarker(rootA) } });
      await runCli(["install", "--yes", "--manual-codex-config", "--select", "none", "--key-env", "TEST_UPSTREAM_KEY"]);
      assert.equal(fs.readFileSync(clientPaths.configToml, "utf8"), content);
      assert.equal(fs.existsSync(path.join(codexA, ".codex-cliproxy-owner.json")), false);
      const updatedState = JSON.parse(fs.readFileSync(pathsA.stateFile));
      assert.equal(updatedState.codexConfigManaged, false);
      assert.equal(updatedState.uninstallClientRestored, undefined);
    `);
  }
});
