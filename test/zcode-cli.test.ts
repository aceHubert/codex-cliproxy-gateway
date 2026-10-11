import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";
import { runCli } from "../apps/gateway/src/cli.ts";
import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } from "../apps/gateway/src/config.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";

function installedConfig(paths: ReturnType<typeof resolvePaths>) {
  return {
    agy: false, opencodeZen: false,
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

test("config --zcode 忽略过时 prefix 残留并保存开关", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cli-reserved-prefix-"));
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  // 前缀已按上游类型派生：文件残留的 zcode/ 不再与启用 ZCode 冲突，
  // 配置开关可以正常保存，过时 prefix 键由前置同步移除。
  const config = { ...installedConfig(paths), prefix: "zcode/" };
  fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config)}\n`);
  fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, config })}\n`);
  try {
    await runCli(["config", "--zcode", "on"]);
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as Record<string, unknown>;
    assert.equal(saved.zcode, true);
    assert.equal("prefix" in saved, false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
