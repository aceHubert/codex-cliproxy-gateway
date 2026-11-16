import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  resolveAgyModel, type AgyModelFamily
} from "@agent-proxy/agy/catalog";
import { loadAgyCredentials } from "@agent-proxy/agy/credentials";
import { AGY_ENDPOINT } from "@agent-proxy/agy/transport";
import test from "./host-test.ts";


const TIMEOUT = { timeout: 30_000 };

test("agy manual 目录查询不拉网络，reload 读取磁盘并校验账号身份", TIMEOUT, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-manual-"));
  let now = 0;
  let fetched = 0;
  let identity = "first-account";
  let id = "gemini-first";
  const options = {
    cacheDirectory: directory,
    catalogMode: "manual" as const,
    now: () => now,
    credentials: async () => ({ accessToken: "fake", expiryMs: Date.now() + 60_000, identity, authMethod: "consumer" as const }),
    fetchCatalog: async () => {
      fetched++;
      return { models: { [id]: { displayName: id } } };
    },
  };
  try {
    const store = createAgyCatalogStore(options);
    await assert.rejects(store.catalog(), /没有可用的本地缓存/);
    assert.equal(fetched, 0);
    await store.refresh();
    now = 24 * 60 * 60 * 1000;
    assert.equal((await store.catalog()).models[0]!.slug, "agy/gemini-first");
    assert.equal(fetched, 1);
    id = "gemini-second";
    await createAgyCatalogStore(options).refresh();
    assert.equal((await store.reload()).models[0]!.slug, "agy/gemini-second");
    assert.equal(fetched, 2);
    identity = "second-account";
    await assert.rejects(store.catalog(), /没有可用的本地缓存/);
    assert.equal(fetched, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

test("agy 目录同步剔除 -disabled 后缀模型，重定向目标同样剔除", TIMEOUT, () => {
  const data = parseAgyCatalogData({
    models: {
      "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash" },
      "gemini-4-argon-disabled": { displayName: "Gemini 4 Argon" },
    },
    agentModelSorts: [{ displayName: "Recommended", groups: [{ modelIds: ["gemini-4-argon-disabled", "gemini-3.8-flash"] }] }],
    deprecatedModelIds: {
      "gemini-3.5-flash": { newModelId: "gemini-3.8-flash" },
      "gemini-3-pro": { newModelId: "gemini-4-argon-disabled" },
    },
  });
  assert.deepEqual(data.models.map((model) => model.id), ["gemini-3.8-flash"], "-disabled 模型不进目录");
  assert.equal(data.reroute.get("gemini-3.5-flash"), "gemini-3.8-flash");
  assert.equal(data.reroute.get("gemini-3-pro"), undefined, "指向 -disabled 模型的重定向一并剔除");
  const catalog = buildAgyCatalog(data);
  assert.deepEqual(catalog.models.map((model) => model.slug), ["agy/gemini-3.8-flash"]);
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
    const credentials = () => Promise.resolve(loadAgyCredentials({ credentialFile, os: "linux" }));
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
  assert.equal(Object.hasOwn(oss, "default_reasoning_level"), false);
});

test("agy 无可选思考级别的模型不声明默认中档或其他占位档位", TIMEOUT, () => {
  const catalog = buildAgyCatalog(parseAgyCatalogData({ models: {
    "gemini-pro-orchestrator-g1-pro": { displayName: "Orchestrator (Argon)", supportsThinking: true },
    "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", supportsThinking: true },
    "no-thinking": { supportsThinking: false },
    "empty-levels": { supportsThinking: true, supportedThinkingLevels: [] },
  } }));
  for (const model of catalog.models) {
    assert.deepEqual(model.supported_reasoning_levels, []);
    assert.equal(Object.hasOwn(model, "default_reasoning_level"), false, String(model.slug));
  }
});

test("agy 四档家族合并 xhigh，目录与请求解析保留最高档", TIMEOUT, () => {
  const tiers = ["low", "medium", "high", "xhigh"] as const;
  const data = parseAgyCatalogData({
    models: Object.fromEntries(tiers.map((tier) => [`gemini-4-hydrogen-${tier}`, {
      displayName: `Gemini 4 Hydrogen (${tier === "xhigh" ? "XHigh" : tier})`, supportsThinking: true,
    }])),
    agentModelSorts: [{ groups: [{ modelIds: ["gemini-4-hydrogen-medium"] }] }],
    tieredModelIds: Object.fromEntries(tiers.map((tier) => [tier, `gemini-4-hydrogen-${tier}`])),
  });
  const catalog = buildAgyCatalog(data);
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["agy/gemini-4-hydrogen"]);
  assert.equal(catalog.models[0]!.display_name, "AGY/Gemini 4 Hydrogen");
  assert.deepEqual((catalog.models[0]!.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort), tiers);
  assert.equal(catalog.models[0]!.default_reasoning_level, "medium");
  for (const tier of tiers) {
    assert.equal(resolveAgyFamilyModel(data.families[0]!, tier), `gemini-4-hydrogen-${tier}`);
  }
  assert.equal(resolveAgyFamilyModel(data.families[0]!, "max"), "gemini-4-hydrogen-medium");
});

