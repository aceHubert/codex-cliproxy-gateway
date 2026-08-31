import fs from "node:fs";
import { httpLogFile, logGroupFromPath, logRealtimeEvent } from "./request-log.ts";
import type { LogFileRef, RequestLogSink } from "./request-log.ts";
import type { GatewayConfig } from "./types.ts";

const MAX_REALTIME_BODY_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_WEBSOCKET_BYTES = 1024 * 1024;
const OPENAI_REALTIME_BASE_URL = "https://api.openai.com/v1";

/**
 * 转发时剥离的头。这里刻意用黑名单而非白名单：代理应当默认透明，
 * 白名单每次都要追着上游/客户端新增的头补（version、openai-safety-identifier、
 * x-codex-turn-metadata 都因此漏过），漏掉就让上游按缺省行为处理。
 */
const HOP_BY_HOP_UPSTREAM_HEADERS = new Set([
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
  "accept-encoding",
]);

/** WebSocket 握手头由客户端库自行生成，转发原值会让上游握手失败。 */
const WEBSOCKET_HANDSHAKE_HEADERS = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "content-type",
]);

export interface RealtimeWebSocketTarget {
  url: string;
  headers: Record<string, string>;
}

export interface RealtimeSocketData extends RealtimeWebSocketTarget {
  upstream?: WebSocket;
  queue: Array<string | Uint8Array>;
  queuedBytes: number;
  log?: RequestLogSink;
  /** 日志目标：整条 WebSocket 会话写同一个文件，建连时确定。 */
  logFile?: LogFileRef;
  /**
   * Responses WebSocket 的连接级路由。Codex 会复用同一条连接跨 turn 发不同模型
   * （实测存活 88 秒），而上游只在握手时选定一次，因此必须逐帧校验。
   * realtime 的 live/sideband 连接不设此字段，走原有透传。
   */
  routeKind?: "cliproxy" | "official";
  /** cliproxy 模型前缀，用于逐帧校验与剥离。 */
  prefix?: string;
  /** official 连接首次收到明确的 cliproxy/* 帧时，固定该 thread 的后续路由。 */
  pinCpaThread?: () => void;
}

/**
 * 校验帧的模型与连接路由是否一致。
 * official 只拒绝明确的 cliproxy/*；CPA thread 已固定路由，无前缀标题/系统帧继续走 CPA。
 * 返回改写后的帧；返回 null 表示 official 收到 CPA 帧，调用方需固定 thread 后重连。
 */
export function checkFrameRouting(
  frame: string,
  routeKind: "cliproxy" | "official",
  prefix: string,
): string | null {
  if (!prefix) return frame;
  let payload: unknown;
  try {
    payload = JSON.parse(frame);
  } catch {
    return frame; // 非 JSON 帧原样透传
  }
  if (!isRecord(payload) || typeof payload.model !== "string") return frame;
  const prefixed = payload.model.startsWith(prefix);
  if (routeKind === "official") return prefixed ? null : frame;
  if (!prefixed) return frame;
  // 前缀是网关加的，上游模型表里没有，必须与 HTTP 路径一样剥掉再转发。
  payload.model = payload.model.slice(prefix.length);
  return JSON.stringify(payload);
}

export type RealtimeProviderMode = "builtin" | "configured" | "invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerModeFromToml(source: string): RealtimeProviderMode {
  try {
    const config: unknown = Bun.TOML.parse(source);
    if (!isRecord(config)) return "invalid";
    if (config.model_provider !== undefined) {
      return typeof config.model_provider === "string" ? "configured" : "invalid";
    }
    if (config.profiles === undefined) return "builtin";
    if (!isRecord(config.profiles)) return "invalid";
    for (const profile of Object.values(config.profiles)) {
      if (!isRecord(profile)) return "invalid";
      if (profile.model_provider !== undefined) {
        return typeof profile.model_provider === "string" ? "configured" : "invalid";
      }
    }
    return "builtin";
  } catch {
    return "invalid";
  }
}

export function loadRealtimeProviderMode(configToml: string): RealtimeProviderMode {
  try {
    return providerModeFromToml(fs.readFileSync(configToml, "utf8"));
  } catch {
    return "invalid";
  }
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

function appendPath(baseUrl: string, suffix: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
  return url;
}

function copyQuery(target: URL, source: URL): void {
  for (const [key, value] of source.searchParams) target.searchParams.append(key, value);
}

/** includeContentType=false 用于 WebSocket 握手：不带 body，也不能复用客户端的握手头。 */
export function forwardedHeaders(headers: Headers, includeContentType: boolean): Record<string, string> {
  const forwarded: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HOP_BY_HOP_UPSTREAM_HEADERS.has(name)) return;
    if (!includeContentType && WEBSOCKET_HANDSHAKE_HEADERS.has(name)) return;
    forwarded[name] = value;
  });
  return forwarded;
}

