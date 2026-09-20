import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import { createZcodeConfigCache, readZcodeAPIKeyProviders, ZcodeConfigError } from "./config.ts";
import type { ZcodeAPIKeyProvider, ZcodeConfigCache, ZcodeFamily, ZcodeProviderSnapshot, ZcodeSelection } from "./config.ts";
import { clearModelsCacheEntries, invalidateModelsCache } from "../catalog.ts";
import {
  buildZcodeVendorCatalog,
  createZcodeCatalog,
  isZcodeModel,
  writeZcodeServedCatalog,
  zcodeAPIProviderIDFromModel,
  zcodeModelPlan,
  zcodeUpstreamModel,
} from "./catalog.ts";
import { translateZcodeRequest, ZcodeRequestError } from "./request.ts";
import { createZcodeResponse, type ZcodeGatewayToolsHook } from "./response.ts";
import { executeZcodeAnalyzeImage, matchZcodeAnalyzeImage } from "./vision.ts";
import { ZcodeEndpointRouting } from "./endpoint-routing.ts";
import { isZcodeRecord } from "./wire.ts";
import { buildZcodeModelHeaders, createZcodeContexts, decorateZcodeBody, readZcodeIdentity, zcodePlan } from "./request-context.ts";
import type { ZcodeIdentity } from "./request-context.ts";
import { localTime, logExchange, logGroupFromPath } from "../request-log.ts";
import type { RequestLogSink } from "../request-log.ts";
import { logGatewayError, logRequestSummary } from "../process-log.ts";
import type { GatewayConfig, ModelCatalog, ProcessLogTarget } from "../types.ts";

export interface ZcodeDependencies {
  zcodeHome?: string;
  /** 注入的自定义缓存绑定到 api-key（裸 zcode/）路由；其余套餐路由用 planCaches 覆盖。 */
  configCache?: ZcodeConfigCache;
  /** 按套餐注入的缓存（测试用）；注入模式下未覆盖的套餐不创建真实缓存。 */
  planCaches?: Partial<Record<ZcodeSelection["kind"], ZcodeConfigCache>>;
  /** 按 API Key provider 注入的多个缓存（测试用）。 */
  apiKeyCaches?: Record<string, ZcodeConfigCache>;
  identity?: ZcodeIdentity;
  /** Codex 自己的目录缓存；zcode-catalog.json 重建时过期它，让 Codex 重新拉取 /models。 */
  codexModelsCacheFile?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** 端点动态重映射；传 null 禁用（测试用），默认按官方客户端行为启用。 */
  endpointRouting?: ZcodeEndpointRouting | null;
  /** 进程日志目标（gateway.log）；未注入时 ZCode 请求不写请求摘要。 */
  processLog?: ProcessLogTarget;
}
export type GatewayHandler = ((request: Request) => Promise<Response>) & { close(): void };

/**
 * ZCode 入口的生效判定。upstream-only 只使用第三方上游（目录与请求都不加前缀），
 * 该模式下 zcode 开关按禁用处理：不建配置缓存、不写 zcode-catalog.json、不拦截请求，
 * 也不再把环回监听与保留前缀的约束强加给纯转发配置。
 */
export function zcodeEnabled(config: GatewayConfig): boolean {
  return config.zcode === true && config.upstreamOnly !== true;
}

export function validateZcodeConfig(config: GatewayConfig): void {
  if (config.zcode !== undefined && typeof config.zcode !== "boolean") throw new Error("zcode 必须为 boolean");
  if (!zcodeEnabled(config)) return;
  const host = config.host;
  if (!(host === "localhost" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127.")))) {
    throw new Error("启用 ZCode 时网关只能监听环回地址");
  }
  if (config.prefix && ("zcode/".startsWith(config.prefix) || config.prefix.startsWith("zcode/")
    || config.prefix.startsWith("zcode-"))) {
    throw new Error("启用 ZCode 时 zcode/ 与 zcode- 前缀保留给 ZCode，请调整第三方 prefix");
  }
}

export function zcodeError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, message } }, { status });
}

