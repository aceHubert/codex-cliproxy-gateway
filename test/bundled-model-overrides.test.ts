import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileModelOverrides,
  resolveModelMergeJson,
  syncCatalog,
} from "../apps/gateway/src/catalog.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";
import {
  fetchConfiguredUpstreamCatalog,
  loadModelOverrideRules,
  rebuildCatalog,
} from "../apps/gateway/src/upstream-catalog.ts";
import type { GatewayConfig, ModelCatalog } from "../apps/gateway/src/types.ts";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-model-overrides-"));
  const paths = resolvePaths({ HOME: directory, CODEX_HOME: path.join(directory, ".codex") });
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 0,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid",
    upstreamBaseUrl: "https://upstream.invalid",
    catalogPath: paths.catalogFile,
  };
  return { directory, paths, config, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function readCatalog(file: string): ModelCatalog {
  return JSON.parse(fs.readFileSync(file, "utf8")) as ModelCatalog;
}

test("网关自有模型覆盖规则重建时不生成运行目录副本或缓存", async () => {
  const { paths, config, cleanup } = fixture();
  try {
    assert.equal(await resolveModelMergeJson(paths.modelMergeFile, undefined), undefined);
    const { modelsConfigFile, rules } = await loadModelOverrideRules(paths, config, false);
    assert.equal(modelsConfigFile, undefined);
    assert.ok(rules.length > 0);
    await rebuildCatalog(paths, config, [{ slug: "gpt-5.6-sol", context_window: 1 }], modelsConfigFile);
    const model = readCatalog(paths.catalogFile).models[0]!;
    assert.equal(model.context_window, 272000);
    assert.equal(model.max_context_window, 372000);
    assert.equal(fs.existsSync(paths.modelMergeFile), false);
  } finally {
    cleanup();
  }
});

test("cached model overrides take priority over bundled values and configured downloads", async () => {
  const { paths, config, cleanup } = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("cached overrides must not download"); }) as unknown as typeof fetch;
  try {
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.modelMergeFile, JSON.stringify({ openai: [{ name: "gpt-5.6-sol", context_window: 42 }] }));
    config.model_merge_json = "https://models.invalid/models.json";
    const { modelsConfigFile } = await loadModelOverrideRules(paths, config, false);
    assert.equal(modelsConfigFile, paths.modelMergeFile);
    await rebuildCatalog(paths, config, [{ slug: "gpt-5.6-sol" }], modelsConfigFile);
    assert.equal(readCatalog(paths.catalogFile).models[0]!.context_window, 42);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("model override downloads and explicit refresh preserve cache validation", async () => {
  const { paths, config, cleanup } = fixture();
  const originalFetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "https://models.invalid/models.json");
    downloads += 1;
    return new Response(JSON.stringify({ openai: [{ name: "gpt-5.6-sol", context_window: downloads }] }));
  }) as unknown as typeof fetch;
  try {
    config.model_merge_json = "https://models.invalid/models.json";
    const first = await loadModelOverrideRules(paths, config, false);
    assert.equal(first.modelsConfigFile, paths.modelMergeFile);
    assert.equal(first.rules[0]!.fields.context_window, 1);
    const refreshed = await loadModelOverrideRules(paths, config, true);
    assert.equal(refreshed.rules[0]!.fields.context_window, 2);
    globalThis.fetch = (async () => new Response("{invalid")) as unknown as typeof fetch;
    await assert.rejects(loadModelOverrideRules(paths, config, true), /Invalid model overrides/);
    assert.equal((await loadModelOverrideRules(paths, config, false)).rules[0]!.fields.context_window, 2);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("invalid cached or explicitly supplied model overrides never fall back to bundled data", async () => {
  const { paths, config, cleanup } = fixture();
  try {
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.modelMergeFile, "{invalid");
    await assert.rejects(loadModelOverrideRules(paths, config, false), /Invalid model overrides/);
    await assert.rejects(rebuildCatalog(paths, config, [{ slug: "gpt-5.6-sol" }], paths.modelMergeFile), /Invalid model overrides/);
    await assert.rejects(rebuildCatalog(paths, config, [{ slug: "gpt-5.6-sol" }], path.join(paths.runtimeHome, "missing.json")), /Invalid model overrides/);
    assert.equal(fs.existsSync(paths.catalogFile), false);
  } finally {
    cleanup();
  }
});

test("catalog synchronization accepts precompiled overrides and preserves input models", async () => {
  const { paths, config, cleanup } = fixture();
  try {
    const proxyModels = [{ slug: "custom-model", context_window: 1 }];
    await syncCatalog({
      catalogFile: paths.catalogFile,
      proxyModels,
      overrides: compileModelOverrides({ openai: [{ name: "custom-model", context_window: 128000 }] }),
    });
    assert.equal(readCatalog(paths.catalogFile).models[0]!.context_window, 128000);
    assert.equal(proxyModels[0]!.context_window, 1);
  } finally {
    cleanup();
  }
});

test("newapi catalog synthesis and rebuilding apply bundled model overrides", async () => {
  const { paths, config, cleanup } = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "https://upstream.invalid/models");
    return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
  }) as unknown as typeof fetch;
  try {
    config.upstreamType = "newapi";
    const { catalog, modelsConfigFile } = await fetchConfiguredUpstreamCatalog(paths, config, { readKey: () => "" });
    assert.equal(modelsConfigFile, undefined);
    assert.equal(catalog.models[0]!.context_window, 272000);
    const { catalogFile } = await rebuildCatalog(paths, config, catalog.models, modelsConfigFile);
    assert.equal(readCatalog(catalogFile).models[0]!.max_context_window, 372000);
    assert.equal(fs.existsSync(paths.modelMergeFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("isolated compiled catalog helpers retain bundled overrides without repository resources", async () => {
  const { directory, paths, config, cleanup } = fixture();
  try {
    const build = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../apps/gateway/src/upstream-catalog.ts")],
      target: "bun",
      outdir: path.join(directory, "compiled"),
    });
    assert.equal(build.success, true, build.logs.map(String).join("\n"));
    assert.equal(build.outputs.length, 1);
    const compiled = await import(pathToFileURL(build.outputs[0]!.path).href) as typeof import("../apps/gateway/src/upstream-catalog.ts");
    const { modelsConfigFile } = await compiled.loadModelOverrideRules(paths, config, false);
    await compiled.rebuildCatalog(paths, config, [{ slug: "gpt-5.6-sol" }], modelsConfigFile);
    assert.equal(readCatalog(paths.catalogFile).models[0]!.max_context_window, 372000);
    assert.equal(fs.existsSync(paths.modelMergeFile), false);
    assert.equal(fs.existsSync(path.join(directory, "models.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "compiled", "models.json")), false);
  } finally {
    cleanup();
  }
});
