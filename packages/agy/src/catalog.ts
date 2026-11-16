import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCodexBaselineEntry } from "@agent-proxy/models";
import { atomicWrite, invalidateModelsCache, type ModelCatalog, type ModelEntry } from "@agent-proxy/plugin-api";
import { AGY_ENDPOINT } from "./transport.ts";
import type { AgyCredentials } from "./credentials.ts";

/**
 * Antigravity 模型目录：`POST /v1internal:fetchAvailableModels` 拉取，以 `models`
 * map 合成 `agy/` 前缀的 Codex 目录条目；`deprecatedModelIds` 提供旧 id 到新 id 的
 * 服务端重定向。同一基名的档位变体在目录中合并为一个
 * `agy/<base>` 条目，转发时按 reasoning.effort 解析具体上游模型。缓存键带账号身份
 * 与端点摘要；缓存文件不含任何凭据。
 */

export const AGY_PREFIX = "agy/";
/** 显示名前缀：与路由 slug 区分的大写标签（对齐 CodeBuddy 的 CB-/WB- 风格）。 */
export const AGY_DISPLAY_PREFIX = "AGY/";

/** 思考级别唯一词汇表，按强度升序；模型能力由各自目录描述。 */
export const AGY_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgyTier = (typeof AGY_TIERS)[number];

export type AgyModelReasoning =
  | { kind: "fixed" }
  | { kind: "parameter"; levels?: AgyTier[] }
  | { kind: "variants"; variants: Partial<Record<AgyTier, string>>; defaultLevel: AgyTier };

/** 可以直接还原为上游请求的结果；无 thinkingLevel 表示模型 ID 已足够或不可调。 */
export interface AgyModelSelection {
  model: string;
  thinkingLevel?: AgyTier;
}

const TIER_VARIANT_PATTERN = new RegExp(`^(.+)-(${AGY_TIERS.join("|")})$`);
const TIER_LABEL_PATTERN = new RegExp(`\\s*\\((${AGY_TIERS.join("|")})\\)$`, "i");

/** 仅供缺少官方分组的旧目录识别变体，不参与请求层的传输决策。 */
function splitAgyTierVariant(id: string): { base: string; tier: AgyTier } | undefined {
  const match = TIER_VARIANT_PATTERN.exec(id);
  return match ? { base: match[1]!, tier: match[2] as AgyTier } : undefined;
}

function stripAgyTierLabel(displayName: string): string {
  return displayName.replace(TIER_LABEL_PATTERN, "");
}

/** effort → 精确家族档位；缺省或未知值不参与选档。 */
function agyEffortTier(effort: unknown): AgyTier | undefined {
  if (effort === "minimal") return "low";
  return typeof effort === "string" && (AGY_TIERS as readonly string[]).includes(effort)
    ? effort as AgyTier : undefined;
}

/** 缺少服务端默认时优先 medium，否则使用实际存在的最低档。 */
function agyDefaultTier(tiers: readonly AgyTier[]): AgyTier {
  return tiers.includes("medium") ? "medium" : tiers[0]!;
}

/** 精确还原模型，不进行相邻档位回退；缺档请求与未指定 effort 使用相同默认值。 */
export function resolveAgyModel(model: string, effort: unknown, profile?: AgyModelReasoning): AgyModelSelection {
  const level = agyEffortTier(effort);
  if (profile?.kind === "variants") {
    const selected = (level && profile.variants[level]) || profile.variants[profile.defaultLevel];
    if (!selected) throw new Error(`Antigravity 模型 ${model} 缺少默认变体，请刷新模型目录`);
    return { model: selected };
  }
  if (profile?.kind === "fixed" || !level || (profile?.levels && !profile.levels.includes(level))) return { model };
  return { model, thinkingLevel: level };
}

/** 在任何客户端协议归一化前读取 effort，模型选择与请求转换共用。 */
export function agyRequestEffort(body: Record<string, unknown>): unknown {
  const reasoning = body.reasoning;
  const effort = reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)
    ? (reasoning as Record<string, unknown>).effort : undefined;
  return effort === undefined ? body.reasoning_effort : effort;
}
/** 目录缓存修订号：合成规则变化时递增，避免复用旧结构的磁盘缓存
 *  （v2：档位家族合并；v3：levels 按实际档位重建；v4：删 web_search_tool_type；
 *  v5：v3/v4 的字段删除改为保留字段置中性值——缺字段疑似导致 Codex 弃用目录；
 *  v6：系统提示词在合成时替换（base_instructions + model_messages 模板））。 */
