import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import codexClientModels from "../../models/codex_client_models.json";
import { atomicWrite } from "../toml.ts";
import { invalidateModelsCache, parseCodexCatalog } from "../catalog.ts";
import type { ModelCatalog, ModelEntry } from "../types.ts";
import type { CodebuddyCredential, CodebuddyProfile } from "./credentials.ts";
import { profileProduct, profileRegion } from "./credentials.ts";
import { buildCodebuddyCatalogHeaders, catalogRevision } from "./request-context.ts";

/**
 * CodeBuddy/WorkBuddy 官方目录：`GET {endpoint}/v3/config` 拉取，按 serves scope
 * 交集筛选后合成为 Codex 目录条目。缓存键带 profile + 版本修订 + 账号身份，双指纹
 * （source_hash + content_hash）任一不符或超过 TTL 即重建；缓存文件不含任何凭据。
 */

export const CODEBUDDY_PREFIX = "codebuddy/";
export const WORKBUDDY_PREFIX = "workbuddy/";

export interface CodebuddyModelRoute {
  product: "cli" | "work";
  region: "cn" | "intl";
}

const MODEL_ROUTES: Array<{ prefix: string } & Required<CodebuddyModelRoute>> = [
  { prefix: "workbuddy-intl/", product: "work", region: "intl" },
  { prefix: "workbuddy-cn/", product: "work", region: "cn" },
  { prefix: "codebuddy-intl/", product: "cli", region: "intl" },
  { prefix: "codebuddy-cn/", product: "cli", region: "cn" },
];

export function isCodebuddyModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const lower = model.toLowerCase();
  // 旧前缀也要识别为 CodeBuddy 族，保证被本地 400 拦截而不是透传官方后端。
  return codebuddyModelRoute(model) !== undefined
    || lower.startsWith(CODEBUDDY_PREFIX)
    || lower.startsWith(WORKBUDDY_PREFIX);
}

export function codebuddyFamilyPrefix(profile: CodebuddyProfile): string {
  const product = profileProduct(profile) === "work" ? "workbuddy" : "codebuddy";
  return `${product}-${profileRegion(profile)}/`;
}

/** 模型前缀 → 产品与地域路由；地域是 slug 的一部分，不接受旧的无地域前缀。 */
export function codebuddyModelRoute(model: unknown): CodebuddyModelRoute | undefined {
  if (typeof model !== "string") return;
  const lower = model.toLowerCase();
  return MODEL_ROUTES.find(({ prefix }) => lower.startsWith(prefix));
}

export function codebuddyModelProduct(model: unknown): "cli" | "work" | undefined {
  return codebuddyModelRoute(model)?.product;
}

export function codebuddyModelRegion(model: unknown): "cn" | "intl" | undefined {
  return codebuddyModelRoute(model)?.region;
}

/** 目录缓存文件按产品×地域命名：`codebuddy-intl-catalog.json`、`workbuddy-cn-catalog.json` 等。 */
export function codebuddyCatalogFileName(profile: CodebuddyProfile): string {
  const product = profileProduct(profile) === "work" ? "workbuddy" : "codebuddy";
  return `${product}-${profileRegion(profile)}-catalog.json`;
}

/** 前缀族 → 裸模型 ID；档位模型原样透传，不做本地展开。 */
export function codebuddyUpstreamModel(model: string): string | undefined {
  const route = codebuddyModelRoute(model);
  if (!route) return;
  const prefix = MODEL_ROUTES.find((candidate) => candidate.product === route.product
    && candidate.region === route.region)!.prefix;
  const bare = model.slice(prefix.length);
  return bare || undefined;
}

/** 免费检测与倍率解析共用同一常量，防止 display 与路由判定不一致。 */
export const CREDITS_PATTERN = /^x\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?$/i;

/** 倍率解析：缺失或格式异常返回 undefined（显示层不加后缀、绝不阻断目录构建）。 */
export function creditsMultiplier(credits: unknown): string | undefined {
  if (typeof credits !== "string") return;
  return CREDITS_PATTERN.exec(credits.trim())?.[1];
}

export function isFreeCredits(credits: unknown): boolean {
  const multiplier = creditsMultiplier(credits);
  return multiplier !== undefined && Number(multiplier) === 0;
}

/**
 * 产品×地域展示标签：`INTL-C/GPT-5.6-Luna (x0.14)`、`CN-W/Auto (free)`。
 * W 表示 WorkBuddy（work 产品），C 表示 CodeBuddy CLI（cli 产品）；两族同名模型
 * 只在 display_name 上区分，Codex 选择框据此避免出现无法分辨的重复条目。
 */
