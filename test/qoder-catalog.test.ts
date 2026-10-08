import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildQoderCatalog,
  createQoderCatalogStore,
  isQoderModel,
  mergeQoderCatalog,
  parseQoderCatalogData,
  qoderModelConfig,
  qoderModelSlug,
  qoderRegionOf,
  qoderUpstreamModel,
  QODER_CN_PREFIX,
} from "../src/qoder/catalog.ts";
import type { QoderCredentials } from "../src/qoder/credentials.ts";

function credential(identity = "account-one"): QoderCredentials {
  return { region: "intl", clientProfile: "cli", identity, accountUid: identity, authDirectory: "/synthetic/.auth",
    machineId: "synthetic-machine", organizationId: "", organizationTags: [], dataPolicyAgreed: true,
    accessToken: "SENTINEL-SECRET-TOKEN", expireTime: 9_999_999_999, encryptUserInfo: "secret-info", key: "secret-key" };
}

function model(key = "qfmodel", overrides: Record<string, unknown> = {}) {
  return { key, enable: true, display_name: "Qwen3.8-Flash", format: "openai", source: "system",
    is_vl: false, is_reasoning: true, max_input_tokens: 128_000, ...overrides };
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qoder-catalog-test-"));
}

test("Qoder 目录只展示当前账号启用的具体模型，并使用国际版路由", () => {
  const parsed = parseQoderCatalogData({ chat: [
    model(), model("off", { enable: false }), model("auto"), model("missing-enable", { enable: undefined }),
    model("disabled", { disabled: true }),
  ], byok_teams: [model("team-only")] });
  const catalog = buildQoderCatalog(parsed);
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["qoder-intl/qfmodel"]);
  const entry = catalog.models[0]!;
  assert.equal(entry.display_name, "Qoder-INTL/Qwen3.8-Flash");
  assert.equal(entry.prefer_websockets, false);
  assert.equal(entry.minimal_client_version, undefined);
  assert.equal(entry.context_window, 128_000);
  assert.equal(entry.supports_parallel_tool_calls, false);
  assert.equal(entry.supports_search_tool, false);
  assert.equal(entry.supports_reasoning_summary_parameter, false);
  assert.equal(entry.support_verbosity, false);
  assert.deepEqual(entry.service_tiers, []);
  assert.deepEqual(entry.input_modalities, ["text"]);
  assert.deepEqual(entry.supported_reasoning_levels, []);
  assert.equal(qoderUpstreamModel(entry.slug), "qfmodel");
  assert.equal(qoderUpstreamModel("qoder-cn/qfmodel"), "qfmodel");
  assert.equal(qoderUpstreamModel("qoder-intl/"), undefined);
  assert.equal(qoderUpstreamModel("qoder-intl/qfmodel/extra"), undefined);
  assert.deepEqual(qoderModelSlug("qoder-cn/qfmodel"), { region: "cn", key: "qfmodel" });
  assert.deepEqual(qoderModelSlug("qoder-intl/qfmodel"), { region: "intl", key: "qfmodel" });
  assert.equal(qoderModelSlug("qoder-cn/"), undefined);
  assert.equal(qoderRegionOf("qoder-cn/qfmodel"), "cn");
  assert.equal(qoderRegionOf("qoder-intl/qfmodel"), "intl");
  assert.ok(isQoderModel("qoder-cn/qfmodel"));
  assert.ok(isQoderModel("qoder/qfmodel"));
  assert.ok(!isQoderModel("official/qfmodel"));
});

