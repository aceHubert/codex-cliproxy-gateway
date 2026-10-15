import { bindHostMethods, withHostServices } from "@agent-proxy/plugin-api";
import type { ClientProtocol, GatewayPlugin, HostServices } from "@agent-proxy/plugin-api";
import path from "node:path";
import { isIP } from "node:net";
import { resolvePaths } from "@agent-proxy/plugin-api";
import {
  CodebuddyCredentialError,
  createCodebuddyCredentialCache,
  defaultAuthDirectory,
  isCodebuddyAccountName,
} from "./credentials.ts";
import type { CodebuddyCredentialCache } from "./credentials.ts";
import {
  codebuddyModelProduct,
  codebuddyModelRegion,
  codebuddyUpstreamModel,
  createCodebuddyCatalogStore,
  dedupeCodebuddyCatalog,
  isCodebuddyModel,
} from "./catalog.ts";
import { translateCodebuddyRequest, CodebuddyRequestError } from "./request.ts";
import { createCodebuddyResponse } from "./response.ts";
import { buildCodebuddyChatHeaders, createCodebuddyContexts, CODEBUDDY_AGENT_SYSTEM_PROMPT } from "./request-context.ts";
const isZcodeRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
import { localTime, logExchange, logGroupFromPath, requestLogDir } from "@agent-proxy/plugin-api";
import type { RequestLogSink } from "@agent-proxy/plugin-api";
import { logGatewayError, logRequestSummary } from "@agent-proxy/plugin-api";
import type { AgentConfig, ModelCatalog, ProcessLogTarget } from "@agent-proxy/plugin-api";

/** CodeBuddy 配置由插件声明，导入插件时合并到公共配置类型。 */
declare module "@agent-proxy/plugin-api" {
  interface AgentConfig {
    /**
     * CodeBuddy/WorkBuddy 凭据选择：值为认证目录内的 `.info` 文件名时锁定该账号登录
     * （文件缺失时运行期回退 auto，不改写配置）；值为 "auto" 或缺省时按最近刷新的
     * 登录自动选取并随客户端切换跟随。展示标签（昵称 <邮箱> / 地域）由 Web UI 实时
     * 解析，不落配置。历史哨兵 "default" 读取时归一为 "auto"。
     */
    codebuddyAccount?: string;
  }
}

/**
 * CodeBuddy/WorkBuddy 入口门面：照 ZCode 适配器模式组合凭据、目录、协议转换与
 * 请求上下文；`catalog()` 供 /v1/models 合并，`forward()` 处理 /v1/responses 拦截。
 */

export interface CodebuddyDependencies {
  /** 认证目录（内含各产品独立的 .info 凭据）；缺省取平台默认目录。 */
  authDirectory?: string;
  credentialCache?: CodebuddyCredentialCache;
  /** 目录缓存目录（每个产品接口各一个 `{codebuddy|workbuddy}-catalog.json`）；缺省取 catalogPath 同目录。 */
  cacheDirectory?: string;
  /** Codex 自己的目录缓存；目录内容变化时过期它。 */
  codexModelsCacheFile?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** 目录刷新间隔（毫秒）；测试可调小，生产缺省 16 分钟。 */
  catalogRefreshIntervalMs?: number;
  /** 是否在适配器构造后立即强制刷新一次目录；测试可关闭，生产缺省开启。 */
  refreshCatalogOnStart?: boolean;
  /** 目录生命周期由网关注入，适配器不判断 default 路由的模式。 */
  catalogMode?: "dynamic" | "manual";
  /** 定时器注入点，便于测试不依赖真实时间。 */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** 进程日志目标（gateway.log）；未注入时 CodeBuddy 请求不写请求摘要。 */
  processLog?: ProcessLogTarget;
}

/** CodeBuddy CLI 自身约每 16 分钟刷新一次目录，网关按同一节奏主动更新。 */
const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 16 * 60 * 1000;

export function validateCodebuddyAccount(account: unknown): void {
  if (account !== undefined && (typeof account !== "string" || !isCodebuddyAccountName(account))) {
    throw new Error("codebuddyAccount 必须是认证目录内的 .info 文件名或 auto");
  }
}

