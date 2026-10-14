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

test("旧默认安装迁移整个目录、状态、权限与凭据，保留旧目录并支持回滚", () => fixture((home, legacy) => {
  const codexHome = path.join(home, "custom-codex");
  const paths = resolvePaths({ HOME: home });
  const config = { zcode: false, codebuddyAccount: "person.info", catalogPath: path.join(legacy, "newapi-catalog.json"), logDir: path.join(legacy, "logs"), model_merge_json: "https://example.com/models.json?token=hidden", future: path.join(legacy, "unchanged") };
  json(path.join(legacy, "config.json"), config);
  json(path.join(legacy, "state.json"), { installedAt: "same-install", codexHome, config, configBackup: { existed: true, backup: path.join(codexHome, "config.toml.bak-cliproxy-gateway-20261011010000") } });
  json(path.join(legacy, "newapi-catalog.json"), { models: [{ slug: "model" }] });
  json(path.join(codexHome, ".codex-cliproxy-owner.json"), { runtimeHome: legacy });
  fs.writeFileSync(path.join(legacy, "unmanaged.txt"), "private");
  const binaryDirectory = path.join(legacy, "unknown", "nested");
  fs.mkdirSync(binaryDirectory, { recursive: true });
  fs.chmodSync(path.join(legacy, "unknown"), 0o770);
  fs.chmodSync(binaryDirectory, 0o710);
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28]);
  fs.writeFileSync(path.join(binaryDirectory, "cache.bin"), binary, { mode: 0o640 });
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
  assert.equal(fs.readFileSync(path.join(paths.runtimeHome, "unmanaged.txt"), "utf8"), "private");
  assert.deepEqual(fs.readFileSync(path.join(paths.runtimeHome, "unknown", "nested", "cache.bin")), binary);
  assert.deepEqual(fs.readFileSync(path.join(binaryDirectory, "cache.bin")), binary);
  assert.equal(fs.statSync(paths.runtimeHome).mode & 0o777, 0o750);
  assert.equal(fs.statSync(path.join(paths.runtimeHome, "unknown")).mode & 0o777, 0o770);
  assert.equal(fs.statSync(path.join(paths.runtimeHome, "unknown", "nested")).mode & 0o777, 0o710);
  assert.equal(fs.statSync(path.join(paths.runtimeHome, "unknown", "nested", "cache.bin")).mode & 0o777, 0o640);
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

test("旧默认根目录为外部目录符号链接时跳过，不读取合法或损坏的配置与状态", () => {
  for (const brokenFile of [undefined, "config.json", "state.json"]) fixture((home, legacy) => {
    const paths = resolvePaths({ HOME: home });
    const outside = path.join(home, "external-install");
    fs.renameSync(legacy, outside);
    json(path.join(outside, "config.json"), { zcode: false });
    json(path.join(outside, "state.json"), { installedAt: "external", config: {} });
    if (brokenFile) fs.writeFileSync(path.join(outside, brokenFile), "invalid-json");
    fs.writeFileSync(path.join(outside, "external.txt"), "external-private");
    const before = new Map(fs.readdirSync(outside).map((name) => [name, fs.readFileSync(path.join(outside, name))]));
    fs.symlinkSync(outside, legacy);

    assert.equal(prepareDefaultInstallMigration(paths, { HOME: home }, "linux"), undefined);
    assert.equal(fs.existsSync(paths.runtimeHome), false);
    assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(legacy), outside);
    assert.deepEqual(fs.readdirSync(outside).sort(), [...before.keys()].sort());
    for (const [name, content] of before) assert.deepEqual(fs.readFileSync(path.join(outside, name)), content);
  });
});

test("旧默认根目录为悬空符号链接时跳过并保留原链接", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  const original = path.join(home, "original-install");
  const missing = path.join(home, "missing-external-install");
  fs.renameSync(legacy, original);
  fs.symlinkSync(missing, legacy);

  assert.equal(prepareDefaultInstallMigration(paths, { HOME: home }, "linux"), undefined);
  assert.equal(fs.existsSync(paths.runtimeHome), false);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(legacy), missing);
  assert.equal(fs.statSync(original).isDirectory(), true);
}));

