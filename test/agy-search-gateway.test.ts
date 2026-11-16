import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGatewayHandler } from "../apps/gateway/src/gateway-composition.ts";
import { ThreadRoutingState } from "../apps/gateway/src/thread-routing.ts";
import { gatewayFixturePaths } from "./gateway-fixture-paths.ts";
import test from "./host-test.ts";
import type { AgyDependencies } from "@agent-proxy/agy";
import type { AgyCredentials } from "@agent-proxy/agy/credentials";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

type Json = Record<string, any>;
const TIMEOUT = { timeout: 60_000 };
const MODEL = "agy/gemini-pro-orchestrator-g1-pro";
const ORCHESTRATOR_ID = "gemini-pro-orchestrator-g1-pro";
const SEARCH_MODEL_ID = "gemini-search-native";
const FAKE_AGY_TOKEN = "fake-agy-search-access-token";
const CLIENT_OAUTH = "client-chatgpt-oauth-must-not-forward";
const SENSITIVE_QUERY = "secret-search-query-should-not-be-logged";

function credential(expired = false): AgyCredentials {
  return {
    accessToken: FAKE_AGY_TOKEN,
    expiryMs: expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
    identity: "agy-search-test-account",
    authMethod: "consumer",
  };
}

function catalogData(includeSearchModel = true): Json {
  return {
    models: {
      [ORCHESTRATOR_ID]: { displayName: "Orchestrator (Argon)", supportsThinking: true },
    },
    agentModelSorts: [{ groups: [{ modelIds: [ORCHESTRATOR_ID] }] }],
    ...(includeSearchModel ? { webSearchModelIds: [SEARCH_MODEL_ID] } : {}),
  };
}

function groundedResponse(queryIndex = 0): Response {
  const summary = `模拟搜索摘要 ${queryIndex}`;
  return Response.json({
    response: {
      candidates: [{
        content: { role: "model", parts: [{ text: summary }] },
        finishReason: "STOP",
        groundingMetadata: {
          groundingChunks: [{ web: { uri: `https://weather.example/${queryIndex}?tracking=private`, title: `来源 ${queryIndex}` } }],
          groundingSupports: [{
            segment: { text: summary, endIndex: Buffer.byteLength(summary), partIndex: 0 },
            groundingChunkIndices: [0],
          }],
        },
      }],
    },
  });
}

interface SearchHarness {
  config: GatewayConfig;
  directory: string;
  paths: ReturnType<typeof gatewayFixturePaths>;
  createHandler: (dependencies: Partial<AgyDependencies>) => ReturnType<typeof createGatewayHandler>;
  restoreGlobalFetch: () => void;
}

function createHarness(upstreamOnly: boolean, overrides: Partial<GatewayConfig> = {}): SearchHarness {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-native-search-gateway-"));
  const paths = gatewayFixturePaths(directory);
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.writeFileSync(path.join(paths.runtimeHome, "cliproxy-catalog.json"), JSON.stringify({ models: [{ slug: "test-gpt" }] }));
  const config: GatewayConfig = {
    zcode: false, codebuddy: false, qoder: false, opencodeZen: false, agy: true,
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    upstreamOnly,
    officialBaseUrl: "https://official.invalid/v1",
    upstreamBaseUrl: "https://cliproxy.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"),
    requestLogging: true,
    ...overrides,
  };
  const originalFetch = globalThis.fetch;
  const createHandler = (dependencies: Partial<AgyDependencies>) => createGatewayHandler(
    config,
    "gateway-test-key",
    "invalid",
    new ThreadRoutingState(),
    new Set<string>(),
    undefined,
    undefined,
    { file: paths.stdoutLog, maxBytes: 100_000 },
    undefined,
    undefined,
    {
      cacheDirectory: paths.runtimeHome,
      refreshCatalogOnStart: false,
      ...dependencies,
    },
    undefined,
    paths,
  );
  return {
    config,
    directory,
    paths,
    createHandler,
    restoreGlobalFetch: () => { globalThis.fetch = originalFetch; },
  };
}

