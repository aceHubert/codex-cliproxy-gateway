import { bindHostMethods, withHostServices } from "@agent-proxy/plugin-api";
import type { HostServices, GatewayPlugin } from "@agent-proxy/plugin-api";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import {
  createOpenCodeSessionResolver,
} from "./session.ts";
import {
  buildOpencodeZenUpstreamHeaders,
  createOpencodeZenProjectId,
  injectOpencodeZenFingerprintBody,
  mergeOpencodeZenGateToolsResponses,
} from "./fingerprint.ts";

import {
  OPENCODE_ZEN_PREFIX,
  classifyOpencodeZenProbeSignal,
  createOpencodeZenCatalogStore,
  isOpencodeZenModel,
  mergeOpencodeZenCatalog,
  opencodeZenUpstreamModel,
} from "./catalog.ts";
import type { OpencodeZenModelProtocol, OpencodeZenProbeResult } from "./catalog.ts";
import { aggregateOpencodeZenStreamToCompletion } from "./response.ts";
import { convertOpencodeZenRequest, mergeOpencodeZenToolIdentities, renderOpencodeZenClientOutput } from "./convert.ts";
import type { OpencodeZenPreparedRequest } from "./convert.ts";
import { clientErrorResponse, normalizeResponsesToolDeclarations } from "@agent-proxy/llm-bridge";
import type { ToolIdentityMap } from "@agent-proxy/llm-bridge";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import { createOpencodeZenUserAgentStore } from "./user-agent.ts";
import type { OpencodeZenUserAgentStore } from "./user-agent.ts";


import { localTime, logExchange, logGroupFromPath, requestLogDir } from "@agent-proxy/plugin-api";
import type { RequestLogSink } from "@agent-proxy/plugin-api";
import { resolvePaths } from "@agent-proxy/plugin-api";
import { logGatewayError, logRequestSummary } from "@agent-proxy/plugin-api";
import type { AgentConfig, ModelCatalog, ProcessLogTarget } from "@agent-proxy/plugin-api";

/**
 * OpenCode Zen（https://opencode.ai/inference/openai/v1）免费模型入口门面。
 *
 * 不需要本地凭据：鉴权是公共 `Bearer public`（可选 OPENCODE_API_KEY），合规性由
 * 指纹层（fingerprint.ts）与合规会话（session.ts）保证——匿名共享池按 IP 滚动限额，
 * 耗尽时上游以 429 FreeUsageLimitError 拒绝（与形态拒绝同文案）。目录按官方元数据
 * 暴露每个模型的端点协议（chat / responses / anthropic / google），转发层按协议
 * 自动转换（convert.ts）：`catalog()` 供 /v1/models 合并，`forward()` 处理
 * /v1/chat/completions 拦截，`forwardResponses()` 处理 /v1/responses 拦截。
 */


/** 上游缺省端点（元数据 provider.api 缺失时的回退）；实际以元数据 api 字段为准。 */
export const OPENCODE_ZEN_DEFAULT_ENDPOINT = "https://opencode.ai/inference/openai/v1";
/** 模型列表端点（/models 仅存在于 /inference/v1 基座；2026-10-26 实测 openai 基座 404）。 */
export const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/inference/v1";
export const OPENCODE_ZEN_PUBLIC_API_KEY = "public";
/** OpenCode 官方模型元数据（客户端同源数据）：含每模型端点协议（provider.npm）与 deprecated 标记。 */
export const OPENCODE_ZEN_METADATA_URL = "https://models.opencode.ai/api.json";

/** 免费目录轮换节奏慢，按 10 分钟对齐目录 TTL 定时刷新。 */
const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 600_000;

export interface OpencodeZenDependencies {
  /** 上游端点覆盖；缺省 https://opencode.ai/inference/openai/v1（正常由元数据 api 字段覆盖）。 */
  endpoint?: string;
  /** 自定义鉴权 key；缺省读环境变量 OPENCODE_API_KEY，再缺省 "public"。 */
  apiKey?: string;
  /** 稳定的 x-opencode-project 标识；缺省按主机名派生 40-hex。 */
  projectId?: string;
  cacheDirectory?: string;
  /** Codex 自己的目录缓存；目录内容变化时过期它。 */
  codexModelsCacheFile?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** models.opencode.ai 元数据拉取覆盖（测试注入）；缺省走真实网络。 */
  fetchMetadata?: () => Promise<unknown>;
  /** 无元数据模型的多端点探针覆盖（测试注入）；缺省用指纹请求真实探测。 */
  probeModel?: (id: string) => Promise<OpencodeZenProbeResult>;
  /** 客户端 UA 版本获取覆盖（测试注入）；缺省按 npm dist-tag 拉取并回退指纹快照。 */
  userAgentStore?: OpencodeZenUserAgentStore;


  catalogRefreshIntervalMs?: number;
  catalogMode?: "dynamic" | "manual";
  refreshCatalogOnStart?: boolean;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  processLog?: ProcessLogTarget;
}

export function validateOpencodeZenConfig(config: AgentConfig): void {
  const host = config.host;
  if (!(host === "localhost" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127.")))) {
    throw new Error("启用 opencodeZen 时网关只能监听环回地址");
  }
}

export function opencodeZenError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, message } }, { status });
}

/**
 * 上游错误归一化：以透传上游 message 原文为主，网关只补两件事——
 * 可程序化处理的 `type` 分类，以及上游没给 message 时的一句中性提示。
 *
 * 文案里不写修复指引：上游协议、门禁形态与目录轮换都会变，硬编码的建议一旦漂移就
 * 把用户引向错误的修复方向。2026-10-14 实证：上游对失效模型返回
 * `server_error: Upstream request failed: Endpoint is unavailable.`，旧文案按「任何
 * 403 都是门禁失效」归成了「升级网关的 Zen 指纹数据」，实际与指纹无关。排查方向改由
 * `scripts/zen-gate-probe.ts` 承接（对照组失败才是指纹本体过期）。
 *
 * Zen 请求不携带用户凭据（public key / 账号 OPENCODE_API_KEY），上游详情可安全透出。
 */
export function normalizeOpencodeZenUpstreamError(status: number, body: string): { status: number; type: string; message: string } {
  const normalizedStatus = status >= 400 && status <= 599 ? status : 502;
  const type = classifyOpencodeZenUpstreamError(status, body);
  const message = extractUpstreamMessage(body) || ZEN_ERROR_FALLBACK[type] || `OpenCode Zen 上游请求失败（HTTP ${normalizedStatus}）。`;
  return { status: normalizedStatus, type, message };
}

/** 上游未给出 message 时的中性兜底文案（只述事实，不给修复指引）。 */
const ZEN_ERROR_FALLBACK: Record<string, string> = {
  zen_free_tier_error: "OpenCode Zen 免费层校验未通过：上游拒绝了当前请求形态。",
  zen_region_error: "OpenCode Zen 提示该模型在当前网络地区不可用。",
  zen_rate_limited: "OpenCode Zen 免费额度限流，请稍后重试。",
  zen_model_unavailable: "OpenCode Zen 当前目录中没有该模型。",
  zen_authentication_error: "OpenCode Zen 鉴权失败。",
};

