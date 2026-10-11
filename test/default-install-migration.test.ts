import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_DEFAULTS, agentConfigEnabled, effectiveAgentConfig } from "../apps/gateway/src/config.ts";
import { prepareDefaultInstallMigration } from "../apps/gateway/src/default-install-migration.ts";
import { assertCodexHomeAvailable, claimCodexHome, releaseCodexHome } from "../apps/gateway/src/codex-ownership.ts";
import { renderLaunchAgent } from "../apps/gateway/src/launchd.ts";
import { createApiKeyStore } from "../apps/gateway/src/keychain.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";

function fixture(run: (home: string, legacy: string) => void): void {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-proxy-migration-")));
  const legacy = path.join(home, ".codex-cliproxy-gateway");
  fs.mkdirSync(legacy, { mode: 0o750 });
  try { run(home, legacy); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function json(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o640 });
}

test("五类 agent 缺失开关默认开启，显式 false 与未知字段保留", () => {
  for (const key of Object.keys(AGENT_DEFAULTS) as (keyof typeof AGENT_DEFAULTS)[]) {
    assert.equal(agentConfigEnabled({}, key), true);
    assert.equal(agentConfigEnabled({ [key]: false }, key), false);
    assert.equal(agentConfigEnabled({ [key]: true }, key), true);
  }
  assert.equal(effectiveAgentConfig({ zcode: false, future: { value: 1 } }).zcode, false);
  assert.deepEqual(effectiveAgentConfig({ future: { value: 1 } }).future, { value: 1 });
});

test("旧默认安装迁移白名单地址、状态、缓存、权限与凭据，保留旧目录并支持回滚", () => fixture((home, legacy) => {
  const codexHome = path.join(home, "custom-codex");
  const paths = resolvePaths({ HOME: home });
  const config = { zcode: false, codebuddyAccount: "person.info", catalogPath: path.join(legacy, "newapi-catalog.json"), logDir: path.join(legacy, "logs"), model_merge_json: "https://example.com/models.json?token=hidden", future: path.join(legacy, "unchanged") };
  json(path.join(legacy, "config.json"), config);
  json(path.join(legacy, "state.json"), { installedAt: "same-install", codexHome, config, configBackup: { existed: true, backup: path.join(codexHome, "config.toml.bak-cliproxy-gateway-20261011010000") } });
  json(path.join(legacy, "newapi-catalog.json"), { models: [{ slug: "model" }] });
  json(path.join(codexHome, ".codex-cliproxy-owner.json"), { runtimeHome: legacy });
  fs.writeFileSync(path.join(legacy, "unmanaged.txt"), "private");
  createApiKeyStore("linux", path.join(legacy, "credentials.json")).save("fixture-key");
  const before = fs.readFileSync(path.join(legacy, "config.json"), "utf8");
  const migration = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!;
  assert.equal(migration.paths.codexHome, codexHome);
  assert.equal(fs.existsSync(paths.runtimeHome), false);
  const rollback = migration.apply();
  const migrated = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
  // catalogPath 已过时：迁移不再改写残留值，后续命令的配置同步会移除该键。
  assert.equal(migrated.catalogPath, config.catalogPath);
  // logDir 已过时：迁移不再改写残留值，日志目录固定为新运行主目录的 logs/。
  assert.equal(migrated.logDir, config.logDir);
  assert.equal(migrated.model_merge_json, config.model_merge_json);
  assert.equal(migrated.future, config.future);
  assert.equal(migrated.zcode, false);
  assert.equal(migrated.codebuddyAccount, "person.info");
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).config, migrated);
  assert.equal(fs.statSync(path.join(paths.runtimeHome, "newapi-catalog.json")).mode & 0o777, 0o640);
  assert.equal(createApiKeyStore("linux", paths.credentialsFile).read(), "fixture-key");
  assert.equal(fs.existsSync(path.join(paths.runtimeHome, "unmanaged.txt")), false);
  assert.equal(fs.readFileSync(path.join(legacy, "config.json"), "utf8"), before);
  assertCodexHomeAvailable(migration.paths, false);
  assert.equal(prepareDefaultInstallMigration(migration.paths, { HOME: home }, "linux"), undefined);
  rollback();
  assert.equal(fs.existsSync(paths.runtimeHome), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexHome, ".codex-cliproxy-owner.json"), "utf8")).runtimeHome, legacy);
}));

