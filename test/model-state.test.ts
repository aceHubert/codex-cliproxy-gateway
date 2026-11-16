import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyModelCatalogToml,
  codexCatalogFile,
  collectAdapterModels,
  rebuildStaticCatalog,
  updateCodexModelCatalog,
  writeStaticCatalog,
} from "../apps/gateway/src/model-composition.ts";
import { managedCatalogFiles, resolvePaths } from "../apps/gateway/src/paths.ts";
import { readRootTomlString } from "../apps/gateway/src/toml.ts";
import test from "./host-test.ts";
import { routingPluginFamily } from "./plugin-routing-fixture.ts";
import type { AgyDependencies } from "@agent-proxy/agy";
import type { GatewayConfig, ResolvedPaths } from "../apps/gateway/src/types.ts";

const TIMEOUT = { timeout: 60_000 };
const hash = (source: string): string => createHash("sha256").update(source).digest("hex");

async function fixture(run: (paths: ResolvedPaths, config: GatewayConfig) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "model-state-"));
  const paths = resolvePaths({ HOME: home, CODEX_HOME: path.join(home, "codex") });
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const config: GatewayConfig = {
    zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
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
    const upstreamSource = fs.readFileSync(paths.catalogFile, "utf8");
    const kept = { slug: "agy/visible", priority: 7, base_instructions: "原始提示词", supported_reasoning_levels: [{ effort: "high" }] };
    const catalog = writeStaticCatalog(paths, config, [kept, { slug: "agy/hidden" }], (model) => Boolean(routingPluginFamily(model)));
    assert.deepEqual(catalog.models.map((entry) => entry.slug), ["gpt-test", "agy/visible"]);
    assert.deepEqual(catalog.models[1], { ...kept, priority: 2 });
    assert.equal(fs.readFileSync(paths.catalogFile, "utf8"), upstreamSource);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), catalog);
  });
});

test("静态目录按上游在前插件在后的顺序重排连续 priority，避免选择框乱序", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    fs.writeFileSync(paths.catalogFile, JSON.stringify({
      models: [
        { slug: "gpt-a", priority: 1 },
        { slug: "gpt-b", priority: 1043 },
      ],
    }));
    const catalog = writeStaticCatalog(paths, config, [
      { slug: "agy/first", priority: 1 },
      { slug: "agy/second", priority: 0 },
    ]);
    assert.deepEqual(catalog.models.map((entry) => [entry.slug, entry.priority]), [
      ["gpt-a", 1],
      ["gpt-b", 2],
      ["agy/first", 3],
      ["agy/second", 4],
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), catalog);
  });
});

test("重复或空静态目录拒绝覆盖 last-good，空上游允许仅 agent 目录", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const good = writeStaticCatalog(paths, config, []);
    const goodSource = fs.readFileSync(codexCatalogFile(paths), "utf8");
    assert.throws(() => writeStaticCatalog(paths, config, [{ slug: "gpt-test" }]), /重复 ID/);
    assert.equal(fs.readFileSync(codexCatalogFile(paths), "utf8"), goodSource);
    fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [] }));
    assert.throws(() => writeStaticCatalog(paths, config, []), /静态模型目录为空/);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), good);
    assert.deepEqual(writeStaticCatalog(paths, config, [{ slug: "agy/only" }]).models, [{ slug: "agy/only", priority: 1 }]);
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

test("agent 刷新失败且没有缓存时仍发布可用静态目录，警告不泄露错误正文", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    writeStaticCatalog(paths, config, [{ slug: "agy/stale" }]);
    config.agy = true;
    const deps = { agy: agyDependencies(paths, async () => { throw new Error("sensitive-upstream-token"); }) };
    const result = await collectAdapterModels(config, deps, { refresh: true });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures.join("").includes("sensitive"), false);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const catalog = await rebuildStaticCatalog(paths, config, deps, { refreshAdapters: true });
      assert.deepEqual(catalog.models.map((entry) => entry.slug), ["gpt-test"]);
      assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")), catalog);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /WARNING: Antigravity 模型目录不可用/);
      assert.equal(warnings.join("").includes("sensitive-upstream-token"), false);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("codexStaticCatalog 开启时受管写入静态指向，动态模式忽略该开关", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    config.codexStaticCatalog = true;
    const original = 'model = "gpt-test"\n[custom]\nvalue = 7\n';
    fs.writeFileSync(paths.configToml, original);
    fs.writeFileSync(paths.stateFile, JSON.stringify({ installedConfigHash: hash(original), version: 1 }));
    const first = await updateCodexModelCatalog(paths, config);
    assert.equal(first.tomlChanged, true);
    const patched = fs.readFileSync(paths.configToml, "utf8");
    assert.equal(readRootTomlString(patched, "model_catalog_json"), codexCatalogFile(paths));
    assert.ok(patched.includes("[custom]\nvalue = 7"));
    // 动态模式不维护静态目录：开关被忽略，受管指向移除。
    config.upstreamOnly = false;
    await updateCodexModelCatalog(paths, config);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), undefined);
  });
});

