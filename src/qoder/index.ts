import path from "node:path";
import { isIP } from "node:net";
import { resolvePaths } from "../paths.ts";
import { loadQoderCredentials, QoderCredentialError, QODER_REGION_LABELS } from "./credentials.ts";
import type { QoderCredentials, QoderRegion } from "./credentials.ts";
import { createQoderTransport, QoderTransportError } from "./transport.ts";
import type { QoderInferPayload } from "./transport.ts";
import { createQoderCatalogStore, qoderModelConfig, qoderModelSlug } from "./catalog.ts";
import { translateQoderRequest, QoderRequestError } from "./request.ts";
import { translateQoderResponse } from "./response.ts";
import { createQueueAwareInfer, QoderQueueError } from "./queue.ts";
import { localTime, logExchange, logGroupFromPath, requestLogDir } from "../request-log.ts";
import type { RequestLogSink } from "../request-log.ts";
import { logGatewayError, logRequestSummary } from "../process-log.ts";
import type { GatewayConfig, ModelCatalog, ProcessLogTarget } from "../types.ts";

export interface QoderTransportLike {
  fetchCatalog(credential: QoderCredentials, signal?: AbortSignal): Promise<unknown>;
  infer(credential: QoderCredentials, payload: QoderInferPayload, signal?: AbortSignal): Promise<Response>;
}

export interface QoderRegionDependencies {
  credentials?: () => Promise<QoderCredentials | null>;
  transport?: QoderTransportLike;
}

export interface QoderDependencies extends QoderRegionDependencies {
  configDir?: string;
  /** 国内版依赖注入；未提供时使用默认目录与官方国内版端点。 */
  cn?: QoderRegionDependencies;
  configDirs?: Partial<Record<QoderRegion, string>>;
  cacheDirectory?: string;
  codexModelsCacheFile?: string;
  fetch?: typeof fetch;
  catalogRefreshIntervalMs?: number;
  catalogMode?: "dynamic" | "manual";
  refreshCatalogOnStart?: boolean;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  processLog?: ProcessLogTarget;
  /** 上游连续无数据的超时；持续输出、心跳与排队状态帧不受总时长限制。 */
  idleTimeoutMs?: number;
}

export function qoderEnabled(config: GatewayConfig): boolean {
  return config.qoder === true;
}

export function validateQoderConfig(config: GatewayConfig): void {
  if (config.qoder !== undefined && typeof config.qoder !== "boolean") throw new Error("qoder 必须为 boolean");
  if (!qoderEnabled(config)) return;
  if (!(config.host === "localhost" || config.host === "::1" || config.host === "[::1]"
    || (isIP(config.host) === 4 && config.host.startsWith("127.")))) {
    throw new Error("启用 Qoder 时网关只能监听环回地址");
  }
  for (const reserved of ["qoder/", "qoder-intl/", "qoder-cn/"]) {
    if (config.prefix && (reserved.startsWith(config.prefix) || config.prefix.startsWith(reserved))) {
      throw new Error(`启用 Qoder 时 ${reserved} 前缀保留给 Qoder，请调整第三方 prefix`);
    }
  }
}

export function qoderError(status: number, message: string): Response {
  return Response.json({ error: { type: status === 401 || status === 403 ? "authentication_error" : "invalid_request_error", message } }, { status });
}