test("新配置优先、旧配置补缺，回滚恢复新目录原有文件", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), { zcode: true, qoder: false, nested: { old: 1, same: "old" }, catalogPath: "/custom/catalog.json", logDir: "/custom/logs" });
  json(paths.gatewayConfig, { zcode: false, nested: { same: "new" }, extra: 2 });
  const before = fs.readFileSync(paths.gatewayConfig, "utf8");
  const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply();
  const migrated = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
  assert.equal(migrated.zcode, false);
  assert.equal(migrated.qoder, false);
  assert.deepEqual(migrated.nested, { same: "new", old: 1 });
  assert.equal(migrated.catalogPath, "/custom/catalog.json");
  assert.equal(migrated.logDir, "/custom/logs");
  const backups = fs.readdirSync(paths.runtimeHome).filter((name) => name.startsWith("config.json.bak-agent-proxy-migration-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(paths.runtimeHome, backups[0]!), "utf8"), before);
  rollback();
  assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), before);
}));

test("新旧安装状态冲突在任何写入前报错", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "state.json"), { installedAt: "old", config: {} });
  json(paths.stateFile, { installedAt: "new", config: {} });
  assert.throws(() => prepareDefaultInstallMigration(paths, { HOME: home }), /state conflict/);
  assert.equal(fs.existsSync(paths.gatewayConfig), false);
}));

test("环境覆盖包括显式旧默认目录时不触发默认迁移", () => fixture((home, legacy) => {
  json(path.join(legacy, "config.json"), {});
  for (const runtimeHome of [legacy, path.join(home, "instance")]) {
    const env = { HOME: home, CODEX_CLIPROXY_HOME: runtimeHome };
    assert.equal(prepareDefaultInstallMigration(resolvePaths(env), env), undefined);
  }
}));

test("迁移失败恢复目标文件和归属，损坏凭据不得静默丢失", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), { qoder: false });
  fs.writeFileSync(path.join(legacy, "credentials.json"), "invalid");
  assert.throws(() => prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply(), /Credentials file .*corrupted/);
  assert.equal(fs.existsSync(paths.runtimeHome), false);
  assert.equal(fs.readFileSync(path.join(legacy, "credentials.json"), "utf8"), "invalid");
}));

test("手动 TOML 安装迁移保持客户端文件和归属只读", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), { codebuddy: false });
  json(path.join(legacy, "state.json"), { codexConfigManaged: false, config: {} });
  fs.mkdirSync(paths.codexHome);
  fs.writeFileSync(paths.configToml, 'model_catalog_json = "/custom/catalog.json"\n');
  const before = fs.readFileSync(paths.configToml, "utf8");
  const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply();
  assert.equal(fs.readFileSync(paths.configToml, "utf8"), before);
  assert.equal(fs.existsSync(path.join(paths.codexHome, ".codex-cliproxy-owner.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).codexConfigManaged, false);
  rollback();
}));

test("目标受管条目为悬空符号链接时拒绝迁移，回滚保留原链接", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  json(path.join(legacy, "cliproxy-catalog.json"), { models: [] });
  fs.mkdirSync(paths.runtimeHome);
  const target = path.join(paths.runtimeHome, "cliproxy-catalog.json");
  const missing = path.join(home, "user-selected-missing-catalog.json");
  fs.symlinkSync(missing, target);
  assert.throws(() => prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply(), /not a regular file/);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(target), missing);
  assert.equal(fs.existsSync(paths.gatewayConfig), false);
}));

test("旧 config-only 安装保持首次安装语义，完成后记录来源且不再次吸收旧配置", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), { zcode: false, future: "old" });
  fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true });
  fs.writeFileSync(paths.launchAgent, renderLaunchAgent({ bunPath: "/opt/bun", cliPath: "/opt/old/dist/index.js", configPath: path.join(legacy, "config.json"), codexHome: paths.codexHome, logPath: path.join(legacy, "gateway.log"), label: "codex-cliproxy-gateway" }));
  const migration = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!;
  const rollback = migration.apply();
  assert.equal(fs.existsSync(paths.stateFile), false);
  assertCodexHomeAvailable(migration.paths, false);
  claimCodexHome(migration.paths);
  json(paths.stateFile, { installedAt: "actual-new-install", config: { zcode: false }, codexConfigManaged: true });
  migration.complete();
  json(paths.gatewayConfig, { zcode: false });
  assert.equal(prepareDefaultInstallMigration(paths, { HOME: home }, "linux"), undefined);
  assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).future, undefined);
  rollback();
  assert.equal(fs.existsSync(paths.stateFile), false);
  assert.equal(fs.existsSync(path.join(paths.codexHome, ".codex-cliproxy-owner.json")), false);
}));

