import { bindHostMethods, getHostServices, withHostServices } from "@agent-proxy/plugin-api";
import type { HostServices, GatewayPlugin, ClientProtocol } from "@agent-proxy/plugin-api";
import path from "node:path";
import { isIP } from "node:net";
import { atomicWrite } from "@agent-proxy/plugin-api";
import { resolvePaths } from "@agent-proxy/plugin-api";
import { agyTokenStale, loadAgyCredentials, AgyCredentialError, defaultAgyCredentialFile } from "./credentials.ts";
import type { AgyCredentials } from "./credentials.ts";
import { createAgyTransport, AgyTransportError } from "./transport.ts";
import {
  AGY_PREFIX,
  agyUpstreamModel,
  createAgyCatalogStore,
  isAgyModel,
  mergeAgyCatalog,
  resolveAgyFamilyModel,
} from "./catalog.ts";
import type { AgyModelFamily } from "./catalog.ts";
import { translateAgyRequest, AgyRequestError } from "./request.ts";
import { createAgyClientResponse } from "./response.ts";
import { localTime, logExchange, logGroupFromPath, requestLogDir } from "@agent-proxy/plugin-api";
import type { RequestLogSink } from "@agent-proxy/plugin-api";
import { logGatewayError, logRequestSummary } from "@agent-proxy/plugin-api";
import type { AgentConfig, ModelCatalog, ModelEntry, ProcessLogTarget } from "@agent-proxy/plugin-api";

declare module "@agent-proxy/plugin-api" {
  interface AgentConfig {
    /**
     * 是否开启调试转储：上游错误时把完整请求体落盘到日志目录（当前覆盖 agy 上游 400 的 agy-debug-400.json）。
     * 与 requestLogging 互相独立，默认关闭。
     */
    debug?: boolean;
  }
}

/**
 * Antigravity（agy）入口门面：凭据只读消费（过期即失败，绝不刷新）、fetchAvailableModels
 * 动态目录、Responses ↔ v1internal streamGenerateContent 双向转换。`catalog()` 供
 * /v1/models 合并，`forward()` 处理 /v1/responses 拦截。
 */

export interface AgyDependencies {
  /** 凭据文件路径；缺省取平台默认的 ~/.gemini/antigravity-cli/antigravity-oauth-token。 */
  credentialFile?: string;
  /** 依赖注入的凭据读取（测试用）；提供时忽略 credentialFile。 */
  credentials?: () => Promise<AgyCredentials | null>;
  /** 上游端点覆盖；缺省 stable 通道 cloudcode-pa.googleapis.com。 */
  endpoint?: string;
  cacheDirectory?: string;
  /** Codex 自己的目录缓存；目录内容变化时过期它。 */
  codexModelsCacheFile?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** 目录刷新间隔（毫秒）；生产缺省 6 分钟，与 CLI 轮询节奏一致。 */
  catalogRefreshIntervalMs?: number;
  /** 是否在适配器构造后立即强制刷新一次目录；测试可关闭。 */
  refreshCatalogOnStart?: boolean;
  /** 目录生命周期由网关注入，适配器不判断 default 路由的模式。 */
  catalogMode?: "dynamic" | "manual";
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** 进程日志目标（gateway.log）。 */
  processLog?: ProcessLogTarget;
}

/** CLI 的模型轮询周期是 360 秒（见调研文档 §5.5），网关按同一节奏刷新目录。 */
const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 360_000;

export function validateAgyConfig(config: AgentConfig): void {
  const host = config.host;
  if (!(host === "localhost" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127.")))) {
    throw new Error("启用 agy 时网关只能监听环回地址");
  }
}

export function agyError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, message } }, { status });
}

export interface SafeAgyError {
  code: string;
  message: string;
  upstream_status?: number;
  [key: string]: unknown;
}

/** 只输出预定义分类；私有错误正文（可能回显请求或凭据）不进客户端与日志。 */
export function safeAgyUpstreamError(status: number, body: string): SafeAgyError {
  const text = body.toLowerCase();
  if (status === 401 || status === 403 || /unauthorized|authentication|invalid.?token|token.*expired|expired.*token/.test(text)) {
    return {
      code: "agy_authentication_error",
      message: "Antigravity 登录态已失效；请运行 agy 或 agy remote-control start 刷新登录后重试",
    };
  }
  if (status === 429 || /resource.?exhausted|rate.?limit|quota|too many requests/.test(text)) {
    return { code: "agy_rate_or_quota_limit", message: "Antigravity 上游限流或账号额度受限，请检查用量后重试" };
  }
  if (/context.{0,30}(exceed|limit|long)|input.{0,30}(too long|exceed)|prompt.{0,30}(too long|exceed)/.test(text)) {
    return { code: "agy_context_limit", message: "Antigravity 上游拒绝当前上下文长度，请压缩历史或新建聊天后重试" };
  }
  return {
    code: "agy_upstream_error",
    message: "Antigravity 上游响应失败，请稍后重试；错误已记录在网关日志中",
    ...(status >= 100 && status <= 599 ? { upstream_status: status } : {}),
  };
}

