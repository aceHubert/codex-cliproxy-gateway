import fs from "node:fs";
import path from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { readApiKey } from "./keychain.ts";
import {
  dialUpstreamWebSocket,
  forwardedHeaders,
  isRealtimeCallRequest,
  proxyRealtimeCall,
  realtimeAccessError,
  realtimeWebSocketHandler,
  realtimeWebSocketTarget,
  websocketUrl,
} from "./realtime.ts";
import type { RealtimeProviderMode, RealtimeSocketData } from "./realtime.ts";
import { normalizeCatalog } from "./catalog.ts";
import {
  logExchange,
  logGatewayError,
  logGroupFromPath,
  logRealtimeEvent,
  websocketLogFile,
  localTime,
  maskedHeaders,
} from "./request-log.ts";
import type { RequestLogSink } from "./request-log.ts";
import { atomicWrite } from "./toml.ts";
import type { GatewayConfig, ModelCatalog } from "./types.ts";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const COMPACTION_PREFIX = "ocx1:";
const COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work.\nHere is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
const OPAQUE_COMPACTION_NOTE = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";
const COMPACT_V1_RETAINED_CHAR_BUDGET = 80_000;

type Route =
  | { kind: "cliproxy"; upstreamModel: string }
  | { kind: "official"; upstreamModel: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGptModel(model: string): boolean {
  return model.toLowerCase().startsWith("gpt-");
}

function uuid(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function encodeCompactionSummary(summary: string): string {
  return COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

function decodeCompactionSummary(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return null;
  const encoded = value.slice(COMPACTION_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return Buffer.from(encoded, "base64").toString("utf8");
}

function compactionMessage(item: Record<string, unknown>): Record<string, unknown> {
  const decoded = decodeCompactionSummary(item.encrypted_content);
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: decoded?.trim()
        ? `${SUMMARY_PREFIX}\n\n${decoded}`
        : OPAQUE_COMPACTION_NOTE,
    }],
  };
}

function rewriteCompactionHistory(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) => isRecord(item) && item.type === "compaction" ? compactionMessage(item) : item);
}

function stripInputImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInputImages);
  if (!isRecord(value)) return value;
  if (value.type === "input_image") {
    return { type: "input_text", text: "[image omitted for compaction]" };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stripInputImages(entry)]));
}

function hasCompactionTrigger(input: unknown): boolean {
  return Array.isArray(input) && input.some((item) => isRecord(item) && item.type === "compaction_trigger");
}

function buildCompactionRequest(
  body: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const {
    tools: _tools,
    tool_choice: _toolChoice,
    parallel_tool_calls: _parallelToolCalls,
    additional_tools: _additionalTools,
    stream_options: _streamOptions,
    text: _text,
    ...rest
  } = body;
  const input = Array.isArray(body.input)
    ? body.input.filter((item) => !isRecord(item)
      || (item.type !== "compaction_trigger" && item.type !== "additional_tools"))
    : [];
  return {
    ...rest,
    model: upstreamModel,
    stream: false,
    input: [
      ...stripInputImages(rewriteCompactionHistory(input)) as unknown[],
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: COMPACTION_PROMPT }],
      },
    ],
  };
}

function responseText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.output)) return "";
  return payload.output
    .filter((item) => isRecord(item) && item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content as unknown[])
    .flatMap((part) => isRecord(part) && part.type === "output_text" && typeof part.text === "string"
      ? [part.text]
      : [])
    .join("")
    .trim();
}

function compactUserMessages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!isRecord(item) || (item.type !== undefined && item.type !== "message") || item.role !== "user") return [];
    if (typeof item.content === "string") {
      return item.content.trim() && !item.content.startsWith(SUMMARY_PREFIX) ? [item.content] : [];
    }
    if (!Array.isArray(item.content)) return [];
    const text = item.content
      .filter((part) => isRecord(part)
        && (part.type === "input_text" || part.type === "text")
        && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    return text.trim() && !text.startsWith(SUMMARY_PREFIX) ? [text] : [];
  });
}

function compactV1Output(input: unknown, summary: string): Record<string, unknown>[] {
  const selected: string[] = [];
  let remaining = COMPACT_V1_RETAINED_CHAR_BUDGET;
  const messages = compactUserMessages(input);
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const message = messages[index];
    selected.push(message.length <= remaining ? message : message.slice(-remaining));
    remaining -= Math.min(message.length, remaining);
  }
  selected.reverse();
  return [...selected, `${SUMMARY_PREFIX}\n${summary}`].map((text) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }));
}