test("Qoder 国内版目录使用 qoder-cn/ 前缀与 Qoder-CN 展示名，缓存按区域隔离", async () => {
  const catalog = buildQoderCatalog(parseQoderCatalogData({ chat: [model("qfmodel", { price_factor: 0 })] }), "cn");
  const entry = catalog.models[0]!;
  assert.equal(entry.slug, "qoder-cn/qfmodel");
  assert.equal(entry.display_name, "Qoder-CN/Qwen3.8-Flash (free)");
  assert.match(entry.description!, /国内版/);
  assert.equal(qoderRegionOf(entry.slug), "cn");

  const directory = temporaryDirectory();
  try {
    const store = createQoderCatalogStore({ region: "cn", cacheDirectory: directory,
      credentials: async () => credential("cn-account"), fetchCatalog: async () => ({ chat: [model()] }) });
    assert.deepEqual((await store.catalog()).models.map((item) => item.slug), [`${QODER_CN_PREFIX}qfmodel`]);
    assert.ok(fs.existsSync(path.join(directory, "qoder-cn-catalog.json")));
    assert.ok(!fs.existsSync(path.join(directory, "qoder-intl-catalog.json")));
    const intlStore = createQoderCatalogStore({ cacheDirectory: directory,
      credentials: async () => credential("intl-account"), fetchCatalog: async () => ({ chat: [model()] }) });
    assert.deepEqual((await intlStore.catalog()).models.map((item) => item.slug), ["qoder-intl/qfmodel"]);
    const merged = mergeQoderCatalog({ models: [] }, { models: catalog.models });
    assert.ok(merged.models.some((item) => item.slug === "qoder-cn/qfmodel"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Qoder 模型元数据使用白名单，未声明能力不继承基底值", () => {
  const entry = buildQoderCatalog(parseQoderCatalogData({ chat: [model("qfmodel", {
    max_input_tokens: undefined, is_reasoning: false, is_vl: true, secret: "SENTINEL", url: "https://example.com/?token=SENTINEL",
    context_config: { default: { token_count: 10_000, is_default: true, private: "SENTINEL" }, invalid: { token_count: -1 } },
    thinking_config: { enabled: { is_default: true, efforts: { medium: { is_default: true, secret: "SENTINEL" } } },
      disabled: {}, unknown: { secret: "SENTINEL" } },
    price_factor: 0.1,
  })] })).models[0]!;
  assert.equal(entry.context_window, 10_000);
  assert.equal(entry.max_context_window, 10_000);
  assert.equal(entry.supports_reasoning_summaries, false);
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
  assert.equal(JSON.stringify(entry).includes("SENTINEL"), false);
  assert.deepEqual(qoderModelConfig(entry), { key: "qfmodel", enable: true, is_vl: true, is_reasoning: false,
    format: "openai", source: "system", context_config: { default: { token_count: 10_000, is_default: true } },
    thinking_config: { disabled: {}, enabled: { is_default: true, efforts: { medium: { is_default: true } } } },
    price_factor: 0.1 });
  const merged = mergeQoderCatalog({ models: [{ slug: "official", priority: 5 }, { slug: "qoder-intl/old" }] }, { models: [entry] });
  assert.deepEqual(merged.models.map((item) => item.slug), ["official", "qoder-intl/qfmodel"]);
  assert.ok(merged.models[1]!.priority! > 5);
});

test("Qoder 目录损坏或重复模型时拒绝整份数据，空目录是有效下线结果", () => {
  for (const value of [null, {}, { chat: "wrong" }, { chat: [null] }, { chat: [model("a/b")] }, { chat: [model(), model()] }]) {
    assert.throws(() => parseQoderCatalogData(value), /目录格式错误/);
  }
  assert.deepEqual(parseQoderCatalogData({ chat: [] }), []);
});

test("Qoder 推理档位来自目录并排序，Flash 默认中而 Max 默认超高", () => {
  const catalog = buildQoderCatalog(parseQoderCatalogData({ chat: [
    model("qfmodel", { thinking_config: { enabled: { is_default: true,
      efforts: { xhigh: {}, low: {}, medium: { is_default: true }, unsupported: {} } }, disabled: {} } }),
    model("qmodel_38max", { thinking_config: { enabled: { is_default: true,
      efforts: { xhigh: { is_default: true }, low: {}, medium: {} } }, disabled: {} } }),
  ] }));
  for (const entry of catalog.models) {
    assert.deepEqual(entry.supported_reasoning_levels, ["low", "medium", "xhigh"].map((effort) => ({ effort, description: "" })));
  }
  assert.equal(catalog.models[0]!.default_reasoning_level, "medium");
  assert.equal(catalog.models[1]!.default_reasoning_level, "xhigh");
});

test("Qoder 上下文使用账号目录最大档位，原始默认输入限制独立保留", () => {
  const entry = buildQoderCatalog(parseQoderCatalogData({ chat: [model("qfmodel", {
    max_input_tokens: 180_000,
    context_config: { "1M": { token_count: 1_000_000 }, "200K": { token_count: 200_000, is_default: true }, "400K": { token_count: 400_000 } },
  })] })).models[0]!;
  assert.equal(entry.context_window, 1_000_000);
  assert.equal(entry.max_context_window, 1_000_000);
  assert.equal(entry.effective_context_window_percent, 95);
  assert.equal(qoderModelConfig(entry).max_input_tokens, 180_000);
  const smaller = buildQoderCatalog(parseQoderCatalogData({ chat: [model("smaller", {
    max_input_tokens: 180_000, context_config: { "200K": { token_count: 200_000 }, "400K": { token_count: 400_000 } },
  })] })).models[0]!;
  assert.equal(smaller.context_window, 400_000);
  const missing = buildQoderCatalog(parseQoderCatalogData({ chat: [model("unknown", { max_input_tokens: undefined })] })).models[0]!;
  assert.equal(missing.context_window, undefined);
});

test("Qoder 倍率显示以 price_factor 为准，不因 is_free 标志误标非零倍率为免费", () => {
  const catalog = buildQoderCatalog(parseQoderCatalogData({ chat: [
    model("qfmodel", { price_factor: 0, is_free: true }),
    model("qmodel_38max", { display_name: "Qwen3.8-Max", price_factor: 0.5, is_free: true }),
    model("missing-rate", { is_free: true }),
    model("bad-rate", { price_factor: -1 }),
  ] }));
  assert.equal(catalog.models[0]!.display_name, "Qoder-INTL/Qwen3.8-Flash (free)");
  assert.equal(catalog.models[1]!.display_name, "Qoder-INTL/Qwen3.8-Max (x0.5)");
  assert.equal(catalog.models[2]!.display_name, "Qoder-INTL/Qwen3.8-Flash");
  assert.equal(catalog.models[3]!.display_name, "Qoder-INTL/Qwen3.8-Flash");
});

test("Qoder 目录按 100 秒 TTL 单飞刷新，原子缓存不保存凭据，目录变更过期 Codex 缓存", async () => {
  const directory = temporaryDirectory();
  try {
    let time = 1_000;
    let calls = 0;
    let raw = { chat: [model()] };
    const codexFile = path.join(directory, "codex-models.json");
    fs.writeFileSync(codexFile, JSON.stringify({ models: [], fetched_at: "2026-10-02T00:00:00Z", client_version: "1" }));
    const store = createQoderCatalogStore({ cacheDirectory: directory, credentials: async () => credential(),
      now: () => time, codexModelsCacheFile: codexFile,
      fetchCatalog: async () => { calls++; await Promise.resolve(); return raw; } });
    await Promise.all([store.catalog(), store.catalog(), store.catalog()]);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(fs.readFileSync(codexFile, "utf8")).client_version, "0.0.0");
    const diskFile = path.join(directory, "qoder-intl-catalog.json");
    const disk = fs.readFileSync(diskFile, "utf8");
    assert.equal(/SENTINEL|secret-info|secret-key|account-one/.test(disk), false);
    assert.equal(fs.statSync(diskFile).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(directory).some((file) => file.endsWith(".tmp")), false);
    const catalog = await store.catalog();
    catalog.models[0]!.slug = "changed-by-caller";
    assert.equal((await store.catalog()).models[0]!.slug, "qoder-intl/qfmodel");
    time += 99_999;
    await store.catalog();
    assert.equal(calls, 1);
    time++;
    await store.catalog();
    assert.equal(calls, 2);
    fs.writeFileSync(codexFile, JSON.stringify({ models: [], client_version: "untouched" }));
    await store.refresh();
    assert.equal(JSON.parse(fs.readFileSync(codexFile, "utf8")).client_version, "untouched");
    raw = { chat: [] };
    await store.refresh();
    assert.deepEqual((await store.catalog()).models, []);
    assert.equal(JSON.parse(fs.readFileSync(codexFile, "utf8")).client_version, "0.0.0");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Qoder 拉取失败保留相同账号 last-good 并退避，账号切换不能复用旧目录", async () => {
  const directory = temporaryDirectory();
  try {
    let identity = "one";
    let time = 1_000;
    let failed = false;
    let calls = 0;
    const store = createQoderCatalogStore({ cacheDirectory: directory, credentials: async () => credential(identity),
      now: () => time, fetchCatalog: async () => { calls++; if (failed) throw new Error("secret failure"); return { chat: [model()] }; } });
    await store.catalog();
    failed = true;
    time += 100_000;
    assert.equal((await store.catalog()).models.length, 1);
    assert.equal(calls, 2);
    await store.catalog();
    assert.equal(calls, 2);
    const restarted = createQoderCatalogStore({ cacheDirectory: directory, credentials: async () => credential(identity),
      now: () => time, fetchCatalog: async () => { throw new Error("offline"); } });
    assert.equal((await restarted.catalog()).models.length, 1);
    identity = "two";
    await assert.rejects(store.catalog(), /没有当前账号/);
    await assert.rejects(restarted.catalog(), /没有当前账号/);
    failed = false;
    await store.refresh();
    assert.equal((await store.catalog()).models.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Qoder 目录首次失败或损坏缓存不产生内置模型，登录缺失与损坏分别处理", async () => {
  const directory = temporaryDirectory();
  try {
    fs.writeFileSync(path.join(directory, "qoder-intl-catalog.json"), "broken");
    let current: QoderCredentials | null = credential();
    let credentialFailure = false;
    const store = createQoderCatalogStore({ cacheDirectory: directory,
      credentials: async () => { if (credentialFailure) throw new Error("登录损坏，请运行 qoder login"); return current; },
      fetchCatalog: async () => { throw new Error("upstream secret"); } });
    await assert.rejects(store.catalog(), /没有当前账号/);
    current = null;
    assert.deepEqual((await store.catalog()).models, []);
    credentialFailure = true;
    await assert.rejects(store.catalog(), /登录损坏/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Qoder 上游请求期间切换账号不能把旧账号结果返回给新账号", async () => {
  const directory = temporaryDirectory();
  try {
    let current = credential("first");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = createQoderCatalogStore({ cacheDirectory: directory, credentials: async () => current,
      fetchCatalog: async () => { await gate; return { chat: [model()] }; } });
    const pending = store.catalog();
    await Promise.resolve();
    current = credential("second");
    release!();
    await assert.rejects(pending, /没有当前账号/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Qoder 缓存内容损坏即丢弃，强制刷新绕过失败退避", async () => {
  const directory = temporaryDirectory();
  try {
    const base = createQoderCatalogStore({ cacheDirectory: directory, credentials: async () => credential(),
      fetchCatalog: async () => ({ chat: [model()] }) });
    await base.catalog();
    const file = path.join(directory, "qoder-intl-catalog.json");
    const cache = JSON.parse(fs.readFileSync(file, "utf8"));
    cache.models[0].slug = "qoder-intl/untrusted";
    fs.writeFileSync(file, JSON.stringify(cache));
    let calls = 0;
    let fails = true;
    const restarted = createQoderCatalogStore({ cacheDirectory: directory, credentials: async () => credential(),
      fetchCatalog: async () => { calls++; if (fails) throw new Error("offline"); return { chat: [model()] }; } });
    await assert.rejects(restarted.catalog(), /没有当前账号/);
    await assert.rejects(restarted.catalog(), /没有当前账号/);
    assert.equal(calls, 1);
    fails = false;
    await restarted.refresh();
    assert.equal(calls, 2);
    assert.deepEqual((await restarted.catalog()).models.map((entry) => entry.slug), ["qoder-intl/qfmodel"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Qoder 强制刷新并发合并，启动刷新跟随当前请求完成", async () => {
  const directory = temporaryDirectory();
  try {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = createQoderCatalogStore({ cacheDirectory: directory, credentials: async () => credential(),
      fetchCatalog: async () => { calls++; await gate; return { chat: [model()] }; } });
    const first = store.refresh();
    const others = [store.refresh(), store.refresh(), store.catalog()];
    release!();
    await Promise.all([first, ...others]);
    assert.equal(calls, 1);
    assert.equal((await store.catalog()).models.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
