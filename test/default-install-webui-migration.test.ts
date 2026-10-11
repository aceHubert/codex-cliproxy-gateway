import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareManagedWebUiMigration, renderLaunchAgent, renderWebUiAgent, type LaunchctlExecutor } from "../apps/gateway/src/launchd.ts";

function fixture(run: (directory: string) => void): void {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-proxy-webui-migrate-")));
  try { run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function setup(directory: string, logPath?: string, runtimeHome?: string) {
  const legacyRuntimeHome = path.join(directory, ".codex-cliproxy-gateway");
  const options = {
    plistPath: path.join(directory, "codex-cliproxy-webui.plist"),
    gatewayPlistPath: path.join(directory, "codex-cliproxy-gateway.plist"),
    legacyRuntimeHome,
    runtimeHome: path.join(directory, ".agent-proxy-gateway"),
    cliPath: "/opt/agent-proxy/apps/gateway/dist/index.js",
    bunPath: "/opt/new-bun/bin/bun",
  };
  const old = { bunPath: "/opt/old-bun/bin/bun", cliPath: "/opt/old-agent/dist/index.js", codexHome: path.join(directory, ".codex") };
  fs.writeFileSync(options.gatewayPlistPath, renderLaunchAgent({ ...old, configPath: path.join(legacyRuntimeHome, "config.json"), logPath: path.join(legacyRuntimeHome, "gateway.log"), label: "codex-cliproxy-gateway" }));
  fs.writeFileSync(options.plistPath, renderWebUiAgent({ ...old, logPath: logPath ?? path.join(legacyRuntimeHome, "webui.log"), label: "codex-cliproxy-webui", runtimeHome }), { mode: 0o640 });
  return options;
}

test("运行中的受管 Web UI 迁移入口和日志后重载，失败回滚恢复原定义与运行状态", () => fixture((directory) => {
  const options = setup(directory);
  const before = fs.readFileSync(options.plistPath, "utf8");
  const calls: string[][] = [];
  const execute: LaunchctlExecutor = (args) => { calls.push(args); return args[0] === "print" ? "state = running\n" : ""; };
  const rollback = prepareManagedWebUiMigration(options, execute)!();
  const after = fs.readFileSync(options.plistPath, "utf8");
  assert.ok(after.includes(options.cliPath));
  assert.ok(after.includes(options.bunPath));
  assert.ok(after.includes(path.join(options.runtimeHome, "webui.log")));
  assert.ok(!after.includes(path.join(options.legacyRuntimeHome, "webui.log")));
  assert.ok(after.includes("codex-cliproxy-webui"));
  assert.deepEqual(calls.map((args) => args[0]), ["print", "bootout", "bootstrap", "kickstart"]);
  assert.equal(fs.statSync(options.plistPath).mode & 0o777, 0o640);
  assert.equal(fs.readdirSync(directory).filter((name) => name.includes("bak-agent-proxy")).length, 1);
  rollback();
  assert.equal(fs.readFileSync(options.plistPath, "utf8"), before);
  assert.deepEqual(calls.map((args) => args[0]), ["print", "bootout", "bootstrap", "kickstart", "bootout", "bootstrap", "kickstart"]);
}));

test("已加载但停止的 Web UI 仅更新定义，保持停止", () => fixture((directory) => {
  const options = setup(directory);
  const calls: string[][] = [];
  const rollback = prepareManagedWebUiMigration(options, (args) => { calls.push(args); return args[0] === "print" ? "state = not running\n" : ""; })!();
  assert.deepEqual(calls.map((args) => args[0]), ["print", "bootout", "bootstrap"]);
  rollback();
  assert.equal(calls.some((args) => args[0] === "kickstart"), false);
}));

test("未加载的 Web UI 更新磁盘定义，不启动服务", () => fixture((directory) => {
  const options = setup(directory);
  const calls: string[][] = [];
  const rollback = prepareManagedWebUiMigration(options, (args) => { calls.push(args); if (args[0] === "print") throw new Error("not loaded"); return ""; })!();
  assert.deepEqual(calls.map((args) => args[0]), ["print"]);
  rollback();
  assert.deepEqual(calls.map((args) => args[0]), ["print"]);
}));

test("自定义日志保留，显式运行目录和自定义脚本不迁移", () => fixture((directory) => {
  const log = path.join(directory, "custom-ui.log");
  const options = setup(directory, log);
  const rollback = prepareManagedWebUiMigration(options, () => { throw new Error("not loaded"); })!();
  const after = fs.readFileSync(options.plistPath, "utf8");
  assert.ok(after.includes(log));
  assert.ok(after.includes(options.cliPath));
  rollback();
  const explicit = setup(directory, undefined, options.legacyRuntimeHome);
  assert.equal(prepareManagedWebUiMigration(explicit, () => { throw new Error("must not call"); }), undefined);
  setup(directory);
  fs.writeFileSync(options.plistPath, fs.readFileSync(options.plistPath, "utf8").replace("/opt/old-agent/dist/index.js", "/opt/custom/user-launch.sh"));
  assert.equal(prepareManagedWebUiMigration(options, () => { throw new Error("must not call"); }), undefined);
}));

test("Web UI 重载失败时恢复原 plist 并重新启动原服务", () => fixture((directory) => {
  const options = setup(directory);
  const before = fs.readFileSync(options.plistPath, "utf8");
  const calls: string[][] = [];
  let firstBootstrap = true;
  assert.throws(() => prepareManagedWebUiMigration(options, (args) => {
    calls.push(args);
    if (args[0] === "print") return "state = running\n";
    if (args[0] === "bootstrap" && firstBootstrap) { firstBootstrap = false; throw new Error("bootstrap failed"); }
    return "";
  })!(), /bootstrap failed/);
  assert.equal(fs.readFileSync(options.plistPath, "utf8"), before);
  assert.deepEqual(calls.map((args) => args[0]), ["print", "bootout", "bootstrap", "bootout", "bootstrap", "kickstart"]);
}));