function isChatGptBackend(baseUrl: string): boolean {
  return baseUrl.includes("/backend-api");
}

function realtimeBaseUrl(request: Request, config: GatewayConfig): string {
  const apiKeyAuth = !request.headers.has("chatgpt-account-id");
  return apiKeyAuth && isChatGptBackend(config.officialBaseUrl)
    ? OPENAI_REALTIME_BASE_URL
    : config.officialBaseUrl;
}

export function realtimeAccessError(
  request: Request,
  providerMode: RealtimeProviderMode,
): Response | null {
  if (providerMode === "configured") {
    return errorResponse(400, "Local Realtime supports only the built-in OpenAI provider");
  }
  if (providerMode === "invalid") {
    return errorResponse(503, "Unable to determine the configured Codex model provider");
  }
  if (!request.headers.get("authorization")) {
    return errorResponse(401, "Realtime requires Authorization from Codex");
  }
  return null;
}

function realtimePaths(config: GatewayConfig) {
  const mountPath = config.mountPath || "/v1";
  return {
    live: `${mountPath}/live`,
    realtime: `${mountPath}/realtime`,
    calls: `${mountPath}/realtime/calls`,
  };
}

export function isRealtimeCallRequest(request: Request, config: GatewayConfig): boolean {
  if (request.method !== "POST") return false;
  const { pathname } = new URL(request.url);
  const paths = realtimePaths(config);
  return pathname === paths.live || pathname === paths.calls;
}

function realtimeCallUrl(request: Request, config: GatewayConfig, baseUrl: string): URL {
  const incoming = new URL(request.url);
  const paths = realtimePaths(config);
  const backend = isChatGptBackend(baseUrl);
  const target = appendPath(
    baseUrl,
    backend || incoming.pathname === paths.calls ? "realtime/calls" : "live",
  );
  copyQuery(target, incoming);
  const backendMultipart = backend
    && request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data");
  if (backendMultipart || (!backend && incoming.pathname === paths.calls)) {
    if (!target.searchParams.has("intent")) target.searchParams.set("intent", "quicksilver");
    if (!target.searchParams.has("architecture")) target.searchParams.set("architecture", "avas");
  }
  return target;
}

async function requestBytes(request: Request): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REALTIME_BODY_BYTES) {
    throw new RangeError("Realtime request body exceeds 16 MiB");
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REALTIME_BODY_BYTES) {
    throw new RangeError("Realtime request body exceeds 16 MiB");
  }
  return bytes;
}

async function backendCallBody(request: Request, bytes: Buffer): Promise<string> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new TypeError("Realtime call requires multipart/form-data");
  }
  const form = await new Request(request.url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: arrayBuffer(bytes),
  }).formData();
  const sdp = form.get("sdp");
  const sessionValue = form.get("session");
  if (typeof sdp !== "string" || !sdp) throw new TypeError("Realtime multipart body is missing sdp");
  let session: Record<string, unknown> | undefined;
  if (sessionValue !== null) {
    if (typeof sessionValue !== "string") throw new TypeError("Realtime multipart session must be JSON text");
    const parsed: unknown = JSON.parse(sessionValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Realtime multipart session must be a JSON object");
    }
    session = { ...parsed as Record<string, unknown> };
    delete session.id;
  }
  return JSON.stringify(session ? { sdp, session } : { sdp });
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function responseHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  for (const name of [
    "connection", "content-encoding", "content-length", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
  ]) result.delete(name);
  return result;
}