export function displayLabel(profile: CodebuddyProfile): string {
  const region = profileRegion(profile) === "intl" ? "INTL" : "CN";
  const product = profileProduct(profile) === "work" ? "W" : "C";
  return `${region}-${product}`;
}

/** 产品×地域标签 + 倍率并入 display_name；倍率缺失时不加括号后缀（不阻断目录构建）。 */
export function displayNameWithCredits(name: string, credits: unknown, profile: CodebuddyProfile): string {
  const label = `${displayLabel(profile)}/${name}`;
  if (isFreeCredits(credits)) return `${label} (free)`;
  const multiplier = creditsMultiplier(credits);
  // 回填 match[1] 原始字符串，避免浮点尾迹（x0.79 不变成 x0.79…）。
  return multiplier === undefined ? label : `${label} (x${multiplier})`;
}

const CODEX_SNAPSHOT = parseCodexCatalog(codexClientModels);
const BASE_SLUG = "gpt-5.5";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** 上游失败后的冷却窗口：请求驱动刷新在此期间复用 last-good，避免持续重打故障端点。 */
const CATALOG_FAILURE_COOLDOWN_MS = 30 * 1000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * 服务端档位模型（Auto/auto/Fast/Balanced/Primary/Deep）：只做 Codex 模型选择框展示用，
 * 后端由服务端解析；从网关目录中过滤，避免与具体模型并列出现。
 */
const TIER_MODEL_IDS = new Set(["default-model", "auto", "fast-model", "balanced-model", "primary-model", "deep-model"]);

type ScopeModel = Record<string, unknown>;

/** /v3/config 的 data 部分：models 全集 + agents 选择器 + 可选 availableModels 过滤。 */
export interface CodebuddyConfigData {
  models: ScopeModel[];
  pickerIds: string[];
}

class CodebuddyCatalogError extends Error {}

function invalidCatalog(field: string): never {
  throw new CodebuddyCatalogError(`模型配置接口返回格式错误: ${field}`);
}

function text(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

/**
 * scope 语义对齐 codebuddy2api 的 select_product_models：
 * picker = cli/workbuddy 选择器引用的子集；account（serves）= 全量 models。
 */
export function parseCodebuddyConfigData(data: unknown, product: "cli" | "workbuddy"): CodebuddyConfigData {
  if (!data || typeof data !== "object" || !Array.isArray((data as { models?: unknown }).models)) {
    invalidCatalog("data.models");
  }
  const models = (data as { models: unknown[] }).models.filter((entry): entry is ScopeModel =>
    entry !== null && typeof entry === "object");
  const byId = new Map<string, ScopeModel>();
  const byName = new Map<string, ScopeModel>();
  const byAlias = new Map<string, ScopeModel>();
  for (const model of models) {
    if (!model || typeof model !== "object" || !text((model as ScopeModel).id)) invalidCatalog("data.models.id");
    const entry = model as ScopeModel;
    const id = entry.id as string;
    if (byId.has(id)) invalidCatalog("data.models.id duplicate");
    byId.set(id, entry);
    if (text(entry.name) && !byName.has(entry.name as string)) byName.set(entry.name as string, entry);
    if (Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) {
        if (!text(alias)) invalidCatalog("data.models.aliases");
        if (!byAlias.has(alias as string)) byAlias.set(alias as string, entry);
      }
    }
  }
  const available = (data as { availableModels?: unknown }).availableModels;
  if (available !== undefined && (!Array.isArray(available) || !available.every(text))) {
    invalidCatalog("data.availableModels");
  }
  const availableSet = available === undefined ? undefined : new Set(available as string[]);

  let agent: ScopeModel | undefined;
  const agents = (data as { agents?: unknown }).agents;
  if (product === "workbuddy" && Array.isArray(agents)) {
    const entries = agents.filter((item): item is ScopeModel => item !== null && typeof item === "object");
    agent = entries.find((item) => Array.isArray(item.tags) && item.tags.includes("default"))
      ?? entries.find((item) => item.name === "cli")
      ?? entries.find((item) => Array.isArray(item.models) && item.models.length > 0);
  } else if (Array.isArray(agents)) {
    agent = agents.find((item): item is ScopeModel =>
      item !== null && typeof item === "object" && (item as ScopeModel).name === "cli");
  }

  const pickerIds: string[] = [];
  const seen = new Set<string>();
  const references = agent !== undefined && Array.isArray(agent.models) ? agent.models : undefined;
  if (references !== undefined) {
    for (const reference of references) {
      const keys = typeof reference === "string" ? [reference]
        : reference !== null && typeof reference === "object"
          ? ["id", "name"].filter((key) => text((reference as ScopeModel)[key])).map((key) => (reference as ScopeModel)[key] as string)
          : invalidCatalog("data.agents.models reference");
      const model = keys.map((key) => byId.get(key) ?? byName.get(key) ?? byAlias.get(key)).find(Boolean);
      if (model === undefined) continue;
      const id = model.id as string;
      if (!seen.has(id)) { seen.add(id); pickerIds.push(id); }
    }
    if (references.length > 0 && pickerIds.length === 0) invalidCatalog("data.agents.models unresolved");
  }
  const usable = (entry: ScopeModel): boolean =>
    entry.disabled !== true
    && entry.supportsToolCall === true
    && (availableSet === undefined || availableSet.has(entry.id as string));
  return { models: models.filter(usable), pickerIds };
}

