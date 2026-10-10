import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import {
  createOpenCodeSessionResolver,
  createSessionBindingCache,
  type SessionBindingCache,
} from "./session.ts";
import {
  buildOpencodeZenUpstreamHeaders,
  createOpencodeZenProjectId,
  injectOpencodeZenFingerprintBody,
} from "./fingerprint.ts";
import { aggregateOpencodeZenStreamToCompletion } from "./response.ts";
import {
  OPENCODE_ZEN_PREFIX,
  classifyOpencodeZenProbeSignal,
  createOpencodeZenCatalogStore,
  isOpencodeZenModel,
  mergeOpencodeZenCatalog,
  opencodeZenUpstreamModel,
} from "./catalog.ts";
import type { OpencodeZenModelProtocol, OpencodeZenProbeResult } from "./catalog.ts";
import { aggregateOpencodeZenResponsesStream, convertOpencodeZenRequest, translateOpencodeZenStream } from "./convert.ts";
import { createOpencodeZenUserAgentStore } from "./user-agent.ts";
import type { OpencodeZenUserAgentStore } from "./user-agent.ts";


import { localTime, logExchange, logGroupFromPath, requestLogDir } from "../request-log.ts";
import type { RequestLogSink } from "../request-log.ts";
import { resolvePaths } from "../paths.ts";
import { logGatewayError, logRequestSummary } from "../process-log.ts";
import type { GatewayConfig, ModelCatalog, ProcessLogTarget } from "../types.ts";

/**
 * OpenCode Zen（https://opencode.ai/zen/v1）免费模型入口门面。
 *
 * 不需要本地凭据：鉴权是公共 `Bearer public`（可选 OPENCODE_API_KEY），合规性由
 * 指纹层（fingerprint.ts）与合规会话（session.ts）保证。目录按官方元数据暴露每个
 * 模型的端点协议（chat / responses / anthropic / google），转发层按协议自动转换
 * （convert.ts）：`catalog()` 供 /v1/models 合并，`forward()` 处理
 * /v1/chat/completions 拦截，`forwardResponses()` 处理 /v1/responses 拦截。
 */


export const OPENCODE_ZEN_DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1";
export const OPENCODE_ZEN_PUBLIC_API_KEY = "public";
/** OpenCode 官方模型元数据（客户端同源数据）：含每模型端点协议（provider.npm）与 deprecated 标记。 */
export const OPENCODE_ZEN_METADATA_URL = "https://models.opencode.ai/api.json";

/** 免费目录轮换节奏慢，按 10 分钟对齐目录 TTL 定时刷新。 */
const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 600_000;

export interface OpencodeZenDependencies {
  /** 上游端点覆盖；缺省 https://opencode.ai/zen/v1。 */
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
  refreshCatalogOnStart?: boolean;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** 会话绑定表（测试注入）；缺省独立 LRU（24h 滑动续期）。 */
  sessionCache?: SessionBindingCache;
  processLog?: ProcessLogTarget;
}

export function opencodeZenEnabled(config: GatewayConfig): boolean {
  return config.opencodeZen === true && config.upstreamOnly !== true;
}

export function validateOpencodeZenConfig(config: GatewayConfig): void {
  if (config.opencodeZen !== undefined && typeof config.opencodeZen !== "boolean") {
    throw new Error("opencodeZen 必须为 boolean");
  }
  if (!opencodeZenEnabled(config)) return;
  const host = config.host;
  if (!(host === "localhost" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127.")))) {
    throw new Error("启用 opencodeZen 时网关只能监听环回地址");
  }
  if (config.prefix && (OPENCODE_ZEN_PREFIX.startsWith(config.prefix) || config.prefix.startsWith(OPENCODE_ZEN_PREFIX))) {
    throw new Error(`启用 opencodeZen 时 ${OPENCODE_ZEN_PREFIX} 前缀保留给 OpenCode Zen，请调整第三方 prefix`);
  }
}

export function opencodeZenError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, message } }, { status });
}