export async function proxyRealtimeCall(
  request: Request,
  config: GatewayConfig,
  providerMode: RealtimeProviderMode = "invalid",
  sink?: RequestLogSink,
): Promise<Response> {
  const accessError = realtimeAccessError(request, providerMode);
  if (accessError) return accessError;

  const baseUrl = realtimeBaseUrl(request, config);
  const backend = isChatGptBackend(baseUrl);
  let bytes: Buffer;
  try {
    bytes = await requestBytes(request);
  } catch (error) {
    return errorResponse(error instanceof RangeError ? 413 : 400, error instanceof Error ? error.message : String(error));
  }

  const headers = forwardedHeaders(request.headers, true);
  let body: BodyInit = arrayBuffer(bytes);
  if (backend) {
    const contentType = request.headers.get("content-type")?.toLowerCase() || "";
    if (contentType.startsWith("multipart/form-data")) {
      try {
        body = await backendCallBody(request, bytes);
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      }
      headers["content-type"] = "application/json";
    } else if (!contentType.startsWith("application/sdp")) {
      return errorResponse(400, "Realtime call requires multipart/form-data or application/sdp");
    }
  }

  // 上游可能是 ChatGPT backend 也可能是 OpenAI API，wrapper 只看得到本地路径，这里补记实际去向。
  const target = realtimeCallUrl(request, config, baseUrl);
  const callFile = httpLogFile(logGroupFromPath(new URL(request.url).pathname));
  const startedAt = Date.now();
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
    });
    const declared = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_REALTIME_BODY_BYTES) {
      await upstream.body?.cancel();
      return errorResponse(502, "Realtime upstream response exceeds 16 MiB");
    }
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    if (responseBody.byteLength > MAX_REALTIME_BODY_BYTES) {
      return errorResponse(502, "Realtime upstream response exceeds 16 MiB");
    }
    logRealtimeEvent(sink, callFile, {
      event: "call-create",
      url: target.href,
      detail: {
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        location: upstream.headers.get("location") ?? undefined,
      },
    });
    return new Response(responseBody.byteLength > 0 ? responseBody : null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers),
    });
  } catch (error) {
    logRealtimeEvent(sink, callFile, {
      event: "call-create-failed",
      url: target.href,
      detail: {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
    });
    return errorResponse(502, `Realtime upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function websocketUrl(url: URL): URL {
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError(`Unsupported Realtime WebSocket scheme: ${url.protocol}`);
  }
  return url;
}

// 经 CF 的上游握手实测 1.2–5.8s：按 5s 截断会把"慢但能成功"的握手变成 426，而 Codex 收到
// 426 后会退避到纯 SSE 约十分钟，代价远高于多等几秒；10s 覆盖实测最慢成功值约 1.7 倍。
const UPSTREAM_DIAL_TIMEOUT_MS = 10_000;

/**
 * 拨号上游 WebSocket，握手成功才 resolve。调用方必须先拨通、再 server.upgrade 客户端，
 * 否则上游拒绝（401/404/超时）会退化成客户端已收到 101 后的静默断开。
 */
export function dialUpstreamWebSocket(
  url: string,
  headers: Record<string, string>,
  timeoutMs = UPSTREAM_DIAL_TIMEOUT_MS,
): Promise<WebSocket> {
  const ClientWebSocket = WebSocket as unknown as new (
    url: string,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  return new Promise((resolve, reject) => {
    const socket = new ClientWebSocket(url, { headers, perMessageDeflate: false });
    socket.binaryType = "arraybuffer";
    const settle = (error?: Error) => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      if (error) {
        socket.close();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const timer = setTimeout(() => {
      settle(new Error(`upstream WebSocket handshake timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    socket.onopen = () => settle();
    socket.onerror = () => settle(new Error(`upstream WebSocket handshake failed: ${url}`));
  });
}

export function realtimeWebSocketTarget(request: Request, config: GatewayConfig): RealtimeWebSocketTarget | null {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
  const incoming = new URL(request.url);
  const paths = realtimePaths(config);
  let target: URL;

  if (incoming.pathname.startsWith(`${paths.live}/`)) {
    let callId: string;
    try {
      callId = decodeURIComponent(incoming.pathname.slice(paths.live.length + 1));
    } catch {
      return null;
    }
    if (!callId || callId.includes("/")) return null;
    target = new URL("https://api.openai.com/v1/live");
    target.pathname = `/v1/live/${callId}`;
  } else if (incoming.pathname === paths.realtime && incoming.searchParams.has("call_id")) {
    target = new URL("https://api.openai.com/v1/realtime");
  } else if (incoming.pathname === paths.live || incoming.pathname === paths.realtime) {
    const baseUrl = realtimeBaseUrl(request, config);
    target = new URL(baseUrl);
    if (!isChatGptBackend(baseUrl)) {
      target = appendPath(target.href, incoming.pathname === paths.live ? "live" : "realtime");
    }
  } else {
    return null;
  }
  copyQuery(target, incoming);
  return {
    url: websocketUrl(target).href,
    headers: forwardedHeaders(request.headers, false),
  };
}

function closeCode(code: number, fallback = 1011): number {
  return code === 1000
    || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code))
    || (code >= 3000 && code <= 4999)
    ? code
    : fallback;
}

function frameBytes(frame: string | Uint8Array): number {
  return typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
}

