import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import codexClientModels from "../../models/codex_client_models.json";
import { invalidateModelsCache, parseCodexCatalog, withAgentSystemPrompt } from "../catalog.ts";
import { atomicWrite } from "../toml.ts";
import type { ModelCatalog, ModelEntry } from "../types.ts";
import { AGY_AGENT_SYSTEM_PROMPT, AGY_ENDPOINT } from "./transport.ts";
import { THINKING_LEVELS } from "./request.ts";
import type { AgyCredentials } from "./credentials.ts";

/**
 * Antigravity 模型目录：`POST /v1internal:fetchAvailableModels` 拉取，以 `models`
 * map 合成 `agy/` 前缀的 Codex 目录条目；`deprecatedModelIds` 提供旧 id 到新 id 的
 * 服务端重定向。多档位家族（同一基名的 high/medium/low 变体）在目录中合并为一个
 * `agy/<base>` 条目，转发时按 reasoning.effort 解析具体上游模型。缓存键带账号身份
 * 与端点摘要；缓存文件不含任何凭据。
 */

export const AGY_PREFIX = "agy/";
/** 显示名前缀：与路由 slug 区分的大写标签（对齐 CodeBuddy 的 CB-/WB- 风格）。 */
export const AGY_DISPLAY_PREFIX = "AGY/";
/** 目录缓存修订号：合成规则变化时递增，避免复用旧结构的磁盘缓存
 *  （v2：档位家族合并；v3：levels 按实际档位重建；v4：删 web_search_tool_type；
 *  v5：v3/v4 的字段删除改为保留字段置中性值——缺字段疑似导致 Codex 弃用目录；
 *  v6：系统提示词在合成时替换（base_instructions + model_messages 模板））。 */
const CACHE_REVISION = 6;
const CATALOG_TTL_MS = 6 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 30_000;
const BASE = parseCodexCatalog(codexClientModels).models.find((entry) => entry.slug === "gpt-5.5");
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function isAgyModel(model: unknown): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith(AGY_PREFIX);
}

