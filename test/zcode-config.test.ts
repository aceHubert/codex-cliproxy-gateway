import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncGatewayConfigFile } from "../src/cli.ts";
import { GATEWAY_CONFIG_VERSION, gatewayConfigWarnings, migrateLegacyConfig } from "../src/config.ts";
import { zcodeConfigPresent } from "../src/zcode/config.ts";
import { resolvePaths } from "../src/paths.ts";
import type { GatewayConfig, ResolvedPaths } from "../src/types.ts";

function validConfig(paths: ResolvedPaths): GatewayConfig {
  return {
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
  };
}

function withConfigFile(run: (paths: ResolvedPaths) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-zcode-config-"));
  try {
    const paths = resolvePaths({ HOME: home });
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    run(paths);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("ZCode 配置为可选布尔值，拒绝对象等非法类型", () => {
  const config = validConfig(resolvePaths({ HOME: "/tmp/codex-zcode-schema" }));
  assert.deepEqual(gatewayConfigWarnings(config), []);
  for (const zcode of [false, true]) {
    assert.deepEqual(gatewayConfigWarnings({ ...config, zcode }), []);
  }
  for (const zcode of [null, {}, { enabled: true }, "true", [], 0]) {
    assert.deepEqual(gatewayConfigWarnings({ ...config, zcode }), ["$.zcode should be boolean"]);
  }
});

test("ZCode 发布的 JSON Schema 声明默认关闭且移除旧属性", () => {
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(import.meta.dir, "../schemas/gateway-config.schema.json"), "utf8",
  ));
  assert.equal(schema.required.includes("zcode"), false);
  assert.equal(schema.properties.zcode.type, "boolean");
  assert.equal(schema.properties.zcode.default, false);
  assert.equal(Object.hasOwn(schema.properties, "zai"), false);
});

test("旧配置读取只提取合法 enabled，并优先保留新字段", () => {
  for (const enabled of [true, false]) {
    assert.equal(migrateLegacyConfig({ zai: { enabled } }).zcode, enabled);
    assert.equal(migrateLegacyConfig({ zai: { enabled }, zcode: !enabled }).zcode, !enabled);
  }
  for (const zai of [null, true, {}, { enabled: "true" }, []]) {
    assert.equal(Object.hasOwn(migrateLegacyConfig({ zai }), "zcode"), false);
  }
});

test("新旧版本同步均为缺失 ZCode 配置补齐关闭状态并同步 state", () => {
  for (const configVersion of ["zcode-config-test-old", GATEWAY_CONFIG_VERSION]) {
    withConfigFile((paths) => {
      const config = { ...validConfig(paths), configVersion, customRoot: { keep: true } };
      fs.writeFileSync(paths.gatewayConfig, JSON.stringify(config));
      fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 4, config, customState: "keep" }));
      syncGatewayConfigFile(paths);
      const synced = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
      const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
      assert.equal(synced.zcode, false);
      assert.equal(synced.configVersion, GATEWAY_CONFIG_VERSION);
      assert.deepEqual(synced.customRoot, { keep: true });
      assert.deepEqual(state.config, synced);
      assert.equal(state.customState, "keep");
      assert.deepEqual(gatewayConfigWarnings(synced), []);
      assert.match(fs.readFileSync(paths.stdoutLog, "utf8"), /zcode: null -> false/);
    });
  }
});

test("新旧版本均迁移旧 enabled、清理 zai、保留新值并记录审计", () => {
  for (const configVersion of ["zcode-config-test-old", GATEWAY_CONFIG_VERSION]) {
    for (const enabled of [true, false]) {
      for (const explicit of [undefined, !enabled]) {
        withConfigFile((paths) => {
          const config = {
            ...validConfig(paths), configVersion, zai: { enabled, customField: "legacy" },
            ...(explicit === undefined ? {} : { zcode: explicit }), customRoot: "keep",
          };
          fs.writeFileSync(paths.gatewayConfig, JSON.stringify(config));
          fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 4, config, customState: "keep" }));
          syncGatewayConfigFile(paths);
          const synced = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
          const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
          assert.equal(synced.zcode, explicit ?? enabled);
          assert.equal(Object.hasOwn(synced, "zai"), false);
          assert.equal(synced.customRoot, "keep");
          assert.deepEqual(state.config, synced);
          assert.equal(state.customState, "keep");
          const audit = fs.readFileSync(paths.stdoutLog, "utf8");
          assert.match(audit, /zai -> zcode:/);
          assert.ok(audit.includes(` -> ${explicit ?? enabled}`));
          const contents = fs.readFileSync(paths.gatewayConfig, "utf8");
          syncGatewayConfigFile(paths);
          assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), contents);
          assert.equal(fs.readFileSync(paths.stdoutLog, "utf8"), audit);
        });
      }
    }
  }
});

test("非法旧对象不能迁移为布尔字段，非法新字段保留以供告警", () => {
  for (const extra of [{ zai: { enabled: "true" } }, { zai: { enabled: true }, zcode: { enabled: false } }]) {
    withConfigFile((paths) => {
      fs.writeFileSync(paths.gatewayConfig, JSON.stringify({ ...validConfig(paths), ...extra }));
      syncGatewayConfigFile(paths);
      const synced = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
      assert.equal(Object.hasOwn(synced, "zai"), false);
      assert.deepEqual(synced.zcode, "zcode" in extra ? extra.zcode : false);
      assert.deepEqual(gatewayConfigWarnings(synced), "zcode" in extra ? ["$.zcode should be boolean"] : []);
    });
  }
});

test("zcodeConfigPresent 要求 setting.json 与 config.json 同时存在", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-zcode-present-"));
  try {
    const home = path.join(root, ".zcode");
    assert.equal(zcodeConfigPresent(home), false, "目录不存在视为未配置");
    fs.mkdirSync(home, { recursive: true });
    assert.equal(zcodeConfigPresent(home), false, "空目录视为未配置");
    fs.writeFileSync(path.join(home, "setting.json"), "{}");
    assert.equal(zcodeConfigPresent(home), false, "只有 setting.json 不算就绪");
    fs.writeFileSync(path.join(home, "config.json"), "{}");
    assert.equal(zcodeConfigPresent(home), true, "两个文件齐备即就绪");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("zcodeConfigPresent 认可 v2 布局与 home/v2 混合布局", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-zcode-present-"));
  try {
    const home = path.join(root, ".zcode");
    fs.mkdirSync(path.join(home, "v2"), { recursive: true });
    fs.writeFileSync(path.join(home, "v2", "setting.json"), "{}");
    fs.writeFileSync(path.join(home, "v2", "config.json"), "{}");
    assert.equal(zcodeConfigPresent(home), true, "v2 布局算就绪");
    fs.writeFileSync(path.join(home, "config.json"), "{}");
    fs.rmSync(path.join(home, "v2", "config.json"));
    assert.equal(zcodeConfigPresent(home), true, "setting 在 v2、config 在 home 也算就绪");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
