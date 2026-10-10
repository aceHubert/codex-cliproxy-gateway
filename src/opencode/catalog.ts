import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import codexClientModels from "../../models/codex_client_models.json";
import { invalidateModelsCache, parseCodexCatalog, withAgentSystemPrompt } from "../catalog.ts";
import { atomicWrite } from "../toml.ts";
import { OPENCODE_ZEN_AGENT_SYSTEM_PROMPT } from "./fingerprint.ts";
import type { ModelCatalog, ModelEntry } from "../types.ts";

/**
 * OpenCode Zen 模型目录：`GET /zen/v1/models` 提供当前真实可服务的模型 id，
 * models.opencode.ai 元数据（models.dev 同构）提供每个模型的免费判定（cost）、
 * 显示名、上下文窗口（limit.context）、reasoning effort 档位（reasoning_options）、
 * 生命周期状态（deprecated）与端点协议（provider.npm）。两个源都是实时的——
 * 免费池轮换、窗口调整、档位变化都不需要改网关代码；磁盘缓存（本模块 store）
 * 只作 TTL 内的 last-good 兜底，不内置任何静态模型快照。
 */

export const OPENCODE_ZEN_PREFIX = "opencode-zen/";
/** 显示名前缀：UI 与目录元数据的统一标签（对齐 AGY/ 的风格约定）。 */
export const OPENCODE_ZEN_DISPLAY_PREFIX = "OP-ZEN/";
const BASE = parseCodexCatalog(codexClientModels).models.find((entry) => entry.slug === "gpt-5.5");
const CATALOG_TTL_MS = 10 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 30_000;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 档位展示文案：复用 gpt-5.5 快照里 low/medium/high 的描述，其余值域（none/max/xhigh）留空。 */
const EFFORT_DESCRIPTIONS = new Map(
  (Array.isArray(BASE?.supported_reasoning_levels)
    ? BASE.supported_reasoning_levels as Array<{ effort?: unknown; description?: unknown }>
    : []).filter((level): level is { effort: string; description: string } =>
    typeof level.effort === "string" && typeof level.description === "string")
    .map((level) => [level.effort, level.description]),
);

/**
 * 模型默认 effort：有 high 取 high（对齐上游默认行为），否则取值域末项；
 * 无档位声明时返回 undefined（目录不暴露档位选择）。
 */
export function opencodeZenDefaultEffort(levels: readonly string[]): string | undefined {
  if (levels.length === 0) return undefined;
  return levels.includes("high") ? "high" : levels[levels.length - 1];
}

export function isOpencodeZenModel(model: unknown): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith(OPENCODE_ZEN_PREFIX);
}

/** `opencode-zen/<model-id>` → 裸模型 ID；无前缀、前缀后为空或含斜杠返回 undefined。 */
export function opencodeZenUpstreamModel(model: string): string | undefined {
  if (!isOpencodeZenModel(model)) return undefined;
  const bare = model.slice(OPENCODE_ZEN_PREFIX.length);
  return bare && !bare.includes("/") ? bare : undefined;
}