function cloneCodexBase(id: string, priority: number): ModelEntry {
  const base = CODEX_SNAPSHOT.models.find((model) => model.slug === BASE_SLUG);
  if (!base) throw new CodebuddyCatalogError(`codex_client_models 快照缺少 ${BASE_SLUG} 基底条目`);
  const model = structuredClone(base);
  model.slug = id;
  model.display_name = id;
  model.description = `CodeBuddy model "${id}" served by the local credential.`;
  // 对齐 synthesizeModelEntry 的兜底行为：解除基底条目的最低客户端版本限制。
  delete model.minimal_client_version;
  model.priority = priority;
  return model;
}

/** ①~④ 字段映射（见执行计划决策记录）：改名直用 + 结构 reshape + Codex 行为基底 + CB 特有字段。 */
export function synthesizeCodebuddyEntry(entry: ScopeModel, priority: number, profile: CodebuddyProfile): ModelEntry {
  const id = entry.id as string;
  const model = cloneCodexBase(id, priority);
  const reasoning = entry.reasoning !== null && typeof entry.reasoning === "object" && !Array.isArray(entry.reasoning)
    ? entry.reasoning as Record<string, unknown>
    : undefined;
  model.display_name = displayNameWithCredits(
    text(entry.name) ? (entry.name as string).trim() : id,
    entry.credits,
    profile,
  );
  const description = text(entry.descriptionZh) ? entry.descriptionZh : text(entry.descriptionEn) ? entry.descriptionEn : undefined;
  if (description !== undefined) model.description = description as string;
  if (typeof entry.maxInputTokens === "number" && entry.maxInputTokens > 0) {
    model.context_window = entry.maxInputTokens;
    model.max_context_window = entry.maxInputTokens;
  }
  model.supports_reasoning_summaries = entry.supportsReasoning === true;
  if (typeof reasoning?.summary === "string" && reasoning.summary) model.default_reasoning_summary = reasoning.summary;
  else delete model.default_reasoning_summary;
  const defaultEffort = typeof reasoning?.defaultEffort === "string" && reasoning.defaultEffort.trim()
    ? reasoning.defaultEffort.trim()
    : typeof reasoning?.effort === "string" && reasoning.effort.trim() ? reasoning.effort.trim() : undefined;
  if (defaultEffort !== undefined) model.default_reasoning_level = defaultEffort;
  else delete model.default_reasoning_level;
  // 上游仅声明默认档位时仍应让客户端可选；完整列表优先，不推断其他档位。
  const efforts = Array.isArray(reasoning?.supportedEfforts) && reasoning.supportedEfforts.length > 0 && reasoning.supportedEfforts.every(text)
    ? reasoning.supportedEfforts as string[]
    : defaultEffort !== undefined ? [defaultEffort] : [];
  model.supported_reasoning_levels = efforts.map((effort) => ({ effort, description: "" }));
  model.input_modalities = entry.supportsImages === true ? ["text", "image"] : ["text"];
  if (entry.supportsToolCall === true) model.supports_parallel_tool_calls = true;
  else delete model.supports_parallel_tool_calls;
  // CB 特有字段存 index signature 供适配器私有使用；vendor 与 tags 丢弃。
  if (typeof entry.credits === "string") model.credits = entry.credits;
  for (const [source, target] of [["maxOutputTokens", "maxOutputTokens"], ["maxAllowedSize", "maxAllowedSize"], ["temperature", "temperature"], ["top_p", "top_p"]] as const) {
    const value = entry[source];
    if (value !== undefined) (model as Record<string, unknown>)[target] = value;
  }
  if (entry.relatedModels !== null && typeof entry.relatedModels === "object") model.relatedModels = entry.relatedModels;
  return model;
}