test("准备后旧默认根目录被替换为符号链接时，应用迁移在写入前明确拒绝", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), { qoder: false });
  fs.writeFileSync(path.join(legacy, "original.txt"), "original-install");
  const migration = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!;
  assert.ok(migration);
  const original = path.join(home, "preserved-original-install");
  const outside = path.join(home, "external-install");
  fs.renameSync(legacy, original);
  json(path.join(outside, "config.json"), { zcode: false });
  fs.writeFileSync(path.join(outside, "external.txt"), "external-private");
  fs.symlinkSync(outside, legacy);

  assert.throws(() => migration.apply(), /Migration source is not a directory/);
  assert.equal(fs.existsSync(paths.runtimeHome), false);
  assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(legacy), outside);
  assert.equal(fs.readFileSync(path.join(original, "original.txt"), "utf8"), "original-install");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(original, "config.json"), "utf8")), { qoder: false });
  assert.equal(fs.readFileSync(path.join(outside, "external.txt"), "utf8"), "external-private");
  assert.deepEqual(fs.readdirSync(outside).sort(), ["config.json", "external.txt"]);
}));

test("迁移失败恢复目标文件和归属，损坏凭据不得静默丢失", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), { qoder: false });
  fs.writeFileSync(path.join(legacy, "credentials.json"), "invalid");
  json(paths.gatewayConfig, { zcode: false });
  const configBefore = fs.readFileSync(paths.gatewayConfig);
  fs.writeFileSync(path.join(paths.runtimeHome, "existing.bin"), Buffer.from([0x00, 0xff]), { mode: 0o600 });
  fs.mkdirSync(path.join(legacy, "unknown"));
  fs.writeFileSync(path.join(legacy, "unknown", "cache.bin"), Buffer.from([0x80, 0xfe]));
  const owner = path.join(paths.codexHome, ".codex-cliproxy-owner.json");
  json(owner, { runtimeHome: legacy });
  const ownerBefore = fs.readFileSync(owner);
  assert.throws(() => prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply(), /Credentials file .*corrupted/);
  assert.deepEqual(fs.readFileSync(paths.gatewayConfig), configBefore);
  assert.equal(fs.statSync(paths.gatewayConfig).mode & 0o777, 0o640);
  assert.deepEqual(fs.readFileSync(path.join(paths.runtimeHome, "existing.bin")), Buffer.from([0x00, 0xff]));
  assert.equal(fs.statSync(path.join(paths.runtimeHome, "existing.bin")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(paths.runtimeHome).sort(), ["config.json", "existing.bin"]);
  assert.deepEqual(fs.readFileSync(owner), ownerBefore);
  assert.deepEqual(fs.readFileSync(path.join(legacy, "unknown", "cache.bin")), Buffer.from([0x80, 0xfe]));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacy, "config.json"), "utf8")), { qoder: false });
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

test("目标普通条目为悬空符号链接时迁移成功且回滚保留原链接", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  json(path.join(legacy, "cliproxy-catalog.json"), { models: [] });
  fs.mkdirSync(paths.runtimeHome);
  const target = path.join(paths.runtimeHome, "cliproxy-catalog.json");
  const missing = path.join(home, "user-selected-missing-catalog.json");
  fs.symlinkSync(missing, target);
  const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply();
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(target), missing);
  assert.equal(fs.existsSync(paths.gatewayConfig), true);
  rollback();
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(target), missing);
  assert.equal(fs.existsSync(paths.gatewayConfig), false);
}));