/** 只输出预定义分类，私有错误正文和任意请求回显不能进入客户端或日志。 */
export function safeQoderUpstreamError(error: Record<string, unknown>): Record<string, unknown> {
  const upstream = error.upstream_error && typeof error.upstream_error === "object"
    ? error.upstream_error as Record<string, unknown> : error;
  const status = upstream.status;
  const text = `${String(upstream.code ?? "")} ${String(upstream.message ?? error.message ?? "")}`.toLowerCase();
  if (status === 401 || /unauthorized|authentication|invalid.?token|token.*expired/.test(text)) {
    return { code: "qoder_authentication_error", message: "Qoder 上游拒绝授权，请运行 qoder login 更新登录后重试" };
  }
  // 403+10605 是排队/额度占用信封，不是授权问题；恢复失败时按并发受限提示。
  if (String(upstream.code) === "10605" || /10605|isqueued|queuetype|serviceavailable/.test(text)) {
    return { code: "qoder_queued_limited", message: "Qoder 服务繁忙，请求排队后未能恢复；请稍后重试或关闭其他正在运行的 Qoder 会话" };
  }
  if (/context.{0,30}(exceed|limit|long)|input.{0,30}(too long|exceed)|prompt.{0,30}(too long|exceed)|上下文|输入过长/.test(text)) {
    return { code: "qoder_context_limit", message: "Qoder 上游拒绝当前上下文长度，请压缩历史或新建聊天后重试" };
  }
  if (status === 429 || /rate.?limit|too many requests|限流|quota|credits|余额|额度/.test(text)) {
    return { code: "qoder_rate_or_quota_limit", message: "Qoder 上游限流或账号额度受限，请检查 Qoder 用量后重试" };
  }
  if (/tool.{0,40}(invalid|missing|call_id|not found)|invalid.{0,40}tool|工具/.test(text)) {
    return { code: "qoder_tool_history_error", message: "Qoder 上游拒绝工具调用历史，请检查工具调用与结果是否成对" };
  }
  if (error.code === "upstream_protocol_error") {
    const code = /finish|eof/.test(text) ? "qoder_incomplete_stream" : "qoder_invalid_stream";
    return { code, message: code === "qoder_incomplete_stream" ? "Qoder 上游流提前结束，请重试" : "Qoder 上游响应格式不符合当前协议，请检查网关适配版本" };
  }
  const upstreamCode = /^\d{1,9}$/.test(String(upstream.code ?? "")) ? Number(upstream.code) : undefined;
  const upstreamStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  return { code: "qoder_upstream_error", message: "Qoder 上游响应失败，请稍后重试；错误已记录在 Qoder 请求日志中",
    ...(upstreamCode === undefined ? {} : { upstream_code: upstreamCode }),
    ...(upstreamStatus === undefined ? {} : { upstream_status: upstreamStatus }) };
}

interface RegionRuntime {
  region: QoderRegion;
  label: string;
  credentials: () => Promise<QoderCredentials | null>;
  transport: QoderTransportLike;
  store: ReturnType<typeof createQoderCatalogStore>;
}