/** 只输出预定义分类 + 上游原始错误文本；Zen 请求不携带用户凭据，错误详情可安全透出。 */
export function normalizeOpencodeZenUpstreamError(status: number, body: string): { status: number; type: string; message: string } {
  const text = body.toLowerCase();
  const upstreamMessage = extractUpstreamMessage(body);
  // 区域限制先于门禁判定：上游对地区不可用的模型同样返回 403，但详情是
  // "not available in your country" 而非 FreeTierError——误报成指纹失效会把
  // 用户引向错误的修复方向（探针分类 classifyOpencodeZenProbeSignal 同样把它视为被服务）。
  if (status === 403 && (text.includes("region") || text.includes("country") || text.includes("not available in your"))) {
    return {
      status: 403,
      type: "zen_region_error",
      message: "该模型在您当前的网络地区不可用（上游区域限制）：OpenCode Zen 按地区开放免费模型，"
        + "请更换网络环境或选择其他模型。"
        + (upstreamMessage ? `上游详情：${upstreamMessage}` : ""),
    };
  }
  if (status === 403 || text.includes("freetier")) {
    return {
      status: 403,
      type: "zen_free_tier_error",
      message: "OpenCode Zen 免费层校验失败（FreeTierError）：上游只接受 OpenCode 客户端形态的请求。"
        + "官方门禁策略可能已更新，请升级网关的 Zen 指纹数据（src/opencode/fingerprint-data.json）或改用本地 opencode 客户端。"
        + (upstreamMessage ? `上游详情：${upstreamMessage}` : ""),
    };
  }
  if (status === 429 || text.includes("freeusagelimit") || text.includes("rate limit")) {
    return {
      status: 429,
      type: "zen_rate_limited",
      message: "OpenCode Zen 免费额度限流（429）：免费模型按 IP 与会话限频，请降低请求频率或稍后重试。"
        + (upstreamMessage ? `上游详情：${upstreamMessage}` : ""),
    };
  }
  if (status === 404 || text.includes("model") && (text.includes("not found") || text.includes("not_available") || text.includes("does not exist"))) {
    return {
      status: 404,
      type: "zen_model_unavailable",
      message: `模型不在 OpenCode Zen 当前目录中（免费模型动态轮换），请刷新模型列表。${upstreamMessage ? `上游详情：${upstreamMessage}` : ""}`,
    };
  }
  if (status === 401) {
    return {
      status: 401,
      type: "zen_authentication_error",
      message: `OpenCode Zen 鉴权失败：请检查 OPENCODE_API_KEY 是否有效。${upstreamMessage ? `上游详情：${upstreamMessage}` : ""}`,
    };
  }
  return {
    status: status >= 400 && status <= 599 ? status : 502,
    type: "zen_upstream_error",
    message: `OpenCode Zen 上游响应失败（HTTP ${status}）。${upstreamMessage ? `上游详情：${upstreamMessage}` : ""}`,
  };
}

function extractUpstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : "";
  } catch {
    return body.trim().slice(0, 300);
  }
}

function resolveApiKey(dependencies: OpencodeZenDependencies): string {
  return dependencies.apiKey ?? process.env.OPENCODE_API_KEY ?? OPENCODE_ZEN_PUBLIC_API_KEY;
}

