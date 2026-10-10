import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GATEWAY_CONFIG_VERSION, gatewayConfigWarnings } from "../src/config.ts";
import { syncGatewayConfigFile } from "../src/cli.ts";
import { applyWebUiConfigPatch, readGatewayConfigFile } from "../src/config-update.ts";
import { resolvePaths } from "../src/paths.ts";
import type { GatewayConfig, ResolvedPaths } from "../src/types.ts";

function validConfig(paths: ResolvedPaths): GatewayConfig {
  return {
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1", catalogPath: paths.catalogFile,
  };
}

function withConfigFile(run: (paths: ResolvedPaths) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-qoder-config-"));
  try {
    const paths = resolvePaths({ HOME: home });
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify(validConfig(paths)));
    run(paths);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("Qoder 配置只使用可选布尔开关，发布 schema 声明默认关闭", () => {
  const config = validConfig(resolvePaths({ HOME: "/tmp/codex-qoder-schema" }));
  assert.deepEqual(gatewayConfigWarnings(config), []);
  for (const qoder of [false, true]) {
    assert.deepEqual(gatewayConfigWarnings({ ...config, qoder }), []);
  }
  for (const qoder of [null, {}, { enabled: true }, "true", [], 0]) {
    assert.deepEqual(gatewayConfigWarnings({ ...config, qoder }), ["$.qoder should be boolean"]);
  }
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(import.meta.dir, "../schemas/gateway-config.schema.json"), "utf8",
  ));
  assert.equal(schema.required.includes("qoder"), false);
  assert.equal(schema.properties.qoder.type, "boolean");
  assert.equal(schema.properties.qoder.default, false);
  assert.equal(Object.hasOwn(schema.properties, "qoderRegion"), false);
});

test("Qoder 开关写入配置和状态并记录审计，重复保存不产生变化", () => {
  withConfigFile((paths) => {
    const original = { ...validConfig(paths), selectedModels: ["cliproxy/example"], custom: "preserved" };
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify(original));
    fs.writeFileSync(paths.stateFile, JSON.stringify({ config: original, customState: "preserved" }));
    const enabled = applyWebUiConfigPatch(paths, { qoder: true });
    assert.equal(enabled.config.qoder, true);
    assert.deepEqual(enabled.applied, [{ field: "qoder", before: null, after: true }]);
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(saved.custom, "preserved");
    assert.deepEqual(saved.selectedModels, original.selectedModels);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
    assert.equal(state.config.qoder, true);
    assert.equal(state.customState, "preserved");
    const audit = fs.readFileSync(paths.stdoutLog, "utf8");
    assert.match(audit, /qoder: null -> true/);
    assert.deepEqual(applyWebUiConfigPatch(paths, { qoder: true }).applied, []);
    assert.equal(fs.readFileSync(paths.stdoutLog, "utf8"), audit);
    assert.deepEqual(applyWebUiConfigPatch(paths, { qoder: false }).applied, [
      { field: "qoder", before: true, after: false },
    ]);
    assert.equal(readGatewayConfigFile(paths.gatewayConfig).qoder, false);
  });
});

test("新旧配置同步为缺失 Qoder 开关补齐关闭状态并记录审计", () => {
  for (const configVersion of ["qoder-config-test-old", GATEWAY_CONFIG_VERSION]) {
    withConfigFile((paths) => {
      const config = { ...validConfig(paths), configVersion, customRoot: { keep: true } };
      fs.writeFileSync(paths.gatewayConfig, JSON.stringify(config));
      fs.writeFileSync(paths.stateFile, JSON.stringify({ config, customState: "keep" }));
      syncGatewayConfigFile(paths);
      const synced = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
      const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
      assert.equal(synced.qoder, false);
      assert.equal(synced.configVersion, GATEWAY_CONFIG_VERSION);
      assert.deepEqual(synced.customRoot, { keep: true });
      assert.deepEqual(state.config, synced);
      assert.equal(state.customState, "keep");
      assert.match(fs.readFileSync(paths.stdoutLog, "utf8"), /qoder: null -> false/);
    });
  }
});

test("配置同步保留已启用或关闭的 Qoder 开关", () => {
  for (const configVersion of ["qoder-config-test-old", GATEWAY_CONFIG_VERSION]) {
    for (const qoder of [true, false]) {
      withConfigFile((paths) => {
        fs.writeFileSync(paths.gatewayConfig, JSON.stringify({ ...validConfig(paths), configVersion, qoder }));
        syncGatewayConfigFile(paths);
        assert.equal(readGatewayConfigFile(paths.gatewayConfig).qoder, qoder);
      });
    }
  }
});

test("临时实例保存 Qoder 开关不修改默认状态文件", () => {
  withConfigFile((paths) => {
    const original = JSON.stringify({ config: validConfig(paths) });
    fs.writeFileSync(paths.stateFile, original);
    assert.equal(applyWebUiConfigPatch(paths, { qoder: true }, false).config.qoder, true);
    assert.equal(fs.readFileSync(paths.stateFile, "utf8"), original);
  });
});

test("Qoder 非布尔开关和额外地域选项被拒绝，失败时不写配置、状态及审计", () => {
  withConfigFile((paths) => {
    const config = fs.readFileSync(paths.gatewayConfig, "utf8");
    const state = JSON.stringify({ config: validConfig(paths) });
    fs.writeFileSync(paths.stateFile, state);
    for (const qoder of [null, "on", 1, {}, []]) {
      assert.throws(() => applyWebUiConfigPatch(paths, { qoder }), /qoder expects a boolean/);
    }
    assert.throws(() => applyWebUiConfigPatch(paths, { qoderRegion: "intl" } as never), /Unsupported field: qoderRegion/);
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), config);
    assert.equal(fs.readFileSync(paths.stateFile, "utf8"), state);
    assert.equal(fs.existsSync(paths.stdoutLog), false);
  });
});

test("Qoder 组合校验在 upstream-only 下同样阻止非环回监听启用", () => {
  withConfigFile((paths) => {
    const config = { ...validConfig(paths), host: "0.0.0.0" };
    const original = JSON.stringify(config);
    fs.writeFileSync(paths.gatewayConfig, original);
    assert.throws(() => applyWebUiConfigPatch(paths, { qoder: true }), /环回/);
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), original);
    assert.equal(fs.existsSync(paths.stdoutLog), false);
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify({ ...config, upstreamOnly: true }));
    assert.throws(() => applyWebUiConfigPatch(paths, { qoder: true }), /环回/);
  });
});
