import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaths } from "../src/paths.ts";
import {
  assertCodexHomeAvailable,
  claimCodexHome,
  releaseCodexHome,
  resolveInstalledCodexPaths,
} from "../src/codex-ownership.ts";

function fixture(run: (home: string) => void): void {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccp-codex-owner-")));
  try { run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function instance(home: string, name: string, codexHome = path.join(home, "client")) {
  return resolvePaths({ HOME: home, CODEX_CLIPROXY_HOME: path.join(home, name), CODEX_HOME: codexHome });
}

function state(file: string, contents: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(contents));
}

test("非默认实例拒绝显式默认客户端目录及其软链别名，手动模式不取得归属", () => fixture((home) => {
  const defaultClient = path.join(home, ".codex");
  fs.mkdirSync(defaultClient);
  fs.symlinkSync(defaultClient, path.join(home, "alias"));
  for (const client of [defaultClient, path.join(home, "alias")]) {
    const paths = instance(home, "A", client);
    assert.throws(() => assertCodexHomeAvailable(paths, false), /distinct CODEX_HOME/);
    assert.doesNotThrow(() => assertCodexHomeAvailable(paths, true));
  }
  assert.deepEqual(fs.readdirSync(defaultClient), []);
}));

test("托管声明禁止 A 与 B 顺序争用，卸载不能删除其他实例声明", () => fixture((home) => {
  const a = instance(home, "A");
  const b = instance(home, "B");
  claimCodexHome(a);
  const file = path.join(a.codexHome, ".codex-cliproxy-owner.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { runtimeHome: a.runtimeHome });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => assertCodexHomeAvailable(b, false), /managed by gateway/);
  assert.throws(() => claimCodexHome(b), /managed by gateway/);
  releaseCodexHome(b);
  assert.ok(fs.existsSync(file));
  releaseCodexHome(a);
  assert.doesNotThrow(() => claimCodexHome(b));
}));

test("安装失败回滚只移除本次新建声明，重复声明的回滚保留原文件", () => fixture((home) => {
  const a = instance(home, "A");
  const file = path.join(a.codexHome, ".codex-cliproxy-owner.json");
  const rollback = claimCodexHome(a);
  const sameOwnerRollback = claimCodexHome(a);
  sameOwnerRollback();
  assert.ok(fs.existsSync(file));
  rollback();
  rollback();
  assert.ok(!fs.existsSync(file));
}));

test("旧声明撤销后重新创建的同实例声明不受旧回滚影响", () => fixture((home) => {
  const a = instance(home, "A");
  const rollback = claimCodexHome(a);
  releaseCodexHome(a);
  claimCodexHome(a);
  rollback();
  assert.ok(fs.existsSync(path.join(a.codexHome, ".codex-cliproxy-owner.json")));
}));

test("同一运行目录与客户端目录的软链别名共享归属", () => fixture((home) => {
  const a = instance(home, "A");
  fs.mkdirSync(a.runtimeHome);
  claimCodexHome(a);
  fs.symlinkSync(a.runtimeHome, path.join(home, "runtime-alias"));
  fs.symlinkSync(a.codexHome, path.join(home, "client-alias"));
  const alias = instance(home, "runtime-alias", path.join(home, "client-alias"));
  assert.doesNotThrow(() => assertCodexHomeAvailable(alias, false));
  claimCodexHome(alias)();
  assert.ok(fs.existsSync(path.join(a.codexHome, ".codex-cliproxy-owner.json")));
}));

test("损坏的归属文件明确报错且不被托管覆盖，手动模式保持只读", () => fixture((home) => {
  const a = instance(home, "A");
  fs.mkdirSync(a.codexHome);
  const file = path.join(a.codexHome, ".codex-cliproxy-owner.json");
  fs.writeFileSync(file, "broken");
  assert.throws(() => claimCodexHome(a), /Cannot read Codex ownership/);
  assert.throws(() => releaseCodexHome(a), /Cannot read Codex ownership/);
  assert.doesNotThrow(() => assertCodexHomeAvailable(a, true));
  assert.equal(fs.readFileSync(file, "utf8"), "broken");
}));

test("安装记录恢复客户端路径，显式不同 CODEX_HOME 拒绝，同根别名允许", () => fixture((home) => {
  const a = instance(home, "A");
  fs.mkdirSync(a.codexHome);
  state(a.stateFile, { codexHome: a.codexHome });
  const noEnv = resolvePaths({ HOME: home, CODEX_CLIPROXY_HOME: a.runtimeHome });
  const restored = resolveInstalledCodexPaths(noEnv, {});
  assert.equal(restored.codexHome, a.codexHome);
  assert.equal(restored.configToml, path.join(a.codexHome, "config.toml"));
  assert.equal(restored.modelsCacheFile, path.join(a.codexHome, "models_cache.json"));
  assert.equal(restored.runtimeHome, a.runtimeHome);
  assert.throws(() => resolveInstalledCodexPaths(noEnv, { CODEX_HOME: path.join(home, "other") }), /does not match/);
  fs.symlinkSync(a.codexHome, path.join(home, "alias"));
  assert.equal(resolveInstalledCodexPaths(noEnv, { CODEX_HOME: path.join(home, "alias") }).codexHome, a.codexHome);
}));

test("旧托管记录从生产备份推导目录，不要求备份文件仍存在", () => fixture((home) => {
  const a = instance(home, "A");
  for (const name of ["config.toml.bak-cliproxy-gateway-20261009183000", "config.toml.20261009183000.backup"]) {
    state(a.stateFile, { configBackup: { backup: path.join(a.codexHome, name) } });
    const noEnv = resolvePaths({ HOME: home, CODEX_CLIPROXY_HOME: a.runtimeHome });
    assert.equal(resolveInstalledCodexPaths(noEnv, {}).codexHome, a.codexHome);
  }
}));

test("无法推导的非默认旧托管记录要求原 CODEX_HOME，拒绝静默使用默认目录", () => fixture((home) => {
  const a = instance(home, "A");
  for (const backup of [undefined, "relative/config.toml.20261009183000.backup", path.join(home, "unrelated.backup")]) {
    state(a.stateFile, { configBackup: { backup } });
    const noEnv = resolvePaths({ HOME: home, CODEX_CLIPROXY_HOME: a.runtimeHome });
    assert.throws(() => resolveInstalledCodexPaths(noEnv, {}), /original CODEX_HOME/);
    assert.equal(resolveInstalledCodexPaths(noEnv, { CODEX_HOME: a.codexHome }).codexHome, a.codexHome);
  }
}));

test("默认旧记录保留默认语义，手动旧记录不通过备份恢复其他客户端", () => fixture((home) => {
  const defaults = resolvePaths({ HOME: home });
  state(defaults.stateFile, {});
  assert.equal(resolveInstalledCodexPaths(defaults, {}).codexHome, path.join(home, ".codex"));
  const a = instance(home, "A");
  state(a.stateFile, { codexConfigManaged: false, configBackup: { backup: path.join(a.codexHome, "config.toml.20261009183000.backup") } });
  const noEnv = resolvePaths({ HOME: home, CODEX_CLIPROXY_HOME: a.runtimeHome });
  assert.equal(resolveInstalledCodexPaths(noEnv, {}).codexHome, path.join(home, ".codex"));
  assert.equal(resolveInstalledCodexPaths(noEnv, { CODEX_HOME: a.codexHome }).codexHome, a.codexHome);
}));

test("新客户端路径展开 HOME 下的 ~ 并拒绝相对目录", () => fixture((home) => {
  const a = instance(home, "A");
  assert.equal(resolveInstalledCodexPaths(a, { CODEX_HOME: " ~/client " }).codexHome, path.join(home, "client"));
  assert.throws(() => resolveInstalledCodexPaths(a, { CODEX_HOME: "relative/client" }), /absolute path/);
}));

test("默认旧托管 state 保留对自定义客户端的原归属", () => fixture((home) => {
  const defaults = resolvePaths({ HOME: home });
  const a = instance(home, "A");
  state(defaults.stateFile, { configBackup: { backup: path.join(a.codexHome, "config.toml.bak-cliproxy-gateway-20261009183000") } });
  assert.throws(() => assertCodexHomeAvailable(a, false), /managed by gateway/);
  state(defaults.stateFile, { codexConfigManaged: false, codexHome: a.codexHome });
  assert.doesNotThrow(() => assertCodexHomeAvailable(a, false));
}));

test("已完成客户端恢复的默认卸载记录不阻止另一实例取得归属", () => fixture((home) => {
  const defaults = resolvePaths({ HOME: home, CODEX_HOME: path.join(home, "client") });
  state(defaults.stateFile, {
    codexHome: defaults.codexHome, codexConfigManaged: true, uninstallClientRestored: true,
  });
  const other = instance(home, "B", defaults.codexHome);
  assert.doesNotThrow(() => claimCodexHome(other));
  assert.equal(JSON.parse(fs.readFileSync(path.join(other.codexHome, ".codex-cliproxy-owner.json"), "utf8")).runtimeHome, other.runtimeHome);
}));

test("标准 LaunchAgent 识别旧实例归属，XML 转义不影响路径判定", () => fixture((home) => {
  const a = instance(home, "A&test", path.join(home, "client&test"));
  const b = instance(home, "B", a.codexHome);
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const escape = (value: string) => value.replaceAll("&", "&amp;");
  fs.writeFileSync(path.join(agents, "codex-cliproxy-gateway-12345678.plist"), `<dict>
    <key>ProgramArguments</key><array><string>bun</string><string>serve</string><string>--config</string><string>${escape(a.gatewayConfig)}</string></array>
    <key>EnvironmentVariables</key><dict><key>CODEX_HOME</key><string>${escape(a.codexHome)}</string></dict></dict>`);
  assert.throws(() => assertCodexHomeAvailable(b, false), /managed by gateway/);
  assert.doesNotThrow(() => assertCodexHomeAvailable(a, false));
  state(a.stateFile, { codexConfigManaged: false });
  assert.doesNotThrow(() => assertCodexHomeAvailable(b, false));
}));