function syntheticCompactionResponse(
  payload: Record<string, unknown>,
  upstreamModel: string,
  summary: string,
  stream: boolean,
): Response {
  const item = {
    type: "compaction",
    id: `cmp_${uuid()}`,
    encrypted_content: encodeCompactionSummary(summary),
  };
  const response = {
    id: typeof payload.id === "string" ? payload.id : `resp_${uuid()}`,
    object: "response",
    created_at: typeof payload.created_at === "number" ? payload.created_at : Math.floor(Date.now() / 1000),
    status: "completed",
    model: upstreamModel,
    output: [item],
    usage: payload.usage ?? null,
  };
  if (!stream) return Response.json(response);

  const created = { ...response, status: "in_progress", output: [], usage: null };
  const frames = [
    ["response.created", { type: "response.created", sequence_number: 0, response: created }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 1,
      output_index: 0,
      item,
    }],
    ["response.completed", { type: "response.completed", sequence_number: 2, response }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(`${frames}data: [DONE]\n\n`, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

function compactionError(message: string): Response {
  return Response.json({ error: { type: "invalid_response_error", message } }, { status: 502 });
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** 未开启 requestLogging 时返回 undefined，日志函数据此整体短路。 */
function resolveLogSink(config: GatewayConfig): RequestLogSink | undefined {
  if (config.requestLogging !== true) return undefined;
  return {
    dir: config.logDir || path.join(path.dirname(config.catalogPath), "logs"),
    maxLogs: Math.max(0, Math.trunc(config.maxRequestLogs ?? 0)),
  };
}

/** 错误响应体形态不统一：{error:{message}}、{error:"..."}、{detail:"..."} 或纯文本都出现过。 */
function errorMessageFromBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === "string") return error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (typeof parsed.detail === "string") return parsed.detail;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // 非 JSON 响应体直接按原文记录。
  }
  return body.trim() || "(empty response body)";
}

export function joinUpstreamUrl(baseUrl: string, incomingUrl: string, mountPath = "/v1"): string {
  const incoming = new URL(incomingUrl);
  let relativePath = incoming.pathname;
  if (relativePath === mountPath) relativePath = "";
  else if (relativePath.startsWith(`${mountPath}/`)) relativePath = relativePath.slice(mountPath.length);
  return `${normalizeBaseUrl(baseUrl)}${relativePath}${incoming.search}`;
}

export function decideRoute(model: unknown, prefix = "cliproxy/"): Route {
  if (typeof model === "string" && model.startsWith(prefix)) {
    const upstreamModel = model.slice(prefix.length);
    if (!upstreamModel) throw new Error(`Model prefix ${prefix} must be followed by a model ID`);
    return { kind: "cliproxy", upstreamModel };
  }
  return { kind: "official", upstreamModel: model };
}

function copyRequestHeaders(request: Request, route: Route, apiKey: string): Headers {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.delete("accept-encoding");
  if (route.kind === "cliproxy") {
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("x-goog-api-key");
    headers.delete("content-encoding");
    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

function copyResponseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.delete("content-encoding");
  return headers;
}

function isReservedOfficialRealtimePath(pathname: string, mountPath: string): boolean {  const livePath = `${mountPath}/live`;
  const realtimePath = `${mountPath}/realtime`;
  const realtimeCallsPath = `${realtimePath}/calls`;
  return pathname === livePath
    || pathname.startsWith(`${livePath}/`)
    || pathname === realtimePath
    || pathname === realtimeCallsPath
    || pathname.startsWith(`${realtimeCallsPath}/`);
}

function officialRealtimeNotImplementedResponse(): Response {
  return Response.json({
    error: {
      type: "unsupported_transport_error",
      code: "official_realtime_proxy_not_implemented",
      message: "Official Realtime /live proxying is not implemented yet.",
    },
  }, {
    status: 426,
    headers: { "x-codex-cliproxy-gateway": "official-realtime-not-implemented" },
  });
}

/** 426 语义是"协商失败，请改用 HTTPS/SSE"——客户端会自动降级重试，不计入错误摘要。 */
function websocketNotSupportedResponse(marker = "websocket-not-supported"): Response {
  return new Response("WebSocket transport is not supported; retry with HTTPS/SSE.", {
    status: 426,
    headers: {
      connection: "close",
      "x-codex-cliproxy-gateway": marker,
    },
  });
}

/** Codex 在 x-codex-routing-hint 里给出完整模型名（含 cliproxy/ 前缀），GET 请求也带。 */
function modelFromRoutingHint(request: Request): string | undefined {
  return request.headers.get("x-codex-routing-hint")
    ?.match(/(?:^|[;,\s])model=([^;,\s]+)/)?.[1] || undefined;
}

/**
 * Responses over WebSocket 的转发目标：Codex 试探（GET + upgrade）带 x-codex-routing-hint，
 * 据此选上游；realtime 保留路径与关闭开关时返回 null（维持原有 426 行为）。
 */
export function responsesWebSocketTarget(
  request: Request,
  config: GatewayConfig,
  apiKey?: string,
): { url: string; headers: Record<string, string>; routeKind: "cliproxy" | "official" } | null {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
  const mountPath = config.mountPath || "/v1";
  if (isReservedOfficialRealtimePath(new URL(request.url).pathname, mountPath)) return null;
  const prefix = config.prefix || "cliproxy/";
  const route = decideRoute(modelFromRoutingHint(request), prefix);
  // 官方模型无条件放行；CLIProxy 侧另有前缀剥离与拨号稳定性问题，默认不放行，由 websocket 显式开启。
  if (route.kind === "cliproxy" && config.websocket !== true) return null;
  const baseUrl = route.kind === "cliproxy" ? config.cliproxyBaseUrl : config.officialBaseUrl;
  const url = websocketUrl(new URL(joinUpstreamUrl(baseUrl, request.url, mountPath))).href;
  const headers = forwardedHeaders(request.headers, false);
  if (route.kind === "cliproxy") {
    // 与 HTTP 路径的 copyRequestHeaders 对齐：剥官方 OAuth，注入 CLIProxy key。
    delete headers.authorization;
    delete headers["chatgpt-account-id"];
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  }
  return { url, headers, routeKind: route.kind };
}

async function readBodyBytes(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  return request.arrayBuffer();
}

/**
 * 解压并解析请求体。仅在确实需要 payload 时调用——拿得到 routing hint 且路由是 official 时，
 * 请求原样透传，没必要为了判路由而解压几十 KB，也就不会因解码失败误拒一个本可透传的请求。
 */
function decodeJsonBody(
  bytes: ArrayBuffer | undefined,
  headers: Headers,
): Record<string, unknown> | undefined {
  if (!bytes || bytes.byteLength === 0) return undefined;
  const encoding = headers.get("content-encoding")?.toLowerCase().trim();
  const compressed = Buffer.from(bytes);
  const decoded = !encoding || encoding === "identity"
    ? compressed
    : encoding === "zstd"
      ? zstdDecompressSync(compressed)
      : encoding === "gzip"
      ? gunzipSync(compressed)
      : encoding === "deflate"
        ? inflateSync(compressed)
        : encoding === "br"
          ? brotliDecompressSync(compressed)
          : (() => { throw new Error(`Unsupported content encoding: ${encoding}`); })();
  const text = new TextDecoder().decode(decoded);
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    if (headers.get("content-type")?.includes("application/json")) {
      throw new Error("Invalid JSON request body");
    }
    return undefined;
  }
}

function validCatalog(value: unknown, requireNonEmpty = true): ModelCatalog {
  const catalog = normalizeCatalog(value);
  if ((requireNonEmpty && catalog.models.length === 0)
    || !catalog.models.every((model) => model && typeof model.slug === "string" && model.slug)) {
    throw new Error(`catalog does not contain a valid${requireNonEmpty ? " non-empty" : ""} models array`);
  }
  return catalog;
}

function readCatalog(file: string, requireNonEmpty = true): ModelCatalog {
  return validCatalog(JSON.parse(fs.readFileSync(file, "utf8")), requireNonEmpty);
}

function mergeDynamicCatalog(native: ModelCatalog, config: GatewayConfig): ModelCatalog {
  let proxyModels: ModelCatalog["models"] = [];
  if (fs.existsSync(config.catalogPath)) {
    proxyModels = readCatalog(config.catalogPath, false).models.filter((model) => model.slug.startsWith(config.prefix));
  }
  const nativeModels = native.models.filter((model) => !model.slug.startsWith(config.prefix));
  const highestPriority = Math.max(0, ...nativeModels.map((model) => Number(model.priority) || 0));
  return { models: [
    ...nativeModels,
    ...proxyModels.map((model, index) => ({ ...model, priority: highestPriority + 100 + index })),
  ] };
}

async function catalogModelsResponse(
  request: Request,
  config: GatewayConfig,
  cacheFile: string,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const clientVersion = incomingUrl.searchParams.get("client_version");
  // ponytail: 当前只保留一份 last-good；需要同时服务多个账号或版本时再按二者分片。
  let native: ModelCatalog | undefined;
  let refreshError: unknown;

  if (clientVersion) {
    try {
      const headers = copyRequestHeaders(request, { kind: "official", upstreamModel: undefined }, "");
      headers.delete("if-none-match");
      headers.delete("if-modified-since");
      const response = await fetch(joinUpstreamUrl(config.officialBaseUrl, request.url, config.mountPath), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: request.signal,
      });
      if (!response.ok) throw new Error(`official /models returned HTTP ${response.status}`);
      native = validCatalog(await response.json());
      atomicWrite(cacheFile, `${JSON.stringify({
        fetched_at: new Date().toISOString(),
        client_version: clientVersion,
        models: native.models,
      }, null, 2)}\n`);
    } catch (error) {
      refreshError = error;
    }
  }

  try {
    native ||= readCatalog(cacheFile);
    const catalog = mergeDynamicCatalog(native, config);
    if (clientVersion) return Response.json(catalog);
    return Response.json({
      object: "list",
      data: catalog.models.map((model) => ({
        id: model.slug,
        object: "model",
        owned_by: model.slug.startsWith(config.prefix) ? "cliproxy" : "openai",
      })),
    });
  } catch (error) {
    const detail = refreshError ?? error;
    return Response.json(
      { error: { message: `Unable to load model catalog: ${detail instanceof Error ? detail.message : String(detail)}` } },
      { status: 502 },
    );
  }
}