test("目标同名文件、目录和类型冲突均整体保留，不合并旧目录内容", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  fs.mkdirSync(paths.runtimeHome);
  for (const name of ["same-file", "file-to-directory"]) fs.writeFileSync(path.join(legacy, name), "old");
  for (const name of ["same-directory", "directory-to-file"]) {
    fs.mkdirSync(path.join(legacy, name));
    fs.writeFileSync(path.join(legacy, name, "old-only"), "old");
  }
  fs.writeFileSync(path.join(paths.runtimeHome, "same-file"), "new", { mode: 0o600 });
  fs.writeFileSync(path.join(paths.runtimeHome, "directory-to-file"), "new", { mode: 0o640 });
  for (const name of ["same-directory", "file-to-directory"]) {
    fs.mkdirSync(path.join(paths.runtimeHome, name), { mode: 0o700 });
    fs.writeFileSync(path.join(paths.runtimeHome, name, "new-only"), "new");
  }
  const assertPreserved = (): void => {
    assert.equal(fs.readFileSync(path.join(paths.runtimeHome, "same-file"), "utf8"), "new");
    assert.equal(fs.statSync(path.join(paths.runtimeHome, "same-file")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(paths.runtimeHome, "directory-to-file"), "utf8"), "new");
    assert.equal(fs.statSync(path.join(paths.runtimeHome, "directory-to-file")).mode & 0o777, 0o640);
    for (const name of ["same-directory", "file-to-directory"]) {
      assert.deepEqual(fs.readdirSync(path.join(paths.runtimeHome, name)), ["new-only"]);
      assert.equal(fs.readFileSync(path.join(paths.runtimeHome, name, "new-only"), "utf8"), "new");
      assert.equal(fs.statSync(path.join(paths.runtimeHome, name)).mode & 0o777, 0o700);
    }
  };
  const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply();
  assertPreserved();
  rollback();
  assertPreserved();
  assert.equal(fs.readFileSync(path.join(legacy, "same-directory", "old-only"), "utf8"), "old");
}));

test("旧目录普通符号链接静默跳过，包括顶层、嵌套、循环与悬空链接", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  const nested = path.join(legacy, "unknown");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "actual.bin"), Buffer.from([0xff, 0x00]));
  const outside = path.join(home, "outside.txt");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(legacy, "top-link"));
  fs.symlinkSync(nested, path.join(legacy, "top-directory-link"));
  fs.symlinkSync("missing", path.join(legacy, "top-dangling"));
  fs.symlinkSync("top-cycle-b", path.join(legacy, "top-cycle-a"));
  fs.symlinkSync("top-cycle-a", path.join(legacy, "top-cycle-b"));
  fs.symlinkSync("actual.bin", path.join(nested, "nested-link"));
  fs.symlinkSync("missing", path.join(nested, "nested-dangling"));
  fs.symlinkSync(".", path.join(nested, "nested-cycle"));
  const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply();
  for (const name of ["top-link", "top-directory-link", "top-dangling", "top-cycle-a", "top-cycle-b"]) {
    assert.throws(() => fs.lstatSync(path.join(paths.runtimeHome, name)), { code: "ENOENT" });
    assert.equal(fs.lstatSync(path.join(legacy, name)).isSymbolicLink(), true);
  }
  assert.deepEqual(fs.readdirSync(path.join(paths.runtimeHome, "unknown")), ["actual.bin"]);
  assert.deepEqual(fs.readFileSync(path.join(paths.runtimeHome, "unknown", "actual.bin")), Buffer.from([0xff, 0x00]));
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  rollback();
  assert.equal(fs.existsSync(paths.runtimeHome), false);
  assert.equal(fs.lstatSync(path.join(nested, "nested-cycle")).isSymbolicLink(), true);
}));

