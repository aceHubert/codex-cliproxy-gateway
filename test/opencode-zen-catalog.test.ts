import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OPENCODE_ZEN_DISPLAY_PREFIX,
  OPENCODE_ZEN_PREFIX,
  buildOpencodeZenCatalog,
  classifyOpencodeZenProbeSignal,
  createOpencodeZenCatalogStore,
  filterOpencodeZenCatalogIds,
  isOpencodeZenModel,
  mergeOpencodeZenCatalog,
  parseOpencodeZenMetadataResponse,
  parseOpencodeZenModelsResponse,
  opencodeZenDefaultEffort,
  opencodeZenDisplayName,
  opencodeZenUpstreamModel,
} from "../src/opencode/catalog.ts";
import type { OpencodeZenModelMetadata } from "../src/opencode/catalog.ts";
import { OPENCODE_ZEN_AGENT_SYSTEM_PROMPT } from "../src/opencode/fingerprint.ts";
import type { ModelCatalog } from "../src/types.ts";

/** 零计费元数据条目（免费模型的默认形状）。 */
const freeMeta = (extra: Record<string, unknown> = {}) => ({ cost: { input: 0, output: 0 }, ...extra });
const paidMeta = (extra: Record<string, unknown> = {}) => ({ cost: { input: 0.5, output: 1.5 }, ...extra });

