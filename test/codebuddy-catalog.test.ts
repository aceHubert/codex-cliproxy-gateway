import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CREDITS_PATTERN,
  buildCodebuddyCatalog,
  codebuddyCatalogFileName,
  codebuddyFamilyPrefix,
  codebuddyModelProduct,
  codebuddyModelRegion,
  codebuddyUpstreamModel,
  createCodebuddyCatalogStore,
  creditsMultiplier,
  dedupeCodebuddyCatalog,
  displayNameWithCredits,
  isCodebuddyModel,
  isFreeCredits,
  mergeCodebuddyCatalog,
  parseCodebuddyConfigData,
  projectCodebuddyCatalog,
  synthesizeCodebuddyEntry,
} from "../src/codebuddy/catalog.ts";
import type { CodebuddyCredential } from "../src/codebuddy/credentials.ts";
import { catalogRevision } from "../src/codebuddy/request-context.ts";
import { invalidateModelsCache } from "../src/catalog.ts";

function credential(profile: CodebuddyCredential["profile"]): CodebuddyCredential {
  const endpoints: Record<CodebuddyCredential["profile"], string> = {
    "cn-cli": "https://copilot.tencent.com",
    "cn-work": "https://www.workbuddy.cn",
    "intl-cli": "https://www.codebuddy.ai",
    "intl-work": "https://www.workbuddy.ai",
  };
  return {
    profile,
    endpoint: endpoints[profile],
    accessToken: "header.payload.signature",
    refreshToken: "header.refresh.signature",
    domain: "www.codebuddy.ai",
    accountUid: "uid-1",
    enterpriseId: "",
    expiresAt: Date.now() + 3_600_000,
  };
}

function fixtureModel(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id.toUpperCase(),
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: true,
    credits: "x1 credits",
    ...overrides,
  };
}

function cliConfig(models: Record<string, unknown>[], refs: unknown[]) {
  return { models, agents: [{ name: "cli", models: refs }] };
}

test("credits 解析：免费、倍率与格式异常共用同一常量", () => {
  assert.ok(CREDITS_PATTERN.test("x0.14 credits"));
  assert.ok(CREDITS_PATTERN.test("x0"));
  assert.ok(CREDITS_PATTERN.test("X0.79 Credits"));
  assert.equal(creditsMultiplier("x0.79 credits"), "0.79");
  assert.equal(creditsMultiplier("x3.31credits"), "3.31");
  assert.equal(creditsMultiplier("x0"), "0");
  assert.equal(creditsMultiplier(null), undefined);
  assert.equal(creditsMultiplier("订阅制"), undefined);
  assert.ok(isFreeCredits("x0 credits"));
  assert.ok(isFreeCredits("x0.00"));
  assert.ok(!isFreeCredits("x0.14 credits"));
  assert.equal(displayNameWithCredits("Auto", "x0.79 credits", "intl-cli"), "INTL-C/Auto (x0.79)");
  assert.equal(displayNameWithCredits("GPT-5.6-Luna", "x0.14 credits", "intl-cli"), "INTL-C/GPT-5.6-Luna (x0.14)");
  assert.equal(displayNameWithCredits("Free Model", "x0", "cn-cli"), "CN-C/Free Model (free)");
  assert.equal(displayNameWithCredits("Plain", "未知", "cn-cli"), "CN-C/Plain");
  assert.equal(displayNameWithCredits("Plain", undefined, "intl-work"), "INTL-W/Plain");
});

test("parseCodebuddyConfigData：picker 引用解析、禁用与可用清单过滤", () => {
  const data = parseCodebuddyConfigData(cliConfig(
    [fixtureModel("a", { disabled: true }), fixtureModel("b"), fixtureModel("c"), fixtureModel("image-only", { supportsToolCall: false })],
    ["b", "c", "a", "image-only", { id: "b" }, "missing"],
  ), "cli");
  // serves（全量）侧过滤禁用与不可聊天模型；picker 侧只解析引用并去重，
  // 禁用/不可服务条目在 buildCodebuddyCatalog 的 serves 交集中被剔除。
  assert.deepEqual(data.pickerIds, ["b", "c", "a", "image-only"]);
  assert.deepEqual(data.models.map((entry) => entry.id).sort(), ["b", "c"]);
  // workbuddy 产品取 default 标签 agent。
  const work = parseCodebuddyConfigData({
    models: [fixtureModel("w1")],
    agents: [{ name: "general", tags: ["default"], models: ["w1"] }],
  }, "workbuddy");
  assert.deepEqual(work.pickerIds, ["w1"]);
  assert.throws(() => parseCodebuddyConfigData({ models: "nope" }, "cli"), /data.models/);
});