export function validateCodebuddyConfig(config: AgentConfig): void {
  validateCodebuddyAccount(config.codebuddyAccount);
  const host = config.host;
  if (!(host === "localhost" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127.")))) {
    throw new Error("启用 CodeBuddy 时网关只能监听环回地址");
  }
}

export function codebuddyError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, message } }, { status });
}

function buildCodebuddyAdapter(config: AgentConfig, dependencies: CodebuddyDependencies = {}) {
  validateCodebuddyConfig(config);
  const credentialCache = dependencies.credentialCache ?? createCodebuddyCredentialCache(
    dependencies.authDirectory ?? defaultAuthDirectory(),
    config.codebuddyAccount ? { preferredAccount: config.codebuddyAccount } : {},
  );
  const fetchUpstream = dependencies.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const catalogStore = createCodebuddyCatalogStore({
    cacheDirectory: dependencies.cacheDirectory ?? resolvePaths().runtimeHome,
    // 目录刷新没有带地域的 slug 可依据，按 codebuddyAccount/auto 选取凭据；
    // 请求路由则始终以带地域 slug 为准。
    credentials: async () => {
      const list = [];
      for (const product of ["cli", "work"] as const) {
        try { list.push(await credentialCache.forProduct(product)); } catch { /* 锁定文件不可用或缺凭据时由另一产品/auto 兜底。 */ }
      }
      return list;
    },
    ...(dependencies.codexModelsCacheFile ? { codexModelsCacheFile: dependencies.codexModelsCacheFile } : {}),
    fetch: (url, init) => fetchUpstream(url, init),
    catalogMode: dependencies.catalogMode,
  });
  const scheduleInterval = dependencies.setInterval ?? setInterval;
  const cancelInterval = dependencies.clearInterval ?? clearInterval;
  const catalogRefreshIntervalMs = Math.max(
    1_000,
    Math.trunc(dependencies.catalogRefreshIntervalMs ?? DEFAULT_CATALOG_REFRESH_INTERVAL_MS),
  );
  let catalogRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let startupRefresh: Promise<void> | undefined;
  if (dependencies.refreshCatalogOnStart !== false) {
    // 构造不阻塞启动；目录消费者等待同一轮刷新，避免静态合成抢跑。
    startupRefresh = catalogStore.refresh();
    void startupRefresh.catch(() => {});
  }
  if (dependencies.catalogMode !== "manual") {
    catalogRefreshTimer = scheduleInterval(() => {
      void catalogStore.refresh().catch(() => {});
    }, catalogRefreshIntervalMs);
    catalogRefreshTimer.unref?.();
  }
  const contexts = createCodebuddyContexts();
  const activeRequests = new Set<AbortController>();
  const sink: RequestLogSink | undefined = config.requestLogging === true ? {
    dir: requestLogDir(),
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
    processLog: dependencies.processLog,
  } : undefined;
  let closed = false;
  /** 已知模型集合（serves scope 投影后的裸 ID）；空目录视为不可校验，透传由上游判定。 */
  let knownModels: Set<string> | undefined;
  let knownRegions = new Set<"cn" | "intl">();
  const updateCatalogMeta = (catalog: ModelCatalog): ModelCatalog => {
    knownModels = new Set(catalog.models.map((entry) => entry.slug));
    knownRegions = new Set(catalog.models.flatMap((entry) => {
      const region = codebuddyModelRegion(entry.slug);
      return region ? [region] : [];
    }));
    return catalog;
  };

  return {
    async catalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      try {
        await startupRefresh?.catch(() => {});
        const catalog = await catalogStore.catalog();
        // 系统提示词已在 cloneCodexBase 合成时替换（含 model_messages 模板），缓存即成品；
        // workbuddy/* 沿用同一份（本机无 WorkBuddy IDE 与其产品配置，未做 CODEBUDDY_BRAND_NAME 品牌名替换，见技术债）。
        return updateCatalogMeta(catalog);
      } catch { return { models: [] }; }
    },
    /** 显式刷新不吞错；无 last-good 时由命令报告失败。 */
    async refreshCatalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      await catalogStore.refresh();
      return updateCatalogMeta(await catalogStore.catalog());
    },
    async reloadCatalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      return updateCatalogMeta(await catalogStore.reload());
    },
    async forward(request: Request, input: Record<string, unknown>, to: ClientProtocol = "responses", mapResult?: (payload: Record<string, unknown>) => Response): Promise<Response> {
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
      if (closed) return fail(503, "CodeBuddy 适配器已关闭", "configuration_error");
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
        // 前缀同时决定产品接口与地域；旧的无地域前缀直接拒绝。
        const product = codebuddyModelProduct(input.model);
        const region = codebuddyModelRegion(input.model);
        if (product) family = product === "work" ? "workbuddy" : "codebuddy";
        if (!product || !region) {
          cleanup();
          return fail(400, "CodeBuddy 模型名必须使用 codebuddy-cn/、codebuddy-intl/、workbuddy-cn/ 或 workbuddy-intl/ 前缀");
        }
        const credential = await credentialCache.forProduct(product, region);
        accessToken = credential.accessToken;
        refreshToken = credential.refreshToken;
        abort.signal.throwIfAborted();
        const model = typeof input.model === "string" ? codebuddyUpstreamModel(input.model) : undefined;
        if (!model) { cleanup(); return fail(400, "CodeBuddy 模型名缺少前缀后的模型 ID"); }
        // 目录可用时校验 belongs-to-serves；空目录（拉取失败）透传，由上游判定。
        if (knownModels !== undefined && knownModels.size > 0 && knownRegions.has(region) && !knownModels.has(String(input.model))) {
          cleanup();
          return fail(404, "此模型不在 CodeBuddy/WorkBuddy 当前账号的可服务目录内");
        }
        const translated = await translateCodebuddyRequest(input, model, to);
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
        // anthropic 源默认非流式；responses/chat 源仅在客户端声明 stream 时流式返回。
        const stream = !mapResult && input.stream === true;
        const response = await createCodebuddyResponse(to, upstream, {
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
      credentialCache.close();
      contexts.close();
      for (const request of activeRequests) request.abort();
      activeRequests.clear();
    },
  };
}
export { getActiveAccount, withInstanceContext } from "./credentials.ts";
export type { CodebuddyInstanceContext, CodebuddyRegion } from "./credentials.ts";
export { CODEBUDDY_RUNTIME_ARTIFACTS } from "./catalog.ts";