/** 模型端点 URL：google 走 per-model 路径 + SSE 流式后缀（对齐官方 AI SDK 构造）。 */
function opencodeZenProtocolUrl(baseUrl: string, protocol: OpencodeZenModelProtocol, model: string): string {
  switch (protocol) {
    case "chat": return `${baseUrl}/chat/completions`;
    case "responses": return `${baseUrl}/responses`;
    case "anthropic": return `${baseUrl}/messages`;
    case "google": return `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  }
}


export function createOpencodeZenAdapter(config: GatewayConfig, dependencies: OpencodeZenDependencies = {}) {
  validateOpencodeZenConfig(config);
  const enabled = opencodeZenEnabled(config);
  const endpoint = dependencies.endpoint ?? OPENCODE_ZEN_DEFAULT_ENDPOINT;
  const baseUrl = endpoint.replace(/\/+$/, "");
  const fetchImpl = dependencies.fetch ?? fetch;
  const projectId = dependencies.projectId ?? createOpencodeZenProjectId(os.hostname());
  const sessionResolver = createOpenCodeSessionResolver(
    dependencies.sessionCache ?? createSessionBindingCache(),
  );

  /** UA 版本动态获取：转发与探测统一读 current()，失败静默回退指纹快照。 */
  const userAgent = dependencies.userAgentStore ?? createOpencodeZenUserAgentStore({ fetch: fetchImpl });
  /** 转发/探测统一用同一套指纹标头（含当前 UA），避免 UA 漂移只修一半。 */
  const opencodeZenHeaders = (session: string): Record<string, string> =>
    buildOpencodeZenUpstreamHeaders(session, resolveApiKey(dependencies), projectId, userAgent.current());
  const sink: RequestLogSink | undefined = config.requestLogging === true ? {
    dir: requestLogDir(config),
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
    processLog: dependencies.processLog,
  } : undefined;
  const fetchModels = async (): Promise<unknown> => {
    // 目录端点目前不校验指纹，但完整标头零成本且能免疫未来收紧。
    const session = sessionResolver.resolve(new Headers());
    const headers = opencodeZenHeaders(session);
    headers.accept = "application/json";
    const response = await fetchImpl(`${baseUrl}/models`, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
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
   * 协议；401/404（模型不存在或需账号）直接 drop；第一阶梯出现 FreeTierError 视为
   * 指纹全局异常、保守保留为 chat；全阶梯无信号才 drop（如 systemone 的 jev）。
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
      ["chat", async () => {
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
      ["google", () => probePlain(`/models/${encodeURIComponent(id)}:generateContent`, { contents: [{ role: "user", parts: [{ text: "hi" }] }] })],
    ];
    for (let index = 0; index < steps.length; index++) {
      const [protocol, send] = steps[index]!;
      let response: Response;
      try {
        response = await send();
      } catch {
        return "chat"; // 网络异常无法判定：保守保留。
      }
      if (response.ok) {
        try { await response.body?.cancel(); } catch { /* 只取状态码，丢弃流。 */ }
        return protocol;
      }
      const text = await response.text().catch(() => "");
      const signal = classifyOpencodeZenProbeSignal(response.status, text);
      if (signal === "served") return protocol;
      if (signal === "offline") return "drop";
      if (signal === "gate" && index === 0) return "chat"; // 指纹/门禁全局异常：保守不过滤。
    }
    return "drop";
  });


  const store = enabled
    ? createOpencodeZenCatalogStore({
      cacheDirectory: dependencies.cacheDirectory ?? resolvePaths().runtimeHome,
      fetchCatalog: fetchModels,
      fetchMetadata,
      probeModel,
      codexModelsCacheFile: dependencies.codexModelsCacheFile,

    })
    : undefined;
  const schedule = dependencies.setInterval ?? setInterval;
  const cancel = dependencies.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (store) {
    if (dependencies.refreshCatalogOnStart !== false) {
      void store.refresh().catch(() => {});
      void userAgent.refresh().catch(() => {});
    }
    timer = schedule(() => {
      void store.refresh().catch(() => {});
      void userAgent.refresh().catch(() => {});
    }, Math.max(1_000, dependencies.catalogRefreshIntervalMs ?? DEFAULT_CATALOG_REFRESH_INTERVAL_MS));
    timer.unref?.();
  }
  const activeRequests = new Set<AbortController>();
  let closed = false;

  return {
    async catalog(): Promise<ModelCatalog> {
      if (!store || closed) return { models: [] };
      try {
        // 系统提示词已在 buildOpencodeZenCatalog 合成时替换（含 model_messages 模板），缓存即成品；
        // 转发路仍保留门禁模板注入，已含模板时不重复注入。
        return { models: await store.catalog() };
      } catch {
        return { models: [] };
      }
    },
    /**
     * /v1/chat/completions 拦截入口：剥前缀、注入指纹、按客户端流式偏好回包。
     * 非流式客户端在网关侧聚合上游 SSE；流式客户端原样透传事件流。
     */
    async forward(request: Request, input: Record<string, unknown>): Promise<Response> {
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
      if (!enabled || closed) return fail(503, "OpenCode Zen 入口未启用或网关已关闭", "configuration_error");
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
        const protocol = store?.protocol(upstreamModel) ?? "chat";
        // 上游 baseURL 由元数据 provider.api 确认（官方同源数据）；元数据缺失回退配置/缺省端点。
        const modelBaseUrl = (store?.endpoint(upstreamModel) ?? endpoint).replace(/\/+$/, "");
        const aggregateForClient = input.stream !== true;
        let upstream: Response;
        if (protocol === "chat") {
          const { body } = injectOpencodeZenFingerprintBody({ ...input, model: upstreamModel }, session, store?.effortLevels(upstreamModel) ?? []);
          abort.signal.throwIfAborted();
          upstream = await fetchImpl(`${modelBaseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: abort.signal,
          });
        } else {
          // 非 chat 协议模型：请求转成模型协议（chat 为规范中间层），上游流反向转回 chat。
          const converted = convertOpencodeZenRequest("chat", protocol, input);
          const body: Record<string, unknown> = {
            ...converted,
            model: upstreamModel,
            stream: true,
            ...(protocol === "responses" ? { prompt_cache_key: session } : {}),
          };
          const extraHeaders: Record<string, string> = protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {};
          abort.signal.throwIfAborted();
          upstream = await fetchImpl(opencodeZenProtocolUrl(modelBaseUrl, protocol, upstreamModel), {
            method: "POST",
            headers: { ...headers, ...extraHeaders },
            body: JSON.stringify(body),
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
        const stream = protocol === "chat" ? upstream.body : translateOpencodeZenStream(upstream.body, protocol, "chat");
        if (aggregateForClient) {
          const completion = await aggregateOpencodeZenStreamToCompletion(stream);
          const response = Response.json(completion);
          log(200, JSON.stringify(completion), response.headers);
          cleanup();
          return response;
        }
        const responseHeaders = new Headers({
          "content-type": protocol === "chat"
            ? upstream.headers.get("content-type") ?? "text/event-stream"
            : "text/event-stream",
        });
        const cacheControl = upstream.headers.get("cache-control");
        if (cacheControl) responseHeaders.set("cache-control", cacheControl);
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
     * google 协议模型先转换请求（chat 目标注入官方模板），上游流反向转回 responses
     * 事件；非流式客户端由网关聚合为完整 response JSON。
     */
    async forwardResponses(request: Request, input: Record<string, unknown>): Promise<Response> {
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
      if (!enabled || closed) return fail(503, "OpenCode Zen 入口未启用或网关已关闭", "configuration_error");
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
        const protocol = store?.protocol(upstreamModel) ?? "chat";
        // 上游 baseURL 由元数据 provider.api 确认（官方同源数据）；元数据缺失回退配置/缺省端点。
        const modelBaseUrl = (store?.endpoint(upstreamModel) ?? endpoint).replace(/\/+$/, "");
        const clientStreams = input.stream === true;
        let upstream: Response;
        if (protocol === "responses") {
          // responses 协议模型直通：仅替换模型 id 并补齐会话缓存键。
          const body = {
            ...input,
            model: upstreamModel,
            ...(typeof input.prompt_cache_key === "string" && input.prompt_cache_key ? {} : { prompt_cache_key: session }),
          };
          upstream = await fetchImpl(`${modelBaseUrl}/responses`, {
            method: "POST", headers, body: JSON.stringify(body), signal: abort.signal,
          });
        } else {
          const converted = convertOpencodeZenRequest("responses", protocol, input);
          let body: Record<string, unknown>;
          let extraHeaders: Record<string, string> = {};
          if (protocol === "chat") {
            // chat 端点门禁要求官方模板在场：转换后仍走注入（带工具时 agent 模板 + 官方工具集）。
            body = injectOpencodeZenFingerprintBody({ ...converted, model: upstreamModel }, session, store?.effortLevels(upstreamModel) ?? []).body;
          } else {
            body = { ...converted, model: upstreamModel, stream: true };
            if (protocol === "anthropic") extraHeaders = { "anthropic-version": "2023-06-01" };
          }
          upstream = await fetchImpl(opencodeZenProtocolUrl(modelBaseUrl, protocol, upstreamModel), {
            method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body), signal: abort.signal,
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
        if (protocol === "responses") {
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
        const translated = translateOpencodeZenStream(upstream.body, protocol, "responses");
        if (!clientStreams) {
          const completion = await aggregateOpencodeZenResponsesStream(translated);
          const response = Response.json(completion);
          log(200, JSON.stringify(completion), response.headers);
          cleanup();
          return response;
        }
        const responseHeaders = new Headers({ "content-type": "text/event-stream" });
        const [toClient, toLog] = translated.tee();
        void new Response(toLog).text().then((text) => log(200, text, responseHeaders)).catch(() => {});
        cleanup();
        return new Response(toClient, { status: 200, headers: responseHeaders });
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