test("synthesizeCodebuddyEntry 按①~④映射合成 Codex 条目", () => {
  const entry = synthesizeCodebuddyEntry(fixtureModel("gpt-5.6-luna", {
    name: "GPT-5.6-Luna",
    descriptionZh: "轻量模型",
    descriptionEn: "lightweight",
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    maxAllowedSize: 1000000,
    supportsReasoning: true,
    supportsImages: true,
    supportsToolCall: true,
    temperature: 0.7,
    top_p: 0.9,
    relatedModels: { lite: "gpt-5.6-luna" },
    credits: "x0.14 credits",
    reasoning: {
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "high",
      summary: "auto",
      canDisableThinking: false,
    },
    vendor: "e",
    tags: ["badge:x"],
  }), 7, "intl-cli");
  assert.equal(entry.slug, "gpt-5.6-luna");
  assert.equal(entry.display_name, "INTL-C/GPT-5.6-Luna (x0.14)");
  assert.equal(entry.description, "轻量模型");
  assert.equal(entry.context_window, 1000000);
  assert.equal(entry.max_context_window, 1000000);
  assert.equal(entry.supports_reasoning_summaries, true);
  assert.equal(entry.default_reasoning_summary, "auto");
  assert.equal(entry.default_reasoning_level, "high");
  assert.deepEqual(entry.supported_reasoning_levels, [{ effort: "low", description: "" }, { effort: "medium", description: "" }, { effort: "high", description: "" }]);
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
  assert.equal(entry.supports_parallel_tool_calls, true);
  assert.equal(entry.priority, 7);
  // ③ Codex 行为字段从快照基底继承，且必须解除最低客户端版本限制。
  assert.equal(entry.minimal_client_version, undefined);
  // CodeBuddy 上游只有 HTTP 接口：不能从 gpt-5.5 基底继承 prefer_websockets=true，
  // 否则 Codex 每次会话都要先被 426 打回再降级到 SSE。
  assert.equal(entry.prefer_websockets, false);
  assert.ok(typeof entry.tool_mode === "string" || Array.isArray(entry.model_messages) || JSON.stringify(entry).includes("truncation_policy"));
  // ④ CB 特有字段保留，vendor/tags 丢弃。
  assert.equal(entry.credits, "x0.14 credits");
  assert.equal(entry.maxOutputTokens, 128000);
  assert.equal(entry.maxAllowedSize, 1000000);
  assert.equal(entry.temperature, 0.7);
  assert.equal(entry.top_p, 0.9);
  assert.deepEqual(entry.relatedModels, { lite: "gpt-5.6-luna" });
  assert.equal(entry.vendor, undefined);
  assert.equal(entry.tags, undefined);
  // 无 reasoning 数据的档位：supported_reasoning_levels 必须仍然存在（Codex ≥0.154 必填）。
  const tier = synthesizeCodebuddyEntry(fixtureModel("default-model", { name: "Auto", supportsReasoning: false, credits: "x0.79 credits" }), 0, "cn-cli");
  assert.deepEqual(tier.supported_reasoning_levels, []);
  assert.equal(tier.supports_reasoning_summaries, false);
  assert.equal(tier.default_reasoning_level, undefined);
  assert.deepEqual(tier.input_modalities, ["text"]);
  assert.equal(tier.display_name, "CN-C/Auto (x0.79)");
});

test("推理档位：有效非空 supportedEfforts 沿用上游列表", () => {
  for (const defaults of [{}, { defaultEffort: "high", effort: "medium" }]) {
    const entry = synthesizeCodebuddyEntry(fixtureModel("deepseek-v4.1-flash", {
      reasoning: { supportedEfforts: ["low", "max"], ...defaults },
    }), 0, "intl-cli");
    assert.deepEqual(entry.supported_reasoning_levels, [
      { effort: "low", description: "" },
      { effort: "max", description: "" },
    ]);
  }
});