test("回滚只移除本次复制内容，保留后来产生的顶层日志和嵌套文件", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  fs.mkdirSync(path.join(legacy, "unknown", "nested"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "unknown", "nested", "copied.bin"), Buffer.from([0x80, 0xff]));
  fs.mkdirSync(path.join(legacy, "empty"));
  const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply();
  fs.writeFileSync(path.join(paths.runtimeHome, "gateway.log"), "later log", { mode: 0o600 });
  fs.writeFileSync(path.join(paths.runtimeHome, "unknown", "nested", "later.bin"), Buffer.from([0x00, 0xfe]), { mode: 0o640 });
  rollback();
  assert.equal(fs.readFileSync(path.join(paths.runtimeHome, "gateway.log"), "utf8"), "later log");
  assert.equal(fs.statSync(path.join(paths.runtimeHome, "gateway.log")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(paths.runtimeHome, "unknown", "nested", "later.bin")), Buffer.from([0x00, 0xfe]));
  assert.equal(fs.statSync(path.join(paths.runtimeHome, "unknown", "nested", "later.bin")).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(path.join(paths.runtimeHome, "unknown", "nested")), ["later.bin"]);
  assert.equal(fs.existsSync(path.join(paths.runtimeHome, "empty")), false);
  assert.equal(fs.existsSync(paths.gatewayConfig), false);
  assert.deepEqual(fs.readFileSync(path.join(legacy, "unknown", "nested", "copied.bin")), Buffer.from([0x80, 0xff]));
}));

test("只读源根目录和子目录迁移保留权限，回滚清理复制项并保留后来文件和目录权限", () => {
  for (const preserveLater of [false, true]) fixture((home, legacy) => {
    const paths = resolvePaths({ HOME: home });
    json(path.join(legacy, "config.json"), {});
    const sourceDirectory = path.join(legacy, "unknown");
    const sourceNested = path.join(sourceDirectory, "readonly");
    const targetDirectory = path.join(paths.runtimeHome, "unknown");
    const targetNested = path.join(targetDirectory, "readonly");
    fs.mkdirSync(sourceNested, { recursive: true });
    fs.writeFileSync(path.join(sourceNested, "copied.txt"), "copied", { mode: 0o644 });
    fs.chmodSync(sourceNested, 0o555);
    fs.chmodSync(sourceDirectory, 0o555);
    fs.chmodSync(legacy, 0o555);
    try {
      const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply();
      assert.equal(fs.readFileSync(path.join(targetNested, "copied.txt"), "utf8"), "copied");
      assert.equal(fs.statSync(paths.runtimeHome).mode & 0o777, 0o555);
      assert.equal(fs.statSync(targetDirectory).mode & 0o777, 0o555);
      assert.equal(fs.statSync(targetNested).mode & 0o777, 0o555);
      if (preserveLater) {
        fs.chmodSync(targetNested, 0o755);
        fs.writeFileSync(path.join(targetNested, "later.txt"), "later", { mode: 0o644 });
        fs.chmodSync(targetNested, 0o555);
      }
      rollback();
      assert.equal(fs.readFileSync(path.join(sourceNested, "copied.txt"), "utf8"), "copied");
      assert.equal(fs.statSync(legacy).mode & 0o777, 0o555);
      assert.equal(fs.statSync(sourceDirectory).mode & 0o777, 0o555);
      assert.equal(fs.statSync(sourceNested).mode & 0o777, 0o555);
      if (preserveLater) {
        assert.deepEqual(fs.readdirSync(targetNested), ["later.txt"]);
        assert.equal(fs.readFileSync(path.join(targetNested, "later.txt"), "utf8"), "later");
        assert.equal(fs.statSync(paths.runtimeHome).mode & 0o777, 0o555);
        assert.equal(fs.statSync(targetDirectory).mode & 0o777, 0o555);
        assert.equal(fs.statSync(targetNested).mode & 0o777, 0o555);
        assert.equal(fs.existsSync(paths.gatewayConfig), false);
      } else assert.equal(fs.existsSync(paths.runtimeHome), false);
    } finally {
      // 测试清理前恢复目录写权限，不影响对迁移结果的权限断言。
      for (const directory of [legacy, paths.runtimeHome, sourceDirectory, sourceNested, targetDirectory, targetNested]) {
        if (fs.existsSync(directory)) fs.chmodSync(directory, 0o755);
      }
    }
  });
});

