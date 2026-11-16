import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { PluginRegistry, type GatewayPlugin, type SearchRequestContext } from "@agent-proxy/plugin-api";
import { createPluginGatewayHandler } from "../apps/gateway/src/gateway.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";
import test from "./host-test.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

const TIMEOUT = { timeout: 30_000 };

function fixture(upstreamOnly: boolean, overrides: Partial<GatewayConfig> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-search-routing-"));
  const paths = resolvePaths({ HOME: directory, CODEX_HOME: path.join(directory, "codex") }, path.join(directory, "runtime"));
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    upstreamBaseUrl: "http://cliproxy.invalid/v1", officialBaseUrl: "https://chatgpt.invalid/backend-api/codex",
    catalogPath: paths.catalogFile, upstreamOnly, ...overrides,
  };
  return { directory, paths, config };
}

function searchRequest(body: Uint8Array | string, headers: HeadersInit = {}): Request {
  const requestHeaders = new Headers({ "content-type": "application/json", authorization: "Bearer client-oauth" });
  new Headers(headers).forEach((value, key) => requestHeaders.set(key, value));
  const requestBody: BodyInit = typeof body === "string" ? body : (() => {
    const buffer = new ArrayBuffer(body.byteLength);
    new Uint8Array(buffer).set(body);
    return buffer;
  })();
  return new Request("http://127.0.0.1:8320/v1/alpha/search", {
    method: "POST",
    headers: requestHeaders,
    body: requestBody,
  });
}

function searchPlugin(handleSearch?: (context: SearchRequestContext) => Promise<Response> | Response): GatewayPlugin {
  return {
    id: "agy",
    modelPatterns: ["agy/*"],
    handleHttp: async () => Response.json({ error: "unexpected generation route" }, { status: 500 }),
    ...(handleSearch ? { handleSearch } : {}),
    getCatalog: () => ({ models: [] }),
    refreshCatalog: async () => ({ models: [] }),
    reloadCatalog: async () => ({ models: [] }),
    ready: async () => {},
    close: () => {},
  };
}

for (const upstreamOnly of [true, false]) {
  test(`Alpha Search 按 body.model 派发到本地插件（upstreamOnly=${upstreamOnly}），且不传客户端授权`, TIMEOUT, async () => {
    const { directory, paths, config } = fixture(upstreamOnly);
    const originalFetch = globalThis.fetch;
    const seen: SearchRequestContext[] = [];
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls++;
      return Response.json({ error: "search escaped plugin" }, { status: 503 });
    }) as unknown as typeof fetch;
    const handler = createPluginGatewayHandler(config, new PluginRegistry([searchPlugin((context) => {
      seen.push(context);
      return Response.json({ search: "handled by agy" });
    })]), "gateway-key", "invalid", undefined, undefined, undefined, undefined, paths);
    try {
      const headers = new Headers({
        "content-encoding": "zstd",
        "x-codex-routing-hint": "model=cliproxy/gpt-6.1-sol",
        "chatgpt-account-id": "private-account",
        "x-api-key": "private-client-key",
      });
      const response = await handler(searchRequest(zstdCompressSync(JSON.stringify({
        id: "turn-1", model: "agy/gemini-pro-orchestrator-g1-pro", commands: { search_query: [{ q: "weather" }] },
      })), headers));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { search: "handled by agy" });
      assert.equal(upstreamCalls, 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.model, "agy/gemini-pro-orchestrator-g1-pro", "body.model must win over stale routing hint");
      assert.deepEqual(await seen[0]!.body.json(), {
        id: "turn-1", model: "agy/gemini-pro-orchestrator-g1-pro", commands: { search_query: [{ q: "weather" }] },
      });
      assert.equal(seen[0]!.request.headers.get("authorization"), null);
      assert.equal(seen[0]!.request.headers.get("chatgpt-account-id"), null);
      assert.equal(seen[0]!.request.headers.get("x-api-key"), null);
      assert.equal(seen[0]!.request.headers.get("content-encoding"), null, "插件收到已解压 JSON");
      assert.equal(seen[0]!.request.headers.get("x-codex-routing-hint"), null, "body.model 已优先采用，不继续传入过期 hint");
    } finally {
      handler.close();
      globalThis.fetch = originalFetch;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("未声明搜索处理器的本地模型明确返回 501，不回退默认上游", TIMEOUT, async () => {
  const { directory, paths, config } = fixture(true);
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls++;
    return Response.json({ error: "must not forward" }, { status: 503 });
  }) as unknown as typeof fetch;
  const handler = createPluginGatewayHandler(config, new PluginRegistry([searchPlugin()]), "gateway-key", "invalid",
    undefined, undefined, undefined, undefined, paths);
  try {
    const response = await handler(searchRequest(JSON.stringify({ model: "agy/model", commands: {} })));
    assert.equal(response.status, 501);
    assert.equal((await response.json() as { error: { type: string } }).error.type, "unsupported_operation");
    assert.equal(upstreamCalls, 0);
  } finally {
    handler.close();
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("已安装但未启用的本地模型不能通过 Alpha Search 逃逸", TIMEOUT, async () => {
  const { directory, paths, config } = fixture(false);
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls++;
    return Response.json({});
  }) as unknown as typeof fetch;
  const handler = createPluginGatewayHandler(config, new PluginRegistry([]), "gateway-key", "invalid",
    undefined, undefined, undefined, undefined, paths, (model) => model.startsWith("agy/"));
  try {
    const response = await handler(searchRequest(JSON.stringify({ model: "agy/model", commands: {} })));
    assert.equal(response.status, 501);
    assert.equal(upstreamCalls, 0);
  } finally {
    handler.close();
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Alpha Search 继续原样转发普通模型和压缩 body", TIMEOUT, async () => {
  const { directory, paths, config } = fixture(true);
  const originalFetch = globalThis.fetch;
  let forwarded: Request | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    forwarded = new Request(input, init);
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const handler = createPluginGatewayHandler(config, new PluginRegistry([searchPlugin()]), "gateway-key", "invalid",
    undefined, undefined, undefined, undefined, paths);
  try {
    const bytes = zstdCompressSync(JSON.stringify({ model: "gpt-6.1-sol", commands: { search_query: [{ q: "weather" }] } }));
    const response = await handler(searchRequest(bytes, { "content-encoding": "zstd" }));
    assert.equal(response.status, 200);
    assert.equal(new URL(forwarded!.url).pathname, "/v1/alpha/search");
    assert.equal(forwarded!.url, "http://cliproxy.invalid/v1/alpha/search");
    assert.equal(forwarded!.headers.get("content-encoding"), "zstd");
    assert.deepEqual(new Uint8Array(await forwarded!.arrayBuffer()), bytes, "普通模型的压缩请求体保持原始字节");
  } finally {
    handler.close();
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("排除模型返回 404，畸形 Alpha Search JSON 返回 400", TIMEOUT, async () => {
  const { directory, paths, config } = fixture(false, { excludedModels: ["agy/blocked"] });
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls++;
    return Response.json({});
  }) as unknown as typeof fetch;
  const handler = createPluginGatewayHandler(config, new PluginRegistry([searchPlugin(() => Response.json({}))]), "gateway-key", "invalid",
    undefined, undefined, undefined, undefined, paths);
  try {
    const excluded = await handler(searchRequest(JSON.stringify({ model: "agy/blocked" })));
    assert.equal(excluded.status, 404);
    const malformed = await handler(searchRequest("{"));
    assert.equal(malformed.status, 400);
    assert.equal(upstreamCalls, 0);
  } finally {
    handler.close();
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