/**
/**
 * 分类优先看上游 `error.type`（结构化、最可靠），再退到报文关键词与状态码。
 *
 * 关键约束：不把「任何 403/429 都当门禁失效」。拒绝里至少混着这些成因——匿名池
 * 按 IP 滚动耗尽与形态拒绝（同为 429 `FreeUsageLimitError`，文案不可区分，换出口
 * 复测才是判据）、地区限制（`RegionError`）、上游自身故障（`server_error`，如模型
 * 端点已下线）；排查方向由 `scripts/zen-gate-probe.ts` 承接（对照组失败才是指纹
 * 本体过期）。
 */
function classifyOpencodeZenUpstreamError(status: number, body: string): string {
  const upstreamType = extractUpstreamErrorType(body).toLowerCase();
  const text = body.toLowerCase();
  if (upstreamType === "freetiererror" || text.includes("free tier") || text.includes("freetier")) return "zen_free_tier_error";
  if (upstreamType === "regionerror" || text.includes("region") || text.includes("country") || text.includes("not available in your")) return "zen_region_error";
  if (status === 429 || upstreamType.includes("usagelimit") || upstreamType.includes("ratelimit") || text.includes("freeusagelimit") || text.includes("rate limit")) return "zen_rate_limited";
  if (status === 404 || text.includes("not found") || text.includes("not_available") || text.includes("does not exist") || text.includes("endpoint is unavailable")) return "zen_model_unavailable";
  if (status === 401) return "zen_authentication_error";
  return "zen_upstream_error";
}

/** 解析上游 JSON 的 `error.type`（兼容 `error` 为字符串与顶层 `type`）；取不到返回空串。 */
function extractUpstreamErrorType(body: string): string {
  const parsed = parseUpstreamError(body);
  if (typeof parsed === "string") return "";
  const error = parsed.error;
  if (isRecord(error)) return typeof error.type === "string" ? error.type : "";
  return typeof parsed.type === "string" ? parsed.type : "";
}

/**
 * 取上游错误描述：`error.message` → `error`（字符串）→ 顶层 `message`。
 * 报文是 JSON 却取不到描述时返回空串，交给兜底文案——不把裸 JSON 当成人话透给客户端；
 * 报文不是 JSON（纯文本 / HTML 错误页）时才原样截断透出。
 */
function extractUpstreamMessage(body: string): string {
  const parsed = parseUpstreamError(body);
  if (typeof parsed === "string") return parsed;
  const error = parsed.error;
  const message = typeof error === "string"
    ? error
    : isRecord(error) && typeof error.message === "string"
      ? error.message
      : typeof parsed.message === "string"
        ? parsed.message
        : "";
  return message.trim().slice(0, 300);
}

/**
 * 上游错误报文：JSON 对象，或（不是对象 / 解析失败时的）截断原文。
 * `null` 与标量都走原文分支，调用方取属性不会抛错；解析用未截断的原文，
 * 避免长报文被截成非法 JSON 而误判成纯文本。
 */
function parseUpstreamError(body: string): UpstreamErrorPayload | string {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : body.trim().slice(0, 300);
  } catch {
    return body.trim().slice(0, 300);
  }
}

