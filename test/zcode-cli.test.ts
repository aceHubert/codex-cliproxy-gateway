import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";

function installedConfig(paths: ReturnType<typeof resolvePaths>) {
  return {
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: [],
    requestLogging: false,
    maxRequestLogs: 0,
    maxGatewayLogBytes: 0,
    upstreamOnly: false,
    zcode: false,
    codebuddy: false,
    qoder: false,
    logDir: paths.logDir,
  };
}

test("config --zcode 写入状态和审计，且不需要 LaunchAgent", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-"));
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldLog = console.log;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  const config = installedConfig(paths);
  fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config)}\n`);
  fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, config })}\n`);
  const printed: string[] = [];
  console.log = (value?: unknown) => { printed.push(String(value)); };
  try {
    await runCli(["config", "--zcode", "on"]);
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).zcode, true);
    assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).config.zcode, true);
    assert.match(fs.readFileSync(paths.stdoutLog, "utf8"), /zcode: false -> true/);
    assert.match(printed.join("\n"), /LaunchAgent is not installed/);

    await runCli(["config", "--zcode", "off", "--log", "on"]);
    const after = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(after.zcode, false);
    assert.equal(after.requestLogging, true);
    assert.match(fs.readFileSync(paths.stdoutLog, "utf8"), /zcode: true -> false/);

    printed.length = 0;
    const beforeQuery = fs.statSync(paths.gatewayConfig).ino;
    await runCli(["config"]);
    assert.equal(fs.statSync(paths.gatewayConfig).ino, beforeQuery, "config 查询不得重写配置");
    assert.match(printed.join("\n"), /"zcode": false/);
  } finally {
    console.log = oldLog;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("upstream-only 下 zcode 开关正常生效并更新静态目录", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-upstream-only-"));
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldLog = console.log;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  const config = { ...installedConfig(paths), upstreamOnly: true };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [{ slug: "upstream-model" }] }));
  fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config)}\n`);
  fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, config })}\n`);
  const printed: string[] = [];
  console.log = (value?: unknown) => { printed.push(String(value)); };
  try {
    await runCli(["config", "--zcode", "on"]);
    // upstream-only 只影响 default 路由，agent 开关正常保存并生效。
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).zcode, true);
    assert.match(printed.join("\n"), /ZCode compatibility enabled/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.runtimeHome, "codex-catalog.json"), "utf8")).models.map((model: { slug: string }) => model.slug), ["upstream-model"]);

    printed.length = 0;
    await runCli(["config"]);
    const status = JSON.parse(printed.join("\n")) as { zcode: boolean; zcodeConfigured?: boolean };
    assert.equal(status.zcode, true, "状态输出必须报告生效值");
    assert.equal(status.zcodeConfigured, undefined);
  } finally {
    console.log = oldLog;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("config --zcode 显式拒绝缺失、非法和位置参数", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-invalid-"));
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  try {
    await assert.rejects(runCli(["config", "zcode"]), /Unexpected argument: zcode/);
    await assert.rejects(runCli(["config", "zcode", "on"]), /Unexpected argument: zcode/);
    await assert.rejects(runCli(["config", "--zcode", "maybe"]), /expects on or off/);
    await assert.rejects(runCli(["config", "--zcode"]), /--zcode requires a value/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("config --zcode 拒绝会让新进程无法启动的组合，保留原配置", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-reserved-prefix-"));
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  // 保留前缀与启用 ZCode 的组合会被新进程的 validateZcodeConfig 拒绝启动：
  // CLI 必须在写盘与重启之前挡下，否则网关直接不可用。
  const config = { ...installedConfig(paths), prefix: "zcode/" };
  fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config)}\n`);
  fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, config })}\n`);
  try {
    await assert.rejects(runCli(["config", "--zcode", "on"]), /前缀保留给 ZCode/);
    // config 命令的非法组合确实未写入；文件差异只来自命令前置同步的同版本补键
    // （新开关按缺省 false 回填并以格式化 JSON 重写，与 qoder/agy 落地时的行为一致）。
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), `${JSON.stringify({ ...config, agy: false, opencodeZen: false }, null, 2)}\n`);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
