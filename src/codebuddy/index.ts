import path from "node:path";
import { isIP } from "node:net";
import {
  CodebuddyCredentialError,
  createCodebuddyCredentialCache,
  defaultAuthDirectory,
} from "./credentials.ts";
import type { CodebuddyCredentialCache } from "./credentials.ts";
import {
  CODEBUDDY_PREFIX,
  WORKBUDDY_PREFIX,
  codebuddyModelProduct,
  codebuddyUpstreamModel,
  createCodebuddyCatalogStore,
  isCodebuddyModel,
} from "./catalog.ts";
import { translateCodebuddyRequest, CodebuddyRequestError } from "./request.ts";
import { createCodebuddyResponse } from "./response.ts";
import { buildCodebuddyChatHeaders, createCodebuddyContexts } from "./request-context.ts";
import { isZcodeRecord } from "../zcode/wire.ts";
import { localTime, logExchange, logGroupFromPath } from "../request-log.ts";
import type { RequestLogSink } from "../request-log.ts";
import { logGatewayError, logRequestSummary } from "../process-log.ts";
import type { GatewayConfig, ModelCatalog, ProcessLogTarget } from "../types.ts";

/**
 * CodeBuddy/WorkBuddy 入口门面：照 ZCode 适配器模式组合凭据、目录、协议转换与
 * 请求上下文；`catalog()` 供 /v1/models 合并，`forward()` 处理 /v1/responses 拦截。
 */

export interface CodebuddyDependencies {
  /** 认证目录（内含各产品独立的 .info 凭据）；缺省取平台默认目录。 */
  authDirectory?: string;
  credentialCache?: CodebuddyCredentialCache;
  /** 目录缓存目录（每个产品×地域接口各一个 `{codebuddy|workbuddy}-{cn|intl}-catalog.json`）；缺省取 catalogPath 同目录。 */
  cacheDirectory?: string;
  /** Codex 自己的目录缓存；目录内容变化时过期它。 */
  codexModelsCacheFile?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** 目录刷新间隔（毫秒）；测试可调小，生产缺省 16 分钟。 */
  catalogRefreshIntervalMs?: number;
  /** 是否在适配器构造后立即强制刷新一次目录；测试可关闭，生产缺省开启。 */
  refreshCatalogOnStart?: boolean;
  /** 定时器注入点，便于测试不依赖真实时间。 */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** 进程日志目标（gateway.log）；未注入时 CodeBuddy 请求不写请求摘要。 */
  processLog?: ProcessLogTarget;
}

/** CodeBuddy CLI 自身约每 16 分钟刷新一次目录，网关按同一节奏主动更新。 */
const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 16 * 60 * 1000;

/**
 * CodeBuddy 入口的生效判定。upstream-only 纯转发模式下按禁用处理：不建凭据/目录
 * 缓存、不拦截请求，也不施加环回监听与前缀保留约束（语义与 zcodeEnabled 一致）。
 */
export function codebuddyEnabled(config: GatewayConfig): boolean {
  return config.codebuddy === true && config.upstreamOnly !== true;
}

export function validateCodebuddyConfig(config: GatewayConfig): void {
  if (config.codebuddy !== undefined && typeof config.codebuddy !== "boolean") throw new Error("codebuddy 必须为 boolean");
  if (!codebuddyEnabled(config)) return;
  const host = config.host;
  if (!(host === "localhost" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127.")))) {
    throw new Error("启用 CodeBuddy 时网关只能监听环回地址");
  }
  for (const reserved of [CODEBUDDY_PREFIX, WORKBUDDY_PREFIX]) {
    if (config.prefix && (reserved.startsWith(config.prefix) || config.prefix.startsWith(reserved))) {
      throw new Error(`启用 CodeBuddy 时 ${reserved} 前缀保留给 CodeBuddy/WorkBuddy，请调整第三方 prefix`);
    }
  }
}

export function codebuddyError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, message } }, { status });
}