function buildAgyAdapter(config: AgentConfig, dependencies: AgyDependencies = {}) {
  validateAgyConfig(config);
  const credentialFile = dependencies.credentialFile ?? defaultAgyCredentialFile();
  const loadCredentials = async (): Promise<AgyCredentials | null> => {
    if (dependencies.credentials) return dependencies.credentials();
    try {
      return loadAgyCredentials({ credentialFile });
    } catch {
      return null;
    }
  };
  const transport = createAgyTransport({ endpoint: dependencies.endpoint, fetch: dependencies.fetch });
  // 请求日志与调试转储共用同一目录解析规则；两者开关（requestLogging / debug）互相独立。
  const logDir = requestLogDir();
  const sink: RequestLogSink | undefined = config.requestLogging === true ? {
    dir: logDir,
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
    processLog: dependencies.processLog,
  } : undefined;
  const store = createAgyCatalogStore({
    cacheDirectory: dependencies.cacheDirectory ?? resolvePaths().runtimeHome,
    credentials: loadCredentials,
    codexModelsCacheFile: dependencies.codexModelsCacheFile,
    endpoint: dependencies.endpoint,
    fetchCatalog: (credential) => transport.fetchModels(credential, AbortSignal.timeout(30_000)),
    catalogMode: dependencies.catalogMode,
  });
  const schedule = dependencies.setInterval ?? setInterval;
  const cancel = dependencies.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startupRefresh: Promise<void> | undefined;
  if (dependencies.refreshCatalogOnStart !== false) {
    startupRefresh = store.refresh();
    void startupRefresh.catch(() => {});
  }
  if (dependencies.catalogMode !== "manual") {
    timer = schedule(() => { void store.refresh().catch(() => {}); }, Math.max(1_000, dependencies.catalogRefreshIntervalMs ?? DEFAULT_CATALOG_REFRESH_INTERVAL_MS));
    timer.unref?.();
  }
  const activeRequests = new Set<AbortController>();
  /** 已知模型集合（含重定向前的旧 id）；空目录视为不可校验，透传由上游判定。 */
  let knownModels: Set<string> | undefined;
  /** 档位家族与成员 id 集合：合并条目按 effort 解析上游变体，显式档位 id 直连。 */
  let catalogFamilies: AgyModelFamily[] = [];
  let memberIds = new Set<string>();
  let catalogReroute = new Map<string, string>();
  const updateCatalogMeta = (catalog: Awaited<ReturnType<typeof store["catalog"]>>): ModelCatalog => {
    knownModels = new Set(catalog.models.map((entry) => entry.slug));
    catalogFamilies = catalog.families;
    memberIds = new Set(catalog.families
      .flatMap((family) => Object.values(family.tiers))
      .filter((id): id is string => typeof id === "string" && id.length > 0));
    catalogReroute = catalog.reroute;
    return { models: catalog.models };
  };
  /** 尽力加载目录元数据（含磁盘缓存回退）；失败时保持未加载状态，由上游判定。 */
  const loadCatalogMeta = async (): Promise<ModelEntry[] | undefined> => {
    try {
      await startupRefresh?.catch(() => {});
      return updateCatalogMeta(await store.catalog()).models;
    } catch { /* 目录不可用时维持透传语义。 */ }
  };
  let closed = false;

  return {
    async catalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      // 目录缓存即成品（官方提示词由请求转换层整体注入，任何客户端协议进入均生效）。
      return { models: (await loadCatalogMeta()) ?? [] };
    },
    /** 显式刷新不吞错；无 last-good 时由命令报告失败。 */
    async refreshCatalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      await store.refresh();
      return updateCatalogMeta(await store.catalog());
    },
    async reloadCatalog(): Promise<ModelCatalog> {
      if (closed) return { models: [] };
      return updateCatalogMeta(await store.reload());
    },
    async forward(request: Request, input: Record<string, unknown>, to: ClientProtocol = "responses", mapResult?: (payload: Record<string, unknown>) => Response): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      const agy = isAgyModel(input.model);
      let logged = false;
      const log = (status: number, resBody: string, headers = new Headers()) => {
        if (logged || !agy) return;
        logged = true;
        const durationMs = Date.now() - start;
        const url = incoming.pathname;
        logExchange(sink, group, {
          requestTime, method: request.method, url,
          // 请求日志只记录模型与流式标记，不落提示词、工具内容或任何凭据。
          reqHeaders: new Headers(), reqBody: { model: input.model, stream: input.stream === true },
          status, resHeaders: headers, resBody, durationMs,
        }, "agy");
        if (status >= 400) {
          logGatewayError(sink?.processLog, { requestTime, method: request.method, url, status, message: resBody.slice(0, 500), durationMs });
        } else {
          logRequestSummary(sink?.processLog, { requestTime, method: request.method, url, status, durationMs });
        }
      };
      const fail = (status: number, message: string, type?: string) => {
        const response = agyError(status, message, type);
        log(status, JSON.stringify({ error: { type, message } }), response.headers);
        return response;
      };
      if (closed) return fail(503, "Antigravity 入口已关闭", "configuration_error");
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
      let chunks = "";
      let resolvedModel: string | undefined;
      const stream = !mapResult && input.stream === true;
      try {
        if (request.signal.aborted) onAbort();
        abort.signal.throwIfAborted();
        const model = typeof input.model === "string" ? input.model : "";
        // isAgyModel 大小写不敏感而目录 slug 用小写前缀：AGY/x 归一为 agy/x 再查目录。
        const normalized = isAgyModel(model)
          ? model.slice(0, AGY_PREFIX.length).toLowerCase() + model.slice(AGY_PREFIX.length)
          : model;
        const upstreamModel = agyUpstreamModel(normalized);
        if (!upstreamModel) {
          cleanup();
          return fail(400, "Antigravity 模型必须使用 agy/ 前缀");
        }
        // 凭据读取失败与过期分开报错：后者给出 1 小时有效期与刷新方式的指引。
        let credential: AgyCredentials;
        try {
          if (dependencies.credentials) {
            const injected = await dependencies.credentials();
            if (!injected) throw new AgyCredentialError("Antigravity 凭据不可用，请运行 agy 登录后重试");
            credential = injected;
          } else {
            credential = loadAgyCredentials({ credentialFile });
          }
        } catch (error) {
          cleanup();
          const message = error instanceof AgyCredentialError && error.message ? error.message : "Antigravity 凭据不可用，请运行 agy 登录后重试";
          return fail(401, message, "authentication_error");
        }
        if (agyTokenStale(credential)) {
          cleanup();
          return fail(401, "Antigravity 令牌已过期（有效期 1 小时，由 agy 进程负责刷新）；请运行 agy 或 agy remote-control start 后重试", "authentication_error");
        }
        // 目录可用时校验 belongs-to 并解析档位；空目录（拉取失败）透传，由上游判定。
        // 转发可能先于任何 catalog() 调用发生，此时尽力加载一次元数据。
        if (knownModels === undefined) await loadCatalogMeta();
        resolvedModel = upstreamModel;
        if (knownModels !== undefined && knownModels.size > 0) {
          if (knownModels.has(normalized) || memberIds.has(upstreamModel)) {
            // 合并条目（agy/<base>）按 reasoning.effort 选择档位变体；显式档位 id 原样直连。
            const family = catalogFamilies.find((item) => item.base === upstreamModel);
            if (family) {
              const reasoning = input.reasoning;
              const effort = reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)
                ? (reasoning as Record<string, unknown>).effort : undefined;
              resolvedModel = resolveAgyFamilyModel(family, effort);
            }
          } else {
            // 动态模式沿用请求驱动的重定向更新；manual 只消费已加载元数据。
            if (dependencies.catalogMode !== "manual") {
              try { updateCatalogMeta(await store.catalog()); } catch { /* 无目录时保留 last-good 元数据。 */ }
            }
            const target = catalogReroute.get(upstreamModel);
            if (target) resolvedModel = target;
            else {
              cleanup();
              return fail(404, "此模型不在 Antigravity 当前账号目录中，请刷新模型列表");
            }
          }
        }
        const translated = translateAgyRequest(input, resolvedModel, to);
        abort.signal.throwIfAborted();
        const upstream = await transport.streamInfer(credential, translated.wrapper, abort.signal);
        // 流式响应在 forward 返回后由客户端 pull 驱动，下列回调可能在调用上下文之外
        // 触发（Bun 的流调度不继承 withHostServices 的 AsyncLocalStorage）；日志等
        // 宿主服务调用必须重入当前宿主上下文，否则 logExchange 抛错被 safely 吞掉、
        // 请求日志静默丢失。
        const host = getHostServices();
        const inHostContext = <T>(callback: () => T): T => withHostServices(host, callback);
        const response = await createAgyClientResponse(to, upstream, {
          model, tools: translated.tools, stream, signal: abort.signal,
          sanitizeError: (error) => inHostContext(() => {
            // 上游流内错误的原始对象只进本机网关日志（截断），供排查；客户端只见预定义分类。
            if (error?.code !== "response_cancelled") {
              logGatewayError(sink?.processLog, {
                requestTime, method: request.method, url: incoming.pathname,
                status: 502,
                message: `agy stream error: ${JSON.stringify(error).slice(0, 2_000)}`,
                durationMs: Date.now() - start,
              });
            }
            return safeAgyUpstreamError(0, `${String(error.code ?? "")} ${String(error.message ?? "")}`);
          }),
          abort: () => inHostContext(() => { abort.abort(); cleanup(); }),
          onChunk: (chunk) => inHostContext(() => { if (sink) chunks += chunk; }),
          onComplete: (payload) => inHostContext(() => {
            cleanup();
            const stripped = translated.dropped.length ? `\n--- stripped built-in tools: ${translated.dropped.join(", ")} ---\n` : "";
            if (!mapResult) log(stream ? 200 : payload.status === "failed" ? 502 : 200,
              stream ? `${chunks}${stripped}\n--- response.${String(payload.status)} ---\n${JSON.stringify(payload)}`
                : `${JSON.stringify(payload)}${stripped}`,
              new Headers({ "content-type": stream ? "text/event-stream" : "application/json" }));
          }),
        });
        if (!mapResult) return response;
        const payload: unknown = await response.json();
        if (!response.ok || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          cleanup();
          return fail(502, "Antigravity 上游未完成上下文压缩", "invalid_response_error");
        }
        const mapped = mapResult(payload as Record<string, unknown>);
        log(mapped.status, await mapped.clone().text(), mapped.headers);
        cleanup();
        return mapped;
      } catch (error) {
        abort.abort();
        cleanup();
        if (error instanceof AgyRequestError) return fail(400, error.message);
        if (error instanceof AgyCredentialError) return fail(401, error.message, "authentication_error");
        if (error instanceof AgyTransportError) {
          const safe = safeAgyUpstreamError(error.status, error.body);
          // 上游 400 且 debug 开启时，把原始请求完整落盘到日志目录的本机调试文件
          // （含提示词，仅用于离线重放验收，绝不进请求日志/外部），下一次同类失败
          // 可直接用真实载荷复现。
          if (error.status === 400 && config.debug === true) {
            try {
              atomicWrite(
                path.join(logDir, "agy-debug-400.json"),
                `${JSON.stringify({
                  captured_at: new Date().toISOString(),
                  model: input.model,
                  resolved_model: resolvedModel,
                  upstream_error: { status: error.status, body: error.body },
                  request_body: input,
                }, null, 2)}\n`,
              );
            } catch { /* 调试落盘失败不影响错误返回。 */ }
          }
          // 上游错误体只进本机网关日志（截断），供排查；不进客户端响应与请求日志。
          logGatewayError(sink?.processLog, {
            requestTime, method: request.method, url: incoming.pathname,
            status: error.status || 502,
            message: `agy upstream ${error.status || "network"}: ${error.body.slice(0, 4_096)}`,
            durationMs: Date.now() - start,
          });
          return fail(error.status === 401 || error.status === 403 || error.status === 429 ? error.status : 502,
            safe.message, "upstream_error");
        }
        if (request.signal.aborted) return fail(499, "Antigravity 请求已取消", "request_cancelled");
        logGatewayError(sink?.processLog, {
          requestTime, method: request.method, url: incoming.pathname, status: 502,
          message: `agy forward failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          durationMs: Date.now() - start,
        });
        return fail(502, "Antigravity 上游请求失败", "upstream_error");
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

export { isAgyModel, mergeAgyCatalog };
export { AGY_RUNTIME_ARTIFACTS } from "./catalog.ts";

export function createAgyAdapter(config: AgentConfig, dependencies: AgyDependencies = {}) {
  return bindHostMethods(buildAgyAdapter(config, dependencies));
}

export const AGY_MODEL_PATTERNS: readonly string[] = Object.freeze(["agy/*"]);

/** 插件只负责本代理路由，协议转换沿用原适配器实现。 */
export function createAgyPlugin(host: HostServices<AgentConfig>, dependencies: AgyDependencies = {}): GatewayPlugin {
  return withHostServices(host, () => {
    const adapter = createAgyAdapter(host.getConfig(), { fetch: host.fetch, ...dependencies });
    return bindHostMethods({
      id: "agy",
      modelPatterns: AGY_MODEL_PATTERNS,
      websocket: false,
      async handleHttp(context) {
        const input = await context.body.json();
        if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ error: { type: "invalid_request_error", message: "请求正文必须是 JSON 对象" } }, { status: 400 });
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
