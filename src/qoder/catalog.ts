import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import codexClientModels from "../../models/codex_client_models.json";
import { invalidateModelsCache, parseCodexCatalog, withAgentSystemPrompt } from "../catalog.ts";
import { QODER_AGENT_SYSTEM_PROMPT } from "./transport.ts";
import { atomicWrite } from "../toml.ts";
import type { ModelCatalog, ModelEntry } from "../types.ts";
import type { QoderCredentials, QoderRegion } from "./credentials.ts";
import { QODER_REGION_LABELS } from "./credentials.ts";

export const QODER_INTL_PREFIX = "qoder-intl/";
export const QODER_CN_PREFIX = "qoder-cn/";
export const QODER_CATALOG_TTL_MS = 100_000;
const FAILURE_COOLDOWN_MS = 30_000;
const CACHE_REVISION = 3;
const BASE = parseCodexCatalog(codexClientModels).models.find((entry) => entry.slug === "gpt-5.5");
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 国内版前缀也属于本地模型族，未实现的地域必须在网关内明确拒绝。 */
export function isQoderModel(model: unknown): boolean {
  return typeof model === "string" && /^qoder(?:-(?:intl|cn))?\//i.test(model);
}

export interface QoderModelSlug {
  region: QoderRegion;
  key: string;
}

const QODER_PREFIXES: Array<{ region: QoderRegion; prefix: string }> = [
  { region: "intl", prefix: QODER_INTL_PREFIX },
  { region: "cn", prefix: QODER_CN_PREFIX },
];

/** 从网关模型名解析地域与上游模型 key；无地域前缀的 qoder/ 归入国际版。 */
export function qoderModelSlug(model: string): QoderModelSlug | undefined {
  for (const { region, prefix } of QODER_PREFIXES) {
    if (!model.toLowerCase().startsWith(prefix)) continue;
    const key = model.slice(prefix.length);
    return key && !key.includes("/") ? { region, key } : undefined;
  }
  return;
}

export function qoderUpstreamModel(model: string): string | undefined {
  return qoderModelSlug(model)?.key;
}

export function qoderRegionOf(model: string): QoderRegion | undefined {
  return qoderModelSlug(model)?.region;
}