export function createGatewayHandler(
  config: GatewayConfig,
  apiKey = readApiKey(),
  realtimeProviderMode: RealtimeProviderMode = "invalid",
  upstreamModelsCacheFile = path.join(path.dirname(config.catalogPath), "models-cache.json"),
): (request: Request) => Promise<Response> {
  const mountPath = config.mountPath || "/v1";
  const prefix = config.prefix || "cliproxy/";
  const logging = config.requestLogging === true;
  const sink = resolveLogSink(config);

  const handleCore = async (request: Request): Promise<Response> => {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname === "/healthz") {
      return Response.json({ ok: true, prefix, port: config.port });
    }

    if (incomingUrl.pathname === `${mountPath}/models` && request.method === "GET") {
      return catalogModelsResponse(request, config, upstreamModelsCacheFile);
    }

    if (isRealtimeCallRequest(request, config)) {
      return proxyRealtimeCall(request, config, realtimeProviderMode, sink);
    }

    // Reserved for the HTTP call-create adapter and bidirectional WebSocket bridge.
    // A normal fetch passthrough cannot proxy these Realtime transports safely.
    if (isReservedOfficialRealtimePath(incomingUrl.pathname, mountPath)) {
      return officialRealtimeNotImplementedResponse();
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // startGateway 拦截不到时（无 server 的调用场景）的防御兜底；生产路径在 fetch 内已转发。
      return websocketNotSupportedResponse();
    }

    // routing hint 能直接定路由；只有拿不到 hint、或路由是 cliproxy（需改写 body）才解码。
    const hinted = modelFromRoutingHint(request);
    let route = hinted === undefined ? undefined : decideRoute(hinted, prefix);
    let bytes: ArrayBuffer | undefined;
    let json: Record<string, unknown> | undefined;
    try {
      bytes = await readBodyBytes(request);
      if (route === undefined || route.kind === "cliproxy") {
        json = decodeJsonBody(bytes, request.headers);
        route ??= decideRoute(json?.model, prefix);
      }
    } catch (error) {
      return Response.json(
        { error: { message: error instanceof Error ? error.message : String(error) } },
        { status: 400 },
      );
    }
    const upstreamBase = route.kind === "cliproxy" ? config.cliproxyBaseUrl : config.officialBaseUrl;
    let upstreamUrl = joinUpstreamUrl(upstreamBase, request.url, mountPath);
    const headers = copyRequestHeaders(request, route, apiKey);

    let body: ArrayBuffer | string | undefined = bytes;
    if (route.kind === "cliproxy" && json && typeof json === "object") {
      json.model = route.upstreamModel;
      if (!isGptModel(route.upstreamModel) && !hasCompactionTrigger(json.input)) {
        json.input = rewriteCompactionHistory(json.input);
      }
      body = JSON.stringify(json);
      headers.set("content-type", "application/json");
    }

    try {
      const isCompactV1 = incomingUrl.pathname === `${mountPath}/responses/compact`;
      const isCompactV2 = hasCompactionTrigger(json?.input);
      if (route.kind === "cliproxy" && !isGptModel(route.upstreamModel) && json && (isCompactV1 || isCompactV2)) {
        upstreamUrl = `${normalizeBaseUrl(config.cliproxyBaseUrl)}/responses`;
        headers.set("accept", "application/json");
        const upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(buildCompactionRequest(json, route.upstreamModel)),
          redirect: "manual",
          signal: request.signal,
        });
        if (!upstream.ok) {
          return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: copyResponseHeaders(upstream),
          });
        }

        let payload: unknown;
        try {
          payload = await upstream.json();
        } catch {
          return compactionError("Upstream compaction returned invalid JSON");
        }
        if (!isRecord(payload) || payload.error || payload.status !== "completed") {
          return compactionError(`Upstream compaction did not complete (status: ${String(isRecord(payload) ? payload.status ?? "unknown" : "unknown")})`);
        }
        const summary = responseText(payload);
        if (!summary) return compactionError("Upstream compaction returned no summary text");
        if (isCompactV1) return Response.json({ output: compactV1Output(json.input, summary) });
        return syntheticCompactionResponse(payload, route.upstreamModel, summary, json.stream === true);
      }

      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: request.signal,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: copyResponseHeaders(upstream),
      });
    } catch (error) {
      return Response.json(
        {
          error: {
            message: "Gateway upstream request failed",
            route: route.kind,
            detail: error instanceof Error ? error.message : String(error),
          },
        },
        { status: 502 },
      );
    }
  };

  if (!logging) return handleCore;

  return async (request: Request): Promise<Response> => {
    const requestTime = localTime();
    const startedAt = Date.now();
    const incoming = new URL(request.url);
    // catalog 与健康检查不转发上游，且 healthz 会被 launchd 高频探活，不计入请求日志。
    if (incoming.pathname === "/healthz" || incoming.pathname === `${mountPath}/models`) {
      return handleCore(request);
    }
    // 分组按请求路径，不按上游：缺模型信息时路由会回落到 official，用它命名文件会误导排查。
    const group = logGroupFromPath(incoming.pathname);
    let reqBody: unknown = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        const clone = request.clone();
        const buffer = Buffer.from(await clone.arrayBuffer());
        if (buffer.length > 0) {
          const encoding = request.headers.get("content-encoding")?.toLowerCase().trim();
          const decoded = !encoding || encoding === "identity"
            ? buffer
            : encoding === "zstd"
              ? zstdDecompressSync(buffer)
              : encoding === "gzip"
                ? gunzipSync(buffer)
                : encoding === "deflate"
                  ? inflateSync(buffer)
                  : encoding === "br"
                    ? brotliDecompressSync(buffer)
                    : buffer;
          const text = new TextDecoder().decode(decoded);
          try {
            reqBody = JSON.parse(text);
          } catch {
            reqBody = text;
          }
        }
      } catch {
        // If decompression fails, log what we can.
      }
    }

    const response = await handleCore(request);
    const url = incoming.pathname + incoming.search;

    // 必须异步消费 clone：await 会读完整个响应流，令 SSE 退化成一次性返回。
    void response.clone().text().then((resBody) => {
      const durationMs = Date.now() - startedAt;
      logExchange(sink, group, {
        requestTime,
        method: request.method,
        url,
        reqHeaders: request.headers,
        reqBody,
        status: response.status,
        resHeaders: response.headers,
        resBody,
        durationMs,
      });
      // 426 是协议协商（客户端会改用 HTTPS/SSE 重试），不是故障，不计入错误汇总。
      if (response.status >= 400 && response.status !== 426) {
        logGatewayError(sink, group, {
          requestTime,
          method: request.method,
          url,
          status: response.status,
          message: errorMessageFromBody(resBody),
          durationMs,
        });
      }
    }).catch(() => {
      // Logging must never break the request flow.
    });
    return response;
  };
}