type UpstreamErrorPayload = { error?: unknown; message?: unknown; type?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveApiKey(dependencies: OpencodeZenDependencies): string {
  return dependencies.apiKey ?? process.env.OPENCODE_API_KEY ?? OPENCODE_ZEN_PUBLIC_API_KEY;
}

/** 模型端点 URL：google 走 per-model 路径 + SSE 流式后缀（对齐官方 AI SDK 构造）。 */
function opencodeZenProtocolUrl(baseUrl: string, protocol: OpencodeZenModelProtocol, model: string): string {
  switch (protocol) {
    case "chat-completions": return `${baseUrl}/chat/completions`;
    case "responses": return `${baseUrl}/responses`;
    case "anthropic": return `${baseUrl}/messages`;
    case "gemini": return `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  }
}

/* ========== R4 厂商适配层：转换结果 → 上游请求（按协议注册，调用点无分支） ========== */

/** zen 上游请求的厂商适配结果：URL / 请求体 / 额外头 / 增补后的身份表。 */
interface ZenUpstreamRequest {
  url: string;
  body: Record<string, unknown>;
  extraHeaders: Record<string, string>;
  tools: ToolIdentityMap;
}

interface ZenUpstreamContext {
  baseUrl: string;
  upstreamModel: string;
  session: string;
  /** 客户端请求的流式意愿（仅 gemini 同协议直通按它选择端点）。 */
  clientStreams: boolean;
  effortLevels: readonly string[];
  /** 客户端原始输入：同协议保真补丁读取原始字段（缓存键 / 上限缺省判断）。 */
  source: Record<string, unknown>;
}

type ZenUpstreamAdapter = (converted: OpencodeZenPreparedRequest, ctx: ZenUpstreamContext) => ZenUpstreamRequest;

/** gemini 请求体无 model 字段（模型在 URL）：桥接 model 回填仅对其余目标启用。 */
function zenConvertModelOptions(protocol: OpencodeZenModelProtocol, upstreamModel: string): { model: string } | undefined {
  return protocol === "gemini" ? undefined : { model: upstreamModel };
}

/** chat 端点门禁为工具名单制：垫补占位并为实际垫补名建立响应身份（同/跨协议共用）。 */
const adaptZenChatUpstream: ZenUpstreamAdapter = (converted, ctx) => {
  const { body } = injectOpencodeZenFingerprintBody({ ...converted.body, model: ctx.upstreamModel }, ctx.session, ctx.effortLevels);
  return {
    url: `${ctx.baseUrl}/chat/completions`,
    body,
    extraHeaders: {},
    tools: mergeOpencodeZenToolIdentities(converted.tools, body.tools),
  };
};

/** 同协议保真补丁：桥接直通体（克隆 + 原名身份表 + model 回填）只补服务必需字段。 */
const ZEN_SAME_PROTOCOL_ADAPTATIONS: Record<OpencodeZenModelProtocol, ZenUpstreamAdapter> = {
  "chat-completions": adaptZenChatUpstream,
  responses: (converted, ctx) => {
    // /responses 端点执行同一门禁：官方 read/shell 扁平定义 + 强制流式（非流式 403），
    // 非流式客户端由 forwardResponses 聚合 SSE 回完整 JSON。
    const tools = mergeOpencodeZenGateToolsResponses(converted.body.tools);
    return {
      url: `${ctx.baseUrl}/responses`,
      body: {
        ...converted.body,
        tools,
        stream: true,
        ...(typeof ctx.source.prompt_cache_key === "string" && ctx.source.prompt_cache_key ? {} : { prompt_cache_key: ctx.session }),
      },
      extraHeaders: {},
      tools: mergeOpencodeZenToolIdentities(converted.tools, tools),
    };
  },
  anthropic: (converted, ctx) => ({
    url: `${ctx.baseUrl}/messages`,
    body: { ...converted.body, ...(ctx.source.max_tokens === undefined ? { max_tokens: 8192 } : {}) },
    extraHeaders: { "anthropic-version": "2023-06-01" },
    tools: converted.tools,
  }),
  gemini: (converted, ctx) => ({
    url: ctx.clientStreams
      ? `${ctx.baseUrl}/models/${encodeURIComponent(ctx.upstreamModel)}:streamGenerateContent?alt=sse`
      : `${ctx.baseUrl}/models/${encodeURIComponent(ctx.upstreamModel)}:generateContent`,
    body: converted.body,
    extraHeaders: {},
    tools: converted.tools,
  }),
};

/** 跨协议服务化改写：转换体补真实模型、恒定 SSE（桥接渲染需要事件流）与协议头。 */
const ZEN_CROSS_PROTOCOL_ADAPTATIONS: Record<OpencodeZenModelProtocol, ZenUpstreamAdapter> = {
  "chat-completions": adaptZenChatUpstream,
  responses: (converted, ctx) => {
    // 同一 /responses 门禁：跨协议转换体同样合并官方定义（流式已恒定强制）。
    const tools = mergeOpencodeZenGateToolsResponses(converted.body.tools);
    return {
      url: `${ctx.baseUrl}/responses`,
      body: { ...converted.body, model: ctx.upstreamModel, stream: true, tools, ...(converted.body.prompt_cache_key === undefined ? { prompt_cache_key: ctx.session } : {}) },
      extraHeaders: {},
      tools: mergeOpencodeZenToolIdentities(converted.tools, tools),
    };
  },
  anthropic: (converted, ctx) => ({
    url: `${ctx.baseUrl}/messages`,
    body: { ...converted.body, model: ctx.upstreamModel, stream: true },
    extraHeaders: { "anthropic-version": "2023-06-01" },
    tools: converted.tools,
  }),
  gemini: (converted, ctx) => ({
    url: `${ctx.baseUrl}/models/${encodeURIComponent(ctx.upstreamModel)}:streamGenerateContent?alt=sse`,
    body: converted.body,
    extraHeaders: {},
    tools: converted.tools,
  }),
};

/**
 * R4 统一请求调用形态：先桥接转换，再按「同协议保真 / 跨协议服务化」查表适配。
 * 主流程保持 convert → adapt → fetch 线性三步，协议差异全部收敛在本表内。
 */
function adaptOpencodeZenUpstreamRequest(
  from: OpencodeZenModelProtocol,
  to: ClientProtocol,
  converted: OpencodeZenPreparedRequest,
  ctx: ZenUpstreamContext,
): ZenUpstreamRequest {
  const adapters = to === from ? ZEN_SAME_PROTOCOL_ADAPTATIONS : ZEN_CROSS_PROTOCOL_ADAPTATIONS;
  // muse-spark 不识别工具信封；其余原生 Responses 仍按原位置直通。
  const prepared = to === "responses" && isOpencodeZenMuseSparkUpstreamModel(ctx.upstreamModel)
    ? { ...converted, body: normalizeResponsesToolDeclarations(converted.body) }
    : converted;
  const adapted = adapters[from](prepared, ctx);
  // muse-spark 家族的 /responses 实现受限：适配出口统一做模型级净化，其余模型零变化。
  if (isOpencodeZenMuseSparkUpstreamModel(ctx.upstreamModel)) {
    adapted.body = sanitizeOpencodeZenMuseSparkResponsesBody(adapted.body);
  }
  return adapted;
}

/* ========== muse-spark 受限 /responses 净化（2026-10-15 上游实证） ========== */

/**
 * muse-spark 家族前缀。该家族 /responses 实现有两处已实证的受限点（chat 端点整体
 * `ModelProtocolUnsupported`，不存在改路由空间）：Codex 0.162 的 `additional_tools`
 * 信封项与 `web_search.search_content_types` 参数都会被 400 拒绝，按模型名前缀净化。
 */
const MUSE_SPARK_MODEL_PREFIX = "muse-spark-";

function isOpencodeZenMuseSparkUpstreamModel(model: string): boolean {
  return model.startsWith(MUSE_SPARK_MODEL_PREFIX);
}

/**
 * muse-spark 请求体净化（对不含相关字段的请求体是零变化直返）：
 * - `additional_tools` 信封已由公共桥接入口归一化，此处只处理模型特有的限制。
 * - `search_content_types` 仅 `web_search_preview` 合法，从 `web_search` 定义剥离
 *   （cliproxy 时代同款过滤，2026-10-15 上游复测确认报文）。
 * - 上游不支持 `custom` 工具（400 "`custom` tools are not supported on this
 *   endpoint"）：丢弃 custom 声明（含 namespace 内层；内层清空的 namespace 一并
 *   丢弃）。custom 依赖 custom_tool_call 响应形状，转 function 会让模型产出
 *   function_call 而客户端无法对应，故只丢弃不转换——代价是该模型上 Codex 的
 *   custom 工具（如 node REPL 的 exec）不可用。
 * - 工具 description 上游要求非空（实测 Codex 的 `functions` namespace 声明带空串
 *   description，被 400 `tools[1].description` 拒绝）：缺失或空串以工具名占位，
 *   namespace 内层工具同样处理。
 */
function sanitizeOpencodeZenMuseSparkResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.tools)) return body;
  const tools = body.tools
    .map(dropMuseSparkCustomTools)
    .filter((tool) => tool !== undefined)
    .map((tool) => fillMuseSparkToolDescription(stripMuseSparkWebSearchContentType(tool)));
  if (tools.length === body.tools.length && !tools.some((tool, index) => tool !== (body.tools as unknown[])[index])) return body;
  return { ...body, tools };
}

/**
 * 丢弃 custom 工具声明：顶层与 namespace 内层（清空的 namespace 一并丢弃）。
 * 其余条目原引用返回；数组无变化时原引用返回。
 */
function dropMuseSparkCustomTools(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;
  if (tool.type === "custom") return undefined;
  if (Array.isArray(tool.tools)) {
    const inner = tool.tools as unknown[];
    const entries = inner.map(dropMuseSparkCustomTools).filter((entry) => entry !== undefined);
    if (entries.length === 0) return undefined;
    if (entries.length !== inner.length) return { ...tool, tools: entries };
  }
  return tool;
}

/** web_search 定义的 search_content_types 剥离（web_search_preview 保留）。 */
function stripMuseSparkWebSearchContentType(tool: unknown): unknown {
  if (!isRecord(tool) || tool.type !== "web_search" || !("search_content_types" in tool)) return tool;
  const { search_content_types: _dropped, ...rest } = tool;
  return rest;
}

/**
 * 工具 description 缺失/空串时以工具名占位（无名的兜底 "tool"）；namespace 内层递归；
 * 无变化时原引用返回。仅 function/custom/namespace 等携带 schema 的声明型工具处理——
 * web_search 等服务端内置工具无 description 上游也接受（2026-10-15 探针实测）。
 */
function fillMuseSparkToolDescription(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;
  let next = tool;
  const declarative = tool.type === "function" || tool.type === "custom" || tool.type === "namespace";
  if (declarative && (typeof tool.description !== "string" || !tool.description)) {
    next = { ...tool, description: typeof tool.name === "string" && tool.name ? tool.name : "tool" };
  }
  if (Array.isArray(next.tools)) {
    const entries = next.tools.map(fillMuseSparkToolDescription);
    if (entries.some((entry, index) => entry !== (next.tools as unknown[])[index])) {
      next = { ...next, tools: entries };
    }
  }
  return next;
}


function buildOpencodeZenAdapter(config: AgentConfig, dependencies: OpencodeZenDependencies = {}) {
  validateOpencodeZenConfig(config);
  const endpoint = dependencies.endpoint ?? OPENCODE_ZEN_DEFAULT_ENDPOINT;
  const baseUrl = endpoint.replace(/\/+$/, "");
  const fetchImpl = dependencies.fetch ?? fetch;
  const projectId = dependencies.projectId ?? createOpencodeZenProjectId(os.hostname());
  const sessionResolver = createOpenCodeSessionResolver();

  /** UA 版本动态获取：转发与探测统一读 current()，失败静默回退指纹快照。 */
  const userAgent = dependencies.userAgentStore ?? createOpencodeZenUserAgentStore({ fetch: fetchImpl });
  /** 转发/探测统一用同一套指纹标头（含当前 UA），避免 UA 漂移只修一半。 */
  const opencodeZenHeaders = (session: string): Record<string, string> =>
    buildOpencodeZenUpstreamHeaders(session, resolveApiKey(dependencies), projectId, userAgent.current());
  const sink: RequestLogSink | undefined = config.requestLogging === true ? {
    dir: requestLogDir(),
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
    processLog: dependencies.processLog,
  } : undefined;
  const fetchModels = async (): Promise<unknown> => {
    // 目录端点目前不校验指纹，但完整标头零成本且能免疫未来收紧。
    const session = sessionResolver.resolve(new Headers());
    const headers = opencodeZenHeaders(session);
    headers.accept = "application/json";
    const response = await fetchImpl(`${OPENCODE_ZEN_MODELS_ENDPOINT}/models`, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`zen /models returned HTTP ${response.status}`);
    return await response.json();
  };
  // 元数据与探针都复用与转发一致的指纹标头：与真实客户端流量同形态，门禁行为一致。
  const fetchMetadata = dependencies.fetchMetadata ?? (async (): Promise<unknown> => {
    const session = sessionResolver.resolve(new Headers());
    const headers = opencodeZenHeaders(session);
    headers.accept = "application/json";
    const response = await fetchImpl(OPENCODE_ZEN_METADATA_URL, { method: "GET", headers, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`zen metadata returned HTTP ${response.status}`);
    return await response.json();
  });
  /**
   * 多端点探针阶梯：chat → responses → anthropic → google。首个"被服务"信号确定
   * 协议；401/404（模型不存在或需账号）直接 drop；429 FreeUsageLimitError 视为
   * "被服务"（形态拒绝与匿名池耗尽同文案，无法区分时保守保留）；全阶梯无信号才
   * drop（如 systemone 的 jev）。
   */
  const probeModel = dependencies.probeModel ?? (async (id: string): Promise<OpencodeZenProbeResult> => {
    const probePlain = async (
      path: string,
      body: Record<string, unknown>,
      extraHeaders: Record<string, string> = {},
    ): Promise<Response> => {
      const session = sessionResolver.resolve(new Headers());
      const headers = { ...opencodeZenHeaders(session), ...extraHeaders };
      return fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, model: id }),
        signal: AbortSignal.timeout(30_000),
      });
    };
    const steps: Array<[OpencodeZenModelProtocol, () => Promise<Response>]> = [
      ["chat-completions", async () => {
        const session = sessionResolver.resolve(new Headers());
        const headers = opencodeZenHeaders(session);
        const { body } = injectOpencodeZenFingerprintBody(
          { model: id, messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 1 },
          session,
        );
        return fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
        });
      }],
      ["responses", () => probePlain("/responses", { input: [{ role: "user", content: "hi" }], stream: true, max_output_tokens: 16 })],
      ["anthropic", () => probePlain("/messages", { messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: true }, { "anthropic-version": "2023-06-01" })],
      ["gemini", () => probePlain(`/models/${encodeURIComponent(id)}:generateContent`, { contents: [{ role: "user", parts: [{ text: "hi" }] }] })],
    ];
    for (let index = 0; index < steps.length; index++) {
      const [protocol, send] = steps[index]!;
      let response: Response;
      try {
        response = await send();
      } catch {
        return "chat-completions"; // 网络异常无法判定：保守保留。
      }
      if (response.ok) {
        try { await response.body?.cancel(); } catch { /* 只取状态码，丢弃流。 */ }
        return protocol;
      }
      const text = await response.text().catch(() => "");
      const signal = classifyOpencodeZenProbeSignal(response.status, text);
      if (signal === "served") return protocol;
      if (signal === "offline") return "drop";
      if (signal === "gate" && index === 0) return "chat-completions"; // 指纹/门禁全局异常：保守不过滤。
    }
    return "drop";
  });


  const store = createOpencodeZenCatalogStore({
    cacheDirectory: dependencies.cacheDirectory ?? resolvePaths().runtimeHome,
    catalogMode: dependencies.catalogMode,
    fetchCatalog: fetchModels,
    fetchMetadata,
    probeModel,
    codexModelsCacheFile: dependencies.codexModelsCacheFile,
  });
  const schedule = dependencies.setInterval ?? setInterval;
  const cancel = dependencies.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startup: Promise<void> | undefined;
  if (dependencies.refreshCatalogOnStart !== false) {
    // 启动/安装刷新一律强制重拉（含元数据）：重启即手动更新窗口，对齐 agy/qoder/
    // codebuddy 的启动强制语义；元数据 6 小时 TTL 只约束后台定时刷新，否则免费池
    // 新上线的模型在 TTL 内始终无窗口档位，客户端按自身缺省（如 1M）虚标上下文。
    startup = store.refresh(true);
    void startup.catch(() => {});
    void startup.finally(() => { startup = undefined; }).catch(() => {});
    void userAgent.refresh().catch(() => {});
  }
  // 手动目录模式仍维护客户端指纹；维护指纹不会刷新模型、元数据或探针。
  timer = schedule(() => {
    if (dependencies.catalogMode !== "manual") void store.refresh().catch(() => {});
    void userAgent.refresh().catch(() => {});
  }, Math.max(1_000, dependencies.catalogRefreshIntervalMs ?? DEFAULT_CATALOG_REFRESH_INTERVAL_MS));
  timer.unref?.();
  const activeRequests = new Set<AbortController>();
  let closed = false;

  return {
    async catalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      await startup?.catch(() => {});
      try {
        return { models: await store.catalog() };
      } catch {
        return { models: [] };
      }
    },
    async refreshCatalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      await (startup ?? store.refresh(true));
      return { models: await store.catalog() };
    },
    async reloadCatalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      await startup?.catch(() => {});
      return { models: await store.reload() };
    },
    /**
     * /v1/chat/completions 拦截入口：剥前缀、注入指纹、按客户端流式偏好回包。
     * 非流式客户端在网关侧聚合上游 SSE；流式客户端原样透传事件流。
     */
    async forward(request: Request, input: Record<string, unknown>, to: ClientProtocol = "chat-completions"): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      let logged = false;
      const log = (status: number, resBody: string, headers = new Headers()) => {
        if (logged) return;
        logged = true;
        const durationMs = Date.now() - start;
        logExchange(sink, group, {
          requestTime, method: request.method, url: incoming.pathname,
          // 请求日志只记录模型与流式标记，不落提示词、工具内容或任何凭据。
          reqHeaders: new Headers(), reqBody: { model: input.model, stream: input.stream === true },
          status, resHeaders: headers, resBody, durationMs,
        }, "opencode-zen");
        if (status >= 400) {
          logGatewayError(sink?.processLog, { requestTime, method: request.method, url: incoming.pathname, status, message: resBody.slice(0, 500), durationMs });
        } else {
          logRequestSummary(sink?.processLog, { requestTime, method: request.method, url: incoming.pathname, status, durationMs });
        }
      };
      const fail = (status: number, message: string, type?: string) => {
        const response = opencodeZenError(status, message, type);
        log(status, JSON.stringify({ error: { type, message } }), response.headers);
        return response;
      };
      if (closed) return fail(503, "OpenCode Zen 入口已关闭", "configuration_error");
      // isOpencodeZenModel 大小写不敏感而目录 slug 用小写前缀：OPENCODE-ZEN/x 归一后再剥前缀。
      const rawModel = typeof input.model === "string" ? input.model : "";
      const normalized = isOpencodeZenModel(rawModel)
        ? rawModel.slice(0, OPENCODE_ZEN_PREFIX.length).toLowerCase() + rawModel.slice(OPENCODE_ZEN_PREFIX.length)
        : rawModel;
      const upstreamModel = opencodeZenUpstreamModel(normalized);
      if (!upstreamModel) return fail(400, `OpenCode Zen 模型必须使用 ${OPENCODE_ZEN_PREFIX} 前缀`);
      const abort = new AbortController();
      const onAbort = () => abort.abort(request.signal.reason);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        request.signal.removeEventListener("abort", onAbort);
        activeRequests.delete(abort);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      activeRequests.add(abort);
      try {
        if (request.signal.aborted) onAbort();
        abort.signal.throwIfAborted();
        const session = sessionResolver.resolve(request.headers);
        const headers = opencodeZenHeaders(session);
        const protocol = store.protocol(upstreamModel) ?? "chat-completions";
        // 上游 baseURL 由元数据 provider.api 确认（官方同源数据）；元数据缺失回退配置/缺省端点。
        const modelBaseUrl = (store.endpoint(upstreamModel) ?? endpoint).replace(/\/+$/, "");
        const aggregateForClient = input.stream !== true;
        let upstream: Response;
        let convertedTools: ToolIdentityMap = new Map();
        {
          // R4 统一形态：桥接转换（同协议直通由桥接层处理）→ 查表厂商适配 → fetch。
          const converted = await convertOpencodeZenRequest(protocol, to, input, zenConvertModelOptions(protocol, upstreamModel));
          const adapted = adaptOpencodeZenUpstreamRequest(protocol, to, converted, {
            baseUrl: modelBaseUrl, upstreamModel, session, clientStreams: input.stream === true,
            effortLevels: store.effortLevels(upstreamModel) ?? [], source: input,
          });
          convertedTools = adapted.tools;
          abort.signal.throwIfAborted();
          upstream = await fetchImpl(adapted.url, {
            method: "POST",
            headers: { ...headers, ...adapted.extraHeaders },
            body: JSON.stringify(adapted.body),
            signal: abort.signal,
          });
        }
        if (!upstream.ok || !upstream.body) {
          const errorBody = await upstream.text().catch(() => "");
          const safe = normalizeOpencodeZenUpstreamError(upstream.status, errorBody);
          logGatewayError(sink?.processLog, {
            requestTime, method: request.method, url: incoming.pathname,
            status: safe.status,
            message: `zen upstream ${upstream.status}: ${errorBody.slice(0, 1_024)}`,
            durationMs: Date.now() - start,
          });
          cleanup();
          return fail(safe.status, safe.message, safe.type);
        }
        const responseHeaders = new Headers({
          "content-type": protocol === "chat-completions"
            ? upstream.headers.get("content-type") ?? "text/event-stream"
            : "text/event-stream",
        });
        const cacheControl = upstream.headers.get("cache-control");
        if (cacheControl) responseHeaders.set("cache-control", cacheControl);
        if (protocol !== "chat-completions") {
          // 跨协议：经桥接事件渲染回 chat-completions 客户端（流式 SSE 或聚合 JSON）。
          const rendered = await renderOpencodeZenClientOutput(protocol, "chat-completions", upstream, {
            model: String(input.model ?? upstreamModel), stream: !aggregateForClient, tools: convertedTools,
            signal: abort.signal, abort: () => { abort.abort(); cleanup(); },
          });
          const headers = new Headers(rendered.headers);
          if (cacheControl && !headers.has("cache-control")) headers.set("cache-control", cacheControl);
          if (aggregateForClient) {
            const completion = await rendered.text();
            log(200, completion, headers);
            cleanup();
            return new Response(completion, { status: rendered.status, headers });
          }
          const [toClient, toLog] = rendered.body!.tee();
          void new Response(toLog).text().then((text) => log(200, text, headers)).catch(() => {});
          return new Response(toClient, { status: rendered.status, headers });
        }
        const stream = upstream.body;
        if (aggregateForClient) {
          const completion = await aggregateOpencodeZenStreamToCompletion(stream);
          const response = Response.json(completion);
          log(200, JSON.stringify(completion), response.headers);
          cleanup();
          return response;
        }
        // 流式透传：用 tee 副本留痕请求日志，避免读完流令客户端拿不到增量。
        const [toClient, toLog] = stream.tee();
        void new Response(toLog).text().then((text) => log(200, text, responseHeaders)).catch(() => {});
        cleanup();
        return new Response(toClient, { status: 200, headers: responseHeaders });

      } catch (error) {
        abort.abort();
        cleanup();
        if (request.signal.aborted) return fail(499, "OpenCode Zen 请求已取消", "request_cancelled");
        logGatewayError(sink?.processLog, {
          requestTime, method: request.method, url: incoming.pathname, status: 502,
          message: `zen forward failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          durationMs: Date.now() - start,
        });
        return fail(502, "OpenCode Zen 上游请求失败", "upstream_error");
      }
    },

    /**
     * /v1/responses 拦截入口：responses 协议模型直通上游（无需转换）；chat / anthropic /
     * google 协议模型先转换请求（chat 目标垫补官方门禁工具，system 内容原样透传），
     * 上游流反向转回 responses
     * 事件；非流式客户端由网关聚合为完整 response JSON。
     */
    async forwardResponses(request: Request, input: Record<string, unknown>, to: ClientProtocol = "responses"): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      let logged = false;
      const log = (status: number, resBody: string, headers = new Headers()) => {
        if (logged) return;
        logged = true;
        const durationMs = Date.now() - start;
        logExchange(sink, group, {
          requestTime, method: request.method, url: incoming.pathname,
          // 请求日志只记录模型与流式标记，不落提示词、工具内容或任何凭据。
          reqHeaders: new Headers(), reqBody: { model: input.model, stream: input.stream === true },
          status, resHeaders: headers, resBody, durationMs,
        }, "opencode-zen");
        if (status >= 400) {
          logGatewayError(sink?.processLog, { requestTime, method: request.method, url: incoming.pathname, status, message: resBody.slice(0, 500), durationMs });
        } else {
          logRequestSummary(sink?.processLog, { requestTime, method: request.method, url: incoming.pathname, status, durationMs });
        }
      };
      const fail = (status: number, message: string, type?: string) => {
        const response = opencodeZenError(status, message, type);
        log(status, JSON.stringify({ error: { type, message } }), response.headers);
        return response;
      };
      if (closed) return fail(503, "OpenCode Zen 入口已关闭", "configuration_error");
      const rawModel = typeof input.model === "string" ? input.model : "";
      const normalized = isOpencodeZenModel(rawModel)
        ? rawModel.slice(0, OPENCODE_ZEN_PREFIX.length).toLowerCase() + rawModel.slice(OPENCODE_ZEN_PREFIX.length)
        : rawModel;
      const upstreamModel = opencodeZenUpstreamModel(normalized);
      if (!upstreamModel) return fail(400, `OpenCode Zen 模型必须使用 ${OPENCODE_ZEN_PREFIX} 前缀`);
      const abort = new AbortController();
      const onAbort = () => abort.abort(request.signal.reason);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        request.signal.removeEventListener("abort", onAbort);
        activeRequests.delete(abort);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      activeRequests.add(abort);
      try {
        if (request.signal.aborted) onAbort();
        abort.signal.throwIfAborted();
        const session = sessionResolver.resolve(request.headers);
        const headers = opencodeZenHeaders(session);
        const protocol = store.protocol(upstreamModel) ?? "chat-completions";
        // 上游 baseURL 由元数据 provider.api 确认（官方同源数据）；元数据缺失回退配置/缺省端点。
        const modelBaseUrl = (store.endpoint(upstreamModel) ?? endpoint).replace(/\/+$/, "");
        const clientStreams = input.stream === true;
        let upstream: Response;
        let preparedTools: ToolIdentityMap = new Map();
        // R4 统一形态：桥接转换（同协议直通由桥接层处理）→ 查表厂商适配 → fetch。
        const converted = await convertOpencodeZenRequest(protocol, to, input, zenConvertModelOptions(protocol, upstreamModel));
        const adapted = adaptOpencodeZenUpstreamRequest(protocol, to, converted, {
          baseUrl: modelBaseUrl, upstreamModel, session, clientStreams: clientStreams,
          effortLevels: store.effortLevels(upstreamModel) ?? [], source: input,
        });
        preparedTools = adapted.tools;
        upstream = await fetchImpl(adapted.url, {
          method: "POST", headers: { ...headers, ...adapted.extraHeaders }, body: JSON.stringify(adapted.body), signal: abort.signal,
        });
        if (!upstream.ok || !upstream.body) {
          const errorBody = await upstream.text().catch(() => "");
          const safe = normalizeOpencodeZenUpstreamError(upstream.status, errorBody);
          logGatewayError(sink?.processLog, {
            requestTime, method: request.method, url: incoming.pathname,
            status: safe.status,
            message: `zen upstream ${upstream.status}: ${errorBody.slice(0, 1_024)}`,
            durationMs: Date.now() - start,
          });
          cleanup();
          return fail(safe.status, safe.message, safe.type);
        }
        if (protocol === "responses") {
          // 直通：流式原样透传；非流式客户端因上游强制流式（门禁拒非流式），聚合 SSE 回完整 JSON。
          if (!clientStreams) {
            const rendered = await renderOpencodeZenClientOutput("responses", "responses", upstream, {
              model: String(input.model ?? upstreamModel), stream: false, tools: preparedTools,
              signal: abort.signal, abort: () => { abort.abort(); cleanup(); },
            });
            const completion = await rendered.text();
            log(200, completion, rendered.headers);
            cleanup();
            return new Response(completion, { status: rendered.status, headers: rendered.headers });
          }
          const responseHeaders = new Headers({ "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
          const [toClient, toLog] = upstream.body.tee();
          void new Response(toLog).text().then((text) => log(200, text, responseHeaders)).catch(() => {});
          cleanup();
          return new Response(toClient, { status: 200, headers: responseHeaders });
        }
        const rendered = await renderOpencodeZenClientOutput(protocol, "responses", upstream, {
          model: String(input.model ?? upstreamModel), stream: clientStreams, tools: preparedTools,
          signal: abort.signal, abort: () => { abort.abort(); cleanup(); },
        });
        if (!clientStreams) {
          const completion = await rendered.text();
          log(200, completion, rendered.headers);
          cleanup();
          return new Response(completion, { status: rendered.status, headers: rendered.headers });
        }
        const [toClient, toLog] = rendered.body!.tee();
        void new Response(toLog).text().then((text) => log(200, text, rendered.headers)).catch(() => {});
        return new Response(toClient, { status: rendered.status, headers: rendered.headers });
      } catch (error) {
        abort.abort();
        cleanup();
        if (request.signal.aborted) return fail(499, "OpenCode Zen 请求已取消", "request_cancelled");
        logGatewayError(sink?.processLog, {
          requestTime, method: request.method, url: incoming.pathname, status: 502,
          message: `zen responses forward failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          durationMs: Date.now() - start,
        });
        return fail(502, "OpenCode Zen 上游请求失败", "upstream_error");
      }
    },
    /**
     * /v1/messages 拦截入口：anthropic 协议模型直通上游；chat / responses / google
     * 协议模型单跳转换后由桥接渲染回 Anthropic Messages 事件或完整 Message JSON。
     */
    async forwardMessages(request: Request, input: Record<string, unknown>, to: ClientProtocol = "anthropic"): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      let logged = false;
      const log = (status: number, resBody: string, headers = new Headers()) => {
        if (logged) return;
        logged = true;
        const durationMs = Date.now() - start;
        logExchange(sink, group, {
          requestTime, method: request.method, url: incoming.pathname,
          // 请求日志只记录模型与流式标记，不落提示词、工具内容或任何凭据。
          reqHeaders: new Headers(), reqBody: { model: input.model, stream: input.stream === true },
          status, resHeaders: headers, resBody, durationMs,
        }, "opencode-zen");
        if (status >= 400) {
          logGatewayError(sink?.processLog, { requestTime, method: request.method, url: incoming.pathname, status, message: resBody.slice(0, 500), durationMs });
        } else {
          logRequestSummary(sink?.processLog, { requestTime, method: request.method, url: incoming.pathname, status, durationMs });
        }
      };
      const fail = (status: number, message: string, type?: string) => {
        const response = opencodeZenError(status, message, type);
        log(status, JSON.stringify({ error: { type, message } }), response.headers);
        return response;
      };
      if (closed) return fail(503, "OpenCode Zen 入口已关闭", "configuration_error");
      const rawModel = typeof input.model === "string" ? input.model : "";
      const normalized = isOpencodeZenModel(rawModel)
        ? rawModel.slice(0, OPENCODE_ZEN_PREFIX.length).toLowerCase() + rawModel.slice(OPENCODE_ZEN_PREFIX.length)
        : rawModel;
      const upstreamModel = opencodeZenUpstreamModel(normalized);
      if (!upstreamModel) return fail(400, `OpenCode Zen 模型必须使用 ${OPENCODE_ZEN_PREFIX} 前缀`);
      const abort = new AbortController();
      const onAbort = () => abort.abort(request.signal.reason);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        request.signal.removeEventListener("abort", onAbort);
        activeRequests.delete(abort);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      activeRequests.add(abort);
      try {
        if (request.signal.aborted) onAbort();
        abort.signal.throwIfAborted();
        const session = sessionResolver.resolve(request.headers);
        const headers = opencodeZenHeaders(session);
        const protocol = store.protocol(upstreamModel) ?? "chat-completions";
        const modelBaseUrl = (store.endpoint(upstreamModel) ?? endpoint).replace(/\/+$/, "");
        const clientStreams = input.stream === true;
        let upstream: Response;
        let preparedTools: ToolIdentityMap = new Map();
        // R4 统一形态：桥接转换（同协议直通由桥接层处理）→ 查表厂商适配 → fetch。
        const converted = await convertOpencodeZenRequest(protocol, to, input, zenConvertModelOptions(protocol, upstreamModel));
        const adapted = adaptOpencodeZenUpstreamRequest(protocol, to, converted, {
          baseUrl: modelBaseUrl, upstreamModel, session, clientStreams: clientStreams,
          effortLevels: store.effortLevels(upstreamModel) ?? [], source: input,
        });
        preparedTools = adapted.tools;
        upstream = await fetchImpl(adapted.url, {
          method: "POST", headers: { ...headers, ...adapted.extraHeaders }, body: JSON.stringify(adapted.body), signal: abort.signal,
        });
        if (!upstream.ok || !upstream.body) {
          const errorBody = await upstream.text().catch(() => "");
          const safe = normalizeOpencodeZenUpstreamError(upstream.status, errorBody);
          logGatewayError(sink?.processLog, {
            requestTime, method: request.method, url: incoming.pathname,
            status: safe.status,
            message: `zen upstream ${upstream.status}: ${errorBody.slice(0, 1_024)}`,
            durationMs: Date.now() - start,
          });
          cleanup();
          return fail(safe.status, safe.message, safe.type);
        }
        if (protocol === "anthropic") {
          // 直通：流式原样透传；非流式原样返回上游 JSON。
          if (!clientStreams) {
            const text = await upstream.text();
            const responseHeaders = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
            log(200, text, responseHeaders);
            cleanup();
            return new Response(text, { status: 200, headers: responseHeaders });
          }
          const responseHeaders = new Headers({ "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
          const [toClient, toLog] = upstream.body.tee();
          void new Response(toLog).text().then((text) => log(200, text, responseHeaders)).catch(() => {});
          cleanup();
          return new Response(toClient, { status: 200, headers: responseHeaders });
        }
        const rendered = await renderOpencodeZenClientOutput(protocol, "anthropic", upstream, {
          model: String(input.model ?? upstreamModel), stream: clientStreams, tools: preparedTools,
          signal: abort.signal, abort: () => { abort.abort(); cleanup(); },
        });
        if (!clientStreams) {
          const message = await rendered.text();
          log(200, message, rendered.headers);
          cleanup();
          return new Response(message, { status: rendered.status, headers: rendered.headers });
        }
        const [toClient, toLog] = rendered.body!.tee();
        void new Response(toLog).text().then((text) => log(200, text, rendered.headers)).catch(() => {});
        return new Response(toClient, { status: rendered.status, headers: rendered.headers });
      } catch (error) {
        abort.abort();
        cleanup();
        if (request.signal.aborted) return fail(499, "OpenCode Zen 请求已取消", "request_cancelled");
        logGatewayError(sink?.processLog, {
          requestTime, method: request.method, url: incoming.pathname, status: 502,
          message: `zen messages forward failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          durationMs: Date.now() - start,
        });
        return fail(502, "OpenCode Zen 上游请求失败", "upstream_error");
      }
    },
    /**
     * /v1/models/{model}:generateContent 拦截入口：gemini 协议模型直通上游；chat /
     * responses / anthropic 协议模型单跳转换后由桥接渲染回 Gemini SSE 或完整 JSON。
     * model 与流式标志来自 URL 路径（gemini 请求体不携带这两者）。
     */
    async forwardGemini(request: Request, input: Record<string, unknown>, pathModel: string, pathStream: boolean, to: ClientProtocol = "gemini"): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      let logged = false;
      const log = (status: number, resBody: string, headers = new Headers()) => {
        if (logged) return;
        logged = true;
        const durationMs = Date.now() - start;
        logExchange(sink, group, {
          requestTime, method: request.method, url: incoming.pathname,
          reqHeaders: new Headers(), reqBody: { model: pathModel, stream: pathStream },
          status, resHeaders: headers, resBody, durationMs,
        }, "opencode-zen");
        if (status >= 400) {
          logGatewayError(sink?.processLog, { requestTime, method: request.method, url: incoming.pathname, status: status, message: resBody.slice(0, 500), durationMs });
        } else {
          logRequestSummary(sink?.processLog, { requestTime, method: request.method, url: incoming.pathname, status, durationMs });
        }
      };
      const fail = (status: number, message: string): Response => {
        // gemini 客户端错误形状由桥接统一构造（Google API 规范 status）。
        const response = clientErrorResponse("gemini", message, { status });
        log(status, JSON.stringify({ error: { code: status, message } }), response.headers);
        return response;
      };
      if (closed) return fail(503, "OpenCode Zen 入口已关闭");
      const normalized = isOpencodeZenModel(pathModel)
        ? pathModel.slice(0, OPENCODE_ZEN_PREFIX.length).toLowerCase() + pathModel.slice(OPENCODE_ZEN_PREFIX.length)
        : pathModel;
      const upstreamModel = opencodeZenUpstreamModel(normalized);
      if (!upstreamModel) return fail(400, `OpenCode Zen 模型必须使用 ${OPENCODE_ZEN_PREFIX} 前缀`);
      const abort = new AbortController();
      const onAbort = () => abort.abort(request.signal.reason);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        request.signal.removeEventListener("abort", onAbort);
        activeRequests.delete(abort);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      activeRequests.add(abort);
      try {
        if (request.signal.aborted) onAbort();
        abort.signal.throwIfAborted();
        const session = sessionResolver.resolve(request.headers);
        const headers = opencodeZenHeaders(session);
        const protocol = store.protocol(upstreamModel) ?? "chat-completions";
        const modelBaseUrl = (store.endpoint(upstreamModel) ?? endpoint).replace(/\/+$/, "");
        const clientStreams = pathStream;
        let upstream: Response;
        let preparedTools: ToolIdentityMap = new Map();
        // R4 统一形态：桥接转换（同协议直通由桥接层处理）→ 查表厂商适配 → fetch。
        const converted = await convertOpencodeZenRequest(protocol, to, input, zenConvertModelOptions(protocol, upstreamModel));
        const adapted = adaptOpencodeZenUpstreamRequest(protocol, to, converted, {
          baseUrl: modelBaseUrl, upstreamModel, session, clientStreams: clientStreams,
          effortLevels: store.effortLevels(upstreamModel) ?? [], source: input,
        });
        preparedTools = adapted.tools;
        upstream = await fetchImpl(adapted.url, {
          method: "POST", headers: { ...headers, ...adapted.extraHeaders }, body: JSON.stringify(adapted.body), signal: abort.signal,
        });
        if (!upstream.ok || !upstream.body) {
          const errorBody = await upstream.text().catch(() => "");
          const safe = normalizeOpencodeZenUpstreamError(upstream.status, errorBody);
          logGatewayError(sink?.processLog, {
            requestTime, method: request.method, url: incoming.pathname,
            status: safe.status,
            message: `zen upstream ${upstream.status}: ${errorBody.slice(0, 1_024)}`,
            durationMs: Date.now() - start,
          });
          cleanup();
          return fail(safe.status, safe.message);
        }
        if (protocol === "gemini") {
          // 直通：流式原样透传；非流式原样返回上游 JSON。
          if (!clientStreams) {
            const text = await upstream.text();
            const responseHeaders = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
            log(200, text, responseHeaders);
            cleanup();
            return new Response(text, { status: 200, headers: responseHeaders });
          }
          const responseHeaders = new Headers({ "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
          const [toClient, toLog] = upstream.body.tee();
          void new Response(toLog).text().then((text) => log(200, text, responseHeaders)).catch(() => {});
          cleanup();
          return new Response(toClient, { status: 200, headers: responseHeaders });
        }
        const rendered = await renderOpencodeZenClientOutput(protocol, "gemini", upstream, {
          model: pathModel || upstreamModel, stream: clientStreams, tools: preparedTools,
          signal: abort.signal, abort: () => { abort.abort(); cleanup(); },
        });
        if (!clientStreams) {
          const completion = await rendered.text();
          log(200, completion, rendered.headers);
          cleanup();
          return new Response(completion, { status: rendered.status, headers: rendered.headers });
        }
        const [toClient, toLog] = rendered.body!.tee();
        void new Response(toLog).text().then((text) => log(200, text, rendered.headers)).catch(() => {});
        return new Response(toClient, { status: rendered.status, headers: rendered.headers });
      } catch (error) {
        abort.abort();
        cleanup();
        if (request.signal.aborted) return fail(499, "OpenCode Zen 请求已取消");
        logGatewayError(sink?.processLog, {
          requestTime, method: request.method, url: incoming.pathname, status: 502,
          message: `zen gemini forward failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          durationMs: Date.now() - start,
        });
        return fail(502, "OpenCode Zen 上游请求失败");
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      for (const controller of activeRequests) controller.abort();
      activeRequests.clear();
    },
  };
}

export { isOpencodeZenModel, mergeOpencodeZenCatalog };
export { OPENCODE_ZEN_RUNTIME_ARTIFACTS } from "./catalog.ts";

export function createOpencodeZenAdapter(config: AgentConfig, dependencies: OpencodeZenDependencies = {}) {
  return bindHostMethods(buildOpencodeZenAdapter(config, dependencies));
}

export const OPENCODE_ZEN_MODEL_PATTERNS: readonly string[] = Object.freeze(["opencode-zen/*"]);

/** 插件只负责本代理路由，协议转换沿用原适配器实现。 */
export function createOpencodeZenPlugin(host: HostServices<AgentConfig>, dependencies: OpencodeZenDependencies = {}): GatewayPlugin {
  return withHostServices(host, () => {
    const adapter = createOpencodeZenAdapter(host.getConfig(), { fetch: host.fetch, ...dependencies });
    return bindHostMethods({
      id: "opencode-zen",
      modelPatterns: OPENCODE_ZEN_MODEL_PATTERNS,
      websocket: false,
      async handleHttp(context) {
        const input = await context.body.json();
        if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ error: { type: "invalid_request_error", message: "请求正文必须是 JSON 对象" } }, { status: 400 });
        if (context.operation === "compact") return Response.json({ error: { type: "invalid_request_error", message: "OpenCode Zen 不支持上下文压缩" } }, { status: 400 });
        if (context.to === "responses") return adapter.forwardResponses(context.request, input as Record<string, unknown>, context.to);
        if (context.to === "anthropic") return adapter.forwardMessages(context.request, input as Record<string, unknown>, context.to);
        if (context.to === "gemini") return adapter.forwardGemini(context.request, input as Record<string, unknown>, context.pathModel ?? "", context.pathStream === true, context.to);
        return adapter.forward(context.request, input as Record<string, unknown>, context.to);
      },
      getCatalog: () => adapter.catalog(),
      refreshCatalog: () => adapter.refreshCatalog(),
      reloadCatalog: () => adapter.reloadCatalog(),
      ready: async () => {},
      close: () => adapter.close(),
    } satisfies GatewayPlugin, host);
  });
}