test("受管模式更新移除历史目录键并匹配安装哈希，重复更新不再改写 TOML", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const original = `model = "gpt-test"\nmodel_catalog_json = ${JSON.stringify(codexCatalogFile(paths))}\n[custom]\nvalue = 7\n`;
    fs.writeFileSync(paths.configToml, original);
    fs.writeFileSync(paths.stateFile, JSON.stringify({ installedConfigHash: hash(original), version: 1 }));
    const first = await updateCodexModelCatalog(paths, config);
    assert.equal(first.manual, false);
    assert.equal(first.tomlChanged, true);
    assert.equal(first.count, 1);
    const patched = fs.readFileSync(paths.configToml, "utf8");
    assert.equal(readRootTomlString(patched, "model_catalog_json"), undefined);
    assert.ok(patched.includes("model = \"gpt-test\""));
    assert.ok(patched.includes("[custom]\nvalue = 7"));
    assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).installedConfigHash, hash(patched));
    const second = await updateCodexModelCatalog(paths, config);
    assert.equal(second.tomlChanged, false);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), patched);
    assert.equal(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).installedConfigHash, hash(patched));
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

test("非受管或不可解析的目录键在刷新前拒绝，受管旧目录指向被移除", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    config.agy = true;
    let requests = 0;
    const deps = { agy: agyDependencies(paths, async () => { requests += 1; throw new Error("禁止请求"); }) };
    fs.writeFileSync(paths.configToml, "model_catalog_json = \"/user/catalog.json\"\n");
    await assert.rejects(updateCodexModelCatalog(paths, config, deps, { refreshAdapters: true }), /unmanaged/);
    assert.equal(requests, 0);
    assert.equal(fs.existsSync(codexCatalogFile(paths)), false);
    const invalid = "model_catalog_json = \"\"\"unparseable\"\"\"\n";
    assert.throws(() => applyModelCatalogToml(invalid, false, paths, managedCatalogFiles(paths)), /cannot be parsed/);
    const source = `model_catalog_json = ${JSON.stringify(paths.catalogFile)}\n`;
    const migrated = applyModelCatalogToml(source, false, paths, managedCatalogFiles(paths));
    assert.equal(migrated.previousCatalog, paths.catalogFile);
    assert.equal(migrated.patchedToml, "");
  });
});

test("异步刷新期间用户修改 TOML 时保留用户修改并恢复已有静态目录", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const previous = writeStaticCatalog(paths, config, []);
    // 预置历史受管目录键：本次更新要移除它，才会进入改写与并发守卫路径。
    const original = `model = "before"\nmodel_catalog_json = ${JSON.stringify(codexCatalogFile(paths))}\n`;
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
    // 换账号后原账号缓存不可复用，拉取失败只警告，不阻止模型更新。
    failure.agy.credentials = async () => ({ accessToken: "fake", expiryMs: Date.now() + 3_600_000, identity: "uncached", authMethod: "consumer" });
    assert.equal((await updateCodexModelCatalog(paths, config, failure, { refreshAdapters: true })).count, 0);
    assert.equal(fs.existsSync(codexCatalogFile(paths)), false);
  });
});

test("目录更新后状态写入失败时回滚静态文件与已经改写的 TOML", TIMEOUT, async () => {
  await fixture(async (paths, config) => {
    const previous = writeStaticCatalog(paths, config, []);
    // 预置历史受管目录键：移除改写会更新安装哈希，状态解析失败时整体回滚。
    const original = `model = "before"\nmodel_catalog_json = ${JSON.stringify(codexCatalogFile(paths))}\n`;
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