/** 显示名：优先元数据官方名称，其余按 id 人工化（mimo-v2.6-flash-free → Mimo V2.6 Flash Free）。 */
export function opencodeZenDisplayName(id: string, metadataName?: string): string {
  if (typeof metadataName === "string" && metadataName.trim()) return metadataName.trim();
  return id.split("-").map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join(" ");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * 解析 /zen/v1/models 响应（OpenAI list 形状）：校验并去重全部模型 id，保持上游
 * 顺序。该端点不带计费信息，「哪些是免费模型」由元数据 cost 判定（见
 * filterOpencodeZenCatalogIds），这里只做形状清洗。
 */
export function parseOpencodeZenModelsResponse(value: unknown): string[] {
  const data = record(value);
  const list = Array.isArray(data?.data) ? data.data : [];
  const ids: string[] = [];
  for (const item of list) {
    const entry = record(item);
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || /[\s/\\]/.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Codex 目录基底沿用 gpt-5.5 快照（与 agy/ 一致），能力字段按 chat-completions 中性化。
 * `metadata` 为可选的实时元数据表（models.opencode.ai）：显示名、上下文窗口
 * （limit.context）与 reasoning effort 档位（reasoning_options）全部取自它；
 * 元数据缺失的模型按 id 人工化命名、删窗口字段、不暴露档位。
 */
export function buildOpencodeZenCatalog(
  ids: string[],
  metadata?: Record<string, OpencodeZenModelMetadata>,
): ModelCatalog {
  if (!BASE) throw new Error("Codex 模型快照缺少 gpt-5.5 基底条目");
  const models: ModelEntry[] = ids.map((id, index) => {
    const meta = metadata && Object.hasOwn(metadata, id) ? metadata[id] : undefined;
    const model = structuredClone(BASE);
    const displayName = opencodeZenDisplayName(id, meta?.name);
    model.slug = `${OPENCODE_ZEN_PREFIX}${id}`;
    model.display_name = `${OPENCODE_ZEN_DISPLAY_PREFIX}${displayName}`;
    model.description = `OpenCode Zen 免费模型 ${displayName}（指纹转发，按模型端点协议自动转换）`;
    model.priority = index;
    model.prefer_websockets = false;
    delete model.minimal_client_version;
    model.input_modalities = ["text"];
    model.supports_reasoning_summaries = false;
    model.supports_reasoning_summary_parameter = false;
    model.supports_image_detail_original = false;
    model.supports_search_tool = false;
    model.support_verbosity = false;
    model.additional_speed_tiers = [];
    model.service_tiers = [];
    delete model.default_service_tier;
    // reasoning effort 按模型声明：上游 reasoning_options 为 effort 型的模型暴露其
    // 真实值域（值域各模型不同，如 deepseek 的 low/high/max、muse-spark 的
    // minimal/low/medium/high/xhigh），toggle/budget 型与未知模型不暴露档位
    // （Codex 目录形状无法表达，参数仍可透传）。
    const effortLevels = meta?.effortLevels ?? [];
    model.supported_reasoning_levels = effortLevels.map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS.get(effort) ?? "",
    }));
    model.default_reasoning_level = opencodeZenDefaultEffort(effortLevels) ?? "medium";
    delete model.default_reasoning_summary;
    // Chat Completions 工具调用原生支持并行函数调用。
    model.supports_parallel_tool_calls = true;
    // 上下文窗口：元数据 limit.context；缺数据时删字段（客户端用自身缺省，
    // 好过用 gpt-5.5 基底的 272k 误导客户端超长输入被上游拒）。
    const contextWindow = meta?.contextWindow;
    if (contextWindow !== undefined) {
      model.context_window = contextWindow;
      model.max_context_window = contextWindow;
      model.effective_context_window_percent = 95;
    } else {
      delete model.context_window;
      delete model.max_context_window;
      delete model.effective_context_window_percent;
    }
    return withAgentSystemPrompt(model, OPENCODE_ZEN_AGENT_SYSTEM_PROMPT);
  });
  return { models };
}

export function mergeOpencodeZenCatalog(base: ModelCatalog, opencodeZen: ModelCatalog): ModelCatalog {
  const models = base.models.filter((entry) => !isOpencodeZenModel(entry.slug));
  const priority = Math.max(0, ...models.map((entry) => Number(entry.priority) || 0)) + 100;
  return { models: [...models, ...opencodeZen.models.map((entry, index) => ({ ...entry, priority: priority + index }))] };
}

/** 官方元数据中的单模型信息：免费判定、生命周期、端点协议、显示名、窗口与 effort 档位。 */
export interface OpencodeZenModelMetadata {
  /** 模型级 SDK 覆盖（如 @ai-sdk/anthropic）；缺省继承 provider 级 openai-compatible。 */
  npm?: string;
  /** provider 级 baseURL（元数据 api 字段，如 https://opencode.ai/zen/v1）；转发 endpoint 的依据。 */
  api?: string;
  /** 官方 deprecated 标记：已轮换下线的模型。 */
  deprecated: boolean;
  /** 元数据 cost.input/output 均为 0：免费模型。 */
  free?: boolean;
  /** 官方显示名。 */
  name?: string;
  /** limit.context：上下文窗口（token）；元数据缺该字段时 undefined（目录删窗口字段）。 */
  contextWindow?: number;
  /** reasoning_options 中 effort 型档位的值域；toggle/budget 型不产出该字段。 */
  effortLevels?: string[];
}

