import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGY_PREFIX,
  agyUpstreamModel,
  buildAgyCatalog,
  createAgyCatalogStore,
  isAgyModel,
  mergeAgyCatalog,
  parseAgyCatalogData,
  resolveAgyFamilyModel,
} from "../src/agy/catalog.ts";
import type { AgyModelFamily } from "../src/agy/catalog.ts";
import { loadAgyCredentials } from "../src/agy/credentials.ts";

const TIMEOUT = { timeout: 30_000 };

function modelsResponse(): Record<string, unknown> {
  return {
    models: {
      "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash", supportsThinking: true, maxTokens: 1_000_000 },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsThinking: true, maxTokens: 1_000_000 },
      "gemini-3.8-flash-image": { displayName: "Gemini 3.8 Flash Image", supportsImages: true },
      "claude-sonnet-4-5": { displayName: "Claude Sonnet 4.5", supportsThinking: true },
    },
    defaultAgentModelId: "gemini-3.8-flash",
    imageGenerationModelIds: ["gemini-3.8-flash-image"],
    deprecatedModelIds: { "gemini-3.5-flash": { newModelId: "gemini-3.8-flash" } },
  };
}

test("agy 目录解析：保留 models、剔除图像/音频模型、还原 deprecated 重定向", TIMEOUT, () => {
  const data = parseAgyCatalogData(modelsResponse());
  assert.deepEqual(data.models.map((model) => model.id), ["gemini-3.8-flash", "gemini-3.8-flash-high", "claude-sonnet-4-5"]);
  assert.equal(data.models[0]!.displayName, "Gemini 3.8 Flash");
  assert.equal(data.models[0]!.supportsThinking, true);
  assert.equal(data.reroute.get("gemini-3.5-flash"), "gemini-3.8-flash");
});

test("agy 目录解析：agent 推荐位与 tiered 模型取并集，tab 专用模型剔除", TIMEOUT, () => {
  const data = parseAgyCatalogData({
    models: {
      "gemini-3.6-flash-high": { displayName: "Gemini 3.6 Flash (High)" },
      "gemini-3.8-flash-tiered": { displayName: "gemini-3.8-flash-tiered" },
      "gemini-pro-agent": { displayName: "Gemini 3.1 Pro (High)" },
      "chat_20706": { displayName: "chat_20706" },
      "tab_jump_flash_lite_preview": { displayName: "tab preview" },
      "gemini-3-flash": { displayName: "Gemini 3 Flash" },
    },
    agentModelSorts: [{ displayName: "Recommended", groups: [{ modelIds: ["gemini-3.6-flash-high", "gemini-pro-agent"] }] }],
    tabModelIds: ["chat_20706", "tab_jump_flash_lite_preview"],
    commandModelIds: ["gemini-3-flash"],
    tieredModelIds: { flash: "gemini-3.8-flash-tiered" },
  });
  // 推荐位在前，tiered 并入；tab 与 command 专用模型不进目录。
  assert.deepEqual(data.models.map((model) => model.id), ["gemini-3.6-flash-high", "gemini-pro-agent", "gemini-3.8-flash-tiered"]);
});

test("agy 目录解析拒绝无效结构", TIMEOUT, () => {
  assert.throws(() => parseAgyCatalogData({}), /models/);
  assert.throws(() => parseAgyCatalogData({ models: {} }), /可用模型为空/);
  assert.throws(() => parseAgyCatalogData({ models: { "bad/id": {} } }), /模型 id 无效/);
});

test("agy 目录合成：agy/ 前缀与显示名一致、能力字段来自 ModelDetails", TIMEOUT, () => {
  const catalog = buildAgyCatalog(parseAgyCatalogData(modelsResponse()));
  const flash = catalog.models[0]!;
  assert.equal(flash.slug, `${AGY_PREFIX}gemini-3.8-flash`);
  assert.equal(flash.display_name, "AGY/Gemini 3.8 Flash");
  assert.equal(flash.prefer_websockets, false);
  assert.equal(flash.supports_reasoning_summaries, true);
  assert.deepEqual(flash.input_modalities, ["text"]);
  assert.equal(flash.context_window, 1_000_000);
  const image = catalog.models.find((entry) => entry.slug === "agy/gemini-3.8-flash-image");
  assert.equal(image, undefined);
});