export interface QoderCatalogModel {
  key: string;
  display_name: string;
  format?: string;
  source?: string;
  is_vl: boolean;
  is_reasoning: boolean;
  max_input_tokens?: number;
  context_config?: Record<string, { token_count: number; is_default?: boolean }>;
  thinking_config?: Record<string, { is_default?: boolean; efforts?: Record<string, { is_default?: boolean }> }>;
  price_factor?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 只消费账号实际返回的 chat 清单；BYOK 目录需要单独验证授权协议后再接入。 */
export function parseQoderCatalogData(value: unknown): QoderCatalogModel[] {
  const data = record(value);
  if (!data || !Array.isArray(data.chat)) throw new Error("Qoder 模型目录格式错误：缺少 chat 数组");
  const models: QoderCatalogModel[] = [];
  const seen = new Set<string>();
  for (const candidate of data.chat) {
    const entry = record(candidate);
    if (!entry || typeof entry.key !== "string" || !entry.key.trim()
      || entry.key !== entry.key.trim() || /[\s/\\]/.test(entry.key)) {
      throw new Error("Qoder 模型目录格式错误：模型 key 无效");
    }
    if (seen.has(entry.key)) throw new Error("Qoder 模型目录格式错误：模型 key 重复");
    seen.add(entry.key);
    // enable 必须由目录明确授权；未知模型、auto 与禁用条目不能触发上游付费回退。
    if (entry.enable !== true || entry.disabled === true || entry.key.toLowerCase() === "auto") continue;
    const model: QoderCatalogModel = {
      key: entry.key,
      display_name: typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim() : entry.key,
      is_vl: entry.is_vl === true,
      is_reasoning: entry.is_reasoning === true,
    };
    if (typeof entry.format === "string") model.format = entry.format;
    if (typeof entry.source === "string") model.source = entry.source;
    if (positiveNumber(entry.max_input_tokens)) model.max_input_tokens = entry.max_input_tokens;
    if (typeof entry.price_factor === "number" && Number.isFinite(entry.price_factor) && entry.price_factor >= 0) {
      model.price_factor = entry.price_factor;
    }
    const contexts = record(entry.context_config);
    if (contexts) {
      const config: NonNullable<QoderCatalogModel["context_config"]> = {};
      for (const [name, context] of Object.entries(contexts)) {
        const count = record(context)?.token_count;
        if (positiveNumber(count)) {
          config[name] = { token_count: count };
          if (record(context)?.is_default === true) config[name]!.is_default = true;
        }
      }
      if (Object.keys(config).length > 0) model.context_config = config;
    }
    const thinking = record(entry.thinking_config);
    if (thinking) {
      const config: NonNullable<QoderCatalogModel["thinking_config"]> = {};
      for (const mode of ["disabled", "enabled"]) {
        const option = record(thinking[mode]);
        if (!option) continue;
        const selected: NonNullable<QoderCatalogModel["thinking_config"]>[string] = {};
        if (option.is_default === true) selected.is_default = true;
        const efforts = record(option.efforts);
        if (efforts) {
          const allowed: NonNullable<typeof selected.efforts> = {};
          for (const [effort, detail] of Object.entries(efforts)) {
            if (!record(detail) || !/^[a-z]+$/.test(effort)) continue;
            allowed[effort] = record(detail)?.is_default === true ? { is_default: true } : {};
          }
          if (Object.keys(allowed).length > 0) selected.efforts = allowed;
        }
        config[mode] = selected;
      }
      if (Object.keys(config).length > 0) model.thinking_config = config;
    }
    models.push(model);
  }
  return models;
}

/** Codex 行为字段使用现有快照基底，模型名与能力仅由当前账号目录决定；系统提示词在合成时替换为 Qoder CLI 内置提示词并随缓存落盘。 */
export function buildQoderCatalog(models: QoderCatalogModel[], region: QoderRegion = "intl"): ModelCatalog {
  if (!BASE) throw new Error("Codex 模型快照缺少 gpt-5.5 基底条目");
  const prefix = region === "cn" ? QODER_CN_PREFIX : QODER_INTL_PREFIX;
  const display = region === "cn" ? "Qoder-CN" : "Qoder-INTL";
  const label = QODER_REGION_LABELS[region];
  return { models: models.map((entry, priority) => {
    const model = structuredClone(BASE);
    model.slug = `${prefix}${entry.key}`;
    const credits = entry.price_factor === 0 ? " (free)"
      : entry.price_factor !== undefined ? ` (x${entry.price_factor})` : "";
    // is_free 可能和非零倍率同时出现；有效倍率由服务端 price_factor 决定。
    model.display_name = `${display}/${entry.display_name}${credits}`;
    model.description = `通过本机${label} Qoder 授权调用 ${entry.display_name}`;
    model.priority = priority;
    model.prefer_websockets = false;
    delete model.minimal_client_version;
    model.input_modalities = entry.is_vl ? ["text", "image"] : ["text"];
    model.supports_reasoning_summaries = entry.is_reasoning;
    model.supports_reasoning_summary_parameter = false;
    model.supports_image_detail_original = false;
    model.supports_search_tool = false;
    model.support_verbosity = false;
    model.additional_speed_tiers = [];
    model.service_tiers = [];
    delete model.default_service_tier;
    const efforts = entry.thinking_config?.enabled?.efforts;
    const supported = ["minimal", "low", "medium", "high", "xhigh", "max"]
      .filter((effort) => efforts && Object.hasOwn(efforts, effort));
    model.supported_reasoning_levels = supported.map((effort) => ({ effort, description: "" }));
    delete model.default_reasoning_level;
    const defaultEffort = supported.find((effort) => efforts?.[effort]?.is_default === true);
    if (defaultEffort) model.default_reasoning_level = defaultEffort;
    delete model.default_reasoning_summary;
    // 目录没有并行工具调用声明，不继承 GPT 基底的能力保证。
    model.supports_parallel_tool_calls = false;
    const windows = Object.values(entry.context_config ?? {}).map((option) => option.token_count);
    const contextWindow = windows.length ? Math.max(...windows) : entry.max_input_tokens;
    if (contextWindow !== undefined) {
      model.context_window = contextWindow;
      model.max_context_window = contextWindow;
      model.effective_context_window_percent = 95;
    } else {
      delete model.context_window;
      delete model.max_context_window;
      delete model.effective_context_window_percent;
    }
    model.qoder_key = entry.key;
    if (entry.max_input_tokens !== undefined) model.qoder_max_input_tokens = entry.max_input_tokens;
    if (entry.format !== undefined) model.qoder_format = entry.format;
    if (entry.source !== undefined) model.qoder_source = entry.source;
    if (entry.context_config !== undefined) model.qoder_context_config = structuredClone(entry.context_config);
    if (entry.thinking_config !== undefined) model.qoder_thinking_config = structuredClone(entry.thinking_config);
    if (entry.price_factor !== undefined) model.qoder_price_factor = entry.price_factor;
    return withAgentSystemPrompt(model, QODER_AGENT_SYSTEM_PROMPT);
  }) };
}

/** 推理请求仅携带目录中核对过的模型元数据，未知 raw 字段不进入请求或缓存。 */
export function qoderModelConfig(entry: ModelEntry): Record<string, unknown> {
  const config: Record<string, unknown> = {
    key: qoderUpstreamModel(entry.slug),
    enable: true,
    is_vl: Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image"),
    is_reasoning: entry.supports_reasoning_summaries === true,
  };
  if (typeof entry.qoder_format === "string") config.format = entry.qoder_format;
  if (typeof entry.qoder_source === "string") config.source = entry.qoder_source;
  if (positiveNumber(entry.qoder_max_input_tokens)) config.max_input_tokens = entry.qoder_max_input_tokens;
  if (entry.qoder_context_config !== undefined) config.context_config = structuredClone(entry.qoder_context_config);
  if (entry.qoder_thinking_config !== undefined) config.thinking_config = structuredClone(entry.qoder_thinking_config);
  if (entry.qoder_price_factor !== undefined) config.price_factor = entry.qoder_price_factor;
  return config;
}

export function mergeQoderCatalog(base: ModelCatalog, qoder: ModelCatalog): ModelCatalog {
  const models = base.models.filter((entry) => !isQoderModel(entry.slug));
  const priority = Math.max(0, ...models.map((entry) => Number(entry.priority) || 0)) + 100;
  return { models: [...models, ...qoder.models.map((entry, index) => ({ ...entry, priority: priority + index }))] };
}

export interface QoderCatalogStoreOptions {
  region?: QoderRegion;
  cacheDirectory: string;
  credentials: () => Promise<QoderCredentials | null>;
  /** 返回已经解码的目录内容；认证、请求签名和超时由传输层负责。 */
  fetchCatalog: (credential: QoderCredentials) => Promise<unknown>;
  codexModelsCacheFile?: string;
  now?: () => number;
  ttlMs?: number;
}

interface CachedCatalog {
  key: string;
  fetchedAt: number;
  models: ModelEntry[];
}

/** 区域目录存储：账号隔离、原子缓存、单飞刷新、同账号失败回退。 */
export function createQoderCatalogStore(options: QoderCatalogStoreOptions) {
  const region = options.region ?? "intl";
  const label = QODER_REGION_LABELS[region];
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? QODER_CATALOG_TTL_MS;
  const file = path.join(options.cacheDirectory, region === "cn" ? "qoder-cn-catalog.json" : "qoder-intl-catalog.json");
  let cached: CachedCatalog | undefined;
  let retry: { key: string; at: number } | undefined;
  let refreshing: Promise<void> | undefined;
  let forced = false;
  let pendingForce = false;

  function cacheKey(credential: QoderCredentials): string {
    if (!credential.identity) throw new Error("Qoder 授权缺少账号身份，请重新运行 qoder login");
    return digest({ region, identity: credential.identity, revision: CACHE_REVISION });
  }

  function readDisk(key: string): CachedCatalog | undefined {
    try {
      const value = record(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!value || value.cache_key !== key || typeof value.fetched_at !== "number"
        || !Number.isFinite(value.fetched_at) || value.fetched_at > now() || !Array.isArray(value.models)) return;
      const models = value.models as ModelEntry[];
      if (value.content_hash !== digest(models) || !models.every((entry) =>
        record(entry) !== undefined && typeof entry.slug === "string" && qoderUpstreamModel(entry.slug) !== undefined)) return;
      return { key, fetchedAt: value.fetched_at, models };
    } catch { /* 缺失或损坏的缓存按未命中处理。 */ }
  }

  function changed(previous: ModelEntry[] | undefined, next: ModelEntry[]): void {
    if (options.codexModelsCacheFile && (previous === undefined || digest(previous) !== digest(next))) {
      try { invalidateModelsCache(options.codexModelsCacheFile); }
      catch { /* 客户端缓存不可写不影响网关目录服务。 */ }
    }
  }

  async function refreshOnce(force: boolean): Promise<void> {
    const credential = await options.credentials();
    if (!credential) {
      if (cached) changed(cached.models, []);
      cached = undefined;
      retry = undefined;
      return;
    }
    const key = cacheKey(credential);
    if (cached?.key !== key) {
      if (cached) changed(cached.models, []);
      cached = readDisk(key);
      if (retry?.key !== key) retry = undefined;
    }
    if (!force && retry?.key === key && retry.at > now()) return;
    if (!force && cached && now() - cached.fetchedAt >= 0 && now() - cached.fetchedAt < ttlMs) return;
    try {
      const raw = await options.fetchCatalog(credential);
      const source = parseQoderCatalogData(raw);
      const models = buildQoderCatalog(source, region).models;
      const previous = cached?.models;
      cached = { key, fetchedAt: now(), models };
      retry = undefined;
      try {
        atomicWrite(file, `${JSON.stringify({
          cache_key: key,
          fetched_at: cached.fetchedAt,
          source_hash: digest(source),
          content_hash: digest(models),
          models,
        }, null, 2)}\n`);
      } catch { /* 目录缓存写入失败仍服务本次成功结果。 */ }
      changed(previous, models);
    } catch {
      // 切换账号时已清空旧目录，失败只能复用相同身份的最近成功结果。
      retry = { key, at: now() + FAILURE_COOLDOWN_MS };
    }
  }

  async function refresh(force: boolean): Promise<void> {
    if (refreshing) {
      if (force && !forced) pendingForce = true;
      return refreshing;
    }
    forced = force;
    refreshing = (async () => {
      let nextForce = force;
      do {
        pendingForce = false;
        forced = nextForce;
        await refreshOnce(nextForce);
        nextForce = pendingForce;
      } while (nextForce);
    })().finally(() => { refreshing = undefined; forced = false; pendingForce = false; });
    return refreshing;
  }

  return {
    async catalog(): Promise<ModelCatalog> {
      await refresh(false);
      const credential = await options.credentials();
      if (!credential) return { models: [] };
      if (!cached || cached.key !== cacheKey(credential)) {
        throw new Error(`${label} Qoder 模型目录拉取失败，且没有当前账号的可用缓存`);
      }
      return { models: structuredClone(cached.models) };
    },
    async refresh(): Promise<void> { await refresh(true); },
  };
}
