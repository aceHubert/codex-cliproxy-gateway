import fs from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { readApiKey } from "./keychain.ts";
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
const LOG_MAX_BODY = 50_000;

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

function truncateBody(text: string, max = LOG_MAX_BODY): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);

function headerLines(headers: Headers): string[] {
  const lines: string[] = [];
  headers.forEach((value, key) => lines.push(`  ${key}: ${SENSITIVE_HEADERS.has(key.toLowerCase()) ? "***" : value}`));
  return lines;
}

async function logExchange(
  requestTime: string,
  method: string,
  url: string,
  reqHeaders: Headers,
  reqBody: unknown,
  status: number,
  resHeaders: Headers,
  resBody: string,
): Promise<void> {
  try {
    const lines = [
      `--${requestTime}--`,
      `=== ${method} ${url} ===`,
      ``,
      `--- request headers ---`,
      ...headerLines(reqHeaders),
      ``,
      `--- request payload ---`,
      `  ${truncateBody(typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody ?? null))}`,
      ``,
      ``,
      `--- response status: ${status} ---`,
      `--- response headers ---`,
      ...headerLines(resHeaders),
      ``,
      `--- response body ---`,
      `  ${truncateBody(resBody)}`,
      ``,
      ``,
    ];
    console.log(lines.join("\n"));
  } catch {
    // Logging must never break the request flow.
  }
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

async function readJsonBody(request: Request): Promise<{
  bytes: ArrayBuffer | undefined;
  json: Record<string, unknown> | undefined;
}> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { bytes: undefined, json: undefined };
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return { bytes, json: undefined };
  const encoding = request.headers.get("content-encoding")?.toLowerCase().trim();
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
    return {
      bytes,
      json: value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined,
    };
  } catch {
    if (request.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Invalid JSON request body");
    }
    return { bytes, json: undefined };
  }
}

async function catalogModelsResponse(config: GatewayConfig): Promise<Response> {
  try {
    const catalog = JSON.parse(fs.readFileSync(config.catalogPath, "utf8")) as ModelCatalog;
    const data = (catalog.models || []).map((model) => ({
      id: model.slug,
      object: "model",
      owned_by: model.slug.startsWith(config.prefix) ? "cliproxy" : "openai",
    }));
    return Response.json({ object: "list", data });
  } catch (error) {
    return Response.json(
      { error: { message: `Unable to read model catalog: ${error instanceof Error ? error.message : String(error)}` } },
      { status: 500 },
    );
  }
}

export function createGatewayHandler(
  config: GatewayConfig,
  apiKey = readApiKey(),
): (request: Request) => Promise<Response> {
  const mountPath = config.mountPath || "/v1";
  const prefix = config.prefix || "cliproxy/";
  const logging = config.requestLogging === true;

  const handleCore = async (request: Request): Promise<Response> => {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname === "/healthz") {
      return Response.json({ ok: true, prefix, port: config.port });
    }

    if (incomingUrl.pathname === `${mountPath}/models` && request.method === "GET") {
      return catalogModelsResponse(config);
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return new Response("WebSocket transport is not supported; retry with HTTPS/SSE.", {
        status: 426,
        headers: {
          connection: "close",
          "x-codex-cliproxy-gateway": "websocket-not-supported",
        },
      });
    }

    let bytes: ArrayBuffer | undefined;
    let json: Record<string, unknown> | undefined;
    try {
      ({ bytes, json } = await readJsonBody(request));
    } catch (error) {
      return Response.json(
        { error: { message: error instanceof Error ? error.message : String(error) } },
        { status: 400 },
      );
    }
    const route = decideRoute(json?.model, prefix);
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
    const requestTime = new Date().toISOString();
    let reqBody: unknown = null;
    let isCliproxy = false;
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
            const parsed = JSON.parse(text);
            if (isRecord(parsed) && typeof parsed.model === "string") {
              isCliproxy = parsed.model.startsWith(prefix);
            }
            reqBody = parsed;
          } catch {
            reqBody = text;
          }
        }
      } catch {
        // If decompression fails, log what we can.
      }
    }

    const response = await handleCore(request);

    if (!isCliproxy) return response;

    const resBodyText = await response.clone().text().catch(() => "");
    await logExchange(
      requestTime,
      request.method,
      new URL(request.url).pathname + new URL(request.url).search,
      request.headers,
      reqBody,
      response.status,
      response.headers,
      resBodyText,
    );
    return response;
  };
}

export function startGateway(config: GatewayConfig): Bun.Server<undefined> {
  if (typeof Bun === "undefined") {
    throw new Error("The gateway server must run with Bun");
  }
  const apiKey = readApiKey(isLoopbackUrl(config.cliproxyBaseUrl));
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255,
    fetch: createGatewayHandler(config, apiKey),
  });
  console.log(`codex-cliproxy gateway listening on ${server.url}`);
  console.log(`native models -> ${config.officialBaseUrl}`);
  console.log(`${config.prefix}* -> ${config.cliproxyBaseUrl}`);
  return server;
}