test("缺失 state 的旧标准服务恢复自定义客户端目录，显式冲突只读报错", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  const codexHome = path.join(home, "old-client");
  json(path.join(legacy, "config.json"), {});
  fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true });
  fs.writeFileSync(paths.launchAgent, renderLaunchAgent({ bunPath: "/opt/bun", cliPath: "/opt/old/dist/index.js", configPath: path.join(legacy, "config.json"), codexHome, logPath: path.join(legacy, "gateway.log"), label: "codex-cliproxy-gateway" }));
  assert.equal(prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.paths.codexHome, codexHome);
  assert.throws(() => prepareDefaultInstallMigration(paths, { HOME: home, CODEX_HOME: path.join(home, "wrong-client") }, "linux"), /does not match the legacy installation/);
  assert.equal(fs.existsSync(paths.runtimeHome), false);
}));

test("旧托管安装切手动先转交归属，成功后释放声明并支持失败恢复", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home, CODEX_HOME: path.join(home, "managed-client") });
  json(path.join(legacy, "config.json"), {});
  json(path.join(legacy, "state.json"), { codexConfigManaged: true, codexHome: paths.codexHome, config: {} });
  const owner = path.join(paths.codexHome, ".codex-cliproxy-owner.json");
  json(owner, { runtimeHome: legacy });
  const migration = prepareDefaultInstallMigration(paths, { HOME: home }, "linux", undefined, true)!;
  const rollback = migration.apply();
  assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).runtimeHome, paths.runtimeHome);
  releaseCodexHome(migration.paths);
  assert.equal(fs.existsSync(owner), false);
  json(paths.stateFile, { codexConfigManaged: false, codexHome: paths.codexHome, config: {} });
  migration.complete();
  const other = resolvePaths({ HOME: home, CODEX_HOME: paths.codexHome, CODEX_CLIPROXY_HOME: path.join(home, "other-instance") });
  assertCodexHomeAvailable(other, false);
  rollback();
  assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).runtimeHome, legacy);
}));

test("旧 config-only 无 state 但遗留 owner 时，明确手动安装转交并释放真实旧声明", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  const owner = path.join(paths.codexHome, ".codex-cliproxy-owner.json");
  json(owner, { runtimeHome: legacy });
  assert.equal(fs.existsSync(path.join(legacy, "state.json")), false);
  const migration = prepareDefaultInstallMigration(paths, { HOME: home }, "linux", undefined, true)!;
  const rollback = migration.apply();
  assert.equal(fs.existsSync(paths.stateFile), false);
  assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).runtimeHome, paths.runtimeHome);
  releaseCodexHome(migration.paths);
  assert.equal(fs.existsSync(owner), false);
  rollback();
  assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).runtimeHome, legacy);
}));

test("旧 config-only 无 state 且无 owner 时，明确手动安装不补建声明", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  const owner = path.join(paths.codexHome, ".codex-cliproxy-owner.json");
  const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux", undefined, true)!.apply();
  assert.equal(fs.existsSync(owner), false);
  assert.equal(fs.existsSync(paths.stateFile), false);
  rollback();
}));

test("迁移失败逐字节恢复新目录已有二进制日志，并保留旧目录原日志", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  const oldLogs = path.join(legacy, "logs");
  fs.mkdirSync(oldLogs);
  fs.mkdirSync(paths.logDir, { recursive: true });
  const oldLog = path.join(oldLogs, "trace.gz");
  const newLog = path.join(paths.logDir, "trace.gz");
  const oldBytes = Buffer.from([0x1f, 0x8b, 0x08, 0xff, 0xfe, 0x00]);
  const newBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x80, 0xc3, 0x28, 0xff, 0x00]);
  fs.writeFileSync(oldLog, oldBytes, { mode: 0o640 });
  fs.writeFileSync(newLog, newBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(legacy, "credentials.json"), "invalid");
  assert.throws(() => prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply(), /Credentials file .*corrupted/);
  assert.deepEqual(fs.readFileSync(newLog), newBytes);
  assert.deepEqual(fs.readFileSync(oldLog), oldBytes);
  assert.equal(fs.statSync(newLog).mode & 0o777, 0o600);
}));