test("推理档位：supportedEfforts 缺失、为空或无效时回退有效默认值", () => {
  const realEntry = synthesizeCodebuddyEntry(fixtureModel("deepseek-v4.1-flash", {
    reasoning: { effort: "high", summary: "auto" },
  }), 0, "intl-cli");
  assert.equal(realEntry.default_reasoning_level, "high");
  assert.equal(realEntry.default_reasoning_summary, "auto");
  assert.deepEqual(realEntry.supported_reasoning_levels, [{ effort: "high", description: "" }]);

  for (const supportedEfforts of [undefined, [], null, "high", ["high", 1], [""], [" \t"]]) {
    for (const defaults of [
      { defaultEffort: "high", effort: "medium" },
      { effort: "high" },
      { defaultEffort: " \t", effort: "high" },
      { defaultEffort: 1, effort: "high" },
    ]) {
      const entry = synthesizeCodebuddyEntry(fixtureModel("deepseek-v4.1-flash", {
        reasoning: { supportedEfforts, ...defaults },
      }), 0, "intl-cli");
      assert.equal(entry.default_reasoning_level, "high");
      assert.deepEqual(entry.supported_reasoning_levels, [{ effort: "high", description: "" }]);
    }
  }
});

test("推理档位：列表与默认值均无效时保持空列表，空白默认值不生效", () => {
  for (const reasoning of [
    undefined,
    {},
    { supportedEfforts: [] },
    { supportedEfforts: ["high", null] },
    { defaultEffort: " \t", effort: "\n", supportedEfforts: [] },
    { defaultEffort: null, effort: 1 },
  ]) {
    const entry = synthesizeCodebuddyEntry(fixtureModel("deepseek-v4.1-flash", { reasoning }), 0, "intl-cli");
    assert.deepEqual(entry.supported_reasoning_levels, []);
    assert.equal(entry.default_reasoning_level, undefined);
  }
});

test("前缀族识别与裸模型透传（档位不做本地展开）", () => {
  assert.ok(isCodebuddyModel("codebuddy-intl/gpt-5.6-luna"));
  assert.ok(isCodebuddyModel("WorkBuddy/default-model"), "旧前缀必须被识别并本地拒绝");
  assert.ok(!isCodebuddyModel("gpt-5.6-luna"));
  assert.equal(codebuddyUpstreamModel("codebuddy-intl/gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(codebuddyUpstreamModel("workbuddy-intl/default-model"), "default-model");
  assert.equal(codebuddyUpstreamModel("codebuddy-intl/"), undefined);
  assert.equal(codebuddyFamilyPrefix("intl-cli"), "codebuddy-intl/");
  assert.equal(codebuddyFamilyPrefix("intl-work"), "workbuddy-intl/");
  assert.equal(codebuddyFamilyPrefix("cn-cli"), "codebuddy-cn/");
  assert.equal(codebuddyModelProduct("WorkBuddy/w1"), undefined, "旧前缀没有强制地域，不参与路由");
  assert.equal(codebuddyModelRegion("codebuddy-cn/w1"), "cn");
});

test("buildCodebuddyCatalog 取 serves 交集；project 按产品前缀投影", () => {
  const data = parseCodebuddyConfigData(cliConfig(
    [fixtureModel("a"), fixtureModel("b"), fixtureModel("c")],
    ["a", "c"],
  ), "cli");
  const catalog = buildCodebuddyCatalog(data, "intl-cli");
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["a", "c"]);
  const projected = projectCodebuddyCatalog(catalog, "intl-work");
  assert.deepEqual(projected.models.map((entry) => entry.slug), ["workbuddy-intl/a", "workbuddy-intl/c"]);
});

test("服务端档位模型（Auto/Fast/Balanced/Primary/Deep）被目录过滤", () => {
  const data = parseCodebuddyConfigData(cliConfig(
    [
      fixtureModel("default-model", { name: "Auto" }),
      fixtureModel("auto", { name: "Auto" }),
      fixtureModel("fast-model", { name: "Fast" }),
      fixtureModel("balanced-model", { name: "Balanced" }),
      fixtureModel("primary-model", { name: "Primary" }),
      fixtureModel("deep-model", { name: "Deep" }),
      fixtureModel("gpt-5.6-luna"),
    ],
    ["default-model", "auto", "fast-model", "balanced-model", "primary-model", "deep-model", "gpt-5.6-luna"],
  ), "cli");
  const catalog = buildCodebuddyCatalog(data, "intl-cli");
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["gpt-5.6-luna"]);
});