/** 双区域门面：认证只读，每区域独立目录与推理调用，入站授权从不参与上游请求。 */
export function createQoderAdapter(config: GatewayConfig, dependencies: QoderDependencies = {}) {
  validateQoderConfig(config);
  const enabled = qoderEnabled(config);
  const lifecycle = new AbortController();
  const active = new Set<AbortController>();
  const sink: RequestLogSink | undefined = config.requestLogging === true ? {
    dir: requestLogDir(config),
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
  } : undefined;
  const cacheDirectory = dependencies.cacheDirectory ?? resolvePaths().runtimeHome;

  const regions: RegionRuntime[] = [];
  if (enabled) {
    for (const region of ["intl", "cn"] as const) {
      const scoped = region === "intl" ? dependencies : dependencies.cn ?? {};
      const configDir = dependencies.configDirs?.[region] ?? (region === "intl" ? dependencies.configDir : undefined);
      const credentials = scoped.credentials ?? (() => loadQoderCredentials({ region, configDir }));
      const transport = scoped.transport
        ?? createQoderTransport({ region, fetch: dependencies.fetch });
      regions.push({
        region,
        label: QODER_REGION_LABELS[region],
        credentials,
        transport,
        store: createQoderCatalogStore({
          region,
          catalogMode: dependencies.catalogMode,
          cacheDirectory,
          credentials,
          codexModelsCacheFile: dependencies.codexModelsCacheFile,
          fetchCatalog: (credential) => transport.fetchCatalog(credential, AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30_000)])),
        }),
      });
    }
  }
  const byRegion = new Map<QoderRegion, RegionRuntime>(regions.map((runtime) => [runtime.region, runtime]));

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const schedule = dependencies.setInterval ?? setInterval;
  const cancel = dependencies.clearInterval ?? clearInterval;
  let startup: Promise<void> | undefined;
  async function refreshAll(): Promise<void> {
    await Promise.all(regions.map((runtime) => runtime.store.refresh()));
  }
  function backgroundRefresh(): void {
    if (closed) return;
    for (const runtime of regions) {
      void runtime.store.refresh().catch(() => {
        if (!closed) logGatewayError(dependencies.processLog, {
          requestTime: localTime(), method: "GET", url: `/qoder/catalog`, status: 502,
          message: `${runtime.label} Qoder 目录更新失败；请检查本机登录及网络。`,
        });
      });
    }
  }
  if (regions.length) {
    if (dependencies.refreshCatalogOnStart !== false) {
      startup = refreshAll();
      void startup.catch(() => {});
      void startup.finally(() => { startup = undefined; }).catch(() => {});
    }
    if (dependencies.catalogMode !== "manual") {
      timer = schedule(backgroundRefresh, Math.max(1_000, dependencies.catalogRefreshIntervalMs ?? 120_000));
      timer.unref?.();
    }
  }

  return {
    async catalog(): Promise<ModelCatalog> {
      if (!regions.length || closed) return { models: [] };
      await startup?.catch(() => {});
      const models = [];
      for (const runtime of regions) {
        try {
          const catalog = await runtime.store.catalog();
          models.push(...catalog.models);
        } catch {
          logGatewayError(dependencies.processLog, {
            requestTime: localTime(), method: "GET", url: "/qoder/catalog", status: 502,
            message: `${runtime.label} Qoder 目录不可用；请检查本机登录及网络。`,
          });
        }
      }
      // 系统提示词已在 buildQoderCatalog 合成时替换（含 model_messages 模板），缓存即成品。
      return { models };
    },
    async refreshCatalog(): Promise<ModelCatalog> {
      if (!regions.length || closed) return { models: [] };
      await (startup ?? refreshAll());
      return { models: (await Promise.all(regions.map((runtime) => runtime.store.catalog()))).flatMap((catalog) => catalog.models) };
    },
    async reloadCatalog(): Promise<ModelCatalog> {
      if (!regions.length || closed) return { models: [] };
      await startup?.catch(() => {});
      return { models: (await Promise.all(regions.map((runtime) => runtime.store.reload()))).flatMap((catalog) => catalog.models) };
    },
    async forward(request: Request, input: Record<string, unknown>, mapResult?: (payload: Record<string, unknown>) => Response): Promise<Response> {
      if (!regions.length || closed) return qoderError(404, "Qoder 适配器未启用");
      const model = typeof input.model === "string" ? input.model : "";
      const slug = qoderModelSlug(model);
      if (!slug) return qoderError(400, "Qoder 模型必须使用 qoder-intl/ 或 qoder-cn/ 前缀");
      const runtime = byRegion.get(slug.region)!;
      const label = runtime.label;
      const modelKey = slug.key;
      const started = Date.now();
      const requestTime = localTime();
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, lifecycle.signal, controller.signal]);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let result: Record<string, unknown> | undefined;
      const armTimeout = () => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          controller.abort(new DOMException("Qoder 上游连续无数据超时", "TimeoutError"));
        }, dependencies.idleTimeoutMs ?? 120_000);
        idleTimer.unref?.();
      };
      active.add(controller);
      let completed = false;
      const finish = (status: number) => {
        if (completed) return;
        completed = true;
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        active.delete(controller);
        // 请求日志保留模型、状态和用量，不记录私有认证头、提示词或工具内容。
        logExchange(sink, logGroupFromPath(new URL(request.url).pathname), {
          requestTime, method: request.method, url: new URL(request.url).pathname,
          reqHeaders: new Headers(), reqBody: { model, stream: input.stream === true },
          status, resHeaders: new Headers(), durationMs: Date.now() - started,
          resBody: JSON.stringify({ status: result?.status, usage: result?.usage, error: result?.error, timedOut }),
        }, "qoder");
        logRequestSummary(dependencies.processLog, {
          requestTime: localTime(), method: request.method, url: new URL(request.url).pathname,
          status, durationMs: Date.now() - started,
        });
      };
      try {
        const credential = await runtime.credentials();
        if (!credential) { finish(401); return qoderError(401, `未检测到${label} Qoder 登录；请运行 qoder login 或打开 Qoder 桌面版登录后重试`); }
        const catalog = await runtime.store.catalog();
        const entry = catalog.models.find((item) => item.slug === model);
        if (!entry) { finish(404); return qoderError(404, `模型不在${label} Qoder 当前账号目录中，请刷新模型列表`); }
        // 目录拉取期间可能发生登录切换，禁止拿新账号目录配旧账号授权。
        const current = await runtime.credentials();
        if (!current || current.identity !== credential.identity) {
          finish(409); return qoderError(409, "Qoder 登录在请求期间发生变化，请刷新模型目录后重试");
        }
        signal.throwIfAborted();
        const levels = Array.isArray(entry.supported_reasoning_levels)
          ? entry.supported_reasoning_levels as Array<{ effort: string }> : [];
        const translated = translateQoderRequest(input, modelKey, levels.map((level) => level.effort));
        // 完整上下文档位通过独立参数选择，不能用默认输入限制代替。
        if (typeof entry.context_window === "number") {
          (translated.body.parameters as Record<string, unknown>).context_length = entry.context_window;
        }
        armTimeout();
        // 排队信封（403+10605）由恢复层处理：放弃排队流并按上游 retryAfterSeconds
        // 节奏重发，总预算内未获得推理机会则给出明确排队失败。
        const queueInfer = createQueueAwareInfer(
          (cred, payload, inferSignal) => runtime.transport.infer(cred, payload, inferSignal),
        );
        const upstream = await queueInfer.infer(current, {
          body: translated.body,
          modelKey,
          modelSource: typeof entry.qoder_source === "string" ? entry.qoder_source : "system",
          modelConfig: qoderModelConfig(entry),
        }, signal, { keepAlive: armTimeout });
        const observed = upstream.body ? new Response(upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, output) { armTimeout(); output.enqueue(chunk); },
        })), { status: upstream.status, headers: upstream.headers }) : upstream;
        const response = await translateQoderResponse(observed, {
          model, tools: translated.tools, stream: !mapResult && input.stream === true,
          signal,
          abort: () => { controller.abort(); },
          onComplete: (payload) => {
            result = payload;
            finish(timedOut ? 504 : payload.status === "failed" ? request.signal.aborted || lifecycle.signal.aborted ? 499 : 502 : 200);
          },
          // 私有上游错误可能回显认证字段，公开响应只保留固定指引。
          sanitizeError: (error) => timedOut
            ? { code: "qoder_upstream_timeout", message: "Qoder 上游连续无数据超时，请稍后重试" }
            : safeQoderUpstreamError(error),
        });
        if (mapResult) return mapResult(await response.json() as Record<string, unknown>);
        return response;
      } catch (error) {
        const status = timedOut ? 504 : error instanceof QoderQueueError ? 503 : signal.aborted ? 499
          : error instanceof QoderCredentialError ? 401
          : error instanceof QoderTransportError ? error.status : error instanceof QoderRequestError ? 400 : 502;
        finish(status);
        const message = timedOut ? "Qoder 上游连续无数据超时，请稍后重试"
          : error instanceof QoderQueueError || error instanceof QoderCredentialError || error instanceof QoderTransportError || error instanceof QoderRequestError
          ? error.message : signal.aborted ? "Qoder 请求已取消或超时" : `${label} Qoder 调用失败，请检查登录及模型目录后重试`;
        return qoderError(status, message);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      lifecycle.abort();
      for (const controller of active) controller.abort();
      active.clear();
    },
  };
}
