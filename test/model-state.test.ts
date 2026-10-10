import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolvePaths } from "../src/paths.ts";
import type { AgyDependencies } from "../src/agy/index.ts";
import {
  applyModelCatalogToml,
  codexCatalogFile,
  collectAdapterModels,
  rebuildStaticCatalog,
  updateCodexModelCatalog,
  writeStaticCatalog,
} from "../src/model-state.ts";
import type { GatewayConfig, ResolvedPaths } from "../src/types.ts";

const TIMEOUT = { timeout: 60_000 };
const hash = (source: string): string => createHash("sha256").update(source).digest("hex");

async function fixture(run: (paths: ResolvedPaths, config: GatewayConfig) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "model-state-"));
  const paths = resolvePaths({ HOME: home, CODEX_HOME: path.join(home, "codex") });
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://upstream.invalid/v1",
    catalogPath: paths.catalogFile, upstreamOnly: true,
  };
  fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [{ slug: "gpt-test", priority: 3, description: "原始元数据" }] }));
  try { await run(paths, config); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function agyDependencies(paths: ResolvedPaths, fetchCatalog: AgyDependencies["fetch"]): AgyDependencies {
  return {
    cacheDirectory: paths.runtimeHome,
    credentials: async () => ({ accessToken: "fake-test-token", expiryMs: Date.now() + 3_600_000, identity: "fixture", authMethod: "consumer" }),
    fetch: fetchCatalog,
    setInterval: (() => { throw new Error("禁止创建后台计时器"); }) as typeof setInterval,
    refreshCatalogOnStart: false,
    catalogMode: "manual",
  };
}

test("静态目录合并裸上游与 agent，排除规则只作用于本地模型且保留元数据", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    config.excludedModels = ["gpt-test", "agy/hidden"];
    const upstreamSource = fs.readFileSync(config.catalogPath, "utf8");
    const kept = { slug: "agy/visible", priority: 7, base_instructions: "原始提示词", supported_reasoning_levels: [{ effort: "high" }] };
    const catalog = writeStaticCatalog(paths, config, [kept, { slug: "agy/hidden" }]);
    assert.deepEqual(catalog.models.map((entry) => entry.slug), ["gpt-test", "agy/visible"]);
    assert.deepEqual(catalog.models[1], kept);
    assert.equal(fs.readFileSync(config.catalogPath, "utf8"), upstreamSource);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), catalog);
  });
});

test("重复或空静态目录拒绝覆盖 last-good，空上游允许仅 agent 目录", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const good = writeStaticCatalog(paths, config, []);
    const goodSource = fs.readFileSync(codexCatalogFile(paths), "utf8");
    assert.throws(() => writeStaticCatalog(paths, config, [{ slug: "gpt-test" }]), /重复 ID/);
    assert.equal(fs.readFileSync(codexCatalogFile(paths), "utf8"), goodSource);
    fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [] }));
    assert.throws(() => writeStaticCatalog(paths, config, []), /静态模型目录为空/);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), good);
    assert.deepEqual(writeStaticCatalog(paths, config, [{ slug: "agy/only" }]).models, [{ slug: "agy/only" }]);
  });
});

test("临时 agent 默认只读目录，显式刷新一次且不启动模型心跳", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    config.agy = true;
    let requests = 0;
    const dependencies = agyDependencies(paths, async () => {
      requests += 1;
      return Response.json({ models: { "gemini-test": { displayName: "测试", supportsThinking: true } } });
    });
    const first = await collectAdapterModels(config, { agy: dependencies }, { refresh: true });
    assert.deepEqual(first.failures, []);
    assert.equal(requests, 1);
    assert.deepEqual(first.entries.map((entry) => entry.slug), ["agy/gemini-test"]);
    const second = await collectAdapterModels(config, { agy: dependencies });
    assert.equal(requests, 1);
    assert.deepEqual(second, first);
    const staticCatalog = await rebuildStaticCatalog(paths, config, { agy: dependencies });
    assert.deepEqual(staticCatalog.models.map((entry) => entry.slug), ["gpt-test", "agy/gemini-test"]);
    assert.equal(requests, 1);
  });
});

test("agent 刷新失败且没有 last-good 时不发布部分静态目录，也不泄露错误正文", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const previous = writeStaticCatalog(paths, config, []);
    config.agy = true;
    const deps = { agy: agyDependencies(paths, async () => { throw new Error("sensitive-upstream-token"); }) };
    const result = await collectAdapterModels(config, deps, { refresh: true });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures.join("").includes("sensitive"), false);
    await assert.rejects(rebuildStaticCatalog(paths, config, deps, { refreshAdapters: true }), /Antigravity 模型目录不可用/);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), previous);
  });
});

test("受管模式更新 TOML 与匹配的安装哈希，退出模式只移除目录键", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const original = "model = \"gpt-test\"\n[custom]\nvalue = 7\n";
    fs.writeFileSync(paths.configToml, original);
    fs.writeFileSync(paths.stateFile, JSON.stringify({ installedConfigHash: hash(original), version: 1 }));
    const first = await updateCodexModelCatalog(paths, config);
    assert.equal(first.manual, false);
    assert.equal(first.tomlChanged, true);
    assert.equal(first.count, 1);
    const patched = fs.readFileSync(paths.configToml, "utf8");
    assert.ok(patched.includes(`model_catalog_json = ${JSON.stringify(codexCatalogFile(paths))}`));
    assert.ok(patched.includes("[custom]\nvalue = 7"));
    assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).installedConfigHash, hash(patched));
    config.upstreamOnly = false;
    await updateCodexModelCatalog(paths, config);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), original);
    assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).installedConfigHash, hash(original));
  });
});