export function createCodebuddyAdapter(config: GatewayConfig, dependencies: CodebuddyDependencies = {}) {
  validateCodebuddyConfig(config);
  const enabled = codebuddyEnabled(config);
  const credentialCache = enabled
    ? dependencies.credentialCache ?? createCodebuddyCredentialCache(dependencies.authDirectory ?? defaultAuthDirectory())
    : undefined;
  const fetchUpstream = dependencies.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const catalogStore = enabled
    ? createCodebuddyCatalogStore({
      cacheDirectory: dependencies.cacheDirectory ?? path.dirname(config.catalogPath),
      // 每个前缀产品各选一个接口凭据（含同地域回退）；某产品完全没有登录时跳过其目录族。
      credentials: async () => {
        const list = [];
        for (const product of ["cli", "work"] as const) {
          try { list.push(await credentialCache!.forProduct(product)); } catch { /* 未登录该地域即无凭据。 */ }
        }
        return list;
      },
      ...(dependencies.codexModelsCacheFile ? { codexModelsCacheFile: dependencies.codexModelsCacheFile } : {}),
      fetch: (url, init) => fetchUpstream(url, init),
    })
    : undefined;
  const scheduleInterval = dependencies.setInterval ?? setInterval;
  const cancelInterval = dependencies.clearInterval ?? clearInterval;
  const catalogRefreshIntervalMs = Math.max(
    1_000,
    Math.trunc(dependencies.catalogRefreshIntervalMs ?? DEFAULT_CATALOG_REFRESH_INTERVAL_MS),
  );
  let catalogRefreshTimer: ReturnType<typeof setInterval> | undefined;
  if (catalogStore) {
    if (dependencies.refreshCatalogOnStart !== false) {
      // 启动刷新必须 fire-and-forget：不能阻塞 serve 的启动路径，失败由 store 回退 last-good。
      void catalogStore.refresh().catch(() => {});
    }
    catalogRefreshTimer = scheduleInterval(() => {
      void catalogStore.refresh().catch(() => {});
    }, catalogRefreshIntervalMs);
    catalogRefreshTimer.unref?.();
  }
  const contexts = createCodebuddyContexts();
  const activeRequests = new Set<AbortController>();
  const sink: RequestLogSink | undefined = config.requestLogging === true ? {
    dir: config.logDir || path.join(path.dirname(config.catalogPath), "logs"),
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
    processLog: dependencies.processLog,
  } : undefined;
  let closed = false;
  /** 已知模型集合（serves scope 投影后的裸 ID）；空目录视为不可校验，透传由上游判定。 */
  let knownModels: Set<string> | undefined;

  return {
    async catalog(): Promise<ModelCatalog> {
      if (!catalogStore || closed) return { models: [] };
      try {
        const catalog = await catalogStore.catalog();
        knownModels = new Set(catalog.models.map((entry) => entry.slug));
        return catalog;
      } catch { return { models: [] }; }
    },
    async forward(request: Request, input: Record<string, unknown>, mapResult?: (payload: Record<string, unknown>) => Response): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      const codebuddy = isCodebuddyModel(input.model);
      let family: "codebuddy" | "workbuddy" | undefined;
      let accessToken = "";
      let refreshToken = "";
      let upstreamUrl: string | undefined;
      let upstreamRequestHeaders: Headers | undefined;
      let upstreamRequestBody: unknown;
      let logged = false;
      const redactTokens = (): string[] => [accessToken, refreshToken].filter(Boolean);
      const redact = (text: string) => {
        const keys = redactTokens();
        if (!keys.length) return text;
        let result = text;
        for (const key of keys) {
          // 错误正文可能以任意 JSON 转义形式回显 token（\/、\uXXXX 及多层反斜杠嵌套）：
          // 逐字符生成四种互斥形式保证每个字符位置的匹配分解唯一，避免灾难性回溯。
          const pattern = [...key].map((char) => {
            const escaped = char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
            const hex = char.codePointAt(0)!.toString(16).padStart(4, "0");
            return `(?:${escaped}|\\\\{1,4}${escaped}|\\\\{1,4}u${hex}|\\\\{1,4}u${hex.toUpperCase()})`;
          }).join("");
          result = result.replace(new RegExp(pattern, "gu"), "***");
          let variant = key;
          // 错误正文可能把请求又序列化成 JSON 字符串，连同转义形式一起遮蔽。
          for (let depth = 0; depth < 4; depth++) {
            result = result.replaceAll(variant, "***");
            variant = JSON.stringify(variant).slice(1, -1);
          }
        }
        return result;
      };
      const redactValue = (value: unknown): unknown => {
        if (typeof value === "string") return redact(value);
        if (Array.isArray(value)) return value.map(redactValue);
        if (isZcodeRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item)]));
        return value;
      };
      const log = (status: number, body: string, headers = new Headers(), logicalError?: string) => {
        if (logged || !codebuddy || !family) return;
        logged = true;
        const durationMs = Date.now() - start;
        const at = incoming.pathname + incoming.search;
        logExchange(sink, group, {
          requestTime, method: request.method, url: at,
          reqHeaders: request.headers, reqBody: redactValue(input),
          status, resHeaders: headers, resBody: redact(body), upstreamUrl, upstreamRequestHeaders, upstreamRequestBody, durationMs,
        }, family);
        if (status >= 400 || logicalError) {
          logGatewayError(sink?.processLog, {
            requestTime, method: request.method, url: at,
            status: logicalError && status < 400 ? 502 : status,
            message: redact(logicalError ?? body), upstreamUrl, durationMs,
          });
        } else {
          logRequestSummary(sink?.processLog, {
            requestTime, method: request.method, url: at, status, upstreamUrl, durationMs,
          });
        }
      };
      const fail = (status: number, message: string, type?: string) => {
        const response = codebuddyError(status, redact(message), type);
        log(status, JSON.stringify({ error: { type, message: redact(message) } }), response.headers);
        return response;
      };
      if (!credentialCache || closed) return fail(503, "CodeBuddy 未启用或网关已关闭", "configuration_error");
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
        // 前缀决定产品接口（codebuddy/ → cli 端点+身份头，workbuddy/ → IDE 端点+身份头）；
        // 凭据按产品选取（同产品优先、同地域另一产品回退），只贡献 token 与账号。
        const product = codebuddyModelProduct(input.model);
        if (product) family = product === "work" ? "workbuddy" : "codebuddy";
        if (!product) { cleanup(); return fail(400, "CodeBuddy 模型名缺少前缀后的模型 ID"); }
        const credential = await credentialCache.forProduct(product);
        accessToken = credential.accessToken;
        refreshToken = credential.refreshToken;
        abort.signal.throwIfAborted();
        const model = typeof input.model === "string" ? codebuddyUpstreamModel(input.model) : undefined;
        if (!model) { cleanup(); return fail(400, "CodeBuddy 模型名缺少前缀后的模型 ID"); }
        // 目录可用时校验 belongs-to-serves；空目录（拉取失败）透传，由上游判定。
        if (knownModels !== undefined && knownModels.size > 0 && !knownModels.has(String(input.model))) {
          cleanup();
          return fail(404, "此模型不在 CodeBuddy/WorkBuddy 当前账号的可服务目录内");
        }
        const translated = translateCodebuddyRequest(input, model);
        upstreamUrl = `${credential.endpoint}/v2/chat/completions`;
        // 从当前凭据重建身份头与会话归因，不采信入站客户端的身份或授权头。
        const context = contexts.resolve(request, credential);
        const headers = buildCodebuddyChatHeaders(credential, context);
        upstreamRequestHeaders = headers;
        const body = translated.body;
        upstreamRequestBody = sink ? redactValue(body) : undefined;
        const upstream = await fetchUpstream(upstreamUrl, {
          method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: abort.signal,
        });
        if (!upstream.ok) {
          const text = redact(await upstream.text());
          cleanup();
          let message = text || `CodeBuddy 上游返回 HTTP ${upstream.status}`;
          try {
            const error: unknown = redactValue(JSON.parse(text));
            if (isZcodeRecord(error)) {
              if (isZcodeRecord(error.error) && typeof error.error.message === "string") message = error.error.message;
              else if (typeof error.message === "string") message = error.message;
              else if (typeof error.msg === "string") message = error.msg;
              else message = JSON.stringify(error);
            }
          } catch { /* 非 JSON 上游错误保留脱敏正文。 */ }
          const guidance = upstream.status === 401
            ? `${message}（CodeBuddy 登录态可能已失效，请在 CodeBuddy/WorkBuddy 桌面端或 CLI 重新登录）`
            : message;
          return fail(upstream.status, guidance, "upstream_error");
        }
        let chunks = "";
        const stream = !mapResult && input.stream === true;
        const response = await createCodebuddyResponse(upstream, {
          model: String(input.model), tools: translated.tools, stream, signal: abort.signal,
          sanitizeError: (error) => ({
            code: typeof error.code === "string" ? redact(error.code) : "upstream_error",
            message: typeof error.message === "string" ? redact(error.message) : "CodeBuddy 上游响应失败",
          }),
          abort: () => { abort.abort(); cleanup(); },
          onChunk: (chunk) => { if (sink) chunks += chunk; },
          onComplete: (payload) => {
            cleanup();
            const stripped = translated.dropped.length ? `\n--- stripped built-in tools: ${translated.dropped.join(", ")} ---` : "";
            if (!mapResult) log(stream ? 200 : payload.status === "failed" ? 502 : 200,
              stream ? `${chunks}${stripped}\n--- response.${payload.status} ---\n${JSON.stringify(redactValue(payload))}` : `${JSON.stringify(redactValue(payload))}${stripped}`,
              new Headers({ "content-type": stream ? "text/event-stream" : "application/json" }),
              payload.status === "failed" ? JSON.stringify(payload.error ?? "响应失败") : undefined);
          },
        });
        if (!mapResult) return response;
        const payload: unknown = await response.json();
        if (!response.ok || !isZcodeRecord(payload)) {
          cleanup();
          return fail(502, "CodeBuddy 上游未完成上下文压缩", "invalid_response_error");
        }
        const mapped = mapResult(payload);
        log(mapped.status, await mapped.clone().text(), mapped.headers);
        cleanup();
        return mapped;
      } catch (error) {
        abort.abort();
        cleanup();
        if (error instanceof CodebuddyRequestError) return fail(400, error.message);
        if (error instanceof CodebuddyCredentialError) return fail(503, error.message, "configuration_error");
        if (request.signal.aborted) return fail(499, "CodeBuddy 请求已取消", "request_cancelled");
        return fail(502, "CodeBuddy 上游请求失败", "upstream_error");
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (catalogRefreshTimer !== undefined) cancelInterval(catalogRefreshTimer);
      catalogRefreshTimer = undefined;
      credentialCache?.close();
      contexts.close();
      for (const request of activeRequests) request.abort();
      activeRequests.clear();
    },
  };
}