test("agy 目录内容变化时失效 Codex 的 models 缓存", TIMEOUT, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-store-"));
  try {
    const credentialFile = path.join(directory, "token.json");
    fs.writeFileSync(credentialFile, JSON.stringify({ token: { access_token: "ya29.x", refresh_token: "seed-a", expiry: "2099-01-01T00:00:00Z" } }));
    const credentials = () => Promise.resolve(loadAgyCredentials({ credentialFile }));
    const modelsCache = path.join(directory, "models_cache.json");
    fs.writeFileSync(modelsCache, JSON.stringify({ models: [{ slug: "gpt-5", version: 1 }] }));
    let fetchCount = 0;
    const store = createAgyCatalogStore({
      cacheDirectory: directory,
      credentials,
      codexModelsCacheFile: modelsCache,
      now: () => 0,
      fetchCatalog: async () => {
        fetchCount++;
        return { models: fetchCount === 1
          ? { "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash" } }
          : { "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash" }, "gemini-3.9-pro": { displayName: "Gemini 3.9 Pro" } } };
      },
    });
    await store.refresh();
    assert.equal((await store.catalog()).models.length, 1);
    // 失效语义是回拨 fetched_at 到 2000 年（Codex 视为陈旧并重新拉取）。
    const stale = JSON.parse(fs.readFileSync(modelsCache, "utf8")) as { fetched_at: string };
    assert.equal(stale.fetched_at, "2000-01-01T00:00:00Z", "目录落盘必须失效 models_cache");
    fs.writeFileSync(modelsCache, JSON.stringify({ models: [{ slug: "gpt-5", version: 1 }], fetched_at: "2026-10-06T00:00:00Z" }));
    await store.refresh();
    assert.equal((await store.catalog()).models.length, 2);
    const staleAgain = JSON.parse(fs.readFileSync(modelsCache, "utf8")) as { fetched_at: string };
    assert.equal(staleAgain.fetched_at, "2000-01-01T00:00:00Z", "目录内容变化再次失效 models_cache");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agy 前缀识别与上游模型名解析", TIMEOUT, () => {
  assert.equal(isAgyModel("agy/gemini-3.8-flash"), true);
  assert.equal(isAgyModel("AGY/gemini-3.8-flash"), true);
  assert.equal(isAgyModel("gemini-3.8-flash"), false);
  assert.equal(agyUpstreamModel("agy/gemini-3.8-flash"), "gemini-3.8-flash");
  assert.equal(agyUpstreamModel("agy/"), undefined);
  assert.equal(agyUpstreamModel("agy/a/b"), undefined);
});

test("mergeAgyCatalog 替换 base 中的 agy 条目并整体后置", TIMEOUT, () => {
  const agy = buildAgyCatalog(parseAgyCatalogData(modelsResponse()));
  const merged = mergeAgyCatalog(
    { models: [{ slug: "gpt-5", priority: 5 }, { slug: "agy/stale", priority: 6 }] },
    agy,
  );
  assert.deepEqual(merged.models.map((entry) => entry.slug),
    ["gpt-5", "agy/gemini-3.8-flash", "agy/gemini-3.8-flash-high", "agy/claude-sonnet-4-5"]);
  assert.ok(merged.models[1]!.priority! > 5);
});

function tieredModelsResponse(): Record<string, unknown> {
  return {
    models: {
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsThinking: true, maxTokens: 900_000 },
      "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", supportsThinking: true, maxTokens: 1_000_000 },
      "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", supportsThinking: true, maxTokens: 1_000_000 },
      "gemini-3.7-pro-high": { displayName: "Gemini 3.7 Pro (High)" },
      "gemini-3.7-pro-low": { displayName: "Gemini 3.7 Pro (Low)" },
      "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
    },
    tieredModelIds: {
      flashHigh: "gemini-3.8-flash-high", flashMedium: "gemini-3.8-flash-medium", flashLow: "gemini-3.8-flash-low",
      proHigh: "gemini-3.7-pro-high", proLow: "gemini-3.7-pro-low", oss: "gpt-oss-120b-medium",
    },
  };
}