test("mergeCodebuddyCatalog 剥离上游同名前缀并按优先级追加", () => {
  const merged = mergeCodebuddyCatalog(
    { models: [{ slug: "native", priority: 3 }, { slug: "codebuddy-intl/evil", priority: 4 }] },
    { models: [{ slug: "codebuddy-intl/a", priority: 0 }, { slug: "workbuddy-intl/b", priority: 1 }] },
  );
  assert.deepEqual(merged.models.map((model) => model.slug), ["native", "codebuddy-intl/a", "workbuddy-intl/b"]);
  assert.deepEqual(merged.models.slice(1).map((model) => model.priority), [103, 104]);
});

test("dedupeCodebuddyCatalog 按裸 ID 合并两族：cli 优先，其次免费与低倍率", () => {
  const entry = (slug: string, credits?: string) => ({ slug, ...(credits === undefined ? {} : { credits }) });
  const deduped = dedupeCodebuddyCatalog({
    models: [
      // 同裸 ID：work 更便宜也应让位给 cli（产品优先于倍率）。
      entry("workbuddy-intl/luna", "x0.1 credits"),
      entry("codebuddy-intl/luna", "x0.14 credits"),
      // cli 内部：倍率低者胜出，x0（free）天然排最前。
      entry("codebuddy-intl/flash", "x0.79 credits"),
      entry("workbuddy-intl/flash", "x0.52 credits"),
      // 倍率缺失视为最贵，让位于已知倍率的同族条目。
      entry("codebuddy-intl/sol", undefined),
      entry("workbuddy-intl/sol", "x3.47 credits"),
      // 仅单侧存在的模型原样保留；非本族条目不参与去重。
      entry("workbuddy-intl/hy4-preview-f"),
      entry("native-model"),
    ],
  });
  assert.deepEqual(
    deduped.models.map((model) => model.slug),
    ["codebuddy-intl/luna", "codebuddy-intl/flash", "codebuddy-intl/sol", "workbuddy-intl/hy4-preview-f", "native-model"],
  );
});

test("dedupeCodebuddyCatalog 同名免费条目胜过付费条目", () => {
  const deduped = dedupeCodebuddyCatalog({
    models: [
      { slug: "codebuddy-intl/hy3", credits: "x0.5 credits" },
      { slug: "workbuddy-intl/hy3", credits: "x0 credits" },
    ],
  });
  // 免费属 work 族，但 cli 优先于 work——产品优先规则下 cli 仍胜出。
  assert.deepEqual(deduped.models.map((model) => model.slug), ["codebuddy-intl/hy3"]);
  const freeCli = dedupeCodebuddyCatalog({
    models: [
      { slug: "codebuddy-intl/hy3", credits: "x0.5 credits" },
      { slug: "codebuddy-intl/hy4", credits: "x0 credits" },
      { slug: "workbuddy-intl/hy4", credits: "x0.2 credits" },
    ],
  });
  assert.deepEqual(freeCli.models.map((model) => model.slug), ["codebuddy-intl/hy3", "codebuddy-intl/hy4"]);
});