/**
 * serves scope 交集：picker 引用的条目必须同时出现在账号可服务清单（同一 models
 * 全集）内，倍率等元数据取 serves 条目；避免把展示价或不可服务模型并入 Codex 目录。
 * 服务端档位模型（*-model）只作展示用途，一并过滤。
 */
export function buildCodebuddyCatalog(data: CodebuddyConfigData, profile: CodebuddyProfile): ModelCatalog {
  const serves = new Map(data.models.map((entry) => [entry.id as string, entry]));
  const entries: ModelEntry[] = [];
  for (const id of data.pickerIds) {
    if (TIER_MODEL_IDS.has(id.toLowerCase())) continue;
    const entry = serves.get(id);
    if (entry) entries.push(synthesizeCodebuddyEntry(entry, entries.length, profile));
  }
  return { models: entries };
}

/** /models 按当前 profile 加带地域的前缀族（如 codebuddy-intl/、workbuddy-cn/）。 */
export function projectCodebuddyCatalog(catalog: ModelCatalog, profile: CodebuddyProfile): ModelCatalog {
  const prefix = codebuddyFamilyPrefix(profile);
  return { models: catalog.models.map((entry) => ({ ...entry, slug: `${prefix}${entry.slug}` })) };
}

/**
 * 条目排序值：cli 族优先于 work 族，其后按倍率升序。倍率缺失或格式异常排最后——
 * 拿不到倍率时无法证明它更便宜，宁可让已知更便宜的条目胜出。
 */
function codebuddyRank(model: ModelEntry): [number, number] {
  const family = codebuddyModelProduct(model.slug) === "work" ? 1 : 0;
  const multiplier = creditsMultiplier(model.credits);
  // 免费即 x0，倍率升序天然把它排在最前，无需单独判定。
  return [family, multiplier === undefined ? Number.POSITIVE_INFINITY : Number(multiplier)];
}

function preferCodebuddyEntry(candidate: ModelEntry, current: ModelEntry): boolean {
  const [candidateFamily, candidateCredits] = codebuddyRank(candidate);
  const [currentFamily, currentCredits] = codebuddyRank(current);
  if (candidateFamily !== currentFamily) return candidateFamily < currentFamily;
  return candidateCredits < currentCredits;
}

/**
 * 同地域两个前缀族的同名模型去重：cli 族与 work 族经同地域回退共用一份登录时，两边会拉到
 * 同一批上游模型（slug 前缀不同、裸 ID 相同），Codex 选择框将出现重名条目。此处按
 * 裸 ID 合并，保留「cli 优先 → 倍率低优先（免费即 x0 最前）」的那一条；只出现在单侧
 * 的模型（如 work 独有的 `hy4-preview-f`）原样保留，非本族条目不参与去重。
 */
export function dedupeCodebuddyCatalog(catalog: ModelCatalog): ModelCatalog {
  const models: ModelEntry[] = [];
  const indexByKey = new Map<string, number>();
  for (const model of catalog.models) {
    const bare = codebuddyUpstreamModel(model.slug);
    if (bare === undefined) {
      models.push(model);
      continue;
    }
    const key = `${codebuddyModelRegion(model.slug)}:${bare.toLowerCase()}`;
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, models.length);
      models.push(model);
    } else if (preferCodebuddyEntry(model, models[index]!)) {
      models[index] = model;
    }
  }
  return { models };
}

/**
 * 启用 CodeBuddy 时保留两个顶层命名空间，防止上游同名条目与 CodeBuddy 目录冲突。
 * 两个前缀族的同名模型在此去重（cli 优先 → 免费/低倍率优先）：回退共用登录时两族
 * 内容高度重合，不去重会在 Codex 选择框出现同名条目。去重只作用于本函数产出的
 * 展示目录，适配器内部仍保留完整 slug 集合做 serves 校验，被隐藏的 work 条目仍可请求。
 */
export function mergeCodebuddyCatalog(base: ModelCatalog, codebuddy: ModelCatalog): ModelCatalog {
  const models = base.models.filter((model) => !isCodebuddyModel(model.slug));
  const priority = Math.max(0, ...models.map((model) => Number(model.priority) || 0)) + 100;
  const deduped = dedupeCodebuddyCatalog(codebuddy).models;
  return { models: [...models, ...deduped.map((model, index) => ({ ...model, priority: priority + index }))] };
}