/** 元数据 provider.api 提取：必须是 http(s) URL，其余（空串/相对路径/其他协议）视为缺失。 */
function metadataApi(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin + parsed.pathname.replace(/\/+$/, "") : undefined;
  } catch { return; }
}

/** 模型端点协议：由元数据 provider.npm 映射，决定转发到哪个 Zen 端点。 */
export type OpencodeZenModelProtocol = "chat" | "responses" | "anthropic" | "google";

const NPM_PROTOCOL: Record<string, OpencodeZenModelProtocol> = {
  "@ai-sdk/openai-compatible": "chat",
  "@ai-sdk/openai": "responses",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "google",
  // @ai-sdk/mistral 等 OpenAI 兼容 SDK 走缺省 chat（Mistral 的 chat completions 与 OpenAI 同构）。
};

/** npm 字段 → 端点协议；缺省（无覆盖）即继承 openai-compatible chat。 */
export function protocolFromNpm(npm: string | undefined): OpencodeZenModelProtocol {
  return (npm && NPM_PROTOCOL[npm]) || "chat";
}

/** 元数据 limit.context 提取：正有限数才采纳，其余（0/负数/NaN/字符串）视为缺失。 */
function metadataContextWindow(entry: Record<string, unknown>): number | undefined {
  const limit = record(entry.limit);
  const context = limit?.context;
  return typeof context === "number" && Number.isFinite(context) && context > 0 ? Math.trunc(context) : undefined;
}

/** 元数据 cost 判定免费：input 与 output 都为 0（缺字段按非免费处理，宁可漏示不误示）。 */
function metadataFree(entry: Record<string, unknown>): boolean {
  const cost = record(entry.cost);
  return cost?.input === 0 && cost?.output === 0;
}

/** 元数据 reasoning_options 提取：只取 effort 型的 values（toggle/budget 型无法映射档位）。 */
function metadataEffortLevels(entry: Record<string, unknown>): string[] | undefined {
  const options = entry.reasoning_options;
  if (!Array.isArray(options)) return undefined;
  const effort = options.find((option) => record(option)?.type === "effort");
  const values = effort ? record(effort)?.values : undefined;
  if (!Array.isArray(values)) return undefined;
  const levels = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  return levels.length > 0 ? levels : undefined;
}

/**
 * 解析 models.opencode.ai 元数据（models.dev 同构）：取 opencode provider 下每个模型的
 * `provider.npm`、`api`（provider 级 baseURL）、`status`、`cost`（免费判定）、`name`、
 * `limit.context` 与 `reasoning_options`（effort 档位）。结构不符返回 undefined，调用方按
 * "元数据不可用"保守处理（只信 `-free` 后缀、删窗口字段、不暴露档位）。
 */