function sendToClient(ws: Bun.ServerWebSocket<RealtimeSocketData>, data: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (typeof data === "string") ws.send(data);
  else if (data instanceof ArrayBuffer) ws.send(data);
  else if (ArrayBuffer.isView(data)) {
    ws.send(arrayBuffer(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
  } else if (data instanceof Blob) {
    void data.arrayBuffer().then((buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
    });
  }
}

export const realtimeWebSocketHandler: Bun.WebSocketHandler<RealtimeSocketData> = {
  maxPayloadLength: MAX_REALTIME_BODY_BYTES,
  perMessageDeflate: false,
  open(ws) {
    // upstream-first：上游在 server.upgrade 之前由 dialUpstreamWebSocket 拨通。
    const upstream = ws.data.upstream;
    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
      logRealtimeEvent(ws.data.log, ws.data.logFile ?? httpLogFile("realtime"), {
        event: "ws-upstream-error",
        url: ws.data.url,
        detail: { error: "upstream socket missing or not open at bridge start" },
      });
      ws.close(1011, "Realtime upstream WebSocket is unavailable");
      return;
    }
    const bridgedAt = Date.now();
    logRealtimeEvent(ws.data.log, ws.data.logFile ?? httpLogFile("realtime"), {
      event: "ws-upstream-open",
      url: ws.data.url,
      detail: { queued: ws.data.queue.length },
    });
    for (const frame of ws.data.queue) upstream.send(frame);
    ws.data.queue = [];
    ws.data.queuedBytes = 0;
    upstream.onmessage = (event) => {
      logRealtimeEvent(ws.data.log, ws.data.logFile ?? httpLogFile("realtime"), {
        event: "ws-recv",
        url: ws.data.url,
        frame: typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : ArrayBuffer.isView(event.data)
              ? event.data.byteLength
              : 0,
      });
      sendToClient(ws, event.data);
    };
    upstream.onerror = () => {
      logRealtimeEvent(ws.data.log, ws.data.logFile ?? httpLogFile("realtime"), {
        event: "ws-upstream-error",
        url: ws.data.url,
        detail: { durationMs: Date.now() - bridgedAt },
      });
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Realtime upstream WebSocket failed");
    };
    upstream.onclose = (event) => {
      logRealtimeEvent(ws.data.log, ws.data.logFile ?? httpLogFile("realtime"), {
        event: "ws-upstream-close",
        url: ws.data.url,
        detail: { code: event.code, reason: event.reason, durationMs: Date.now() - bridgedAt },
      });
      if (ws.readyState === WebSocket.OPEN) ws.close(closeCode(event.code, 1000), event.reason);
    };
  },
  message(ws, message) {
    const upstream = ws.data.upstream;
    let frame = typeof message === "string" ? message : Buffer.from(message);
    // Codex 复用连接跨模型发送，握手时选定的上游可能已不适用于当前帧。
    if (ws.data.routeKind && typeof frame === "string") {
      const routed = checkFrameRouting(frame, ws.data.routeKind, ws.data.prefix ?? "cliproxy/");
      if (routed === null) {
        if (ws.data.routeKind === "official") ws.data.pinCpaThread?.();
        logRealtimeEvent(ws.data.log, ws.data.logFile ?? httpLogFile("realtime"), {
          event: "ws-route-mismatch",
          url: ws.data.url,
          detail: { routeKind: ws.data.routeKind },
        });
        // 断开让客户端重连：新握手会按当时的 routing hint 选到正确上游。
        ws.close(1012, "Model routing changed; reconnect required");
        upstream?.close(1000, "Model routing changed");
        return;
      }
      frame = routed;
    }
    logRealtimeEvent(ws.data.log, ws.data.logFile ?? httpLogFile("realtime"), {
      event: "ws-send",
      url: ws.data.url,
      frame: typeof frame === "string" ? frame : frame.byteLength,
    });
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(frame);
      return;
    }
    if (upstream && upstream.readyState !== WebSocket.CONNECTING) {
      ws.close(1011, "Realtime upstream WebSocket is unavailable");
      return;
    }
    const nextBytes = ws.data.queuedBytes + frameBytes(frame);
    // ponytail: 单连接 1 MiB 握手队列；实测需要更高吞吐时再做背压协调。
    if (nextBytes > MAX_PENDING_WEBSOCKET_BYTES) {
      ws.close(1009, "Realtime upstream connection queue exceeded 1 MiB");
      upstream?.close(1009, "Client queue limit exceeded");
      return;
    }
    ws.data.queue.push(frame);
    ws.data.queuedBytes = nextBytes;
  },
  close(ws, code, reason) {
    logRealtimeEvent(ws.data.log, ws.data.logFile ?? httpLogFile("realtime"), {
      event: "ws-client-close",
      url: ws.data.url,
      detail: { code, reason, pendingFrames: ws.data.queue.length },
    });
    const upstream = ws.data.upstream;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) {
      upstream.close(closeCode(code, 1000), reason);
    }
    ws.data.queue = [];
    ws.data.queuedBytes = 0;
  },
};