function alphaSearchRequest(commands: Json, signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1:8327/v1/alpha/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CLIENT_OAUTH}`,
      "chatgpt-account-id": "private-client-account",
    },
    body: JSON.stringify({ id: "search-turn", model: MODEL, commands, max_output_tokens: 1000 }),
    ...(signal ? { signal } : {}),
  });
}

for (const upstreamOnly of [true, false]) {
  test(`AGY Alpha Search 在两种路由模式下使用搜索模型并返回 grounding 来源（upstreamOnly=${upstreamOnly}）`, TIMEOUT, async () => {
    const harness = createHarness(upstreamOnly);
    const upstreamBodies: Json[] = [];
    const outboundAuthorizations: string[] = [];
    let queryIndex = 0;
    let fallbackCalls = 0;
    globalThis.fetch = (async () => {
      fallbackCalls++;
      return Response.json({ error: "search must stay in AGY plugin" }, { status: 503 });
    }) as unknown as typeof fetch;
    const handler = harness.createHandler({
      credentials: async () => credential(),
      fetch: async (url, init) => {
        outboundAuthorizations.push(new Headers(init.headers).get("authorization") ?? "");
        if (url.includes(":fetchAvailableModels")) return Response.json(catalogData());
        if (url.includes(":generateContent")) {
          const body = JSON.parse(String(init.body)) as Json;
          upstreamBodies.push(body);
          return groundedResponse(queryIndex++);
        }
        throw new Error(`未预期的 AGY 上游路径：${url}`);
      },
    });
    try {
      await handler.modelsReady();
      const response = await handler(new Request("http://127.0.0.1:8327/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_OAUTH}`, "chatgpt-account-id": "private-client-account" },
        body: JSON.stringify({
          id: "search-turn",
          model: MODEL,
          commands: {
            search_query: [{ q: "杭州 2026-11-17 天气" }, { q: SENSITIVE_QUERY }],
            weather: [{ location: "杭州", start: "2026-11-17", duration: 1 }],
          },
          max_output_tokens: 1000,
        }),
      }));

      assert.equal(response.status, 200);
      const result = await response.json() as Json;
      assert.equal(result.encrypted_output, null);
      assert.equal(result.results.length, 3);
      assert.match(result.output, /杭州 2026-11-17 天气/);
      assert.match(result.output, /weather.example\/0/);
      assert.equal(result.results[0].url, "https://weather.example/0", "来源 URL 应剥离 query 参数");
      assert.equal(upstreamBodies.length, 3, "search_query 与 weather 均由 AGY 原生搜索模型执行");
      assert.ok(upstreamBodies.every((body) => body.model === SEARCH_MODEL_ID), "搜索应使用目录专用模型，不使用 Orchestrator ID");
      assert.ok(upstreamBodies.every((body) => body.requestType === "web_search"));
      assert.ok(upstreamBodies.every((body) => Array.isArray(body.request.tools)
        && body.request.tools.some((tool: Json) => tool.googleSearch !== undefined)));
      assert.ok(outboundAuthorizations.length >= 4);
      assert.ok(outboundAuthorizations.every((header) => header === `Bearer ${FAKE_AGY_TOKEN}`));
      assert.equal(JSON.stringify(upstreamBodies).includes(CLIENT_OAUTH), false, "Codex OAuth 不得进入 AGY 上游");
      assert.equal(fallbackCalls, 0, "alpha/search 不应误路由到 CLIProxy 或官方默认上游");

      const logs = fs.readdirSync(harness.paths.logDir)
        .map((name) => fs.readFileSync(path.join(harness.paths.logDir, name), "utf8")).join("\n");
      assert.equal(logs.includes(SENSITIVE_QUERY), false, "查询文本不得写入请求日志");
      assert.equal(logs.includes(FAKE_AGY_TOKEN), false, "AGY access token 不得写入请求日志");
      assert.equal(logs.includes(CLIENT_OAUTH), false, "Codex OAuth 不得写入请求日志");
    } finally {
      handler.close();
      harness.restoreGlobalFetch();
      fs.rmSync(harness.directory, { recursive: true, force: true });
    }
  });
}

test("没有 webSearchModelIds 时返回 search_unavailable，不调用默认上游", TIMEOUT, async () => {
  const harness = createHarness(false);
  const upstreamCalls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    upstreamCalls.push(String(input));
    return Response.json({ error: "must not escape" }, { status: 503 });
  }) as unknown as typeof fetch;
  const handler = harness.createHandler({
    credentials: async () => credential(),
    fetch: async (url) => {
      upstreamCalls.push(url);
      if (url.includes(":fetchAvailableModels")) return Response.json(catalogData(false));
      throw new Error(`没有搜索模型时不应推理：${url}`);
    },
  });
  try {
    await handler.modelsReady();
    const response = await handler(alphaSearchRequest({ search_query: [{ q: "weather" }] }));
    assert.equal(response.status, 503);
    assert.equal((await response.json() as Json).error.type, "search_unavailable");
    assert.equal(upstreamCalls.some((url) => url.includes(":generateContent")), false);
    assert.equal(upstreamCalls.some((url) => url.includes("/alpha/search")), false);
  } finally {
    handler.close();
    harness.restoreGlobalFetch();
    fs.rmSync(harness.directory, { recursive: true, force: true });
  }
});

test("过期 AGY 凭据返回 401，搜索前不请求目录或推理上游", TIMEOUT, async () => {
  const harness = createHarness(false);
  let outboundCalls = 0;
  globalThis.fetch = (async () => {
    outboundCalls++;
    return Response.json({});
  }) as unknown as typeof fetch;
  const handler = harness.createHandler({
    refreshCatalogOnStart: false,
    credentials: async () => credential(true),
    fetch: async () => {
      outboundCalls++;
      return Response.json(catalogData());
    },
  });
  try {
    const response = await handler(alphaSearchRequest({ search_query: [{ q: "weather" }] }));
    assert.equal(response.status, 401);
    assert.equal((await response.json() as Json).error.type, "authentication_error");
    assert.equal(outboundCalls, 0);
  } finally {
    handler.close();
    harness.restoreGlobalFetch();
    fs.rmSync(harness.directory, { recursive: true, force: true });
  }
});

test("取消客户端 Alpha Search 会中止正在进行的 AGY generateContent 调用", TIMEOUT, async () => {
  const harness = createHarness(false);
  let signalSeen: AbortSignal | undefined;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
  const handler = harness.createHandler({
    credentials: async () => credential(),
    fetch: async (url, init) => {
      if (url.includes(":fetchAvailableModels")) return Response.json(catalogData());
      signalSeen = init.signal as AbortSignal;
      signalStarted();
      return new Promise<Response>((_resolve, reject) => {
        signalSeen!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  });
  try {
    await handler.modelsReady();
    const controller = new AbortController();
    const pending = handler(alphaSearchRequest({ search_query: [{ q: "weather" }] }, controller.signal));
    await started;
    controller.abort();
    const response = await pending;
    assert.equal(response.status, 504);
    assert.equal(signalSeen!.aborted, true);
    assert.equal((await response.json() as Json).error.type, "search_error");
  } finally {
    handler.close();
    harness.restoreGlobalFetch();
    fs.rmSync(harness.directory, { recursive: true, force: true });
  }
});