export function createZcodeAdapter(config: GatewayConfig, dependencies: ZcodeDependencies = {}) {
  validateZcodeConfig(config);
  const enabled = zcodeEnabled(config);
  // 厂商全量目录只依赖构建期静态数据与可选覆盖规则，先建好再挂 watch 回调。
  const vendorCatalog = enabled
    ? buildZcodeVendorCatalog(path.join(path.dirname(config.catalogPath), "models.json"))
    : undefined;
  /** 套餐或选择变化时立即撤下 Codex 缓存里的旧 ZCode 条目，避免旧套餐模型继续可选。 */
  const dropCachedZcodeModels = () => {
    if (dependencies.codexModelsCacheFile) {
      clearModelsCacheEntries(dependencies.codexModelsCacheFile, isZcodeModel);
    }
  };
  const servedCatalogFile = path.join(path.dirname(config.catalogPath), "zcode-catalog.json");
  /** 当前对外目录（各套餐作用域前缀的并集）。watch 或启动时重建，/v1/models 只读取这里。 */
  let servedCatalog: ModelCatalog = { models: [] };
  /** 已发布目录对应的各套餐快照；仅在身份变化时才重算，避免每次 /v1/models 重新求交集。 */
  let publishedSnapshots: (ZcodeProviderSnapshot | undefined)[] | undefined;
  /** 收敛 Codex 缓存：撤下已不在当前对外目录里的 ZCode 条目；返回是否发生了删除。 */
  const pruneCodexCache = (catalog: ModelCatalog): boolean => {
    if (!dependencies.codexModelsCacheFile) return false;
    const current = new Set(catalog.models.map((model) => model.slug.toLowerCase()));
    return clearModelsCacheEntries(
      dependencies.codexModelsCacheFile,
      (slug) => isZcodeModel(slug) && !current.has(slug.toLowerCase()),
    );
  };
  const publishServedCatalog = (catalog: ModelCatalog) => {
    servedCatalog = catalog;
    const changed = writeZcodeServedCatalog(servedCatalogFile, catalog);
    if (!changed || !dependencies.codexModelsCacheFile) return;
    // 目录变化：既撤下已下线条目，也过期新鲜度让 Codex 主动重拉一次。
    pruneCodexCache(catalog);
    invalidateModelsCache(dependencies.codexModelsCacheFile);
  };
  /**
   * 会话级套餐路由：模型 slug 的套餐段（zcode-<kind>/）或 API provider 段
   * （zcode-<providerId>/）决定快照、目录与凭据来自哪条路由；每条路由一个
   * 独立配置缓存，key 的解析与上游调用本身不变。
   * start-plan 暂不暴露：zcode-plan 中继在鉴权之外还要求阿里云 captcha（code 3007），
   * 网关无法 headless 通过，暴露了也无法调用（见 docs/exec-plans/tech-debt-tracker.md）。
   */
  type ZcodeRoute = {
    plan: ZcodeSelection["kind"];
    apiProviderID?: string;
    cache?: ZcodeConfigCache;
    snapshot?: ZcodeProviderSnapshot;
  };
  const planRoutes: ZcodeRoute[] = [
    { plan: "individual-coding-plan" },
    { plan: "team-coding-plan" },
  ];
  let synchronizeAPIKeyRoutes: () => void = () => {};
  const republishFromPlans = () => {
    if (!vendorCatalog) return;
    const current = planRoutes.map((route) => route.snapshot);
    const previous = publishedSnapshots;
    if (previous && current.length === previous.length
      && current.every((snapshot, index) => snapshot === previous[index])) return;
    publishedSnapshots = current;
    // 各可用套餐目录的并集：单套餐失效只撤下自己的条目，其余套餐继续可选。
    const models: ModelCatalog["models"] = [];
    const seen = new Set<string>();
    for (const route of planRoutes) {
      if (!route.snapshot) continue;
      for (const entry of createZcodeCatalog(route.snapshot, vendorCatalog).models) {
        const slug = entry.slug.toLowerCase();
        if (seen.has(slug)) continue;
        seen.add(slug);
        models.push(entry);
      }
    }
    publishServedCatalog({ models });
  };
  if (enabled) {
    const home = dependencies.zcodeHome ?? path.join(os.homedir(), ".zcode");
    // 注入模式（测试）只为显式给出的套餐建缓存，避免读到真实的 ~/.zcode。
    const injected: Partial<Record<ZcodeSelection["kind"], ZcodeConfigCache>> | undefined = dependencies.planCaches
      ?? (dependencies.apiKeyCaches ? {} : dependencies.configCache ? { "api-key": dependencies.configCache } : undefined);
    for (const route of planRoutes) {
      route.cache = injected?.[route.plan]
        ?? (injected ? undefined : createZcodeConfigCache(home, {
          plan: route.plan,
          // 选择变化只撤下本套餐的快照并重发并集；另一个套餐的条目不受影响。
          onSelectionChange: () => {
            route.snapshot = undefined;
            republishFromPlans();
          },
          onSnapshotChange: (snapshot) => {
            route.snapshot = snapshot;
            republishFromPlans();
          },
        }));
    }
    if (injected) {
      const apiCaches = dependencies.apiKeyCaches
        ?? (dependencies.planCaches?.["api-key"] || dependencies.configCache
          ? { current: dependencies.planCaches?.["api-key"] ?? dependencies.configCache! }
          : {});
      for (const [apiProviderID, cache] of Object.entries(apiCaches)) {
        planRoutes.push({ plan: "api-key", ...(apiProviderID === "current" ? {} : { apiProviderID }), cache });
      }
    } else {
      const createAPIRoute = (provider: ZcodeAPIKeyProvider): ZcodeRoute => {
        const route: ZcodeRoute = { plan: "api-key", apiProviderID: provider.providerID };
        route.cache = createZcodeConfigCache(home, {
          plan: "api-key",
          apiProviderID: provider.providerID,
          onSelectionChange: () => {
            route.snapshot = undefined;
            republishFromPlans();
          },
          onSnapshotChange: (snapshot) => {
            route.snapshot = snapshot;
            republishFromPlans();
          },
        });
        return route;
      };
      const synchronize = (republish = true): void => {
        let providers: ZcodeAPIKeyProvider[] = [];
        try { providers = readZcodeAPIKeyProviders(home); }
        catch { /* 目录撤下无效 API Key；套餐路由不受影响。 */ }
        const targetIDs = new Set(providers.map((provider) => provider.providerID));
        let changed = false;
        const removed = planRoutes.filter((route) => route.plan === "api-key" && route.apiProviderID && !targetIDs.has(route.apiProviderID));
        for (const route of removed) route.cache?.close();
        if (removed.length) {
          for (let index = planRoutes.length - 1; index >= 0; index--) {
            if (removed.includes(planRoutes[index]!)) planRoutes.splice(index, 1);
          }
          changed = true;
        }
        for (const provider of providers) {
          if (planRoutes.some((route) => route.plan === "api-key" && route.apiProviderID === provider.providerID)) continue;
          planRoutes.push(createAPIRoute(provider));
          changed = true;
        }
        if (changed && republish) republishFromPlans();
      };
      synchronizeAPIKeyRoutes = () => synchronize(true);
      synchronize(false);
      // /models 与未知 API 前缀请求都会重新同步，支持新增/删除 provider；现有
      // provider 的 Key 与模型变化由各自 cache 的 provider_config watcher 驱动。
    }
  }
  const fetchUpstream = dependencies.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const activeRequests = new Set<AbortController>();
  const identity = enabled ? dependencies.identity ?? readZcodeIdentity() : undefined;
  const endpointRouting = enabled && dependencies.endpointRouting !== null
    ? dependencies.endpointRouting ?? new ZcodeEndpointRouting({
      identity: identity!,
      fetch: (url, init) => fetchUpstream(url, init),
    })
    : undefined;
  const contexts = createZcodeContexts();
  const sink: RequestLogSink | undefined = config.requestLogging === true ? {
    dir: config.logDir || path.join(path.dirname(config.catalogPath), "logs"),
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
    processLog: dependencies.processLog,
  } : undefined;
  let closed = false;
  /** 启动首读：为每个套餐路由建立快照并写盘，随后完全由 watch 事件驱动。 */
  if (enabled && vendorCatalog) {
    void Promise.allSettled(planRoutes.map(async (route) => {
      if (route.cache) route.snapshot = await route.cache.get();
    })).then(() => {
      if (closed) return;
      // 所有套餐都失败且从未发布过目录：撤下上一次运行留在 Codex 缓存里的条目。
      if (publishedSnapshots === undefined && !planRoutes.some((route) => route.snapshot)) dropCachedZcodeModels();
      republishFromPlans();
    });
  }

  return {
    async catalog(): Promise<ModelCatalog> {
      synchronizeAPIKeyRoutes();
      if (closed || planRoutes.every((route) => !route.cache)) return { models: [] };
      const neverPublished = publishedSnapshots === undefined;
      // watch 是主驱动；注入的自定义缓存没有回调，这里按快照身份做一次廉价兜底。
      await Promise.all(planRoutes.map(async (route) => {
        if (!route.cache) return;
        try { route.snapshot = await route.cache.get(); }
        catch { route.snapshot = undefined; }
      }));
      // 所有套餐都失效且从未发布过目录时，撤下 Codex 缓存里的遗留 ZCode 条目。
      if (neverPublished && !planRoutes.some((route) => route.snapshot)) dropCachedZcodeModels();
      republishFromPlans();
      return servedCatalog;
    },
    async forward(request: Request, input: Record<string, unknown>, mapResult?: (payload: Record<string, unknown>) => Response): Promise<Response> {
      const start = Date.now();
      const requestTime = localTime();
      const incoming = new URL(request.url);
      const group = logGroupFromPath(incoming.pathname);
      const zcode = isZcodeModel(input.model);
      // 渠道（zai/bigmodel）只在转发时按当前套餐快照判定，用于鉴权与日志分流；模型 ID 不携带渠道。
      let family: ZcodeFamily | undefined;
      let key = "";
      let upstreamUrl: string | undefined;
      let upstreamRequestHeaders: Headers | undefined;
      let upstreamRequestBody: unknown;
      let logged = false;
      const redact = (text: string) => {
        if (!key) return text;
        // 错误正文可能以任意 JSON 转义形式回显 key（\/、\uXXXX 及多层反斜杠嵌套）：
        // 固定枚举变体漏掉转义形式时，客户端反序列化 JSON 即可还原完整密钥。逐字符
        // 生成四种互斥形式（裸字符、反斜杠+字符、反斜杠+u 十六进制两种大小写），
        // 保证每个字符位置的匹配分解唯一，避免灾难性回溯。
        const pattern = [...key].map((char) => {
          const escaped = char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
          const hex = char.codePointAt(0)!.toString(16).padStart(4, "0");
          return `(?:${escaped}|\\\\{1,4}${escaped}|\\\\{1,4}u${hex}|\\\\{1,4}u${hex.toUpperCase()})`;
        }).join("");
        let result = text.replace(new RegExp(pattern, "gu"), "***");
        let variant = key;
        // 错误正文可能把请求又序列化成 JSON 字符串，连同转义形式一起遮蔽。
        for (let depth = 0; depth < 4; depth++) {
          result = result.replaceAll(variant, "***");
          variant = JSON.stringify(variant).slice(1, -1);
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
        if (logged || !zcode || !family) return;
        logged = true;
        const durationMs = Date.now() - start;
        const at = incoming.pathname + incoming.search;
        logExchange(sink, group, {
          requestTime, method: request.method, url: at,
          reqHeaders: request.headers, reqBody: redactValue(input),
          status, resHeaders: headers, resBody: redact(body), upstreamUrl, upstreamRequestHeaders, upstreamRequestBody, durationMs,
        }, family);
        // 与网关主链一样，进程日志里每条请求恰好一行：逻辑错误也算错误，走错误摘要。
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
        const response = zcodeError(status, redact(message), type);
        log(status, JSON.stringify({ error: { type, message: redact(message) } }), response.headers);
        return response;
      };
      if (closed || planRoutes.every((route) => !route.cache)) return fail(503, "ZCode 未启用或网关已关闭", "configuration_error");
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
        // 会话级套餐选择：模型 slug 的套餐段决定走哪条路由；key 的解析与上游调用链路不变。
        const requested = typeof input.model === "string" ? input.model : "";
        const requestedPlan = zcodeModelPlan(requested);
        if (requestedPlan === "api-key") synchronizeAPIKeyRoutes();
        const requestedProviderID = requestedPlan === "api-key" ? zcodeAPIProviderIDFromModel(requested) : undefined;
        const route = planRoutes.find((entry) => {
          if (entry.plan !== requestedPlan) return false;
          if (requestedPlan !== "api-key") return true;
          if (!requestedProviderID) return !entry.apiProviderID || planRoutes.find(
            (candidate) => candidate.plan === "api-key" && candidate.apiProviderID,
          ) === entry;
          if (entry.apiProviderID === requestedProviderID) return true;
          // 注入模式只有一个 legacy api-key 缓存时先命中，再由 zcodeUpstreamModel
          // 按快照 providerID 精确拒绝不匹配的请求。
          return !entry.apiProviderID;
        });
        if (!route?.cache) { cleanup(); return fail(404, "此模型不属于 ZCode 当前套餐或厂商目录"); }
        const snapshot = await route.cache.get();
        key = snapshot.apiKey;
        family = snapshot.family;
        abort.signal.throwIfAborted();
        const model = zcodeUpstreamModel(requested, snapshot);
        if (!model) { cleanup(); return fail(404, "此模型不属于 ZCode 当前套餐或厂商目录"); }
        const translated = translateZcodeRequest(input, model);
        const baseUpstreamUrl = `${snapshot.baseURL}${snapshot.baseURL.endsWith("/v1") ? "/messages" : "/v1/messages"}`;
        const routedUrl = endpointRouting
          // 跟随 z.ai 服务端下发的端点映射（如 zcode.z.ai ultra 中转）；resolve 内部 fail-open，失败保持原 URL。
          ? (await endpointRouting.resolve(baseUpstreamUrl, key)).url
          : baseUpstreamUrl;
        upstreamUrl = routedUrl;
        // 从当前快照重建协议头与会话归因，不采信入站客户端的 ZCode 身份或授权头。
        const context = contexts.resolve(request, snapshot);
        const headers = buildZcodeModelHeaders(identity!, context, zcodePlan(snapshot), key);
        const beta = request.headers.get("anthropic-beta")?.trim();
        if (beta && beta.length <= 1024 && /^[\x20-\x7e]+$/.test(beta)) headers.set("anthropic-beta", beta);
        upstreamRequestHeaders = headers;
        const body = decorateZcodeBody(translated.body, context);
        // 图片识别适配：请求含图片时把被吸收的 analyze_image 调用落到网关执行并续跑上游。
        let gatewayTools: ZcodeGatewayToolsHook | undefined;
        let continuationLegs = 0;
        if (translated.vision) {
          gatewayTools = {
            maxContinuations: 3,
            execute: async (call) => {
              abort.signal.throwIfAborted();
              const prompt = typeof call.input.prompt === "string" && call.input.prompt
                ? call.input.prompt
                : "请详细识别并提取这张图片中的所有内容。";
              const image = matchZcodeAnalyzeImage(call.input.imageSource, translated.images);
              if (!image) return "analyze_image 无法定位请求中的图片（imageSource 缺少有效引用）。请向用户说明或改用其他方式。";
              try {
                return await executeZcodeAnalyzeImage({
                  url: routedUrl,
                  model,
                  image,
                  prompt,
                  headers: () => buildZcodeModelHeaders(identity!, context, zcodePlan(snapshot), key),
                  fetchImpl: fetchUpstream,
                  signal: abort.signal,
                  // 错误正文脱敏必须在截断之前发生（见 ZcodeExecutorOptions.redact）。
                  redact,
                });
              } catch (error) {
                if (abort.signal.aborted) throw error;
                // 降级旁白会把异常消息直接发给客户端（响应仍为 completed，失败事件的
                // sanitizeError 覆盖不到）：先按同一规则抹掉上游错误正文可能回显的 key。
                throw new Error(redact(error instanceof Error ? error.message : String(error)));
              }
            },
            nextUpstream: async (calls) => {
              abort.signal.throwIfAborted();
              // 把被吸收的调用与执行结果回放为上游 tool_use/tool_result 消息对。
              const toolUses = calls.map(({ call }) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input }));
              const toolResults = calls.map(({ call, result }) => ({
                type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: result }],
              }));
              (body.messages as unknown[]).push({ role: "assistant", content: toolUses }, { role: "user", content: toolResults });
              continuationLegs++;
              const response = await fetchUpstream(routedUrl, {
                method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: abort.signal,
              });
              if (!response.ok) {
                // 与执行信封同规则：先对完整正文脱敏、后截断，避免跨边界 key 前缀泄漏。
                const text = redact(await response.text().catch(() => ""));
                throw new Error(`续跑上游返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ""}`);
              }
              return response;
            },
          };
        }
        // 记录转换后真正发往上游的正文；未开启请求日志时不付出遍历脱敏的开销。
        upstreamRequestBody = sink ? redactValue(body) : undefined;
        const upstream = await fetchUpstream(upstreamUrl, {
          method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: abort.signal,
        });
        if (!upstream.ok) {
          const text = redact(await upstream.text());
          cleanup();
          let message = text || `ZCode 上游返回 HTTP ${upstream.status}`;
          try {
            const error: unknown = redactValue(JSON.parse(text));
            if (isZcodeRecord(error) && isZcodeRecord(error.error) && typeof error.error.message === "string") message = error.error.message;
            else message = JSON.stringify(error);
          } catch { /* 非 JSON 上游错误保留脱敏正文。 */ }
          return fail(upstream.status, message, "upstream_error");
        }
        let chunks = "";
        const stream = !mapResult && input.stream === true;
        const response = await createZcodeResponse(upstream, {
          model: String(input.model), tools: translated.tools, stream, signal: abort.signal,
          gatewayTools,
          sanitizeError: (error) => ({
            code: typeof error.code === "string" ? redact(error.code) : "upstream_error",
            message: typeof error.message === "string" ? redact(error.message) : "ZCode 上游响应失败",
          }),
          abort: () => { abort.abort(); cleanup(); },
          onChunk: (chunk) => { if (sink) chunks += chunk; },
          onComplete: (payload) => {
            cleanup();
            // 剥离的内置工具与图片识别续跑腿数写进交换日志，避免“静默降级”无从排查。
            const stripped = translated.dropped.length ? `\n--- stripped built-in tools: ${translated.dropped.join(", ")} ---` : "";
            const visionLegs = continuationLegs > 0 ? `\n--- analyze_image continuation legs: ${continuationLegs} ---` : "";
            if (!mapResult) log(stream ? 200 : payload.status === "failed" ? 502 : 200,
              stream ? `${chunks}${stripped}${visionLegs}\n--- response.${payload.status} ---\n${JSON.stringify(redactValue(payload))}` : `${JSON.stringify(redactValue(payload))}${stripped}${visionLegs}`,
              new Headers({ "content-type": stream ? "text/event-stream" : "application/json" }),
              payload.status === "failed" ? JSON.stringify(payload.error ?? "响应失败") : undefined);
          },
        });
        if (!mapResult) return response;
        const payload: unknown = await response.json();
        if (!response.ok || !isZcodeRecord(payload)) {
          cleanup();
          return fail(502, "ZCode 上游未完成上下文压缩", "invalid_response_error");
        }
        const mapped = mapResult(payload);
        log(mapped.status, await mapped.clone().text(), mapped.headers);
        cleanup();
        return mapped;
      } catch (error) {
        abort.abort();
        cleanup();
        if (error instanceof ZcodeRequestError) return fail(400, error.message);
        if (error instanceof ZcodeConfigError) return fail(503, error.message, "configuration_error");
        if (request.signal.aborted) return fail(499, "ZCode 请求已取消", "request_cancelled");
        return fail(502, "ZCode 上游请求失败", "upstream_error");
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const route of planRoutes) route.cache?.close();
      contexts.close();
      for (const request of activeRequests) request.abort();
      activeRequests.clear();
    },
  };
}