test("目录存储：指纹与 TTL 命中不拉取，key 变化或内容被改即重建", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-"));
  const cacheFile = path.join(directory, "codebuddy-intl-catalog.json");
  const codexCache = path.join(directory, "models_cache.json");
  fs.writeFileSync(codexCache, JSON.stringify({ fetched_at: new Date().toISOString(), client_version: "1.0.0", models: [{ slug: "x" }] }));
  let fetched = 0;
  let response = () => Response.json({ code: 0, msg: "OK", data: cliConfig([fixtureModel("a"), fixtureModel("b")], ["a", "b"]) });
  const store = createCodebuddyCatalogStore({
    cacheDirectory: directory,
    codexModelsCacheFile: codexCache,
    credentials: async () => [credential("intl-cli")],
    fetch: async () => { fetched++; return response(); },
  });
  try {
    let catalog = await store.catalog();
    assert.equal(fetched, 1);
    assert.deepEqual(catalog.models.map((model) => model.slug), ["codebuddy-intl/a", "codebuddy-intl/b"]);
    assert.ok(fs.existsSync(cacheFile), "缓存按产品×地域命名落盘");
    // 重建目录改变了 Codex 可见模型：它自己的缓存必须被过期。
    assert.equal(JSON.parse(fs.readFileSync(codexCache, "utf8")).client_version, "0.0.0");
    // 双指纹命中：不再拉取。
    catalog = await store.catalog();
    assert.equal(fetched, 1);
    // 内容被篡改（content_hash 不符）→ 重建：用新 store 迫使重读磁盘。
    const tampered = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    tampered.models = [{ slug: "fake" }];
    fs.writeFileSync(cacheFile, JSON.stringify(tampered));
    const reopen = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli")],
      fetch: async () => { fetched++; return response(); },
    });
    catalog = await reopen.catalog();
    assert.equal(fetched, 2);
    assert.deepEqual(catalog.models.map((model) => model.slug), ["codebuddy-intl/a", "codebuddy-intl/b"]);
    // 账号身份变化（key 变化）→ 重建。
    const second = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [{ ...credential("intl-cli"), accountUid: "uid-2" }],
      fetch: async () => { fetched++; return response(); },
    });
    await second.catalog();
    assert.equal(fetched, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：双产品接口各拉各的目录并合并两个前缀族", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-duo-"));
  try {
    const fetched: string[] = [];
    const store = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli"), credential("intl-work")],
      fetch: async (url) => {
        fetched.push(url);
        if (url.startsWith("https://www.workbuddy.ai")) {
          return Response.json({ code: 0, data: { models: [fixtureModel("w1")], agents: [{ tags: ["default"], models: ["w1"] }] } });
        }
        return Response.json({ code: 0, data: cliConfig([fixtureModel("a")], ["a"]) });
      },
    });
    const catalog = await store.catalog();
    assert.deepEqual(catalog.models.map((model) => model.slug).sort(), ["codebuddy-intl/a", "workbuddy-intl/w1"]);
    assert.deepEqual([...fetched].sort(), ["https://www.codebuddy.ai/v3/config", "https://www.workbuddy.ai/v3/config"]);
    assert.ok(fs.existsSync(path.join(directory, "codebuddy-intl-catalog.json")));
    assert.ok(fs.existsSync(path.join(directory, "workbuddy-intl-catalog.json")));
    // display_name 带产品×地域标签：cli 族 INTL-C、work 族 INTL-W，同名模型据此区分。
    assert.match(catalog.models.find((model) => model.slug === "codebuddy-intl/a")!.display_name!, /^INTL-C\//);
    assert.match(catalog.models.find((model) => model.slug === "workbuddy-intl/w1")!.display_name!, /^INTL-W\//);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("codebuddyModelProduct 按前缀映射产品；缓存文件按产品×地域命名", () => {
  assert.equal(codebuddyModelProduct("codebuddy-intl/gpt-5.6-luna"), "cli");
  assert.equal(codebuddyModelProduct("workbuddy-cn/w1"), "work");
  assert.equal(codebuddyModelProduct("gpt-5.6-luna"), undefined);
  assert.equal(codebuddyCatalogFileName("intl-cli"), "codebuddy-intl-catalog.json");
  assert.equal(codebuddyCatalogFileName("cn-cli"), "codebuddy-cn-catalog.json");
  assert.equal(codebuddyCatalogFileName("intl-work"), "workbuddy-intl-catalog.json");
  assert.equal(codebuddyCatalogFileName("cn-work"), "workbuddy-cn-catalog.json");
});