test("agy 不支持的档位不生效，使用与目录一致的默认档位", TIMEOUT, () => {
  const data = parseAgyCatalogData({ models: {
    "gemini-4-hydrogen-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)" },
    "gemini-4-hydrogen-low": { displayName: "Gemini 4 Hydrogen (Low)" },
  } });
  const family = data.families[0]!;
  assert.equal(family.displayName, "Gemini 4 Hydrogen");
  assert.equal(resolveAgyFamilyModel(family, "high"), "gemini-4-hydrogen-low");
  assert.equal(resolveAgyFamilyModel(family, "max"), "gemini-4-hydrogen-low");
  assert.equal(resolveAgyFamilyModel(family, undefined), "gemini-4-hydrogen-low");
  assert.equal(buildAgyCatalog(data).models[0]!.default_reasoning_level, "low");
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

test("agy 档位按 reasoning effort 精确解析，缺省或不支持的档位使用默认变体", TIMEOUT, () => {
  const family: AgyModelFamily = {
    base: "gemini-3.8-flash",
    tiers: { high: "gemini-3.8-flash-high", medium: "gemini-3.8-flash-medium", low: "gemini-3.8-flash-low" },
    displayName: "Gemini 3.8 Flash",
  };
  assert.equal(resolveAgyFamilyModel(family, "high"), "gemini-3.8-flash-high");
  assert.equal(resolveAgyFamilyModel(family, "xhigh"), "gemini-3.8-flash-medium");
  assert.equal(resolveAgyFamilyModel(family, "max"), "gemini-3.8-flash-medium");
  assert.equal(resolveAgyFamilyModel(family, "minimal"), "gemini-3.8-flash-low");
  assert.equal(resolveAgyFamilyModel(family, undefined), "gemini-3.8-flash-medium");
  assert.equal(resolveAgyFamilyModel(family, "bogus"), "gemini-3.8-flash-medium");
  for (const effort of ["toString", "constructor", "__proto__"]) {
    assert.equal(resolveAgyFamilyModel(family, effort), "gemini-3.8-flash-medium");
  }
  const proOnly: AgyModelFamily = {
    base: "gemini-3.7-pro",
    tiers: { high: "gemini-3.7-pro-high", low: "gemini-3.7-pro-low" },
    displayName: "Gemini 3.7 Pro",
  };
  // 无 medium 档的家族使用目录首档，不按请求强度寻找邻近档位。
  assert.equal(resolveAgyFamilyModel(proOnly, "medium"), "gemini-3.7-pro-low");
  assert.equal(resolveAgyFamilyModel(proOnly, undefined), "gemini-3.7-pro-low");
});

test("agy max 只选择同名变体，不作为 xhigh 的别名", TIMEOUT, () => {
  const data = parseAgyCatalogData({ models: {
    "gemini-future-medium": { displayName: "Gemini Future (Medium)" },
    "gemini-future-xhigh": { displayName: "Gemini Future (XHigh)" },
    "gemini-future-max": { displayName: "Gemini Future (Max)" },
  } });
  assert.equal(data.families.length, 1);
  assert.equal(resolveAgyFamilyModel(data.families[0]!, "max"), "gemini-future-max");
  assert.equal(resolveAgyFamilyModel(data.families[0]!, "xhigh"), "gemini-future-xhigh");
  const entry = buildAgyCatalog(data).models[0]!;
  assert.equal(entry.display_name, "AGY/Gemini Future");
  assert.deepEqual((entry.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
    ["medium", "xhigh", "max"]);
});

test("agy 目录保存每个家族自己的默认档位，不将 Hydrogen 默认强制为 medium", TIMEOUT, () => {
  const data = parseAgyCatalogData({
    defaultAgentModelId: "gemini-4-hydrogen-high",
    agentModelSorts: [{ groups: [{ modelIds: ["gemini-4-hydrogen-high", "claude-opus-5-5-medium"] }] }],
    groupedModels: {
      "gemini-4-hydrogen": { displayName: "Gemini 4 Hydrogen", supportedThinkingLevels: ["low", "high", "xhigh"].map((thinkingSuffix) => ({ thinkingSuffix })) },
      "claude-opus-5-5": { displayName: "Claude Opus 5.5", supportedThinkingLevels: ["medium", "max"].map((thinkingSuffix) => ({ thinkingSuffix })) },
    },
    models: Object.fromEntries([
      "gemini-4-hydrogen-low", "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh",
      "claude-opus-5-5-medium", "claude-opus-5-5-max",
    ].map((id) => [id, { displayName: id, supportsThinking: true }])),
  });
  const catalog = buildAgyCatalog(data);
  assert.equal(catalog.models.find((model) => model.slug === "agy/gemini-4-hydrogen")!.default_reasoning_level, "high");
  assert.equal(catalog.models.find((model) => model.slug === "agy/claude-opus-5-5")!.default_reasoning_level, "medium");
  assert.deepEqual(resolveAgyModel("gemini-4-hydrogen", undefined, data.reasoning["gemini-4-hydrogen"]), { model: "gemini-4-hydrogen-high" });
  assert.deepEqual(resolveAgyModel("claude-opus-5-5", "max", data.reasoning["claude-opus-5-5"]), { model: "claude-opus-5-5-max" });
});

test("agy 显式档位映射还原不规则 ID，参数能力优先于名字后缀", TIMEOUT, () => {
  const data = parseAgyCatalogData({
    defaultAgentModelId: "custom-deep",
    groupedModels: { custom: { displayName: "Custom", supportedThinkingLevels: [
      { thinkingSuffix: "-fast", thinkingDisplayName: "Low" }, { thinkingSuffix: "-deep", thinkingDisplayName: "XHigh" },
      { thinkingSuffix: "-missing", thinkingDisplayName: "Max" },
    ] } },
    models: {
      "custom-fast": { supportsThinking: true }, "custom-deep": { supportsThinking: true },
      "custom-max": { supportsThinking: true, supportedThinkingLevels: ["LOW", "THINKING_LEVEL_EXTRA_HIGH", "MAX"] },
      orchestrator: { supportsThinking: true, thinkingLevel: "high" },
    },
  });
  assert.deepEqual(resolveAgyModel("custom", "xhigh", data.reasoning.custom), { model: "custom-deep" });
  assert.deepEqual(resolveAgyModel("custom", "max", data.reasoning.custom), { model: "custom-deep" });
  assert.deepEqual(resolveAgyModel("custom-max", "max", data.reasoning["custom-max"]), { model: "custom-max", thinkingLevel: "max" });
  assert.deepEqual(resolveAgyModel("custom-max", "medium", data.reasoning["custom-max"]), { model: "custom-max" });
  assert.deepEqual(resolveAgyModel("orchestrator", "xhigh", data.reasoning.orchestrator), { model: "orchestrator" });
  assert.deepEqual((buildAgyCatalog(data).models.find((model) => model.slug === "agy/custom-max")!.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
    ["low", "xhigh", "max"]);
});

test("agy 参数能力和默认变体经磁盘重载后仍能还原，能力变化使目录缓存失效", TIMEOUT, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-reasoning-cache-"));
  try {
    const options = {
      cacheDirectory: directory, catalogMode: "manual" as const,
      credentials: async () => ({ accessToken: "fake", expiryMs: Date.now() + 60_000, identity: "account", authMethod: "consumer" as const }),
      fetchCatalog: async () => ({
        defaultAgentModelId: "hydrogen-high",
        models: { "hydrogen-low": {}, "hydrogen-high": {}, parameter: { supportsThinking: true, supportedThinkingLevels: ["low", "max"] } },
      }),
    };
    await createAgyCatalogStore(options).refresh();
    const recovered = await createAgyCatalogStore({ ...options, fetchCatalog: async () => { throw new Error("offline"); } }).reload();
    assert.deepEqual(resolveAgyModel("hydrogen", undefined, recovered.reasoning.hydrogen), { model: "hydrogen-high" });
    assert.deepEqual(resolveAgyModel("parameter", "max", recovered.reasoning.parameter), { model: "parameter", thinkingLevel: "max" });
    assert.deepEqual(resolveAgyModel("parameter", "xhigh", recovered.reasoning.parameter), { model: "parameter" });
    // 旧版本的分组或默认占位语义不同，即使内容哈希完整也不能沿用。
    const cacheFile = path.join(directory, "agy-catalog.json");
    const oldCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const endpoint = createHash("sha256").update(AGY_ENDPOINT).digest("hex").slice(0, 16);
    for (const revision of [10, 11]) {
      oldCache.cache_key = createHash("sha256").update(JSON.stringify({ revision, identity: "account", endpoint })).digest("hex");
      fs.writeFileSync(cacheFile, JSON.stringify(oldCache));
      await assert.rejects(createAgyCatalogStore(options).reload(), /没有可用的本地缓存/);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agy groupedModels 保留服务端默认级别和显示名，排除目录没有的变体", TIMEOUT, () => {
  const data = parseAgyCatalogData({
    agentModelSorts: [{ groups: [{ modelIds: ["hydrogen"] }] }],
    groupedModels: {
      hydrogen: { displayName: "Gemini 4 Hydrogen", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"].map((level) => ({ thinkingSuffix: `-${level}` })) },
    },
    models: {
      hydrogen: { thinkingLevel: "THINKING_LEVEL_HIGH" },
      "hydrogen-low": {}, "hydrogen-medium": {}, "hydrogen-high": {}, "hydrogen-xhigh": {},
    },
  });
  const catalog = buildAgyCatalog(data);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0]!.slug, "agy/hydrogen");
  assert.equal(catalog.models[0]!.display_name, "AGY/Gemini 4 Hydrogen");
  assert.equal(catalog.models[0]!.default_reasoning_level, "high");
  assert.deepEqual((catalog.models[0]!.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
    ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(resolveAgyModel("hydrogen", undefined, data.reasoning.hydrogen), { model: "hydrogen-high" });
  assert.deepEqual(resolveAgyModel("hydrogen", "xhigh", data.reasoning.hydrogen), { model: "hydrogen-xhigh" });
});

test("agy 家族信息随目录缓存落盘，磁盘缓存回退时仍可解析档位", TIMEOUT, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-family-cache-"));
  try {
    const credentialFile = path.join(directory, "token.json");
    fs.writeFileSync(credentialFile, JSON.stringify({ token: { access_token: "ya29.x", refresh_token: "seed-a", expiry: "2099-01-01T00:00:00Z" } }));
    const credentials = () => Promise.resolve(loadAgyCredentials({ credentialFile, os: "linux" }));
    const first = createAgyCatalogStore({
      cacheDirectory: directory, credentials, now: () => 0,
      fetchCatalog: async () => {
        const response = tieredModelsResponse();
        (response.models as Record<string, unknown>)["gemini-3.8-flash-xhigh"] = { displayName: "Gemini 3.8 Flash (XHigh)" };
        return response;
      },
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
    assert.equal(resolveAgyFamilyModel(families[0]!, "xhigh"), "gemini-3.8-flash-xhigh");
    assert.deepEqual((models[0]!.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
      ["low", "medium", "high", "xhigh"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