interface CacheFile {
  cache_key?: unknown;
  fetched_at?: unknown;
  source_hash?: unknown;
  content_hash?: unknown;
  models?: unknown;
}

export interface CodebuddyCatalogStoreOptions {
  /** 缓存目录；每个产品×地域接口各写一个 `{codebuddy|workbuddy}-{cn|intl}-catalog.json`。 */
  cacheDirectory: string;
  /** 每个可用产品接口的凭据清单（按前缀产品选出的接口凭据，含同地域回退）。 */
  credentials: () => Promise<CodebuddyCredential[]>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Codex 自己的目录缓存；目录内容变化时过期它，让 Codex 重新拉取 /models。 */
  codexModelsCacheFile?: string;
  now?: () => number;
  ttlMs?: number;
}

interface CachedCatalog {
  key: string;
  fetchedAt: number;
  models: ModelEntry[];
}

interface CatalogFamily {
  credential: CodebuddyCredential;
  key: string;
  profile: CodebuddyProfile;
}

/**
 * 目录存储：每个产品×地域接口独立的双指纹磁盘缓存 + TTL + 单飞刷新；拉取失败回退
 * 该接口的 last-good 缓存，单个接口失败不拖垮其余接口的目录族。
 */
export function createCodebuddyCatalogStore(options: CodebuddyCatalogStoreOptions) {
  const fetchUpstream = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(60_000, options.ttlMs ?? CATALOG_TTL_MS);
  const cached = new Map<CodebuddyProfile, CachedCatalog>();
  const retryAt = new Map<CodebuddyProfile, number>();
  let refreshing: Promise<void> | undefined;
  let refreshingForce = false;
  let pendingForce = false;

  function cacheKey(credential: CodebuddyCredential): { profile: CodebuddyProfile; revision: string; identity: string; key: string } {
    // 账号身份用不可逆摘要，缓存文件不含任何凭据。
    const identity = createHash("sha256").update(JSON.stringify([credential.profile, credential.accountUid, credential.enterpriseId])).digest("hex");
    const profile = credential.profile;
    const revision = catalogRevision(profile);
    // 合成规则变化无需另设结构版本：适配器启动即强制刷新（refresh() 绕过 TTL），
    // 代码更新必然伴随进程重启，缓存会在启动时按新规则整体重建。
    return { profile, revision, identity, key: digest({ profile, revision, identity }) };
  }

  function cacheFile(profile: CodebuddyProfile): string {
    return path.join(options.cacheDirectory, codebuddyCatalogFileName(profile));
  }

  function readDisk(profile: CodebuddyProfile, key: string): CachedCatalog | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile(profile), "utf8")) as CacheFile;
      if (parsed.cache_key !== key || typeof parsed.fetched_at !== "number" || !Array.isArray(parsed.models)) return;
      const models = parsed.models as ModelEntry[];
      if (parsed.content_hash !== digest(models)) return;
      return { key, fetchedAt: parsed.fetched_at, models };
    } catch { /* 缺失或损坏的缓存按未命中处理。 */ }
  }

  function writeDisk(profile: CodebuddyProfile, value: CachedCatalog, sourceHash: string, previous: ModelEntry[] | undefined): void {
    try {
      atomicWrite(cacheFile(profile), `${JSON.stringify({
        cache_key: value.key,
        fetched_at: value.fetchedAt,
        source_hash: sourceHash,
        content_hash: digest(value.models),
        models: value.models,
      }, null, 2)}\n`);
    } catch { /* 缓存写失败不影响本次目录返回。 */ }
    if (previous === undefined || digest(previous) !== digest(value.models)) {
      // 目录内容变化会改变 Codex 能看到的模型列表：过期它自己的目录缓存。
      if (options.codexModelsCacheFile) invalidateModelsCache(options.codexModelsCacheFile);
    }
  }

  async function fetchUpstreamCatalog(credential: CodebuddyCredential): Promise<ModelEntry[]> {
    const response = await fetchUpstream(`${credential.endpoint}/v3/config`, {
      method: "GET",
      headers: buildCodebuddyCatalogHeaders(credential),
      redirect: "manual",
    });
    if (!response.ok) throw new CodebuddyCatalogError(`模型配置接口返回 HTTP ${response.status}`);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new CodebuddyCatalogError("模型配置接口返回无法解析"); }
    if (!payload || typeof payload !== "object" || (payload as { code?: unknown }).code !== 0) {
      throw new CodebuddyCatalogError("模型配置接口返回非成功状态");
    }
    const product = profileProduct(credential.profile) === "work" ? "workbuddy" : "cli";
    const data = parseCodebuddyConfigData((payload as { data?: unknown }).data, product);
    return buildCodebuddyCatalog(data, credential.profile).models;
  }

  async function families(): Promise<Map<CodebuddyProfile, CatalogFamily>> {
    const credentials = await options.credentials();
    // 按 interface profile 去重（同 profile 只保留一份目录族）。
    const result = new Map<CodebuddyProfile, CatalogFamily>();
    for (const credential of credentials) {
      if (result.has(credential.profile)) continue;
      const { key } = cacheKey(credential);
      result.set(credential.profile, { credential, key, profile: credential.profile });
    }
    return result;
  }

  /** 每个接口独立刷新；任一接口失败都保留该接口的 last-good，不影响其他目录族。 */
  async function refreshFamilies(targets: CatalogFamily[]): Promise<void> {
    for (const { credential, key, profile } of targets) {
      try {
        const models = await fetchUpstreamCatalog(credential);
        const previous = cached.get(profile)?.key === key ? cached.get(profile)!.models : undefined;
        cached.set(profile, { key, fetchedAt: now(), models });
        retryAt.delete(profile);
        writeDisk(profile, cached.get(profile)!, digest({ key, revision: catalogRevision(profile) }), previous);
      } catch {
        // 拉取失败回退该接口的 last-good（允许陈旧）；完全无缓存的接口跳过其目录族。
        retryAt.set(profile, now() + CATALOG_FAILURE_COOLDOWN_MS);
        const existing = cached.get(profile);
        const fallback = readDisk(profile, key)
          ?? (existing !== undefined && existing.key === key ? existing : undefined);
        if (fallback) cached.set(profile, fallback);
      }
    }
  }

  /**
   * 强制刷新会绕过 TTL，但仍复用同一个单飞 Promise：启动刷新、定时刷新与请求驱动
   * 刷新同时发生时，只会有一次上游请求。`force` 只影响本次是否需要重新拉取。
   */
  async function refreshOnce(force: boolean): Promise<void> {
    const allFamilies = await families();
    if (allFamilies.size === 0) return;
    const fresh = (value: CachedCatalog): boolean => now() - value.fetchedAt < ttlMs;
    const targets: CatalogFamily[] = [];
    for (const family of allFamilies.values()) {
      const { key, profile } = family;
      if (!cached.has(profile)) {
        const disk = readDisk(profile, key);
        if (disk) cached.set(profile, disk);
      }
      const current = cached.get(profile);
      const cooling = !force && (retryAt.get(profile) ?? 0) > now();
      if (!cooling && (force || !current || current.key !== key || !fresh(current))) targets.push(family);
    }
    if (targets.length > 0) await refreshFamilies(targets);
  }

  async function refresh(force: boolean): Promise<void> {
    if (refreshing) {
      // 普通刷新进行中被强制请求追赶时，等当前轮结束后再补一轮；若当前已经是强制
      // 刷新则直接合并，保证启动、定时与请求驱动不会重复打上游。
      if (force && !refreshingForce) pendingForce = true;
      return refreshing;
    }
    refreshingForce = force;
    refreshing = (async () => {
      let nextForce = force;
      do {
        pendingForce = false;
        refreshingForce = nextForce;
        await refreshOnce(nextForce);
        nextForce = pendingForce;
      } while (nextForce);
    })().finally(() => {
      refreshing = undefined;
      refreshingForce = false;
      pendingForce = false;
    });
    return refreshing;
  }

  return {
    async catalog(): Promise<ModelCatalog> {
      await refresh(false);
      const allFamilies = await families();
      if (allFamilies.size === 0) return { models: [] };
      const models: ModelEntry[] = [];
      let served = 0;
      for (const [profile, { key }] of allFamilies) {
        // last-good 语义：key 匹配即服务（TTL 只驱动刷新尝试），账号切换后的旧 key 条目不复用。
        const value = cached.get(profile);
        if (!value || value.key !== key) continue;
        served++;
        models.push(...projectCodebuddyCatalog({ models: value.models }, profile).models);
      }
      if (served === 0) throw new Error("CodeBuddy 模型目录拉取失败，且没有可用的本地缓存");
      return { models };
    },
    /** 启动/定时刷新入口：绕过 TTL 重新校验所有可用目录族。 */
    async refresh(): Promise<void> {
      await refresh(true);
    },
  };
}