export function createCodebuddyAdapter(config: AgentConfig, dependencies: CodebuddyDependencies = {}) {
  return bindHostMethods(buildCodebuddyAdapter(config, dependencies));
}

export const CODEBUDDY_MODEL_PATTERNS: readonly string[] = Object.freeze(["codebuddy/*","workbuddy/*","codebuddy-cn/*","codebuddy-intl/*","workbuddy-cn/*","workbuddy-intl/*"]);

/** 插件只负责本代理路由，协议转换沿用原适配器实现。 */
export function createCodebuddyPlugin(host: HostServices<AgentConfig>, dependencies: CodebuddyDependencies = {}): GatewayPlugin {
  return withHostServices(host, () => {
    const adapter = createCodebuddyAdapter(host.getConfig(), { fetch: host.fetch, ...dependencies });
    return bindHostMethods({
      id: "codebuddy",
      modelPatterns: CODEBUDDY_MODEL_PATTERNS,
      websocket: false,
      async handleHttp(context) {
        const input = await context.body.json();
        if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ error: { type: "invalid_request_error", message: "请求正文必须是 JSON 对象" } }, { status: 400 });
        return adapter.forward(context.request, input as Record<string, unknown>, context.to);
      },
      getCatalog: () => adapter.catalog().then(dedupeCodebuddyCatalog),
      refreshCatalog: () => adapter.refreshCatalog(),
      reloadCatalog: () => adapter.reloadCatalog(),
      ready: async () => {},
      close: () => adapter.close(),
    } satisfies GatewayPlugin, host);
  });
}
