import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GATEWAY_CONFIG_VERSION, gatewayConfigWarnings } from "../src/config.ts";
import { applyWebUiConfigPatch, readGatewayConfigFile } from "../src/config-update.ts";
import { runCli } from "../src/cli.ts";
import { validateAgyConfig } from "../src/agy/index.ts";
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-config-"));
  try {
    const paths = resolvePaths({ HOME: home });
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify(validConfig(paths)));
    run(paths);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("agy 配置只使用可选布尔开关，发布 schema 声明默认关闭", () => {
  const config = validConfig(resolvePaths({ HOME: "/tmp/codex-agy-schema" }));
  assert.deepEqual(gatewayConfigWarnings(config), []);
  for (const agy of [false, true]) {
    assert.deepEqual(gatewayConfigWarnings({ ...config, agy }), []);
  }
  for (const agy of [null, {}, { enabled: true }, "true", [], 0]) {
    assert.deepEqual(gatewayConfigWarnings({ ...config, agy }), ["$.agy should be boolean"]);
  }
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(import.meta.dir, "../schemas/gateway-config.schema.json"), "utf8",
  ));
  assert.equal(schema.required.includes("agy"), false);
  assert.equal(schema.properties.agy.type, "boolean");
  assert.equal(schema.properties.agy.default, false);
  assert.equal(Object.hasOwn(schema.properties, "agyRegion"), false);
});

test("agy 开关写入配置和状态并记录审计，重复保存不产生变化", () => {
  withConfigFile((paths) => {
    const original = { ...validConfig(paths), selectedModels: ["cliproxy/example"], custom: "preserved" };
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify(original));
    fs.writeFileSync(paths.stateFile, JSON.stringify({ config: original, customState: "preserved" }));
    const enabled = applyWebUiConfigPatch(paths, { agy: true });
    assert.equal(enabled.config.agy, true);
    assert.deepEqual(enabled.applied, [{ field: "agy", before: null, after: true }]);
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(saved.custom, "preserved");
    assert.equal(readGatewayConfigFile(paths.gatewayConfig).agy, true);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
    assert.equal(state.config.agy, true);
    assert.equal(state.customState, "preserved");
    // 同值重复保存：不写盘也不追加审计。
    const again = applyWebUiConfigPatch(paths, { agy: true });
    assert.deepEqual(again.applied, []);
    const disabled = applyWebUiConfigPatch(paths, { agy: false });
    assert.equal(disabled.config.agy, false);
  });
});

test("config 命令接受 --agy 选项（选项白名单含 agy）", async () => {
  // 未安装环境下 --agy 必须通过选项校验：报「未安装」而不是 Unknown option。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-option-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await assert.rejects(runCli(["config", "--agy", "on"]), (error: unknown) =>
      error instanceof Error && !/Unknown option/.test(error.message));
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("agy 开关拒绝非法值与非法组合，保留原配置", () => {
  withConfigFile((paths) => {
    assert.throws(() => applyWebUiConfigPatch(paths, { agy: "yes" as unknown as boolean }), /agy expects a boolean/);
    assert.equal(readGatewayConfigFile(paths.gatewayConfig).agy, undefined);
    // 非环回监听 + agy 组合在写盘前被组合校验挡下。
    const loopback = readGatewayConfigFile(paths.gatewayConfig);
    loopback.host = "0.0.0.0";
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify({ ...loopback, agy: true }));
    assert.throws(() => validateAgyConfig(readGatewayConfigFile(paths.gatewayConfig)), /环回/);
  });
});
