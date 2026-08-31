import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isCodexAppServerProcess,
  parseWindowsCommandLine,
  stopCodexAppServers,
} from "../src/app-server.ts";
import { runCli } from "../src/cli.ts";
import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import type { ProcessIdentity } from "../src/app-server.ts";

function appServer(pid: number, overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    pid,
    owner: "501",
    startedAt: "start-1",
    executable: "/Applications/Codex.app/Contents/Resources/codex",
    args: ["codex", "app-server"],
    ...overrides,
  };
}

test("app-server matching accepts only explicit Codex executables and subcommands", () => {
  assert.equal(isCodexAppServerProcess(appServer(1)), true);
  assert.equal(isCodexAppServerProcess(appServer(1, {
    executable: "/opt/codex-aarch64-apple-darwin",
    args: ["codex-aarch64-apple-darwin", "--enable", "feature", "-c", "x=1", "app-server"],
  })), true);
  assert.equal(isCodexAppServerProcess(appServer(1, {
    executable: "C:\\tools\\codex.cmd",
    args: ["codex.cmd", "--profile=work", "app-server"],
  })), true);
  assert.equal(isCodexAppServerProcess(appServer(1, {
    executable: "/Applications/Codex.app/Contents/Resources/codex-code-mode-host",
    args: ["codex-code-mode-host"],
  })), true);
  assert.equal(isCodexAppServerProcess(appServer(1, {
    executable: "/tmp/my-codex-helper",
    args: ["my-codex-helper", "app-server"],
  })), false);
  assert.equal(isCodexAppServerProcess(appServer(1, {
    args: ["codex", "exec", "app-server"],
  })), false);
  assert.equal(isCodexAppServerProcess(appServer(1, {
    args: ["codex", "--unknown", "app-server"],
  })), false);
});

test("Windows command lines preserve quoted executable paths and arguments", () => {
  assert.deepEqual(
    parseWindowsCommandLine('"C:\\Program Files\\Codex\\codex.exe" --config "model=foo bar" app-server'),
    ["C:\\Program Files\\Codex\\codex.exe", "--config", "model=foo bar", "app-server"],
  );
});

test("stop revalidates identity, waits once, and classifies survivors", async () => {
  const first = appServer(10);
  const second = appServer(20);
  const scans = [[first, second], [first, second], [first]];
  const terminated: number[] = [];
  const waits: number[] = [];

  const result = await stopCodexAppServers({
    listProcesses: () => scans.shift()!,
    terminate: (pid) => terminated.push(pid),
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.deepEqual(terminated, [10, 20]);
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(result, {
    scan: "ok",
    results: [
      { pid: 10, status: "surviving" },
      { pid: 20, status: "stopped" },
    ],
  });
});

test("changed process identity is never signaled", async () => {
  const original = appServer(10);
  const changed = appServer(10, { startedAt: "start-2" });
  const scans = [[original], [changed]];
  const terminated: number[] = [];

  const result = await stopCodexAppServers({
    listProcesses: () => scans.shift()!,
    terminate: (pid) => terminated.push(pid),
    wait: async () => undefined,
  });

  assert.deepEqual(terminated, []);
  assert.deepEqual(result, { scan: "ok", results: [{ pid: 10, status: "failed" }] });
});

test("process enumeration failure remains unknown", async () => {
  const result = await stopCodexAppServers({
    listProcesses: () => { throw new Error("denied"); },
    terminate: () => assert.fail("must not terminate"),
    wait: async () => assert.fail("must not wait"),
  });
  assert.deepEqual(result, { scan: "unknown", results: [], error: "denied" });
});

test("restart-codex requires an explicit catalog sync", async () => {
  await assert.rejects(runCli(["models", "--restart-codex"]), /--restart-codex requires models --sync/);
});

test("config.toml-mutating commands accept restart-codex", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "restart-codex-options-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });

  try {
    fs.writeFileSync(paths.stateFile, "{}");
    await assert.rejects(runCli(["install", "--restart-codex"]), /Already installed/);

    fs.rmSync(paths.stateFile);
    await assert.rejects(runCli(["uninstall", "--restart-codex"]), /No managed installation found/);
    await assert.rejects(runCli(["restart", "--restart-codex"]), /Gateway is not installed/);
    await assert.rejects(runCli(["models", "--sync", "--restart-codex"]), /Gateway is not installed/);
    await assert.rejects(runCli(["status", "--restart-codex"]), /Unknown option --restart-codex/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("误改的 codex-restart 参数不再作为别名接受", async () => {
  await assert.rejects(runCli(["models", "--codex-restart"]), /--codex-restart requires a value/);
  for (const command of ["install", "uninstall", "restart", "models"]) {
    await assert.rejects(runCli([command, "--codex-restart", "true"]), /Unknown option --codex-restart/);
  }
});

test("cpa-only switch requires models --sync", async () => {
  await assert.rejects(runCli(["models", "--cpa-only"]), /--cpa-only requires models --sync/);
});

test("unknown options are rejected instead of silently ignored", async () => {
  await assert.rejects(runCli(["models", "--log", "on"]), /Unknown option --log for command "models"/);
  await assert.rejects(runCli(["models", "--sync", "--websocket", "on"]), /Unknown option --websocket for command "models"/);
  await assert.rejects(runCli(["config", "--logg", "on"]), /Unknown option --logg for command "config"/);
  await assert.rejects(runCli(["config", "--cpa-only"]), /Unknown option --cpa-only for command "config"/);
  // 隔离 HOME 确认 config 命令止步于未安装错误，而非参数报错。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "config-command-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  try {
    await assert.rejects(runCli(["config", "--log", "on"]), /Gateway is not installed/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome !== undefined) process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("config writes every requested update while a query stays read-only", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "config-always-reload-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousLog = console.log;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  console.log = () => {};
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: [],
    requestLogging: true,
    maxRequestLogs: 0,
    cpaOnly: false,
    logDir: paths.logDir,
  }));

  try {
    const beforeUpdate = fs.statSync(paths.gatewayConfig).ino;
    await runCli(["config", "--log", "on"]);
    const afterUpdate = fs.statSync(paths.gatewayConfig).ino;
    assert.notEqual(afterUpdate, beforeUpdate, "matching config updates must still rewrite the config");

    await runCli(["config"]);
    assert.equal(
      fs.statSync(paths.gatewayConfig).ino,
      afterUpdate,
      "a config query must not rewrite the config",
    );
  } finally {
    console.log = previousLog;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("websocket and bare select flags no longer exist", async () => {
  await assert.rejects(runCli(["models", "--sync", "--websocket"]), /--websocket requires a value/);
  await assert.rejects(runCli(["models", "--sync", "--select"]), /--select requires a value/);
});