/**
 * upstream-first 桥接：先拨通上游、成功后才 upgrade 客户端，上游拒绝时错误以真实
 * 状态返回而不是 101 后静默断开。返回 undefined 表示已完成 upgrade，直接结束 fetch。
 */
async function bridgeUpstreamWebSocket(
  request: Request,
  server: Bun.Server<RealtimeSocketData>,
  target: {
    url: string;
    headers: Record<string, string>;
    routeKind?: "cliproxy" | "official";
    prefix?: string;
  },
  sink: RequestLogSink | undefined,
  dialFailureResponse: (error: Error) => Response,
): Promise<Response | undefined> {
  const logGroup = logGroupFromPath(new URL(request.url).pathname);
  // 整条 WebSocket 会话共用一个文件：多条连接（含 subagent 的 thread）共享 session-id，
  // 按它聚合能把此前每秒一个文件的碎片收敛成每会话一个。
  const logFile = websocketLogFile(logGroup, request.headers.get("session-id") ?? undefined);
  const socket: RealtimeSocketData = {
    url: target.url,
    headers: target.headers,
    queue: [],
    queuedBytes: 0,
    log: sink,
    logFile,
    routeKind: target.routeKind,
    prefix: target.prefix,
  };
  const startedAt = Date.now();
  let upstream: WebSocket;
  try {
    upstream = await dialUpstreamWebSocket(target.url, target.headers);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    logRealtimeEvent(sink, logFile, {
      event: "ws-dial-failed",
      url: target.url,
      // 握手请求不经过 logging wrapper，转发的头只能在这里留痕。
      detail: {
        durationMs: Date.now() - startedAt,
        error: `${error.name}: ${error.message}`,
        headers: maskedHeaders(target.headers),
      },
    });
    return dialFailureResponse(error);
  }
  logRealtimeEvent(sink, logFile, {
    event: "ws-dial",
    url: target.url,
    detail: { durationMs: Date.now() - startedAt, headers: maskedHeaders(target.headers) },
  });
  if (server.upgrade(request, { data: { ...socket, upstream } })) return undefined;
  upstream.close(1000, "Client upgrade failed");
  return new Response("WebSocket upgrade failed", { status: 400 });
}