test("agy 多档位家族合并为一个目录条目，单档位后缀模型保持独立", TIMEOUT, () => {
  const data = parseAgyCatalogData(tieredModelsResponse());
  assert.deepEqual(data.families.map((family) => family.base), ["gemini-3.8-flash", "gemini-3.7-pro"]);
  assert.equal(data.families[0]!.displayName, "Gemini 3.8 Flash");
  const catalog = buildAgyCatalog(data);
  // flash 三档合并为 agy/gemini-3.8-flash；pro 两档合并；单档位的 gpt-oss 不合并。
  assert.deepEqual(catalog.models.map((entry) => entry.slug),
    ["agy/gemini-3.8-flash", "agy/gemini-3.7-pro", "agy/gpt-oss-120b-medium"]);
  const flash = catalog.models[0]!;
  assert.equal(flash.display_name, "AGY/Gemini 3.8 Flash");
  assert.equal(flash.context_window, 1_000_000, "窗口取家族成员最大值");
  assert.match(flash.description!, /reasoning effort/);
  // supported_reasoning_levels 只列家族实际存在的档位：不得出现基底快照的 xhigh/minimal。
  assert.deepEqual((flash.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
    ["low", "medium", "high"]);
  assert.equal(flash.default_reasoning_level, "medium");
  // 上游无搜索通道由布尔关闭；字段本身保留基底值，不删除——缺字段可能让 Codex 弃用整个目录。
  assert.equal(flash.supports_search_tool, false);
  assert.equal(flash.web_search_tool_type, "text_and_image");
  // 无档位后缀的独立条目保留字段但置空档位（不删除字段）。
  const oss = catalog.models[2]!;
  assert.equal(oss.display_name, "AGY/GPT-OSS 120B (Medium)");
  assert.deepEqual((oss.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort), []);
  assert.equal(oss.default_reasoning_level, "medium");
});

test("agy 家族基名与显式无后缀模型冲突时不合并，避免重复 slug", TIMEOUT, () => {
  const data = parseAgyCatalogData({
    models: {
      "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash" },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
      "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
    },
    tieredModelIds: { high: "gemini-3.8-flash-high", low: "gemini-3.8-flash-low" },
  });
  assert.deepEqual(data.families, []);
  assert.deepEqual(buildAgyCatalog(data).models.map((entry) => entry.slug),
    ["agy/gemini-3.8-flash", "agy/gemini-3.8-flash-high", "agy/gemini-3.8-flash-low"]);
});

test("agy 档位按 reasoning effort 解析，缺省 medium、缺档就近回退", TIMEOUT, () => {
  const family: AgyModelFamily = {
    base: "gemini-3.8-flash",
    tiers: { high: "gemini-3.8-flash-high", medium: "gemini-3.8-flash-medium", low: "gemini-3.8-flash-low" },
    displayName: "Gemini 3.8 Flash",
  };
  assert.equal(resolveAgyFamilyModel(family, "high"), "gemini-3.8-flash-high");
  assert.equal(resolveAgyFamilyModel(family, "xhigh"), "gemini-3.8-flash-high");
  assert.equal(resolveAgyFamilyModel(family, "minimal"), "gemini-3.8-flash-low");
  assert.equal(resolveAgyFamilyModel(family, undefined), "gemini-3.8-flash-medium");
  assert.equal(resolveAgyFamilyModel(family, "bogus"), "gemini-3.8-flash-medium");
  const proOnly: AgyModelFamily = {
    base: "gemini-3.7-pro",
    tiers: { high: "gemini-3.7-pro-high", low: "gemini-3.7-pro-low" },
    displayName: "Gemini 3.7 Pro",
  };
  // 无 medium 档的家族：medium 与缺省按「就近偏高」回退到 high。
  assert.equal(resolveAgyFamilyModel(proOnly, "medium"), "gemini-3.7-pro-high");
  assert.equal(resolveAgyFamilyModel(proOnly, undefined), "gemini-3.7-pro-high");
});

test("agy 家族信息随目录缓存落盘，磁盘缓存回退时仍可解析档位", TIMEOUT, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-family-cache-"));
  try {
    const credentialFile = path.join(directory, "token.json");
    fs.writeFileSync(credentialFile, JSON.stringify({ token: { access_token: "ya29.x", refresh_token: "seed-a", expiry: "2099-01-01T00:00:00Z" } }));
    const credentials = () => Promise.resolve(loadAgyCredentials({ credentialFile }));
    const first = createAgyCatalogStore({
      cacheDirectory: directory, credentials, now: () => 0,
      fetchCatalog: async () => tieredModelsResponse(),
    });
    await first.refresh();
    const disk = JSON.parse(fs.readFileSync(path.join(directory, "agy-catalog.json"), "utf8")) as { families: Array<{ base: string }> };
    assert.equal(disk.families.length, 2, "家族必须随缓存落盘");
    // 第二个 store 拉取持续失败：从磁盘缓存回退，家族仍可用于 effort 解析。
    const second = createAgyCatalogStore({
      cacheDirectory: directory, credentials, now: () => 0,
      fetchCatalog: async () => { throw new Error("upstream down"); },
    });
    const { models, families } = await second.catalog();
    assert.deepEqual(models.map((entry) => entry.slug),
      ["agy/gemini-3.8-flash", "agy/gemini-3.7-pro", "agy/gpt-oss-120b-medium"]);
    assert.equal(resolveAgyFamilyModel(families[0]!, "low"), "gemini-3.8-flash-low");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
