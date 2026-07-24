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

type Route =
  | { kind: "cliproxy"; upstreamModel: string }
  | { kind: "official"; upstreamModel: unknown };

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
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

  return async function handle(request: Request): Promise<Response> {
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
    const upstreamUrl = joinUpstreamUrl(upstreamBase, request.url, mountPath);
    const headers = copyRequestHeaders(request, route, apiKey);

    let body: ArrayBuffer | string | undefined = bytes;
    if (route.kind === "cliproxy" && json && typeof json === "object") {
      json.model = route.upstreamModel;
      body = JSON.stringify(json);
      headers.set("content-type", "application/json");
    }

    try {
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