/** 目录输出语义修订：v13 保存官方原生搜索专用模型；旧缓存整体失效。 */
const CACHE_REVISION = 13;
const CATALOG_TTL_MS = 6 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 30_000;
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

/** 目录枚举与客户端 effort 使用同一词汇表，只归一化协议前缀和书写形式。 */
function catalogThinkingLevel(value: unknown): AgyTier | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.toLowerCase().replace(/^thinking_level_/, "");
  return agyEffortTier(raw === "extra_high" ? "xhigh" : raw);
}

export interface AgyModelDetails {
  id: string;
  displayName: string;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsVideo: boolean;
  maxTokens?: number;
  /** 显式参数能力优先于模型名；空数组表示不接受档位参数。 */
  thinkingLevels?: AgyTier[];
}

/**
 * 多档位家族：同一基名的实际变体集合。目录只暴露
 * `agy/<base>` 一个条目，具体上游模型由请求的 reasoning.effort 解析；显式档位
 * id（如 `agy/gemini-3.8-flash-high`）仍按成员 id 直连。
 */
export interface AgyModelFamily {
  base: string;
  tiers: Partial<Record<AgyTier, string>>;
  displayName: string;
  defaultTier?: AgyTier;
}

export interface AgyCatalogData {
  models: AgyModelDetails[];
  families: AgyModelFamily[];
  reroute: Map<string, string>;
  reasoning: Record<string, AgyModelReasoning>;
  searchModels: string[];
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
    ...strings(data.webSearchModelIds),
  ]);
  // agentModelSorts 给出推荐位；tieredModelIds 是性能系列配置。
  // groupedModels 才是选择器的思考级别分组，实际成员均并入可用目录。
  const agentIds = (Array.isArray(data.agentModelSorts) ? data.agentModelSorts : [])
    .flatMap((sort) => record(sort)?.groups)
    .flatMap((group) => strings(record(group)?.modelIds));
  const tiered = record(data.tieredModelIds) ?? {};
  const tieredIds = Object.values(tiered).filter((id): id is string => typeof id === "string" && id.length > 0);
  const explicitVariants = new Map<string, Partial<Record<AgyTier, string>>>();
  const groups = record(data.groupedModels);
  const groupedIds: string[] = [];
  for (const [base, value] of Object.entries(groups ?? {})) {
    const group = record(value);
    if (!group || base.trim() !== base || !base || /[\s/\\]/.test(base)) continue;
    const variants: Partial<Record<AgyTier, string>> = {};
    for (const raw of Array.isArray(group.supportedThinkingLevels) ? group.supportedThinkingLevels : []) {
      const item = record(raw);
      const suffix = typeof item?.thinkingSuffix === "string" ? item.thinkingSuffix : "";
      const tier = agyEffortTier(suffix.replace(/^-/, ""))
        ?? agyEffortTier(typeof item?.thinkingDisplayName === "string" ? item.thinkingDisplayName.toLowerCase() : undefined);
      const id = suffix ? `${base}${suffix.startsWith("-") ? "" : "-"}${suffix}` : base;
      // 只还原目录实际存在的 ID，不能通过拼接制造可调用模型。
      if (!tier || !Object.hasOwn(modelsRaw, id)) continue;
      variants[tier] = id;
      groupedIds.push(id);
    }
    if (Object.keys(variants).length > 1) explicitVariants.set(base, variants);
  }
  const defaultId = typeof data.defaultAgentModelId === "string" ? [data.defaultAgentModelId] : [];
  const selection = agentIds.length ? [...new Set([...agentIds, ...defaultId, ...tieredIds, ...groupedIds])] : undefined;
  let models: AgyModelDetails[] = [];
  const seen = new Set<string>();
  for (const [id, raw] of Object.entries(modelsRaw)) {
    if (!id.trim() || id !== id.trim() || /[\s/\\]/.test(id)) {
      throw new Error("Antigravity 模型目录格式错误：模型 id 无效");
    }
    if (seen.has(id)) throw new Error("Antigravity 模型目录格式错误：模型 id 重复");
    seen.add(id);
    if (excluded.has(id)) continue;
    // 上游把当前下线的模型保留在目录里并以 `-disabled` 后缀命名，同步时整体剔除；
    // 推荐位/档位里引用的同名 id 由 selection 重排自然跳过。
    if (id.endsWith("-disabled")) continue;
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
    const thinkingConfig = record(details.thinkingConfig);
    const levels = details.supportedThinkingLevels ?? thinkingConfig?.supportedThinkingLevels;
    if (Array.isArray(levels)) {
      model.thinkingLevels = [...new Set(levels.flatMap((value) => {
        const level = catalogThinkingLevel(value);
        return level ? [level] : [];
      }))];
    }
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
      const newModelId = typeof target?.newModelId === "string" ? target.newModelId : "";
      // 重定向目标已被 `-disabled` 剔除时不产出重定向，避免把可请求的旧 id 指到下线模型。
      if (newModelId && newModelId !== oldId && !newModelId.endsWith("-disabled")) {
        reroute.set(oldId, newModelId);
      }
    }
  }
  // 多档位家族识别：优先官方分组，旧目录按统一词汇表的后缀识别；仅合并两个成员以上的组
  // （单档位后缀模型与无后缀模型保持独立），且基名与显式无后缀模型冲突时不合并
  // （避免目录出现重复 slug）。已改名的档位（如 gemini-pro-agent）不强行归族。
  const listed = new Set(models.map((model) => model.id));
  const grouped = new Map<string, Partial<Record<AgyTier, string>>>();
  const assigned = new Set<string>();
  for (const [base, variants] of explicitVariants) {
    const available = Object.fromEntries(Object.entries(variants).filter(([, id]) => listed.has(id!)));
    if (Object.keys(available).length < 2) continue;
    grouped.set(base, available);
    Object.values(available).forEach((id) => assigned.add(id!));
  }
  for (const model of models) {
    if (assigned.has(model.id) || model.thinkingLevels !== undefined) continue;
    const variant = splitAgyTierVariant(model.id);
    if (!variant || groups) continue;
    grouped.set(variant.base, { ...(grouped.get(variant.base) ?? {}), [variant.tier]: model.id });
  }
  const families: AgyModelFamily[] = [];
  for (const [base, tiers] of grouped) {
    if (Object.keys(tiers).length < 2 || (listed.has(base) && !explicitVariants.has(base))) continue;
    const memberIds = Object.values(tiers).filter((id): id is string => typeof id === "string");
    // 展示名取 medium 成员的显示名（无则首个成员），去掉档位括号后缀。
    const preferred = models.find((model) => model.id === tiers.medium)
      ?? models.find((model) => memberIds.includes(model.id));
    const preferredId = typeof data.defaultAgentModelId === "string" && memberIds.includes(data.defaultAgentModelId)
      ? data.defaultAgentModelId : undefined;
    const serverLevel = catalogThinkingLevel(record(modelsRaw[base])?.thinkingLevel);
    const defaultTier = serverLevel && tiers[serverLevel] ? serverLevel
      : AGY_TIERS.find((tier) => tiers[tier] === preferredId && preferredId !== undefined)
        ?? agyDefaultTier(AGY_TIERS.filter((tier) => tiers[tier] !== undefined));
    families.push({
      base, tiers,
      displayName: typeof record(groups?.[base])?.displayName === "string"
        ? record(groups?.[base])!.displayName as string : preferred ? stripAgyTierLabel(preferred.displayName) : base,
      defaultTier,
    });
  }
  const reasoning: Record<string, AgyModelReasoning> = Object.create(null);
  for (const model of models) {
    reasoning[model.id] = model.thinkingLevels !== undefined
      ? { kind: "parameter", levels: model.thinkingLevels } : { kind: "fixed" };
  }
  for (const family of families) {
    reasoning[family.base] = { kind: "variants", variants: family.tiers, defaultLevel: family.defaultTier! };
    for (const id of Object.values(family.tiers)) {
      if (id && id !== family.base) reasoning[id] = { kind: "fixed" };
    }
  }
  const searchModels = strings(data.webSearchModelIds).filter((id) => id.trim() === id && !/[\s/\\]/.test(id)
    && !id.endsWith("-disabled"));
  return { models, families, reroute, reasoning, searchModels: [...new Set(searchModels)] };
}