export function parseOpencodeZenMetadataResponse(value: unknown): Record<string, OpencodeZenModelMetadata> | undefined {
  const provider = record(record(value)?.opencode);
  const models = record(provider?.models);
  if (!models) return undefined;
  // provider 级 baseURL：所有模型共享，缺省由转发层回退 OPENCODE_ZEN_DEFAULT_ENDPOINT。
  const api = metadataApi(provider?.api);
  const result: Record<string, OpencodeZenModelMetadata> = {};
  for (const [id, raw] of Object.entries(models)) {
    const entry = record(raw);
    if (!entry) continue;
    const npm = record(entry.provider)?.npm;
    const contextWindow = metadataContextWindow(entry);
    const effortLevels = metadataEffortLevels(entry);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
    result[id] = {
      ...(typeof npm === "string" && npm ? { npm } : {}),
      ...(api ? { api } : {}),
      ...(metadataFree(entry) ? { free: true } : {}),
      ...(name ? { name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(effortLevels ? { effortLevels } : {}),
      deprecated: entry.status === "deprecated",
    };
  }
  return result;
}

/** 单端点探针信号。 */
export type OpencodeZenProbeSignal = "served" | "unsupported" | "offline" | "gate";

/**
 * 探针响应分类：协议不符（400 ModelProtocolUnsupported）→ unsupported；模型不存在
 * 或需账号（401、404）→ offline；门禁拒绝（403 FreeTierError）→ gate；其余
 * （200、429、5xx、403 RegionError）→ served——地区限制与本地网络相关，视为模型
 * 在该端点被正常服务，不作为剔除依据。
 */
export function classifyOpencodeZenProbeSignal(status: number, body: string): OpencodeZenProbeSignal {
  const text = body.toLowerCase();
  if (status === 400 && (text.includes("modelprotocolunsupported") || text.includes("does not support this protocol"))) return "unsupported";
  if (status === 401 || status === 404) return "offline";
  if (status === 403 && text.includes("freetier")) return "gate";
  return "served";
}

/** 多端点探针阶梯的裁决：模型端点协议，或 drop（所有已支持协议都不服务该模型）。 */
export type OpencodeZenProbeResult = OpencodeZenModelProtocol | "drop";

/** 探针裁决缓存条目。 */
export interface OpencodeZenProbeVerdictEntry {
  result: OpencodeZenProbeResult;
  at: number;
}

/**
 * 可见目录过滤——免费判定以实时元数据为唯一权威：
 * - 元数据有条目：`cost` 为零且未 deprecated 才可见（免费池轮换、付费模型混列都靠它）；
 * - 元数据无条目（刚轮换上线的新模型）：只认 `-free` 后缀（元数据滞后的宽限），
 *   并由探针裁决兜底（drop 才剔除）；
 * - 元数据整体不可用（拉取失败且无 last-good）：只信 `-free` 后缀——无后缀的
 *   零计费模型（grok-code、big-pickle）此时无法验证免费，暂时不示（好过误示付费模型）。
 */
export function filterOpencodeZenCatalogIds(
  ids: string[],
  metadata: Record<string, OpencodeZenModelMetadata> | undefined,
  verdicts: Record<string, OpencodeZenProbeVerdictEntry> | undefined,
): string[] {
  if (!metadata) return ids.filter((id) => id.endsWith("-free"));
  return ids.filter((id) => {
    const meta = Object.hasOwn(metadata, id) ? metadata[id] : undefined;
    if (meta) return meta.free === true && !meta.deprecated;
    if (!id.endsWith("-free")) return false;
    return verdicts?.[id]?.result !== "drop";
  });
}

export interface OpencodeZenCatalogStoreOptions {
  cacheDirectory: string;
  /** 返回 /zen/v1/models 的已解码 JSON；认证与超时由调用方负责。 */
  fetchCatalog: () => Promise<unknown>;
  /** 返回 models.opencode.ai 元数据 JSON；缺省不启用下线过滤。 */
  fetchMetadata?: () => Promise<unknown>;
  /** 无元数据模型的多端点探针；缺省不探测（保守保留）。 */
  probeModel?: (id: string) => Promise<OpencodeZenProbeResult>;
  codexModelsCacheFile?: string;
  now?: () => number;
  ttlMs?: number;
  metadataTtlMs?: number;
  probeTtlMs?: number;
}

interface CachedCatalog {
  fetchedAt: number;
  /** 动态 ∪ 预置的原始 id 列表（未过滤）。 */
  ids: string[];
  metadata?: { fetchedAt: number; models: Record<string, OpencodeZenModelMetadata> };
  verdicts?: Record<string, OpencodeZenProbeVerdictEntry>;
  /** 成品条目（`base_instructions` 与 `model_messages` 模板已替换）：刷新时合成，
   *  与 `opencode-zen-catalog.json` 内容一致；serve 路径只读，不重建。 */
  models?: ModelEntry[];
}

/** 元数据与探针裁决的有效期：元数据 6 小时、裁决 24 小时。 */
const METADATA_TTL_MS = 6 * 60 * 60 * 1000;
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 目录存储：内存 + 磁盘缓存（`opencode-zen-metadata.json`）、TTL、单飞刷新、失败回退
 * last-good；完全无缓存时返回空目录。缓存文件不含任何凭据。
 *
 * 可见目录在原始 id 列表之上叠加两层数据：官方元数据（deprecated 过滤 + 端点协议）
 * 与无元数据模型的探针裁决；两层数据随主缓存落盘，元数据不可用时保守不过滤。
 * 合成好的条目（base_instructions + model_messages 模板已替换）同样落盘，
 * `/v1/models` 侧只读缓存并合并，不重建条目。
 */
/**
 * 目录存储：内存 + 双磁盘文件、TTL、单飞刷新、失败回退 last-good；完全无缓存时返回空目录。
 * 缓存文件不含任何凭据。
 *
 * - `opencode-zen-metadata.json`：原始数据（ids + 官方元数据 + 探针裁决）。ids 按目录
 *   TTL（10 分钟）刷新，元数据按 6 小时 TTL 刷新，裁决 24 小时。
 * - `opencode-zen-catalog.json`：由上述数据生成的**成品目录**（`base_instructions` 与
 *   `model_messages` 模板已替换），每次刷新元数据时同步重新生成；`/v1/models` 侧只读
 *   合并这一份，不在运行时重建条目。
 *
 * 可见目录在原始 id 列表之上叠加两层数据：官方元数据（deprecated 过滤 + 端点协议）
 * 与无元数据模型的探针裁决；元数据不可用时保守不过滤。
 */
export function createOpencodeZenCatalogStore(options: OpencodeZenCatalogStoreOptions) {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(60_000, options.ttlMs ?? CATALOG_TTL_MS);
  const metadataTtlMs = Math.max(60_000, options.metadataTtlMs ?? METADATA_TTL_MS);
  const probeTtlMs = Math.max(60_000, options.probeTtlMs ?? PROBE_TTL_MS);
  const metadataFile = path.join(options.cacheDirectory, "opencode-zen-metadata.json");
  const catalogFile = path.join(options.cacheDirectory, "opencode-zen-catalog.json");
  let cached: CachedCatalog | undefined;
  let retryAt = 0;
  let metadataRetryAt = 0;
  let refreshing: Promise<void> | undefined;

  const visibleIds = (value: CachedCatalog): string[] =>
    filterOpencodeZenCatalogIds(value.ids, value.metadata?.models, value.verdicts);
  const contentDigest = (ids: string[]): string => digest(ids);

  /** 按当前 ids/元数据/裁决合成成品条目；刷新与 catalog.json 落盘都走这里。 */
  const buildModels = (value: CachedCatalog): ModelEntry[] =>
    buildOpencodeZenCatalog(visibleIds(value), value.metadata?.models).models;

  /** 解析单模型元数据条目（磁盘读回用）；字段与 parseOpencodeZenMetadataResponse 产出同构。 */
  const parseMetadataEntry = (raw: unknown): OpencodeZenModelMetadata | undefined => {
    const entry = record(raw);
    if (!entry) return;
    return {
      ...(typeof entry.npm === "string" && entry.npm ? { npm: entry.npm } : {}),
      ...(typeof entry.api === "string" && entry.api ? { api: entry.api } : {}),
      ...(entry.free === true ? { free: true } : {}),
      ...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}),
      ...(typeof entry.contextWindow === "number" && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0
        ? { contextWindow: Math.trunc(entry.contextWindow) } : {}),
      ...(Array.isArray(entry.effortLevels) && entry.effortLevels.every((level) => typeof level === "string")
        ? { effortLevels: entry.effortLevels as string[] } : {}),
      deprecated: entry.deprecated === true,
    };
  };

  /**
   * 读原始数据：优先 `opencode-zen-metadata.json`；缺失时回退旧版单文件
   * `opencode-zen-catalog.json`（只取其中的 ids/元数据/裁决，成品条目重新合成），
   * 让升级不丢 last-good。哈希只校验 ids 数组的完整性——可见性是读取时按元数据派生
   * 的结果，不参与校验，否则元数据变化会让旧缓存整体失配。
   */
  function readDisk(): CachedCatalog | undefined {
    for (const file of [metadataFile, catalogFile]) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
          fetched_at?: unknown; ids?: unknown; content_hash?: unknown;
          metadata?: unknown; probe_verdicts?: unknown;
        };
        if (typeof parsed.fetched_at !== "number" || !Array.isArray(parsed.ids)
          || !parsed.ids.every((id) => typeof id === "string")) continue;
        const ids = parsed.ids as string[];
        const value: CachedCatalog = { fetchedAt: parsed.fetched_at, ids };
        const metadataRaw = record(parsed.metadata);
        if (metadataRaw && typeof metadataRaw.fetched_at === "number") {
          const models = record(metadataRaw.models);
          if (models) {
            const parsedModels: Record<string, OpencodeZenModelMetadata> = {};
            for (const [id, raw] of Object.entries(models)) {
              const entry = parseMetadataEntry(raw);
              if (entry) parsedModels[id] = entry;
            }
            value.metadata = { fetchedAt: metadataRaw.fetched_at, models: parsedModels };
          }
        }
        const verdictsRaw = record(parsed.probe_verdicts);
        if (verdictsRaw) {
          const verdicts: Record<string, OpencodeZenProbeVerdictEntry> = {};
          for (const [id, raw] of Object.entries(verdictsRaw)) {
            const entry = record(raw);
            if (!entry || typeof entry.at !== "number") continue;
            if (entry.result === "drop" || entry.result === "chat" || entry.result === "responses"
              || entry.result === "anthropic" || entry.result === "google") {
              verdicts[id] = { result: entry.result, at: entry.at };
            }
          }
          if (Object.keys(verdicts).length > 0) value.verdicts = verdicts;
        }
        if (parsed.content_hash !== contentDigest(value.ids)) continue;
        return value;
      } catch { /* 缺失或损坏的缓存按未命中处理，尝试下一个文件。 */ }
    }
  }

  /** 原始数据落盘（ids + 元数据 + 裁决）。 */
  function writeMetadataDisk(value: CachedCatalog): void {
    try {
      atomicWrite(metadataFile, `${JSON.stringify({
        fetched_at: value.fetchedAt,
        content_hash: contentDigest(value.ids),
        ids: value.ids,
        ...(value.metadata ? { metadata: { fetched_at: value.metadata.fetchedAt, models: value.metadata.models } } : {}),
        ...(value.verdicts ? { probe_verdicts: value.verdicts } : {}),
      }, null, 2)}\n`);
    } catch { /* 缓存写失败不影响本次目录返回。 */ }
  }

  /** 成品目录落盘：每次元数据刷新后重新生成，供 /v1/models 直接合并。 */
  function writeCatalogDisk(value: CachedCatalog): void {
    const models = value.models ?? buildModels(value);
    try {
      atomicWrite(catalogFile, `${JSON.stringify({
        content_hash: digest(models),
        models,
      }, null, 2)}\n`);
    } catch { /* 缓存写失败不影响本次目录返回。 */ }
  }

  async function refreshMetadata(value: CachedCatalog): Promise<void> {
    if (!options.fetchMetadata) return;
    const current = value.metadata;
    if (current && now() - current.fetchedAt < metadataTtlMs) return;
    if (metadataRetryAt > now()) return;
    try {
      const parsed = parseOpencodeZenMetadataResponse(await options.fetchMetadata());
      if (parsed) value.metadata = { fetchedAt: now(), models: parsed };
      metadataRetryAt = 0;
    } catch {
      // 拉取失败保留 last-good 元数据（自上一份缓存携带）；无 last-good 则不过滤。
      metadataRetryAt = now() + FAILURE_COOLDOWN_MS;
    }
  }

  async function probeMissing(value: CachedCatalog): Promise<void> {
    if (!options.probeModel || !value.metadata) return;
    const verdicts = (value.verdicts ??= {});
    for (const id of Object.keys(verdicts)) {
      if (!value.ids.includes(id)) delete verdicts[id];
    }
    for (const id of value.ids) {
      if (Object.hasOwn(value.metadata.models, id)) continue;
      // 只探测「可能是免费」的未知 id：无元数据且无 -free 后缀的模型（新付费模型）
      // 直接不示，没必要为它花一次真实请求。
      if (!id.endsWith("-free")) continue;
      const existing = verdicts[id];
      if (existing && now() - existing.at < probeTtlMs) continue;
      try {
        verdicts[id] = { result: await options.probeModel(id), at: now() };
      } catch {
        // 探针失败不记录裁决：下个刷新周期重试（受目录刷新节奏与失败冷却约束）。
      }
    }
  }

  /** 元数据免费集里未 deprecated 的 id：动态列表拉不到时的后备 id 源。 */
  const metadataFreeIds = (metadata: CachedCatalog["metadata"]): string[] =>
    Object.entries(metadata?.models ?? {})
      .filter(([, meta]) => meta.free === true && !meta.deprecated)
      .map(([id]) => id);

  async function refreshOnce(force: boolean): Promise<void> {
    cached ??= readDisk();
    // 旧版单文件缓存（只有 opencode-zen-catalog.json）：补写成双文件格式后按新语义服务。
    const legacyOnly = cached !== undefined && !fs.existsSync(metadataFile);
    if (cached && !cached.models) cached.models = buildModels(cached);
    if (legacyOnly && cached) {
      writeMetadataDisk(cached);
      writeCatalogDisk(cached);
    }
    const cooling = !force && retryAt > now();
    if (cooling || !(force || !cached || now() - cached.fetchedAt >= ttlMs)) return;
    try {
      const dynamicIds = parseOpencodeZenModelsResponse(await options.fetchCatalog());
      const previous = cached;
      const value: CachedCatalog = {
        fetchedAt: now(),
        // id 源：动态列表（当前真实可服务）优先；动态为空（拉到了空列表或免费池
        // 整体轮换）时回退元数据免费集。不再并入任何静态快照。
        ids: dynamicIds.length > 0 ? dynamicIds : [],
        ...(previous?.metadata ? { metadata: previous.metadata } : {}),
        ...(previous?.verdicts ? { verdicts: { ...previous.verdicts } } : {}),
      };
      await refreshMetadata(value);
      if (value.ids.length === 0) value.ids = metadataFreeIds(value.metadata);
      await probeMissing(value);
      value.models = buildModels(value);
      cached = value;
      retryAt = 0;
      writeMetadataDisk(value);
      writeCatalogDisk(value);
      if (previous === undefined || contentDigest(visibleIds(previous)) !== contentDigest(visibleIds(value))) {
        // 可见目录变化会改变客户端模型列表：过期 Codex 自己的目录缓存。
        try {
          if (options.codexModelsCacheFile) invalidateModelsCache(options.codexModelsCacheFile);
        } catch { /* 客户端缓存不可写不影响网关目录服务。 */ }
      }
    } catch {
      // 拉取失败回退 last-good（允许陈旧）；完全没有缓存则目录为空（等下次刷新），
      // 不用静态快照充数——快照会把已轮换下线的模型暴露给客户端。
      retryAt = now() + FAILURE_COOLDOWN_MS;
      cached ??= readDisk();
      if (cached && !cached.models) cached.models = buildModels(cached);
    }
  }

  async function refresh(force: boolean): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = refreshOnce(force).finally(() => { refreshing = undefined; });
    return refreshing;
  }

  return {
    /** 返回成品条目（刷新时合成并落盘）；无任何缓存（首次拉取即失败）时返回空目录。 */
    async catalog(): Promise<ModelEntry[]> {
      await refresh(false);
      return cached?.models ?? [];
    },
    /** 模型端点协议：元数据 npm 优先，其次探针裁决，缺省 chat。 */
    protocol(id: string): OpencodeZenModelProtocol {
      const models = cached?.metadata?.models;
      const meta = models && Object.hasOwn(models, id) ? models[id] : undefined;
      if (meta) return protocolFromNpm(meta.npm);
      const result = cached?.verdicts?.[id]?.result;
      return result && result !== "drop" ? result : "chat";
    },
    /**
     * 模型上游 baseURL：元数据 provider.api 确认（全 provider 共享一份），元数据缺失或
     * 非 http(s) 时返回 undefined，由转发层回退 OPENCODE_ZEN_DEFAULT_ENDPOINT。
     */
    endpoint(id: string): string | undefined {
      return cached?.metadata?.models?.[id]?.api;
    },
    /** 模型 reasoning effort 档位值域（元数据 reasoning_options）；未知模型空数组。 */
    effortLevels(id: string): string[] {
      const models = cached?.metadata?.models;
      const meta = models && Object.hasOwn(models, id) ? models[id] : undefined;
      return meta?.effortLevels ?? [];
    },
    /** 启动/定时刷新入口：绕过 TTL 重新校验。 */
    async refresh(): Promise<void> {
      await refresh(true);
    },
  };
}