test("Zen 手动目录查询不发网，显式刷新及磁盘重载同步协议、端点和档位", { timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-manual-"));
  try {
    let time = 1_000;
    let calls = 0;
    let npm = "@ai-sdk/openai-compatible";
    let levels = ["low"];
    const options = { cacheDirectory: directory, now: () => time,
      fetchCatalog: async () => { calls++; return { data: [{ id: "one-free" }] }; },
      fetchMetadata: async () => { calls++; return { opencode: { api: "https://zen.invalid/v1", models: { "one-free": freeMeta({
        provider: { npm }, reasoning_options: [{ type: "effort", values: levels }],
      }) } } }; } };
    const store = createOpencodeZenCatalogStore({ ...options, catalogMode: "manual" });
    assert.deepEqual(await store.catalog(), []);
    assert.equal(calls, 0);
    await store.refresh();
    time += 700_000;
    assert.equal((await store.catalog())[0]!.slug, "opencode-zen/one-free");
    assert.equal(calls, 2);
    npm = "@ai-sdk/anthropic";
    levels = ["high", "max"];
    await createOpencodeZenCatalogStore(options).refresh(true);
    await store.reload();
    assert.equal(store.protocol("one-free"), "anthropic");
    assert.equal(store.endpoint("one-free"), "https://zen.invalid/v1");
    assert.deepEqual(store.effortLevels("one-free"), ["high", "max"]);
    assert.equal(calls, 4);
    const missing = createOpencodeZenCatalogStore({ cacheDirectory: path.join(directory, "missing"), catalogMode: "manual",
      fetchCatalog: async () => { throw new Error("离线"); } });
    await assert.rejects(missing.refresh(), /没有可用缓存/);
    assert.deepEqual(await missing.catalog(), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("模型前缀识别与剥除：opencode-zen/ 前缀大小写不敏感", () => {
  assert.equal(isOpencodeZenModel("opencode-zen/nemotron-3.5-lightning-free"), true);
  assert.equal(isOpencodeZenModel("OPENCODE-ZEN/glm-5-free"), true);
  assert.equal(isOpencodeZenModel("gpt-5.5"), false);
  assert.equal(isOpencodeZenModel(42), false);
  assert.equal(opencodeZenUpstreamModel("opencode-zen/kimi-k2.5-free"), "kimi-k2.5-free");
  assert.equal(opencodeZenUpstreamModel("OPENCODE-ZEN/glm-5-free"), "glm-5-free");
  assert.equal(opencodeZenUpstreamModel("opencode-zen/"), undefined);
  assert.equal(opencodeZenUpstreamModel("opencode-zen/a/b"), undefined);
  assert.equal(opencodeZenUpstreamModel("glm-5-free"), undefined);
});

test("元数据 cost 判定免费：input/output 均为零才算，缺字段按非免费", () => {
  const parsed = parseOpencodeZenMetadataResponse({ opencode: { models: {
    "grok-code": freeMeta(),
    "big-pickle": freeMeta(),
    "nemotron-free": freeMeta({ cost: { input: 0, output: 0 } }),
    "claude-opus-5": paidMeta(),
    "half-free": { cost: { input: 0, output: 1.5 } },
    "no-cost": {},
  } } });
  assert.equal(parsed!["grok-code"]!.free, true);
  assert.equal(parsed!["big-pickle"]!.free, true);
  assert.equal(parsed!["claude-opus-5"]!.free, undefined);
  assert.equal(parsed!["half-free"]!.free, undefined);
  assert.equal(parsed!["no-cost"]!.free, undefined);
});

test("显示名：元数据官方名优先，缺失按 id 人工化", () => {
  assert.equal(opencodeZenDisplayName("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free"), "Nemotron 3.5 Lightning Free");
  assert.equal(opencodeZenDisplayName("mimo-v2.6-flash-free"), "Mimo V2.6 Flash Free");
  assert.equal(opencodeZenDisplayName("grok-code", "  "), "Grok Code");
  assert.equal(opencodeZenDisplayName("exo-free", "Exo Free"), "Exo Free");
});

test("目录条目：slug 带 opencode-zen/ 前缀，display_name 带 OP-ZEN/ 前缀", () => {
  const catalog = buildOpencodeZenCatalog(["nemotron-3.5-lightning-free", "exo-free"]);
  assert.equal(catalog.models.length, 2);
  const entry = catalog.models[0]!;
  assert.equal(entry.slug, "opencode-zen/nemotron-3.5-lightning-free");
  assert.equal(entry.display_name, "OP-ZEN/Nemotron 3.5 Lightning Free");
  assert.equal(entry.prefer_websockets, false);
  assert.deepEqual(entry.input_modalities, ["text"]);
  assert.equal(entry.supports_parallel_tool_calls, true);
  assert.match(String(entry.description), /按模型端点协议自动转换/);
});

test("reasoning effort 档位取实时元数据：effort 型暴露真实值域，toggle/budget 型不暴露", () => {
  const metadata: Record<string, OpencodeZenModelMetadata> = {
    "deepseek-v4-flash-free": { deprecated: false, effortLevels: ["low", "high", "max"] },
    "muse-spark-free": { deprecated: false, effortLevels: ["minimal", "low", "medium", "high", "xhigh"] },
    "nemotron-3.5-lightning-free": { deprecated: false },
    "brand-new-free": undefined as unknown as OpencodeZenModelMetadata,
  };
  // 默认档位：有 high 取 high（对齐上游默认），否则末项；空值域不暴露。
  assert.equal(opencodeZenDefaultEffort(["low", "high", "max"]), "high");
  assert.equal(opencodeZenDefaultEffort(["minimal", "low", "medium", "high", "xhigh"]), "high");
  assert.equal(opencodeZenDefaultEffort(["none", "medium"]), "medium");
  assert.equal(opencodeZenDefaultEffort([]), undefined);

  const catalog = buildOpencodeZenCatalog(["deepseek-v4-flash-free", "muse-spark-free", "nemotron-3.5-lightning-free", "brand-new-free"], metadata);
  const deepseek = catalog.models[0]!;
  assert.deepEqual(
    (deepseek.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
    ["low", "high", "max"],
  );
  assert.equal(deepseek.default_reasoning_level, "high");
  const muse = catalog.models[1]!;
  assert.deepEqual(
    (muse.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  // 无档位声明与未知模型保持空档位（Codex 目录形状无法表达 toggle/budget）。
  assert.deepEqual(catalog.models[2]!.supported_reasoning_levels, []);
  assert.equal(catalog.models[2]!.default_reasoning_level, "medium");
  assert.deepEqual(catalog.models[3]!.supported_reasoning_levels, []);
});

test("mergeOpencodeZenCatalog 替换旧 zen 条目并整体后置 priority", () => {
  const base: ModelCatalog = { models: [
    { slug: "gpt-5.5", priority: 0 },
    { slug: "opencode-zen/stale-free", priority: 5 },
  ] };
  const merged = mergeOpencodeZenCatalog(base, buildOpencodeZenCatalog(["exo-free"]));
  assert.deepEqual(merged.models.map((entry) => entry.slug), ["gpt-5.5", "opencode-zen/exo-free"]);
  assert.ok(merged.models[1]!.priority! > 0);
});

test("parseOpencodeZenModelsResponse 清洗全部 id（含付费）：去重、去非法字符、保序", () => {
  // 该端点不带计费信息：付费模型也在这里返回，免费判定交给元数据 cost。
  const ids = parseOpencodeZenModelsResponse({ object: "list", data: [
    { id: "claude-opus-5", object: "model" },
    { id: "nemotron-3.5-lightning-free", object: "model" },
    { id: "exo-free", object: "model" },
    { id: "exo-free", object: "model" },
    { id: "bad id/free", object: "model" },
    { id: "grok-code", object: "model" },
  ] });
  assert.deepEqual(ids, ["claude-opus-5", "nemotron-3.5-lightning-free", "exo-free", "grok-code"]);
  // 畸形输入（非对象、缺 data）返回空数组而非抛错。
  assert.deepEqual(parseOpencodeZenModelsResponse(null), []);
  assert.deepEqual(parseOpencodeZenModelsResponse({}), []);
  assert.deepEqual(parseOpencodeZenModelsResponse({ data: "nope" }), []);
});

test("元数据解析：npm/free/name/limit/reasoning_options/deprecated 全字段提取", () => {
  const parsed = parseOpencodeZenMetadataResponse({ opencode: { models: {
    "exo-free": { status: "deprecated", cost: { input: 0, output: 0 } },
    "muse-spark-1.3-contributor-free": { provider: { npm: "@ai-sdk/openai" }, cost: { input: 0, output: 0 }, name: "Muse Spark" },
    "space-bunny-free": { provider: { npm: "@ai-sdk/openai-compatible" } },
  } } });
  assert.deepEqual(parsed, {
    "exo-free": { free: true, deprecated: true },
    "muse-spark-1.3-contributor-free": { npm: "@ai-sdk/openai", free: true, name: "Muse Spark", deprecated: false },
    "space-bunny-free": { npm: "@ai-sdk/openai-compatible", deprecated: false },
  });
  assert.equal(parseOpencodeZenMetadataResponse(null), undefined);
  assert.equal(parseOpencodeZenMetadataResponse({}), undefined);
  assert.equal(parseOpencodeZenMetadataResponse({ opencode: { models: "nope" } }), undefined);
});

test("元数据解析：limit.context 与 reasoning_options 提取，畸形值视为缺失", () => {
  const parsed = parseOpencodeZenMetadataResponse({ opencode: { models: {
    "a-free": { limit: { context: 262144, output: 32768 } },
    "b-free": { limit: { context: 0 } },
    "c-free": { limit: { context: -5 } },
    "d-free": { limit: { context: "262144" } },
    "e-free": { limit: null },
    "f-free": { reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
    "g-free": { reasoning_options: [{ type: "toggle" }] },
    "h-free": { reasoning_options: [{ type: "effort", values: [] }] },
    "i-free": { reasoning_options: "nope" },
  } } });
  assert.deepEqual(parsed, {
    "a-free": { contextWindow: 262144, deprecated: false },
    "b-free": { deprecated: false },
    "c-free": { deprecated: false },
    "d-free": { deprecated: false },
    "e-free": { deprecated: false },
    "f-free": { effortLevels: ["low", "high"], deprecated: false },
    "g-free": { deprecated: false },
    "h-free": { deprecated: false },
    "i-free": { deprecated: false },
  });
});

test("上下文窗口：元数据 limit.context 声明，未知模型删字段", () => {
  const catalog = buildOpencodeZenCatalog(["nemotron-3.5-lightning-free", "brand-new-free"], {
    "nemotron-3.5-lightning-free": { deprecated: false, contextWindow: 262144 },
  });
  const nemotron = catalog.models[0]!;
  assert.equal(nemotron.context_window, 262144);
  assert.equal(nemotron.max_context_window, 262144);
  assert.equal(nemotron.effective_context_window_percent, 95);
  // 未知模型（无元数据）：删字段而不是沿用 gpt-5.5 基底的 272k。
  const unknown = catalog.models[1]!;
  assert.equal("context_window" in unknown, false);
  assert.equal("max_context_window" in unknown, false);
  assert.equal("effective_context_window_percent" in unknown, false);
});

test("探针信号分类：协议不符/下线/门禁/被服务四类，地区限制视为被服务", () => {
  assert.equal(classifyOpencodeZenProbeSignal(400, '{"error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}'), "unsupported");
  assert.equal(classifyOpencodeZenProbeSignal(401, '{"error":{"type":"ModelError","message":"Model glm-5-free is not supported"}}'), "offline");
  assert.equal(classifyOpencodeZenProbeSignal(404, '{"status":404,"message":"Cannot find any route matching"}'), "offline");
  assert.equal(classifyOpencodeZenProbeSignal(403, '{"error":{"type":"FreeTierError","message":"free tier can only be used from within OpenCode"}}'), "gate");
  assert.equal(classifyOpencodeZenProbeSignal(403, '{"error":{"type":"RegionError","message":"This model is not available in your country."}}'), "served");
  assert.equal(classifyOpencodeZenProbeSignal(200, ""), "served");
  assert.equal(classifyOpencodeZenProbeSignal(503, '{"error":{"message":"Endpoint is unavailable."}}'), "served");
});

test("目录过滤：cost 免费判定 + deprecated 剔除 + 无条目只认 -free 后缀 + 探针兜底", () => {
  const metadata: Record<string, OpencodeZenModelMetadata> = {
    "grok-code": { deprecated: false, free: true },
    "big-pickle": { deprecated: false, free: true },
    "exo-free": { deprecated: true, free: true },
    "claude-opus-5": { deprecated: false },
    "muse-spark-free": { deprecated: false, free: true },
  };
  // 元数据权威：零计费且未 deprecated 才可见；付费/已下线剔除。
  assert.deepEqual(
    filterOpencodeZenCatalogIds(
      ["grok-code", "big-pickle", "exo-free", "claude-opus-5", "muse-spark-free"],
      metadata,
      undefined,
    ),
    ["grok-code", "big-pickle", "muse-spark-free"],
  );
  // 元数据无条目（刚轮换上线）：-free 后缀宽限 + 探针裁决；无后缀无法验证免费，剔除。
  assert.deepEqual(
    filterOpencodeZenCatalogIds(["jev-1.13-free", "claude-fable-5"], metadata, {
      "jev-1.13-free": { result: "chat", at: 1 },
      "claude-fable-5": { result: "chat", at: 1 },
    }),
    ["jev-1.13-free"],
  );
  assert.deepEqual(filterOpencodeZenCatalogIds(["jev-1.13-free"], metadata, { "jev-1.13-free": { result: "drop", at: 1 } }), []);
  // 元数据整体不可用：只信 -free 后缀（无后缀零计费模型暂不示，好过误示付费）。
  assert.deepEqual(filterOpencodeZenCatalogIds(["exo-free", "grok-code", "claude-opus-5"], undefined, undefined), ["exo-free"]);
});

test("目录存储：动态 id + 元数据属性 + TTL 内不重复拉取 + 失败回退 last-good", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-"));
  let now = 1_000_000;
  let fetches = 0;
  let metadataFetches = 0;
  try {
    const store = createOpencodeZenCatalogStore({
      cacheDirectory: directory,
      now: () => now,
      ttlMs: 60_000,
      fetchCatalog: async () => {
        fetches++;
        return { data: [{ id: "exo-free" }, { id: "grok-code" }, { id: "claude-opus-5" }] };
      },
      fetchMetadata: async () => {
        metadataFetches++;
        return { opencode: { models: {
          "exo-free": freeMeta({ name: "Exo Free", limit: { context: 1_048_576 } }),
          "grok-code": freeMeta({ name: "Grok Code Fast 1" }),
          "claude-opus-5": paidMeta(),
        } } };
      },
    });
    const first = await store.catalog();
    assert.equal(fetches, 1);
    const slugs = first.map((entry) => entry.slug);
    assert.ok(slugs.includes("opencode-zen/exo-free"), "元数据判定免费的模型可见");
    assert.ok(slugs.includes("opencode-zen/grok-code"), "无后缀零计费模型靠 cost 识别");
    assert.ok(!slugs.includes("opencode-zen/claude-opus-5"), "付费模型不进目录");
    // 属性来自元数据：名称与窗口。
    const exo = first.find((entry) => entry.slug === "opencode-zen/exo-free")!;
    assert.equal(exo.display_name, "OP-ZEN/Exo Free");
    assert.equal(exo.context_window, 1_048_576);
    // TTL 内再取：命中内存缓存不重拉。
    await store.catalog();
    assert.equal(fetches, 1);
    assert.equal(metadataFetches, 1);
    // TTL 过期后重拉。
    now += 61_000;
    await store.catalog();
    assert.equal(fetches, 2);
    // 失败冷却：拉取异常回退 last-good，冷却期内不重试。
    let fail = true;
    const failing = createOpencodeZenCatalogStore({
      cacheDirectory: directory,
      now: () => now,
      ttlMs: 60_000,
      fetchCatalog: async () => {
        if (fail) throw new Error("upstream down");
        return { data: [{ id: "exo-free" }] };
      },
      fetchMetadata: async () => ({ opencode: { models: { "exo-free": freeMeta() } } }),
    });
    now += 61_000;
    const fallback = await failing.catalog();
    assert.ok(fallback.some((entry) => entry.slug === "opencode-zen/exo-free"), "失败时回退磁盘 last-good");
    await failing.catalog();
    now += 61_000;
    fail = false;
    const recovered = await failing.catalog();
    assert.ok(recovered.length > 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：动态列表为空时回退元数据免费集", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-meta-fallback-"));
  try {
    const store = createOpencodeZenCatalogStore({
      cacheDirectory: directory,
      fetchCatalog: async () => ({ data: [] }),
      fetchMetadata: async () => ({ opencode: { models: {
        "exo-free": freeMeta({ name: "Exo Free" }),
        "grok-code": freeMeta(),
        "dead-free": freeMeta({ status: "deprecated" }),
        "claude-opus-5": paidMeta(),
      } } }),
    });
    const slugs = (await store.catalog()).map((entry) => entry.slug);
    assert.deepEqual(slugs, ["opencode-zen/exo-free", "opencode-zen/grok-code"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：完全无缓存（首次拉取即失败）返回空目录，不用静态快照充数", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-empty-"));
  try {
    const store = createOpencodeZenCatalogStore({
      cacheDirectory: directory,
      fetchCatalog: async () => { throw new Error("always down"); },
    });
    assert.deepEqual(await store.catalog(), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：刷新同时写 metadata.json 与成品 catalog.json，serve 只读缓存", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-split-"));
  let now = 1_000_000;
  try {
    const store = createOpencodeZenCatalogStore({
      cacheDirectory: directory,
      now: () => now,
      ttlMs: 60_000,
      fetchCatalog: async () => ({ data: [{ id: "exo-free" }, { id: "grok-code" }] }),
      fetchMetadata: async () => ({ opencode: { api: "https://opencode.ai/zen/v1", models: {
        "exo-free": freeMeta({ name: "Exo Free" }),
        "grok-code": freeMeta({ name: "Grok Code Fast 1" }),
        "claude-opus-5": paidMeta(),
      } } }),
    });
    const models = await store.catalog();
    assert.deepEqual(models.map((entry) => entry.slug), ["opencode-zen/exo-free", "opencode-zen/grok-code"]);
    // 双文件：原始数据在 metadata.json，成品目录在 catalog.json。
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "opencode-zen-metadata.json"), "utf8"));
    assert.deepEqual(metadata.ids, ["exo-free", "grok-code"]);
    assert.ok(metadata.metadata?.models, "元数据随原始数据落盘");
    assert.equal(metadata.metadata.models["exo-free"].api, "https://opencode.ai/zen/v1", "provider.api 进入元数据");
    assert.equal(metadata.models, undefined, "metadata.json 不再内嵌成品条目");
    const catalog = JSON.parse(fs.readFileSync(path.join(directory, "opencode-zen-catalog.json"), "utf8"));
    assert.ok(Array.isArray(catalog.models) && catalog.models.length === 2, "catalog.json 是成品目录");
    // 成品即终态：提示词与模板在生成时已替换，serve 不再加工。
    for (const entry of catalog.models) {
      assert.equal(entry.base_instructions, OPENCODE_ZEN_AGENT_SYSTEM_PROMPT);
      assert.equal((entry.model_messages as { instructions_template?: string }).instructions_template, OPENCODE_ZEN_AGENT_SYSTEM_PROMPT);
    }
    // 转发 endpoint 由元数据确认（provider.api）。
    assert.equal(store.endpoint("exo-free"), "https://opencode.ai/zen/v1");
    assert.equal(store.endpoint("claude-opus-5"), "https://opencode.ai/zen/v1", "provider 级 baseURL 全模型共享");
    assert.equal(store.endpoint("unknown-model"), undefined, "元数据缺失时由转发层回退缺省端点");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** 元数据拉取失败 + 旧版缓存（无 metadata 字段）兼容读取。 */
test("目录存储：元数据拉取失败只信 -free 后缀，旧版缓存文件兼容读取", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-legacy-"));
  try {
    const store = createOpencodeZenCatalogStore({
      cacheDirectory: directory,
      ttlMs: 60_000,
      fetchCatalog: async () => ({ data: [{ id: "exo-free" }, { id: "grok-code" }] }),
      fetchMetadata: async () => { throw new Error("metadata down"); },
    });
    const models = await store.catalog();
    assert.deepEqual(models.map((entry) => entry.slug), ["opencode-zen/exo-free"],
      "元数据不可用时只信 -free 后缀，grok-code 无法验证免费暂不示");

    // 旧版缓存（仅 ids + content_hash，无 metadata/probe_verdicts）按同样规则读取。
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-legacy-file-"));
    const ids = ["exo-free", "grok-code"];
    fs.writeFileSync(path.join(legacy, "opencode-zen-catalog.json"), JSON.stringify({
      fetched_at: Date.now(),
      content_hash: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
      ids,
    }));
    const legacyStore = createOpencodeZenCatalogStore({
      cacheDirectory: legacy,
      fetchCatalog: async () => { throw new Error("不应拉取"); },
    });
    const legacyModels = await legacyStore.catalog();
    assert.deepEqual(legacyModels.map((entry) => entry.slug), ["opencode-zen/exo-free"]);
    fs.rmSync(legacy, { recursive: true, force: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：元数据过滤 + 探针裁决 + 磁盘回读（TTL 内不重复拉取/探测）", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-meta-"));
  let now = 1_000_000;
  let metadataFetches = 0;
  const probed: string[] = [];
  const fetchCatalog = async () => ({ data: [
    { id: "exo-free" }, { id: "space-bunny-free" },
    { id: "muse-spark-1.3-contributor-free" }, { id: "jev-1.13-free" },
  ] });
  const fetchMetadata = async () => {
    metadataFetches++;
    return { opencode: { models: {
      "exo-free": freeMeta({ status: "deprecated" }),
      "space-bunny-free": freeMeta(),
      "muse-spark-1.3-contributor-free": freeMeta({ provider: { npm: "@ai-sdk/openai" } }),
    } } };
  };
  try {
    const store = createOpencodeZenCatalogStore({
      cacheDirectory: directory, now: () => now, ttlMs: 60_000,
      metadataTtlMs: 600_000, probeTtlMs: 120_000,
      fetchCatalog, fetchMetadata,
      probeModel: async (id) => { probed.push(id); return "drop"; },
    });
    const first = new Set((await store.catalog()).map((entry) => entry.slug));
    assert.ok(first.has("opencode-zen/space-bunny-free"));
    assert.ok(!first.has("opencode-zen/exo-free"), "deprecated 模型不暴露");
    assert.ok(first.has("opencode-zen/muse-spark-1.3-contributor-free"), "非 chat 协议模型保留（按协议路由）");
    assert.ok(!first.has("opencode-zen/jev-1.13-free"), "探针 drop 的模型不暴露");
    assert.equal(metadataFetches, 1);
    assert.deepEqual(probed, ["jev-1.13-free"]);
    // TTL 内二次取目录：不重拉元数据、不重探。
    now += 61_000;
    await store.catalog();
    assert.equal(metadataFetches, 1);
    assert.equal(probed.length, 1);
    // 新 store 从磁盘回读元数据（不再拉取）；探针 TTL 过期后重新裁决并翻转结果。
    now += 61_000;
    const reread = createOpencodeZenCatalogStore({
      cacheDirectory: directory, now: () => now, ttlMs: 60_000,
      metadataTtlMs: 600_000, probeTtlMs: 120_000,
      fetchCatalog,
      fetchMetadata: async () => { metadataFetches++; throw new Error("不应重复拉取元数据"); },
      probeModel: async (id) => { probed.push(id); return "chat"; },
    });
    const rereadCatalog = new Set((await reread.catalog()).map((entry) => entry.slug));
    assert.ok(rereadCatalog.has("opencode-zen/jev-1.13-free"), "探针翻转为 chat 后重新暴露");
    assert.equal(metadataFetches, 1, "磁盘元数据在 TTL 内直接复用");
    assert.deepEqual(probed, ["jev-1.13-free", "jev-1.13-free"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：探针失败不记录裁决，保守保留并下轮重试", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-probe-fail-"));
  let now = 1_000_000;
  let attempts = 0;
  try {
    const store = createOpencodeZenCatalogStore({
      cacheDirectory: directory, now: () => now, ttlMs: 60_000,
      metadataTtlMs: 600_000, probeTtlMs: 600_000,
      fetchCatalog: async () => ({ data: [{ id: "jev-1.13-free" }] }),
      fetchMetadata: async () => ({ opencode: { models: {} } }),
      probeModel: async () => {
        attempts++;
        if (attempts === 1) throw new Error("network blip");
        return "drop";
      },
    });
    const first = await store.catalog();
    assert.ok(first.some((entry) => entry.slug === "opencode-zen/jev-1.13-free"), "探针失败保守保留");
    assert.equal(attempts, 1);
    now += 61_000;
    const second = await store.catalog();
    assert.ok(!second.some((entry) => entry.slug === "opencode-zen/jev-1.13-free"), "下轮重试成功后剔除");
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：协议与 effort 档位暴露均取实时元数据", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-catalog-protocol-"));
  try {
    const store = createOpencodeZenCatalogStore({
      cacheDirectory: directory,
      fetchCatalog: async () => ({ data: [{ id: "muse-spark-1.3-contributor-free" }, { id: "deepseek-v4-flash-free" }] }),
      fetchMetadata: async () => ({ opencode: { models: {
        "muse-spark-1.3-contributor-free": freeMeta({ provider: { npm: "@ai-sdk/openai" } }),
        "deepseek-v4-flash-free": freeMeta({ reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] }),
      } } }),
      probeModel: async () => "chat",
    });
    await store.catalog();
    assert.equal(store.protocol("muse-spark-1.3-contributor-free"), "responses", "元数据 npm 映射端点协议");
    assert.equal(store.protocol("never-seen"), "chat", "缺省 chat");
    assert.deepEqual(store.effortLevels("deepseek-v4-flash-free"), ["low", "high", "max"]);
    assert.deepEqual(store.effortLevels("muse-spark-1.3-contributor-free"), []);
    assert.deepEqual(store.effortLevels("never-seen"), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