/** 家族内精确选档；未提供或不支持的 effort 不生效，使用家族默认变体。 */
export function resolveAgyFamilyModel(family: AgyModelFamily, effort: unknown): string {
  return resolveAgyModel(family.base, effort, {
    kind: "variants", variants: family.tiers, defaultLevel: family.defaultTier ?? agyDefaultTier(orderedTiers(family)),
  }).model;
}

/** 从基底快照复用实际存在档位的展示文案。 */
const baseLevelDescriptions = (base: ModelEntry) => new Map(
  (Array.isArray(base.supported_reasoning_levels)
    ? base.supported_reasoning_levels as Array<{ effort?: unknown; description?: unknown }>
    : []).filter((level): level is { effort: string; description: string } =>
    typeof level.effort === "string" && typeof level.description === "string")
    .map((level) => [level.effort, level.description]),
);

/** Codex 行为字段沿用快照基底（优先 gpt-5.5，缺失回退首条）；模型名与能力仅由当前账号目录决定。
 *  多档位家族合并为一个 `agy/<base>` 条目（能力/窗口取成员并集或最大值），
 *  `supported_reasoning_levels` 只列家族实际存在的档位；无档位后缀的模型保持
 *  独立条目且不暴露档位选择。 */
export function buildAgyCatalog(data: AgyCatalogData): ModelCatalog {
  const BASE = getCodexBaselineEntry();
  const BASE_LEVEL_DESCRIPTIONS = baseLevelDescriptions(BASE);
  const familyByMember = new Map<string, AgyModelFamily>();
  for (const family of data.families) {
    familyByMember.set(family.base, family);
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
    // 只有目录明确发布搜索专用模型时才声明原生搜索能力。
    model.supports_search_tool = data.searchModels.length > 0;
    model.support_verbosity = false;
    model.additional_speed_tiers = [];
    model.service_tiers = [];
    delete model.default_service_tier;
    delete model.default_reasoning_level;
    delete model.default_reasoning_summary;
    // 家族条目只列实际存在的变体，不能继承快照的完整档位列表。
    // 默认档位与转发侧缺省解析保持一致。
    // 支持档位列表保留；无可选档位时不声明默认级别。
    if (merged && tiers.length) {
      model.supported_reasoning_levels = tiers.map((tier) => ({
        effort: tier,
        description: BASE_LEVEL_DESCRIPTIONS.get(tier) ?? "",
      }));
      const profile = data.reasoning[details.id];
      model.default_reasoning_level = profile?.kind === "variants" ? profile.defaultLevel : agyDefaultTier(tiers);
    } else {
      const profile = data.reasoning[details.id];
      const levels = profile?.kind === "parameter" ? profile.levels ?? [] : [];
      model.supported_reasoning_levels = levels.map((effort) => ({ effort, description: BASE_LEVEL_DESCRIPTIONS.get(effort) ?? "" }));
      if (levels.length) model.default_reasoning_level = agyDefaultTier(levels);
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
    return model;
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

/** 家族档位按词汇表声明顺序输出，保证目录展示顺序稳定。 */
function orderedTiers(family: AgyModelFamily): AgyTier[] {
  return AGY_TIERS.filter((tier) => family.tiers[tier] !== undefined);
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
  /** manual 仅允许显式刷新；目录查询不按 TTL 拉取。 */
  catalogMode?: "dynamic" | "manual";
}

interface CachedCatalog {
  key: string;
  fetchedAt: number;
  models: ModelEntry[];
  families: AgyModelFamily[];
  reroute: Array<[oldId: string, newId: string]>;
  reasoning: Record<string, AgyModelReasoning>;
  searchModels: string[];
}

interface CacheFile {
  cache_key?: unknown;
  fetched_at?: unknown;
  content_hash?: unknown;
  models?: unknown;
  families?: unknown;
  reroute?: unknown;
  reasoning?: unknown;
  searchModels?: unknown;
}

/**
 * 目录存储：内存 + 磁盘双指纹缓存、TTL、单飞刷新、失败回退 last-good。
 * 账号切换（identity 变化）后旧 key 条目不复用。
 */
/** agy 落在缓存目录的产物清单（目录缓存，与落盘点同源）；卸载清理与受管值守卫经组合层聚合消费。 */
const AGY_CATALOG_FILE_NAME = "agy-catalog.json";
export const AGY_RUNTIME_ARTIFACTS: readonly string[] = Object.freeze([AGY_CATALOG_FILE_NAME]);

export function createAgyCatalogStore(options: AgyCatalogStoreOptions) {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(60_000, options.ttlMs ?? CATALOG_TTL_MS);
  const endpoint = options.endpoint ?? AGY_ENDPOINT;
  const endpointDigest = createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
  const cacheFile = path.join(options.cacheDirectory, AGY_CATALOG_FILE_NAME);
  let cached: CachedCatalog | undefined;
  let retryAt = 0;
  let refreshing: Promise<void> | undefined;
  let refreshingForce = false;
  let pendingForce = false;

  const cacheKey = (credential: AgyCredentials): string =>
    digest({ revision: CACHE_REVISION, identity: credential.identity, endpoint: endpointDigest });

  /** 家族结构与模型列表共同构成目录内容：任一变化都需失效 Codex 的目录缓存。 */
  const contentDigest = (value: CachedCatalog): string =>
    digest({ models: value.models, families: value.families, reasoning: value.reasoning, reroute: value.reroute, searchModels: value.searchModels });

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
        || !Object.entries(tiers).every(([tier, id]) => (AGY_TIERS as readonly string[]).includes(tier)
          && typeof id === "string" && id.length > 0)) {
        return undefined;
      }
      if (typeof family.defaultTier !== "string" || !Object.hasOwn(tiers, family.defaultTier)) return undefined;
      families.push({ base: family.base, displayName: family.displayName, tiers, defaultTier: family.defaultTier as AgyTier });
    }
    return families;
  }

  function readDisk(key: string): CachedCatalog | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as CacheFile;
      if (parsed.cache_key !== key || typeof parsed.fetched_at !== "number" || !Array.isArray(parsed.models)) return;
      const models = parsed.models as ModelEntry[];
      if (parsed.content_hash !== digest({ models, families: parsed.families, reasoning: parsed.reasoning, reroute: parsed.reroute, searchModels: parsed.searchModels })) return;
      if (!Array.isArray(parsed.searchModels) || !parsed.searchModels.every((id) => typeof id === "string" && id.length > 0
        && id.trim() === id && !/[\s/\\]/.test(id) && !id.endsWith("-disabled"))) return;
      const families = readFamilies(parsed.families);
      if (!families) return;
      const reroute = Array.isArray(parsed.reroute)
        && parsed.reroute.every((pair) => Array.isArray(pair) && pair.length === 2
          && typeof pair[0] === "string" && typeof pair[1] === "string")
        ? parsed.reroute as Array<[string, string]> : [];
      const rawProfiles = record(parsed.reasoning);
      if (!rawProfiles) return;
      const reasoning: Record<string, AgyModelReasoning> = Object.create(null);
      for (const [id, raw] of Object.entries(rawProfiles)) {
        const profile = record(raw);
        if (profile?.kind === "fixed") reasoning[id] = { kind: "fixed" };
        else if (profile?.kind === "parameter") {
          if (profile.levels !== undefined && (!Array.isArray(profile.levels)
            || !profile.levels.every((level) => (AGY_TIERS as readonly unknown[]).includes(level)))) return;
          reasoning[id] = { kind: "parameter", ...(profile.levels !== undefined ? { levels: profile.levels as AgyTier[] } : {}) };
        } else if (profile?.kind === "variants") {
          const family = families.find((family) => family.base === id);
          if (!family || profile.defaultLevel !== family.defaultTier || digest(profile.variants) !== digest(family.tiers)) return;
          reasoning[id] = { kind: "variants", variants: family.tiers, defaultLevel: family.defaultTier! };
        } else return;
      }
      if (models.some((model) => typeof model.slug !== "string" || !model.slug.startsWith(AGY_PREFIX)
        || !Object.hasOwn(reasoning, model.slug.slice(AGY_PREFIX.length)))) return;
      for (const family of families) {
        if (reasoning[family.base]?.kind !== "variants"
          || Object.values(family.tiers).some((id) => id && id !== family.base && reasoning[id]?.kind !== "fixed")) return;
      }
      return { key, fetchedAt: parsed.fetched_at, models, families, reroute, reasoning, searchModels: parsed.searchModels as string[] };
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
        reasoning: value.reasoning,
        searchModels: value.searchModels,
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
          reasoning: data.reasoning,
          searchModels: data.searchModels,
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
    if (refreshing) {
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

  async function currentCatalog(reload = false) {
    const credential = await options.credentials();
    const key = credential ? cacheKey(credential) : undefined;
    if (!key) cached = undefined;
    else if (reload || cached?.key !== key) {
      const disk = readDisk(key);
      if (disk) cached = disk;
      else if (cached?.key !== key) cached = undefined;
    }
    if (!cached) throw new Error("Antigravity 模型目录拉取失败，且没有可用的本地缓存");
    return { models: cached.models, families: cached.families, reroute: new Map(cached.reroute), reasoning: cached.reasoning, searchModels: cached.searchModels };
  }

  return {
    /** 返回目录条目、档位家族与旧 id 重定向表；无凭据或完全无缓存时抛错。 */
    async catalog() {
      if (options.catalogMode !== "manual") await refresh(false);
      return currentCatalog();
    },
    /** 重读当前账号目录及路由元数据，不请求网络。 */
    async reload() {
      return currentCatalog(true);
    },
    /** 启动/定时刷新入口：绕过 TTL 重新校验。 */
    async refresh(): Promise<void> {
      await refresh(true);
      await currentCatalog();
    },
  };
}