test("目录存储：旧缓存键（含已移除的结构版本字段）不再命中并重建", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-version-"));
  const cacheFile = path.join(directory, "codebuddy-intl-catalog.json");
  const account = credential("intl-cli");
  const time = 1_000_000;
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const revision = catalogRevision(account.profile);
  const identity = digest([account.profile, account.accountUid, account.enterpriseId]);
  // 旧缓存键里曾带 version 字段；该字段已移除，旧 key 天然不再匹配。
  const oldKey = digest({ version: 6, profile: account.profile, revision, identity });
  const upstreamModel = fixtureModel("deepseek-v4.1-flash", { reasoning: { effort: "high", summary: "auto" } });
  // 模拟旧版本的有效缓存：有默认 high，但可选推理档位仍为空。
  const oldModels = [{ ...synthesizeCodebuddyEntry(upstreamModel, 0, "intl-cli"), supported_reasoning_levels: [] }];
  fs.writeFileSync(cacheFile, JSON.stringify({
    cache_key: oldKey,
    fetched_at: time,
    source_hash: digest({ key: oldKey, revision }),
    content_hash: digest(oldModels),
    models: oldModels,
  }));
  let fetched = 0;
  const store = createCodebuddyCatalogStore({
    cacheDirectory: directory,
    credentials: async () => [account],
    now: () => time + 1_000,
    fetch: async () => {
      fetched++;
      return Response.json({ code: 0, data: cliConfig([upstreamModel], ["deepseek-v4.1-flash"]) });
    },
  });
  try {
    const catalog = await store.catalog();
    assert.equal(fetched, 1, "旧缓存键不能因 TTL 尚未过期而复用");
    assert.equal(catalog.models[0]?.slug, "codebuddy-intl/deepseek-v4.1-flash");
    assert.deepEqual(catalog.models[0]?.supported_reasoning_levels, [{ effort: "high", description: "" }]);
    const refreshed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.notEqual(refreshed.cache_key, oldKey);
    assert.deepEqual(refreshed.models[0].supported_reasoning_levels, [{ effort: "high", description: "" }]);
    await store.catalog();
    assert.equal(fetched, 1, "新目录在 TTL 内复用");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：拉取失败回退 last-good，完全无缓存才报错", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-fail-"));
  try {
    let ok = true;
    const store = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli")],
      fetch: async () => {
        if (ok) return Response.json({ code: 0, data: cliConfig([fixtureModel("a")], ["a"]) });
        return new Response("boom", { status: 500 });
      },
    });
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
    ok = false;
    // 缓存未过期仍新鲜；直接清内存态的方式是重建 store（读同一磁盘缓存）。
    const reopened = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli")],
      fetch: async () => new Response("boom", { status: 500 }),
    });
    assert.deepEqual((await reopened.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"], "拉取失败回退 last-good");
    const empty = createCodebuddyCatalogStore({
      cacheDirectory: path.join(directory, "missing-dir"),
      credentials: async () => [credential("intl-cli")],
      fetch: async () => new Response("boom", { status: 500 }),
    });
    await assert.rejects(empty.catalog(), /拉取失败/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：非成功 code 与 TTL 过期触发重建", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-ttl-"));
  let time = 1_000_000;
  try {
    let code = 0;
    const store = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("cn-cli")],
      fetch: async () => Response.json({ code, data: cliConfig([fixtureModel("a")], ["a"]) }),
      now: () => time,
      ttlMs: 60_000,
    });
    await store.catalog();
    // TTL 内命中。
    time += 30_000;
    const store2 = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("cn-cli")],
      fetch: async () => { throw new Error("must not fetch"); },
      now: () => time,
      ttlMs: 60_000,
    });
    assert.deepEqual((await store2.catalog()).models.map((model) => model.slug), ["codebuddy-cn/a"]);
    // TTL 过期：重建；code != 0 时仍回退 last-good（陈旧目录可用时不向客户端报错）。
    time += 60_000;
    code = 1001;
    const store3 = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("cn-cli")],
      fetch: async () => Response.json({ code, msg: "denied" }),
      now: () => time,
      ttlMs: 60_000,
    });
    assert.deepEqual((await store3.catalog()).models.map((model) => model.slug), ["codebuddy-cn/a"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：强制刷新绕过 TTL，普通读取仍复用缓存", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-force-"));
  let time = 1_000_000;
  try {
    let version = "a";
    let fetched = 0;
    const store = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli")],
      fetch: async () => {
        fetched++;
        return Response.json({ code: 0, data: cliConfig([fixtureModel(version)], [version]) });
      },
      now: () => time,
      ttlMs: 60 * 60 * 1000,
    });
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
    assert.equal(fetched, 1);
    // TTL 未到期：普通读取直接复用。
    time += 1_000;
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
    assert.equal(fetched, 1);
    // 强制刷新无视 TTL，并让后续读取看到新目录。
    version = "b";
    await store.refresh();
    assert.equal(fetched, 2);
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/b"]);
    assert.equal(fetched, 2, "强制刷新后的新目录在 TTL 内复用");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：并发强制刷新共享单飞，不重复请求上游", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-singleflight-"));
  try {
    let fetched = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli")],
      fetch: async () => {
        fetched++;
        await gate;
        return Response.json({ code: 0, data: cliConfig([fixtureModel("a")], ["a"]) });
      },
    });
    const first = store.refresh();
    const second = store.refresh();
    release();
    await Promise.all([first, second]);
    assert.equal(fetched, 1, "并发刷新只触发一次上游请求");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：强制刷新失败时保留 last-good", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-force-fail-"));
  try {
    let ok = true;
    const store = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli")],
      fetch: async () => ok
        ? Response.json({ code: 0, data: cliConfig([fixtureModel("a")], ["a"]) })
        : new Response("boom", { status: 500 }),
    });
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
    ok = false;
    await store.refresh();
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：拉取失败进入 30 秒冷却，冷却结束后恢复重试", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-cooldown-"));
  let time = 1_000_000;
  try {
    let ok = true;
    let fetched = 0;
    const store = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli")],
      fetch: async () => {
        fetched++;
        return ok
          ? Response.json({ code: 0, data: cliConfig([fixtureModel("a")], ["a"]) })
          : new Response("boom", { status: 500 });
      },
      now: () => time,
      ttlMs: 60_000,
    });
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
    assert.equal(fetched, 1);
    // TTL 过期后第一次失败进入冷却，仍服务 last-good。
    ok = false;
    time += 61_000;
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
    assert.equal(fetched, 2);
    // 冷却窗口内即使 TTL 已过期也不重打上游。
    time += 10_000;
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
    assert.equal(fetched, 2, "30 秒冷却内不重试");
    // 冷却结束、上游恢复后重新拉取成功。
    ok = true;
    time += 30_000;
    assert.deepEqual((await store.catalog()).models.map((model) => model.slug), ["codebuddy-intl/a"]);
    assert.equal(fetched, 3, "冷却结束后恢复重试");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录存储：强制刷新忽略失败冷却", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-cooldown-force-"));
  let time = 1_000_000;
  try {
    let fetched = 0;
    let ok = true;
    const store = createCodebuddyCatalogStore({
      cacheDirectory: directory,
      credentials: async () => [credential("intl-cli")],
      fetch: async () => {
        fetched++;
        return ok
          ? Response.json({ code: 0, data: cliConfig([fixtureModel("a")], ["a"]) })
          : new Response("boom", { status: 500 });
      },
      now: () => time,
      ttlMs: 60_000,
    });
    await store.catalog();
    ok = false;
    time += 61_000;
    await store.catalog();
    assert.equal(fetched, 2, "TTL 过期后请求驱动尝试一次");
    await store.catalog();
    assert.equal(fetched, 2, "请求驱动在冷却内不重复重试");
    await store.refresh();
    assert.equal(fetched, 3, "定时/启动刷新不受冷却限制");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalidateModelsCache 过期 Codex 目录缓存", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-catalog-inv-"));
  try {
    const file = path.join(directory, "models_cache.json");
    fs.writeFileSync(file, JSON.stringify({ fetched_at: new Date().toISOString(), client_version: "1.2.3", models: [{ slug: "x" }] }));
    invalidateModelsCache(file);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.client_version, "0.0.0");
    assert.deepEqual(parsed.models, [{ slug: "x" }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