test("用户改过 TOML 后不覆盖安装哈希，手动配置不改任何用户 TOML", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    fs.writeFileSync(paths.configToml, "model = \"user-model\"\n");
    fs.writeFileSync(paths.stateFile, JSON.stringify({ installedConfigHash: "user-changed" }));
    await updateCodexModelCatalog(paths, config);
    assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).installedConfigHash, "user-changed");
    const manualToml = "model_catalog_json = \"/user/owned/catalog.json\"\n";
    fs.writeFileSync(paths.configToml, manualToml);
    const state = JSON.stringify({ codexConfigManaged: false, installedConfigHash: "user-changed" });
    fs.writeFileSync(paths.stateFile, state);
    const result = await updateCodexModelCatalog(paths, config);
    assert.equal(result.manual, true);
    assert.equal(result.tomlChanged, false);
    assert.equal(result.count, 1);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), manualToml);
    assert.equal(fs.readFileSync(paths.stateFile, "utf8"), state);
    config.upstreamOnly = false;
    await updateCodexModelCatalog(paths, config);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), manualToml);
  });
});

test("非受管或不可解析的目录键在刷新前拒绝，受管旧目录可迁移", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    config.agy = true;
    let requests = 0;
    const deps = { agy: agyDependencies(paths, async () => { requests += 1; throw new Error("禁止请求"); }) };
    fs.writeFileSync(paths.configToml, "model_catalog_json = \"/user/catalog.json\"\n");
    await assert.rejects(updateCodexModelCatalog(paths, config, deps, { refreshAdapters: true }), /unmanaged/);
    assert.equal(requests, 0);
    assert.equal(fs.existsSync(codexCatalogFile(paths)), false);
    const invalid = "model_catalog_json = \"\"\"unparseable\"\"\"\n";
    assert.throws(() => applyModelCatalogToml(invalid, false, paths, codexCatalogFile(paths)), /cannot be parsed/);
    const source = `model_catalog_json = ${JSON.stringify(paths.catalogFile)}\n`;
    const migrated = applyModelCatalogToml(source, true, paths, codexCatalogFile(paths));
    assert.equal(migrated.previousCatalog, paths.catalogFile);
    assert.equal(migrated.patchedToml, `model_catalog_json = ${JSON.stringify(codexCatalogFile(paths))}\n`);
  });
});

test("异步刷新期间用户修改 TOML 时保留用户修改并恢复已有静态目录", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const previous = writeStaticCatalog(paths, config, []);
    const original = "model = \"before\"\n";
    const userEdit = "model = \"user-edit-during-refresh\"\n";
    fs.writeFileSync(paths.configToml, original);
    config.agy = true;
    const deps = { agy: agyDependencies(paths, async () => {
      fs.writeFileSync(paths.configToml, userEdit);
      return Response.json({ models: { "gemini-test": { displayName: "测试" } } });
    }) };
    await assert.rejects(updateCodexModelCatalog(paths, config, deps, { refreshAdapters: true }), /Codex 配置发生变化/);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), userEdit);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), previous);
  });
});

test("动态模式的显式更新刷新 agent 一次但不生成静态目录", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    config.upstreamOnly = false;
    config.agy = true;
    let requests = 0;
    const deps = { agy: agyDependencies(paths, async () => {
      requests += 1;
      return Response.json({ models: { "gemini-test": { displayName: "测试" } } });
    }) };
    const result = await updateCodexModelCatalog(paths, config, deps, { refreshAdapters: true });
    assert.equal(requests, 1);
    assert.equal(result.count, 1);
    assert.equal(fs.existsSync(codexCatalogFile(paths)), false);
    assert.equal(fs.existsSync(paths.configToml), false);
    const failure = { agy: agyDependencies(paths, async () => { throw new Error("private-failure"); }) };
    // 换账号后原账号缓存不可复用，真实拉取失败必须报告。
    failure.agy.credentials = async () => ({ accessToken: "fake", expiryMs: Date.now() + 3_600_000, identity: "uncached", authMethod: "consumer" });
    await assert.rejects(updateCodexModelCatalog(paths, config, failure, { refreshAdapters: true }), /Antigravity 模型目录不可用/);
    assert.equal(fs.existsSync(codexCatalogFile(paths)), false);
  });
});

test("目录更新后状态写入失败时回滚静态文件与已经改写的 TOML", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const previous = writeStaticCatalog(paths, config, []);
    const original = "model = \"before\"\n";
    fs.writeFileSync(paths.configToml, original);
    fs.writeFileSync(paths.stateFile, JSON.stringify({ installedConfigHash: hash(original) }));
    config.agy = true;
    const deps = { agy: agyDependencies(paths, async () => {
      fs.writeFileSync(paths.stateFile, "invalid-state-json");
      return Response.json({ models: { "gemini-test": { displayName: "测试" } } });
    }) };
    await assert.rejects(updateCodexModelCatalog(paths, config, deps, { refreshAdapters: true }));
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), original);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), previous);
  });
});