/** `agy/<model-id>` → 裸模型 ID；不含前缀或前缀后为空返回 undefined。 */
export function agyUpstreamModel(model: string): string | undefined {
  if (!isAgyModel(model)) return undefined;
  const bare = model.slice(AGY_PREFIX.length);
  return bare && !bare.includes("/") ? bare : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export interface AgyModelDetails {
  id: string;
  displayName: string;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsVideo: boolean;
  maxTokens?: number;
}

export type AgyTier = "high" | "medium" | "low";

/**
 * 多档位家族：同一基名（去 `-high/-medium/-low` 后缀）的变体集合。目录只暴露
 * `agy/<base>` 一个条目，具体上游模型由请求的 reasoning.effort 解析；显式档位
 * id（如 `agy/gemini-3.8-flash-high`）仍按成员 id 直连。
 */
export interface AgyModelFamily {
  base: string;
  tiers: Partial<Record<AgyTier, string>>;
  displayName: string;
}

export interface AgyCatalogData {
  models: AgyModelDetails[];
  families: AgyModelFamily[];
  reroute: Map<string, string>;
}

/**
 * 解析 fetchAvailableModels 响应。只消费 models map 与排除清单；图像生成与音频
 * 转写类模型无法走 Responses 文本链路，从目录中剔除。未知字段一律忽略。
 */
export function parseAgyCatalogData(value: unknown): AgyCatalogData {
  const data = record(value);
  const modelsRaw = record(data?.models);
  if (!data || !modelsRaw) throw new Error("Antigravity 模型目录格式错误：缺少 models 映射");
  const strings = (source: unknown): string[] =>
    (Array.isArray(source) ? source : []).filter((id): id is string => typeof id === "string" && id.length > 0);
  // tab 补全与图像/音频专用模型不能走 Responses 文本链路，一律剔除。
  const excluded = new Set<string>([
    ...strings(data.tabModelIds),
    ...strings(data.imageGenerationModelIds),
    ...strings(data.audioTranscriptionModelIds),
  ]);
  // agentModelSorts 是官方选择器的推荐位；tieredModelIds 给出各档位当前指向的具体模型。
  // 两者都存在时目录取其并集（推荐位在前），否则回退 models 全集。
  const agentIds = (Array.isArray(data.agentModelSorts) ? data.agentModelSorts : [])
    .flatMap((sort) => record(sort)?.groups)
    .flatMap((group) => strings(record(group)?.modelIds));
  const tiered = record(data.tieredModelIds) ?? {};
  const tieredIds = Object.values(tiered).filter((id): id is string => typeof id === "string" && id.length > 0);
  const selection = agentIds.length ? [...new Set([...agentIds, ...tieredIds])] : undefined;
  let models: AgyModelDetails[] = [];
  const seen = new Set<string>();
  for (const [id, raw] of Object.entries(modelsRaw)) {
    if (!id.trim() || id !== id.trim() || /[\s/\\]/.test(id)) {
      throw new Error("Antigravity 模型目录格式错误：模型 id 无效");
    }
    if (seen.has(id)) throw new Error("Antigravity 模型目录格式错误：模型 id 重复");
    seen.add(id);
    if (excluded.has(id)) continue;
    if (selection !== undefined && !selection.includes(id)) continue;
    const details = record(raw) ?? {};
    const displayName = typeof details.displayName === "string" && details.displayName.trim()
      ? details.displayName.trim() : id;
    const model: AgyModelDetails = {
      id,
      displayName,
      supportsImages: details.supportsImages === true,
      supportsThinking: details.supportsThinking === true,
      supportsVideo: details.supportsVideo === true,
    };
    if (positiveNumber(details.maxTokens)) model.maxTokens = details.maxTokens;
    models.push(model);
  }
  if (models.length === 0) throw new Error("Antigravity 模型目录格式错误：可用模型为空");
  // 推荐位顺序即展示优先级：有 selection 时按其顺序输出，selection 外的条目已被过滤。
  if (selection !== undefined) {
    const byId = new Map(models.map((model) => [model.id, model]));
    models = selection.flatMap((id) => {
      const model = byId.get(id);
      return model && !excluded.has(id) ? [model] : [];
    });
    if (models.length === 0) throw new Error("Antigravity 模型目录格式错误：可用模型为空");
  }
  const reroute = new Map<string, string>();
  const deprecated = record(data.deprecatedModelIds);
  if (deprecated) {
    for (const [oldId, info] of Object.entries(deprecated)) {
      const target = record(info);
      if (typeof target?.newModelId === "string" && target.newModelId && target.newModelId !== oldId) {
        reroute.set(oldId, target.newModelId);
      }
    }
  }
  // 多档位家族识别：按 `-high/-medium/-low` 后缀分组；仅两个成员以上的组才合并
  // （单档位后缀模型与无后缀模型保持独立），且基名与显式无后缀模型冲突时不合并
  // （避免目录出现重复 slug）。已改名的档位（如 gemini-pro-agent）不强行归族。
  const listed = new Set(models.map((model) => model.id));
  const grouped = new Map<string, Partial<Record<AgyTier, string>>>();
  for (const model of models) {
    const match = /^(.+)-(high|medium|low)$/.exec(model.id);
    if (!match) continue;
    const [, base, tier] = match as unknown as [string, string, AgyTier];
    grouped.set(base, { ...(grouped.get(base) ?? {}), [tier]: model.id });
  }
  const families: AgyModelFamily[] = [];
  for (const [base, tiers] of grouped) {
    if (Object.keys(tiers).length < 2 || listed.has(base)) continue;
    const memberIds = Object.values(tiers).filter((id): id is string => typeof id === "string");
    // 展示名取 medium 成员的显示名（无则首个成员），去掉档位括号后缀。
    const preferred = models.find((model) => model.id === tiers.medium)
      ?? models.find((model) => memberIds.includes(model.id));
    families.push({
      base, tiers,
      displayName: preferred ? preferred.displayName.replace(/\s*\((High|Medium|Low)\)$/, "") : base,
    });
  }
  return { models, families, reroute };
}

/** effort（缺省或未知值）→ 目标档位；与 thinkingLevel 的档位语义一致，缺省 medium。 */
export function agyEffortTier(effort: unknown): AgyTier {
  if (typeof effort !== "string") return "medium";
  return (THINKING_LEVELS[effort] as AgyTier | undefined) ?? "medium";
}

const TIER_FALLBACK: Record<AgyTier, readonly AgyTier[]> = {
  low: ["low", "medium", "high"],
  medium: ["medium", "high", "low"],
  high: ["high", "medium", "low"],
};

/** 家族内按档位解析上游模型 id；目标档缺失时按「就近偏高」回退，家族必有成员。 */
export function resolveAgyFamilyModel(family: AgyModelFamily, effort: unknown): string {
  for (const tier of TIER_FALLBACK[agyEffortTier(effort)]) {
    const id = family.tiers[tier];
    if (typeof id === "string" && id) return id;
  }
  return family.base;
}

/** 基底快照里 low/medium/high 档位的展示文案（复用到家族条目；xhigh/minimal 不沿用）。 */
const BASE_LEVEL_DESCRIPTIONS = new Map(
  (Array.isArray(BASE?.supported_reasoning_levels)
    ? BASE.supported_reasoning_levels as Array<{ effort?: unknown; description?: unknown }>
    : []).filter((level): level is { effort: string; description: string } =>
    typeof level.effort === "string" && typeof level.description === "string")
    .map((level) => [level.effort, level.description]),
);

/** Codex 行为字段沿用 gpt-5.5 快照基底；模型名与能力仅由当前账号目录决定。
 *  多档位家族合并为一个 `agy/<base>` 条目（能力/窗口取成员并集或最大值），
 *  `supported_reasoning_levels` 只列家族实际存在的档位；无档位后缀的模型保持
 *  独立条目且不暴露档位选择。 */
export function buildAgyCatalog(data: AgyCatalogData): ModelCatalog {
  if (!BASE) throw new Error("Codex 模型快照缺少 gpt-5.5 基底条目");
  const familyByMember = new Map<string, AgyModelFamily>();
  for (const family of data.families) {
    for (const id of Object.values(family.tiers)) {
      if (typeof id === "string" && id) familyByMember.set(id, family);
    }
  }
  const toEntry = (
    details: { id: string; displayName: string; supportsImages: boolean; supportsThinking: boolean; maxTokens?: number },
    merged: boolean,
    priority: number,
    tiers: AgyTier[] = [],
  ): ModelEntry => {
    const model = structuredClone(BASE);
    model.slug = `${AGY_PREFIX}${details.id}`;
    model.display_name = `${AGY_DISPLAY_PREFIX}${details.displayName}`;
    model.description = merged
      ? `通过本机 Antigravity CLI 授权调用 ${details.displayName}，reasoning effort 决定档位变体`
      : `通过本机 Antigravity CLI 授权调用 ${details.displayName}`;
    model.priority = priority;
    model.prefer_websockets = false;
    delete model.minimal_client_version;
    model.input_modalities = details.supportsImages ? ["text", "image"] : ["text"];
    model.supports_reasoning_summaries = details.supportsThinking;
    model.supports_reasoning_summary_parameter = false;
    model.supports_image_detail_original = false;
    model.supports_search_tool = false;
    // 上游没有搜索通道：能力由 supports_search_tool=false 关闭。字段本身保留基底的值，
    // 不做删除——Codex 的目录反序列化可能要求字段存在，缺字段会导致整个目录被弃用。
    model.support_verbosity = false;
    model.additional_speed_tiers = [];
    model.service_tiers = [];
    delete model.default_service_tier;
    delete model.default_reasoning_level;
    delete model.default_reasoning_summary;
    // 快照基底的 supported_reasoning_levels 是 OpenAI 风格档位（含 xhigh/minimal），
    // 上游只有 high/medium/low 变体：家族条目必须只列出实际存在的档位，否则客户端
    // 会发出不存在的档位。默认档位与转发侧缺省解析一致（medium → high → low）。
    // 字段一律保留（无档位的条目置空数组），不删除——缺字段可能让 Codex 弃用整个目录。
    if (merged && tiers.length) {
      model.supported_reasoning_levels = tiers.map((tier) => ({
        effort: tier,
        description: BASE_LEVEL_DESCRIPTIONS.get(tier) ?? "",
      }));
      model.default_reasoning_level = tiers.includes("medium") ? "medium"
        : tiers.includes("high") ? "high" : "low";
    } else {
      model.supported_reasoning_levels = [];
      model.default_reasoning_level = "medium";
    }
    // Gemini 系后端支持并行函数调用；目录未声明时按支持处理。
    model.supports_parallel_tool_calls = true;
    if (details.maxTokens !== undefined) {
      model.context_window = details.maxTokens;
      model.max_context_window = details.maxTokens;
      model.effective_context_window_percent = 95;
    } else {
      delete model.context_window;
      delete model.max_context_window;
      delete model.effective_context_window_percent;
    }
    return withAgentSystemPrompt(model, AGY_AGENT_SYSTEM_PROMPT);
  };
  const emitted = new Set<AgyModelFamily>();
  const models: ModelEntry[] = [];
  for (const member of data.models) {
    const family = familyByMember.get(member.id);
    if (family) {
      if (emitted.has(family)) continue;
      emitted.add(family);
      const members = data.models.filter((item) => familyByMember.get(item.id) === family);
      const maxTokens = Math.max(0, ...members.map((item) => item.maxTokens ?? 0));
      models.push(toEntry({
        id: family.base,
        displayName: family.displayName,
        supportsImages: members.some((item) => item.supportsImages),
        supportsThinking: members.some((item) => item.supportsThinking),
        ...(maxTokens > 0 ? { maxTokens } : {}),
      }, true, models.length, orderedTiers(family)));
      continue;
    }
    models.push(toEntry({
      id: member.id,
      displayName: member.displayName,
      supportsImages: member.supportsImages,
      supportsThinking: member.supportsThinking,
      ...(member.maxTokens !== undefined ? { maxTokens: member.maxTokens } : {}),
    }, false, models.length));
  }
  return { models };
}

/** 家族档位按 low → high 排序输出；保证目录展示顺序稳定。 */
function orderedTiers(family: AgyModelFamily): AgyTier[] {
  return (["low", "medium", "high"] as const).filter((tier) => family.tiers[tier] !== undefined);
}

export function mergeAgyCatalog(base: ModelCatalog, agy: ModelCatalog): ModelCatalog {
  const models = base.models.filter((entry) => !isAgyModel(entry.slug));
  const priority = Math.max(0, ...models.map((entry) => Number(entry.priority) || 0)) + 100;
  return { models: [...models, ...agy.models.map((entry, index) => ({ ...entry, priority: priority + index }))] };
}

export interface AgyCatalogStoreOptions {
  cacheDirectory: string;
  credentials: () => Promise<AgyCredentials | null>;
  /** 返回 fetchAvailableModels 的已解码 JSON；认证与超时由传输层负责。 */
  fetchCatalog: (credential: AgyCredentials) => Promise<unknown>;
  codexModelsCacheFile?: string;
  endpoint?: string;
  now?: () => number;
  ttlMs?: number;
}

interface CachedCatalog {
  key: string;
  fetchedAt: number;
  models: ModelEntry[];
  families: AgyModelFamily[];
  reroute: Array<[oldId: string, newId: string]>;
}

interface CacheFile {
  cache_key?: unknown;
  fetched_at?: unknown;
  content_hash?: unknown;
  models?: unknown;
  families?: unknown;
  reroute?: unknown;
}

/**
 * 目录存储：内存 + 磁盘双指纹缓存、TTL、单飞刷新、失败回退 last-good。
 * 账号切换（identity 变化）后旧 key 条目不复用。
 */
export function createAgyCatalogStore(options: AgyCatalogStoreOptions) {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(60_000, options.ttlMs ?? CATALOG_TTL_MS);
  const endpoint = options.endpoint ?? AGY_ENDPOINT;
  const endpointDigest = createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
  const cacheFile = path.join(options.cacheDirectory, "agy-catalog.json");
  let cached: CachedCatalog | undefined;
  let retryAt = 0;
  let refreshing: Promise<void> | undefined;

  const cacheKey = (credential: AgyCredentials): string =>
    digest({ revision: CACHE_REVISION, identity: credential.identity, endpoint: endpointDigest });

  /** 家族结构与模型列表共同构成目录内容：任一变化都需失效 Codex 的目录缓存。 */
  const contentDigest = (value: CachedCatalog): string =>
    digest({ models: value.models, families: value.families });

  /** families 磁盘形状校验：条目不合法视为整体缓存不可用。 */
  function readFamilies(value: unknown): AgyModelFamily[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const families: AgyModelFamily[] = [];
    for (const raw of value) {
      const family = record(raw);
      const tiers = family ? record(family.tiers) : undefined;
      if (!family || typeof family.base !== "string" || !family.base || /[\s/\\]/.test(family.base)
        || typeof family.displayName !== "string" || !family.displayName
        || !tiers || Object.keys(tiers).length === 0
        || !Object.entries(tiers).every(([tier, id]) => ["high", "medium", "low"].includes(tier)
          && typeof id === "string" && id.length > 0)) {
        return undefined;
      }
      families.push({ base: family.base, displayName: family.displayName, tiers });
    }
    return families;
  }

  function readDisk(key: string): CachedCatalog | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as CacheFile;
      if (parsed.cache_key !== key || typeof parsed.fetched_at !== "number" || !Array.isArray(parsed.models)) return;
      const models = parsed.models as ModelEntry[];
      if (parsed.content_hash !== digest({ models, families: parsed.families })) return;
      const families = readFamilies(parsed.families);
      if (!families) return;
      const reroute = Array.isArray(parsed.reroute)
        && parsed.reroute.every((pair) => Array.isArray(pair) && pair.length === 2
          && typeof pair[0] === "string" && typeof pair[1] === "string")
        ? parsed.reroute as Array<[string, string]> : [];
      return { key, fetchedAt: parsed.fetched_at, models, families, reroute };
    } catch { /* 缺失或损坏的缓存按未命中处理。 */ }
  }

  function writeDisk(value: CachedCatalog, previous: CachedCatalog | undefined): void {
    try {
      atomicWrite(cacheFile, `${JSON.stringify({
        cache_key: value.key,
        fetched_at: value.fetchedAt,
        content_hash: contentDigest(value),
        models: value.models,
        families: value.families,
        reroute: value.reroute,
      }, null, 2)}\n`);
    } catch { /* 缓存写失败不影响本次目录返回。 */ }
    if (previous === undefined || contentDigest(previous) !== contentDigest(value)) {
      // 目录内容变化会改变 Codex 能看到的模型列表：过期它自己的目录缓存。
      try {
        if (options.codexModelsCacheFile) invalidateModelsCache(options.codexModelsCacheFile);
      } catch { /* 客户端缓存不可写不影响网关目录服务。 */ }
    }
  }

  async function refreshOnce(force: boolean): Promise<void> {
    const credential = await options.credentials();
    if (!credential) return;
    const key = cacheKey(credential);
    if (!cached) {
      const disk = readDisk(key);
      if (disk) cached = disk;
    }
    if (cached && cached.key !== key) cached = undefined;
    const cooling = !force && retryAt > now();
    if (!cooling && (force || !cached || now() - cached.fetchedAt >= ttlMs)) {
      try {
        const data = parseAgyCatalogData(await options.fetchCatalog(credential));
        const previous = cached;
        cached = {
          key,
          fetchedAt: now(),
          models: buildAgyCatalog(data).models,
          families: data.families,
          reroute: [...data.reroute],
        };
        retryAt = 0;
        writeDisk(cached, previous);
      } catch {
        // 拉取失败回退 last-good（允许陈旧）；完全没有缓存则维持空目录。
        retryAt = now() + FAILURE_COOLDOWN_MS;
        cached ??= readDisk(key);
      }
    }
  }

  async function refresh(force: boolean): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = refreshOnce(force).finally(() => { refreshing = undefined; });
    return refreshing;
  }

  return {
    /** 返回目录条目、档位家族与旧 id 重定向表；无凭据或完全无缓存时抛错。 */
    async catalog(): Promise<{ models: ModelEntry[]; families: AgyModelFamily[]; reroute: Map<string, string> }> {
      await refresh(false);
      if (!cached) throw new Error("Antigravity 模型目录拉取失败，且没有可用的本地缓存");
      return { models: cached.models, families: cached.families, reroute: new Map(cached.reroute) };
    },
    /** 启动/定时刷新入口：绕过 TTL 重新校验。 */
    async refresh(): Promise<void> {
      await refresh(true);
    },
  };
}
