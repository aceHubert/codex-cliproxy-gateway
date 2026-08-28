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
  await assert.rejects(runCli(["models", "--restart-codex"]), /requires models --sync/);
});

test("CPA-only mode is only accepted with an explicit catalog sync", async () => {
  await assert.rejects(runCli(["models", "--cpa-only"]), /requires models --sync/);
});

test("WebSocket mode requires an explicit catalog sync", async () => {
  await assert.rejects(runCli(["models", "--websocket"]), /requires models --sync/);
  // split 模式的 --websocket 已通过参数校验；隔离 HOME 确认命令止步于未安装错误。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ws-param-matrix-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  try {
    await assert.rejects(runCli(["models", "--sync", "--websocket"]), /Gateway is not installed/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome !== undefined) process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