export function startGateway(
  config: GatewayConfig,
  realtimeProviderMode: RealtimeProviderMode = "invalid",
  upstreamModelsCacheFile = path.join(path.dirname(config.catalogPath), "models-cache.json"),
): Bun.Server<RealtimeSocketData> {
  if (typeof Bun === "undefined") {
    throw new Error("The gateway server must run with Bun");
  }
  const apiKey = readApiKey(isLoopbackUrl(config.cliproxyBaseUrl));
  const handler = createGatewayHandler(config, apiKey, realtimeProviderMode, upstreamModelsCacheFile);
  const server = Bun.serve<RealtimeSocketData>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255,
    fetch(request, server) {
      const target = realtimeWebSocketTarget(request, config);
      if (target) {
        const accessError = realtimeAccessError(request, realtimeProviderMode);
        if (accessError) return accessError;
        const sink = resolveLogSink(config);
        return bridgeUpstreamWebSocket(request, server, target, sink, (error) => {
          // sideband 拨号失败是真实故障：502 并进错误摘要（原先会退化成 101 后静默断开）。
          const incoming = new URL(request.url);
          const group = logGroupFromPath(incoming.pathname);
          logGatewayError(sink, group, {
            requestTime: localTime(),
            method: request.method,
            url: incoming.pathname + incoming.search,
            status: 502,
            message: `Realtime upstream WebSocket failed: ${error.message}`,
            upstreamUrl: target.url,
          });
          return new Response("Realtime upstream WebSocket failed", {
            status: 502,
            headers: { "x-codex-cliproxy-gateway": "realtime-upstream-unavailable" },
          });
        });
      }
      // Responses over WebSocket：按 hint 选上游转发；拨号失败回 426 令客户端降级 HTTPS/SSE。
      const wsTarget = responsesWebSocketTarget(request, config, apiKey);
      if (wsTarget) {
        return bridgeUpstreamWebSocket(
          request,
          server,
          { ...wsTarget, prefix: config.prefix || "cliproxy/" },
          resolveLogSink(config),
          () => websocketNotSupportedResponse("websocket-upstream-unavailable"),
        );
      }
      return handler(request);
    },
    websocket: realtimeWebSocketHandler,
  });
  console.log([
    `--${new Date().toISOString()}--`,
    `codex-cliproxy gateway listening on ${server.url}`,
    `native models -> ${config.officialBaseUrl}`,
    `${config.prefix}* -> ${config.cliproxyBaseUrl}`,
    `realtime provider -> ${realtimeProviderMode}`,
  ].join("\n"));
  return server;
}