test("只读旧根目录遇到损坏凭据时回滚清理新增目标，保留源内容和权限", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  const sourceDirectory = path.join(legacy, "unknown");
  fs.mkdirSync(sourceDirectory);
  fs.writeFileSync(path.join(sourceDirectory, "copied.txt"), "copied");
  fs.writeFileSync(path.join(legacy, "credentials.json"), "invalid");
  fs.chmodSync(sourceDirectory, 0o555);
  fs.chmodSync(legacy, 0o555);
  try {
    assert.throws(() => prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply(), /Credentials file .*corrupted/);
    assert.equal(fs.existsSync(paths.runtimeHome), false);
    assert.equal(fs.readFileSync(path.join(sourceDirectory, "copied.txt"), "utf8"), "copied");
    assert.equal(fs.readFileSync(path.join(legacy, "credentials.json"), "utf8"), "invalid");
    assert.equal(fs.statSync(legacy).mode & 0o777, 0o555);
    assert.equal(fs.statSync(sourceDirectory).mode & 0o777, 0o555);
  } finally {
    fs.chmodSync(legacy, 0o755);
    fs.chmodSync(sourceDirectory, 0o755);
  }
}));

test("目标已有凭据优先，迁移和回滚保持原始字节与权限", () => fixture((home, legacy) => {
  const paths = resolvePaths({ HOME: home });
  json(path.join(legacy, "config.json"), {});
  const oldStore = createApiKeyStore("linux", path.join(legacy, "credentials.json"));
  oldStore.save("old-fixture-key");
  const newStore = createApiKeyStore("linux", paths.credentialsFile);
  newStore.save("new-fixture-key");
  fs.chmodSync(paths.credentialsFile, 0o640);
  const before = fs.readFileSync(paths.credentialsFile);
  const oldBefore = fs.readFileSync(path.join(legacy, "credentials.json"));
  const rollback = prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply();
  assert.equal(newStore.read(), "new-fixture-key");
  assert.deepEqual(fs.readFileSync(paths.credentialsFile), before);
  assert.equal(fs.statSync(paths.credentialsFile).mode & 0o777, 0o640);
  rollback();
  assert.equal(newStore.read(), "new-fixture-key");
  assert.deepEqual(fs.readFileSync(paths.credentialsFile), before);
  assert.equal(fs.statSync(paths.credentialsFile).mode & 0o777, 0o640);
  assert.deepEqual(fs.readFileSync(path.join(legacy, "credentials.json")), oldBefore);
}));

test("配置、状态和凭据的源或目标符号链接均严格拒绝且保持链接与外部文件", () => {
  for (const name of ["config.json", "state.json", "credentials.json"]) {
    for (const side of ["source", "target"]) {
      for (const dangling of [false, true]) fixture((home, legacy) => {
        const paths = resolvePaths({ HOME: home });
        if (!(name === "config.json" && side === "source")) json(path.join(legacy, "config.json"), {});
        const external = path.join(home, "external.json");
        if (!dangling) {
          if (name === "credentials.json") createApiKeyStore("linux", external).save("external-fixture-key");
          else json(external, {});
        }
        const before = dangling ? undefined : fs.readFileSync(external);
        const link = path.join(side === "source" ? legacy : paths.runtimeHome, name);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(external, link);
        assert.throws(() => prepareDefaultInstallMigration(paths, { HOME: home }, "linux")!.apply(), /regular file/);
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(link), external);
        if (before) assert.deepEqual(fs.readFileSync(external), before);
        else assert.equal(fs.existsSync(external), false);
        if (side === "source") assert.equal(fs.existsSync(paths.runtimeHome), false);
        else assert.deepEqual(fs.readdirSync(paths.runtimeHome), [name]);
      });
    }
  }
});

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
