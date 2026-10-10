import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayHandler, isOpencodeZenResponsesWebSocket } from "../src/gateway.ts";
import { collectCompatibleModels } from "../src/cli.ts";
import {
  OPENCODE_ZEN_CLIENT_USER_AGENT,
  OPENCODE_ZEN_AGENT_SYSTEM_PROMPT,
} from "../src/opencode/fingerprint.ts";
import { createSessionBindingCache, OPENCODE_SESSION_PATTERN } from "../src/opencode/session.ts";
import { createOpencodeZenAdapter, normalizeOpencodeZenUpstreamError, validateOpencodeZenConfig, opencodeZenEnabled } from "../src/opencode/index.ts";
import type { OpencodeZenDependencies } from "../src/opencode/index.ts";
import type { GatewayConfig } from "../src/types.ts";

type Json = Record<string, any>;
const TIMEOUT = { timeout: 60_000 };
const MODEL = "opencode-zen/nemotron-3.5-lightning-free";

function headersToObject(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => { record[key] = value; });
  return record;
}

/** 单帧 SSE 流；frames 为 data 载荷对象序列。 */
function sse(frames: Json[], doneFrame = true): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
    + (doneFrame ? "data: [DONE]\n\n" : "");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunkFrame(delta: Json, finish: string | null = null, id = "zen-test-1"): Json {
  return { id, object: "chat.completion.chunk", created: 1_790_000_000, model: "nemotron-3.5-lightning-free", choices: [{ index: 0, delta, finish_reason: finish }] };
}

interface Fixture {
  directory: string;
  config: GatewayConfig;
  create: (overrides?: Partial<GatewayConfig>, dependencies?: Partial<OpencodeZenDependencies>) => ReturnType<typeof createGatewayHandler>;
  upstream: { url: string; headers: Record<string, string>; body: Json } | undefined;
}

async function fixture(
  run: (fixture: Fixture) => Promise<void>,
  chatResponse: () => Response = () => sse([
    chunkFrame({ role: "assistant", content: "TIME_WAIT 是主动关闭方等待 2MSL 的状态" }),
    chunkFrame({}),
    chunkFrame({ content: "" }, "stop"),
  ]),
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zen-gateway-"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: true,
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
  };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [{ slug: "test-cpa", priority: 0 }] }));
  const handlers: Array<ReturnType<typeof createGatewayHandler>> = [];
  const originalFetch = globalThis.fetch;
  let upstream: Fixture["upstream"];
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/models")) return Response.json({ models: [{ slug: "gpt-native", priority: 0 }] });
    throw new Error("测试禁止未模拟的网络请求");
  }) as typeof fetch;
  try {
    await run({
      directory, config,
      get upstream() { return upstream; },
      set upstream(value) { upstream = value; },
      create(overrides = {}, dependencies = {}) {
        const defaultFetch = async (url: string, init?: RequestInit): Promise<Response> => {
          const target = String(url);
          if (target.endsWith("/zen/v1/models")) {
            return Response.json({ object: "list", data: [
              { id: "nemotron-3.5-lightning-free" },
              { id: "exo-free" },
              { id: "claude-opus-5" },
            ] });
          }
          if (target.endsWith("/zen/v1/chat/completions")) {
            upstream = {
              url: target,
              headers: headersToObject(new Headers(init?.headers)),
              body: JSON.parse(String(init?.body)),
            };
            assert.equal(new Headers(init?.headers).get("x-opencode-session")?.match(OPENCODE_SESSION_PATTERN) !== null, true);
            return chatResponse();
          }
          throw new Error(`未模拟的 zen 上游调用：${target}`);
        };
        const handler = createGatewayHandler({ ...config, ...overrides }, "fake-cpa-key", "invalid",
          new Set<string>(), new Set<string>(), path.join(directory, "models-cache.json"), undefined,
          { file: path.join(directory, "gateway.log"), maxBytes: 100_000 }, undefined, undefined, undefined,
          {
            cacheDirectory: directory,
            refreshCatalogOnStart: false,
            projectId: "a".repeat(40),
            ...dependencies,
            fetch: dependencies.fetch ?? defaultFetch,
          });
        handlers.push(handler);
        return handler;
      },
    } as Fixture);
  } finally {
    handlers.forEach((handler) => handler.close());
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function chatRequest(model = MODEL, extra: Json = {}, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:8327/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "解释 TCP TIME_WAIT 状态" }], ...extra }),
  });
}

test("合并排除规则只命中点名模型：未排除的 Zen 可用，其他兼容端仍在转发前拒绝", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const handler = create({ excludedModels: ["agy/hidden-model", "opencode-zen/exo-free"] });
    const listed = await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const models = await listed.json() as { data: Array<{ id: string }> };
    assert.ok(models.data.some((model) => model.id === MODEL));
    assert.ok(!models.data.some((model) => model.id === "opencode-zen/exo-free"));
    const blocked = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "agy/hidden-model", input: "test" }),
    }));
    assert.equal(blocked.status, 404);
    assert.equal(blocked.headers.get("x-codex-cliproxy-gateway"), "model-excluded");
    const response = await handler(chatRequest());
    assert.equal(response.status, 200);
    await response.text();
  });
});

test("普通兼容模型列表与排除选择器都包含 Zen", TIMEOUT, async () => {
  await fixture(async ({ config, directory }) => {
    const dependencies = { opencodeZen: {
      cacheDirectory: directory, refreshCatalogOnStart: false,
      fetch: async () => Response.json({ data: [{ id: "nemotron-3.5-lightning-free" }] }),
      fetchMetadata: async () => ({}), probeModel: async () => "chat" as const,
    } };
    const listed = await collectCompatibleModels(config, dependencies);
    assert.ok(listed.entries.some((model) => model.slug === MODEL));
    const selectable = await collectCompatibleModels(config, dependencies, { includeUpstream: false });
    assert.ok(selectable.entries.some((model) => model.slug === MODEL));
  });
});

test("Zen 手动目录只维护客户端指纹，查询和显式刷新等待同一次启动更新", TIMEOUT, async () => {
  await fixture(async ({ config, directory }) => {
    let fetches = 0;
    let uaRefreshes = 0;
    let callback!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = createOpencodeZenAdapter({ ...config, upstreamOnly: true }, {
      catalogMode: "manual", cacheDirectory: directory,
      fetch: async () => { fetches++; await gate; return Response.json({ data: [{ id: "nemotron-3.5-lightning-free" }] }); },
      fetchMetadata: async () => ({}),
      userAgentStore: { current: () => OPENCODE_ZEN_CLIENT_USER_AGENT, refresh: async () => { uaRefreshes++; } },
      setInterval: ((fn: () => void) => { callback = fn; return { unref() {} }; }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    try {
      const listed = adapter.catalog();
      const explicit = adapter.refreshCatalog();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fetches, 1);
      release();
      assert.equal((await listed).models[0]!.slug, MODEL);
      assert.equal((await explicit).models[0]!.slug, MODEL);
      callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fetches, 1);
      assert.equal(uaRefreshes, 2);
      await adapter.refreshCatalog();
      assert.equal(fetches, 2);
      assert.equal((await adapter.reloadCatalog()).models[0]!.slug, MODEL);
      assert.equal(fetches, 2);
    } finally { release(); adapter.close(); }
  });
});

test("zen 配置校验：类型、环回监听与前缀保留", () => {
  const base: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1", catalogPath: "/tmp/catalog.json",
  };
  assert.equal(opencodeZenEnabled(base), false);
  assert.equal(opencodeZenEnabled({ ...base, opencodeZen: true }), true);
  assert.equal(opencodeZenEnabled({ ...base, opencodeZen: true, upstreamOnly: true }), true);
  assert.throws(() => validateOpencodeZenConfig({ ...base, opencodeZen: 1 as unknown as boolean }), /opencodeZen 必须为 boolean/);
  assert.throws(() => validateOpencodeZenConfig({ ...base, host: "0.0.0.0", opencodeZen: true }), /环回/);
  assert.throws(() => validateOpencodeZenConfig({ ...base, prefix: "opencode-zen/", opencodeZen: true }), /前缀保留/);
  assert.throws(() => validateOpencodeZenConfig({ ...base, host: "0.0.0.0", opencodeZen: true, upstreamOnly: true }), /环回/);
});

test("上游错误归一化：FreeTierError/限流/模型失效给出明确指引", () => {
  const free403 = normalizeOpencodeZenUpstreamError(403, JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }));
  assert.equal(free403.status, 403);
  assert.equal(free403.type, "zen_free_tier_error");
  assert.match(free403.message, /指纹数据/);
  const limited = normalizeOpencodeZenUpstreamError(429, JSON.stringify({ error: { type: "FreeUsageLimitError", message: "rate limited" } }));
  assert.equal(limited.status, 429);
  assert.equal(limited.type, "zen_rate_limited");
  assert.match(limited.message, /限频/);
  const gone = normalizeOpencodeZenUpstreamError(404, JSON.stringify({ error: { message: "model nemotron-not-exist not found" } }));
  assert.equal(gone.status, 404);
  assert.equal(gone.type, "zen_model_unavailable");
  assert.match(gone.message, /动态轮换/);
  const generic = normalizeOpencodeZenUpstreamError(500, "internal");
  assert.equal(generic.status, 500);
  assert.equal(generic.type, "zen_upstream_error");
});

test("上游错误归一化：403 区域限制与门禁失效分开归类", () => {
  // 区域限制：同为 403，但详情是地区不可用——不能误报成指纹失效（探针分类同样视为被服务）。
  const region = normalizeOpencodeZenUpstreamError(403, JSON.stringify({ type: "error", error: { type: "RegionError", message: "This model is not available in your country" } }));
  assert.equal(region.status, 403);
  assert.equal(region.type, "zen_region_error");
  assert.match(region.message, /地区/);
  assert.ok(!region.message.includes("指纹数据"), "区域错误不得引导用户升级指纹");
  // 门禁失效仍是 FreeTierError 归类。
  const gate = normalizeOpencodeZenUpstreamError(403, JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }));
  assert.equal(gate.type, "zen_free_tier_error");
});

test("zen 动态目录合并进 OpenAI 与 Codex 模型列表，前缀格式统一", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const handler = create();
    const basic = await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const data = (await basic.json() as Json).data as Json[];
    const free = data.find((item) => item.id === MODEL);
    assert.ok(free, "OpenAI 列表必须包含免费模型");
    assert.equal(free.owned_by, "opencode-zen");
    assert.ok(!data.some((item) => item.id === "opencode-zen/claude-opus-5"), "付费模型不得进目录");
    const codex = await handler(new Request("http://127.0.0.1:8327/v1/models?client_version=1.0.0"));
    const models = (await codex.json() as Json).models as Json[];
    const entry = models.find((item) => item.slug === MODEL);
    assert.ok(entry);
    assert.equal(entry.display_name, "OP-ZEN/Nemotron 3.5 Lightning Free");
    const exo = models.find((item) => item.slug === "opencode-zen/exo-free");
    assert.ok(exo);
    assert.equal(exo.display_name, "OP-ZEN/Exo Free");
  });
});

test("chat/completions 转发：指纹标头注入、前缀剥除、模板与强制流式注入", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create();
    const response = await handler(chatRequest(MODEL, { stream: true }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(await response.text(), /TIME_WAIT/);
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.equal(up.url, "https://opencode.ai/zen/v1/chat/completions");
    assert.equal(up.headers["user-agent"], OPENCODE_ZEN_CLIENT_USER_AGENT);
    assert.equal(up.headers.authorization, "Bearer public");
    assert.equal(up.headers["x-opencode-client"], "cli");
    assert.match(up.headers["x-opencode-project"], /^[0-9a-f]{40}$/);
    assert.match(up.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const session = up.headers["x-opencode-session"];
    assert.match(session, OPENCODE_SESSION_PATTERN);
    assert.equal(up.headers["x-session-affinity"], session);
    assert.equal(up.headers["x-session-id"], session);
    // 请求体：剥前缀、强制流式、无工具走标题模板、缓存键对齐会话。
    assert.equal(up.body.model, "nemotron-3.5-lightning-free");
    assert.equal(up.body.stream, true);
    assert.equal(up.body.prompt_cache_key, session);
    assert.ok(String(up.body.messages[0].content).startsWith("You are a title generator"));
  });
});

test("OPENCODE_API_KEY 环境变量覆盖公共鉴权，未设置时回落 Bearer public", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create();
    const previous = process.env.OPENCODE_API_KEY;
    try {
      await handler(chatRequest(MODEL, { stream: true }));
      assert.equal((fixture.upstream as NonNullable<Fixture["upstream"]>).headers.authorization, "Bearer public");
      // 环境变量按请求时读取：设置后无需重建适配器即生效。
      process.env.OPENCODE_API_KEY = "zen-key-from-env";
      await handler(chatRequest(MODEL, { stream: true }));
      assert.equal((fixture.upstream as NonNullable<Fixture["upstream"]>).headers.authorization, "Bearer zen-key-from-env");
      // 显式注入的依赖 key 优先于环境变量（测试注入口）。
      const injected = fixture.create(undefined, { apiKey: "injected-key" });
      await injected(chatRequest(MODEL, { stream: true }));
      assert.equal((fixture.upstream as NonNullable<Fixture["upstream"]>).headers.authorization, "Bearer injected-key");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previous;
    }
  });
});

test("会话连续性：相同 X-Session-Id 复用同一上游会话，已带合规头原样透传", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const captured: string[] = [];
    const handler = create(undefined, {      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/zen/v1/models")) return Response.json({ data: [] });
        if (target.endsWith("/zen/v1/chat/completions")) {
          captured.push(new Headers(init?.headers).get("x-opencode-session") ?? "");
          return sse([chunkFrame({ content: "ok" }), chunkFrame({}, "stop")]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    await handler(chatRequest(MODEL, { stream: true }, { "X-Session-Id": "test-conv-1" }));
    await handler(chatRequest(MODEL, { stream: true }, { "X-Session-Id": "test-conv-1" }));
    await handler(chatRequest(MODEL, { stream: true }, { "X-Session-Id": "test-conv-2" }));
    assert.equal(captured.length, 3);
    assert.equal(captured[0], captured[1], "同一外部会话必须稳定复用同一 Zen 会话");
    assert.notEqual(captured[1], captured[2], "不同外部会话必须映射到不同 Zen 会话");
    assert.match(captured[0], OPENCODE_SESSION_PATTERN);
    // 已带合法 x-opencode-session 的请求原样透传，不做转换。
    await handler(chatRequest(MODEL, { stream: true }, { "x-opencode-session": "ses_3a4ee6335ffedFB8f76BPU1Eb3", "X-Session-Id": "ignored" }));
    assert.equal(captured[3], "ses_3a4ee6335ffedFB8f76BPU1Eb3");
  });
});

test("非流式客户端：上游强制流式、网关聚合为完整 chat.completion JSON", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/zen/v1/models")) return Response.json({ data: [] });
        if (target.endsWith("/zen/v1/chat/completions")) {
          return sse([
            chunkFrame({ role: "assistant", content: "TIME_WAIT " }),
            chunkFrame({ content: "是主动关闭方等待 2MSL 的状态" }),
            chunkFrame({ reasoning: "thinking..." }),
            chunkFrame({}, "stop"),
            { id: "zen-test-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } },
          ]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    const response = await handler(chatRequest(MODEL, { stream: false }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const payload = await response.json() as Json;
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.equal(payload.choices[0].message.role, "assistant");
    assert.match(payload.choices[0].message.content, /TIME_WAIT 是主动关闭方/);
    assert.equal(payload.usage.total_tokens, 10);
  });
});

test("工具调用：客户端工具与官方工具集合并转发，SSE 聚合还原 tool_calls", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/zen/v1/models")) return Response.json({ data: [] });
        if (target.endsWith("/zen/v1/chat/completions")) {
          fixture.upstream = {
            url: target,
            headers: headersToObject(new Headers(init?.headers)),
            body: JSON.parse(String(init?.body)),
          };
          return sse([
            chunkFrame({ role: "assistant" }),
            chunkFrame({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup_issue", arguments: "" } }] }),
            chunkFrame({ tool_calls: [{ index: 0, function: { arguments: "{\"issue\":" } }] }),
            chunkFrame({ tool_calls: [{ index: 0, function: { arguments: "42}" } }] }),
            chunkFrame({}, "tool_calls"),
          ]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    const response = await handler(chatRequest(MODEL, {
      stream: false,
      tools: [{ type: "function", function: { name: "lookup_issue", description: "lookup", parameters: { type: "object", properties: {} } } }],
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as Json;
    const call = payload.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "lookup_issue");
    assert.equal(call.function.arguments, "{\"issue\":42}");
    assert.equal(payload.choices[0].finish_reason, "tool_calls");
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    const tools = up.body.tools as Json[];
    const names = tools.map((tool) => tool.function.name);
    assert.ok(names.includes("lookup_issue"));
    assert.ok(names.includes("read") && names.includes("shell"), "官方工具集必须并入");
    assert.ok(String(up.body.messages[0].content).startsWith(AGENT_PROMPT_HEAD));
  });
});

test("上游 403/429 归一化为带指引的错误；网络故障 502", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const forbidden = create(undefined, {
      fetch: async (url) => {
        if (String(url).endsWith("/zen/v1/models")) return Response.json({ data: [] });
        return new Response(JSON.stringify({ error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }), { status: 403, headers: { "content-type": "application/json" } });
      },
    });
    const denied = await forbidden(chatRequest(MODEL, { stream: true }));
    assert.equal(denied.status, 403);
    const payload = await denied.json() as Json;
    assert.equal(payload.error.type, "zen_free_tier_error");
    assert.match(payload.error.message, /指纹数据/);

    const limited = create(undefined, {
      fetch: async (url) => {
        if (String(url).endsWith("/zen/v1/models")) return Response.json({ data: [] });
        return new Response(JSON.stringify({ error: { type: "FreeUsageLimitError", message: "too many" } }), { status: 429 });
      },
    });
    const throttled = await limited(chatRequest(MODEL, { stream: true }));
    assert.equal(throttled.status, 429);
    assert.equal(((await throttled.json()) as Json).error.type, "zen_rate_limited");

    const broken = create(undefined, {
      fetch: async (url) => {
        if (String(url).endsWith("/zen/v1/models")) return Response.json({ data: [] });
        throw new Error("connection reset");
      },
    });
    const failed = await broken(chatRequest(MODEL, { stream: true }));
    assert.equal(failed.status, 502);
    assert.equal(((await failed.json()) as Json).error.type, "upstream_error");
  });
});

test("Responses 入口：responses 协议模型直通（模型替换 + 指纹标头，SSE 原样）", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/zen/v1/models")) return Response.json({ data: [{ id: "muse-spark-1.3-contributor-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: { "muse-spark-1.3-contributor-free": { provider: { npm: "@ai-sdk/openai" } } } } });
        }
        if (target.endsWith("/zen/v1/responses")) {
          fixture.upstream = { url: target, headers: headersToObject(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
          return new Response(
            "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\"}}\n\n"
            + "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        throw new Error(`未模拟调用 ${target}`);
      },
      probeModel: async () => "chat",
    });
    // 协议路由依赖元数据：先触发一次目录刷新（/v1/models）再发 responses 请求。
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opencode-zen/muse-spark-1.3-contributor-free",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: true,
      }),
    }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /response\.completed/);
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.equal(up.url, "https://opencode.ai/zen/v1/responses");
    assert.equal(up.body.model, "muse-spark-1.3-contributor-free");
    assert.equal(up.headers["user-agent"], OPENCODE_ZEN_CLIENT_USER_AGENT);
    assert.match(up.headers["x-opencode-session"] ?? "", OPENCODE_SESSION_PATTERN);
    assert.match(up.body.prompt_cache_key ?? "", OPENCODE_SESSION_PATTERN);
  });
});

test("Responses 入口：chat 协议模型经严格转换（模板注入 + tool 历史重建）", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/zen/v1/models")) return Response.json({ data: [{ id: "nemotron-3.5-lightning-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: { "nemotron-3.5-lightning-free": {} } } });
        }
        if (target.endsWith("/zen/v1/chat/completions")) {
          fixture.upstream = { url: target, headers: headersToObject(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
          return sse([
            chunkFrame({ role: "assistant", content: "issue 42 done" }),
            chunkFrame({}, "stop"),
          ]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opencode-zen/nemotron-3.5-lightning-free",
        instructions: "SYS-INSTR",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "look up 42" }] },
          { type: "function_call", call_id: "call_1", name: "lookup_issue", arguments: "{\"issue\":42}" },
          { type: "function_call_output", call_id: "call_1", output: "issue 42: example" },
        ],
        tools: [{ type: "function", name: "lookup_issue", description: "lookup", parameters: { type: "object", properties: { issue: { type: "number" } } } }],
        stream: true,
      }),
    }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /issue 42 done/);
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.equal(up.url, "https://opencode.ai/zen/v1/chat/completions");
    const messages = up.body.messages as Json[];
    assert.ok(String(messages[0]!.content).startsWith(AGENT_PROMPT_HEAD), "chat 门禁模板注入");
    assert.ok(messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls[0].id === "call_1"));
    assert.ok(messages.some((message) => message.role === "tool" && message.tool_call_id === "call_1"));
    assert.equal(up.body.stream, true);
  });
});

test("Responses 入口：zen 模型的 compact 子树保持拒绝", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const handler = create();
    const response = await handler(new Request("http://127.0.0.1:8327/v1/responses/compact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: [] }),
    }));
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /compact/);
  });
});

test("非 zen 模型与关闭开关时：chat/completions 走通用转发不拦截", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    let cpaHits = 0;
    let officialHits = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.startsWith("https://cpa.invalid/")) {
        cpaHits++;
        return Response.json({ ok: true });
      }
      if (target.startsWith("https://official.invalid/")) {
        officialHits++;
        return Response.json({ ok: true });
      }
      if (target.includes("/models")) return Response.json({ models: [{ slug: "gpt-native", priority: 0 }] });
      throw new Error(`未模拟调用 ${target}`);
    }) as typeof fetch;
    try {
      const handler = create();
      // cliproxy/ 前缀模型：不拦截，透传第三方上游。
      const passthrough = await handler(chatRequest("cliproxy/test-cpa", { stream: true }));
      assert.equal(passthrough.status, 200);
      assert.equal(cpaHits, 1);
      // 关闭开关：zen 模型回到原行为（未知前缀 → 官方上游转发），不进 Zen 适配器。
      const disabled = create({ opencodeZen: false });
      const forwarded = await disabled(chatRequest(MODEL, { stream: true }));
      assert.equal(forwarded.status, 200);
      assert.equal(officialHits, 1);
      assert.equal(cpaHits, 1);
      // 开关关闭时 /v1/models 不含 zen 条目。
      const models = await (await disabled(new Request("http://127.0.0.1:8327/v1/models"))).json() as Json;
      assert.ok(!JSON.stringify(models).includes("opencode-zen/"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("zen 目录过滤：下线/非 chat 协议/探针剔除的模型不暴露", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const handler = create(undefined, {
      fetch: async (url) => {
        const target = String(url);
        if (target.endsWith("/zen/v1/models")) {
          return Response.json({ data: [
            { id: "nemotron-3.5-lightning-free" },
            { id: "muse-spark-1.3-contributor-free" },
            { id: "jev-1.13-free" },
            { id: "claude-opus-5" },
          ] });
        }
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: {
            "nemotron-3.5-lightning-free": { cost: { input: 0, output: 0 } },
            "muse-spark-1.3-contributor-free": { cost: { input: 0, output: 0 }, provider: { npm: "@ai-sdk/openai" } },
            "claude-opus-5": { cost: { input: 0.5, output: 1.5 } },
          } } });
        }
        throw new Error(`未模拟调用 ${target}`);
      },
      probeModel: async (id) => (id === "jev-1.13-free" ? "drop" : "chat"),
    });
    const response = await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const data = (await response.json() as Json).data as Json[];
    const opencodeZenIds = data.filter((item) => String(item.id).startsWith("opencode-zen/")).map((item) => String(item.id));
    assert.ok(opencodeZenIds.includes("opencode-zen/nemotron-3.5-lightning-free"));
    assert.ok(opencodeZenIds.includes("opencode-zen/muse-spark-1.3-contributor-free"), "非 chat 协议模型保留（按协议路由）");
    assert.ok(!opencodeZenIds.includes("opencode-zen/jev-1.13-free"), "探针 drop 的模型不得暴露");
    assert.ok(!opencodeZenIds.includes("opencode-zen/claude-opus-5"), "元数据 cost 非零的付费模型不得暴露");
  });
});

const AGENT_PROMPT_HEAD = OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.slice(0, 60);

test("Zen WebSocket 握手本地拒绝，令客户端降级 HTTPS/SSE", TIMEOUT, async () => {
  await fixture(async ({ create, config }) => {
    const handler = create();
    for (const model of [MODEL, "OPENCODE-ZEN/exo-free"]) {
      const upgrade = new Request("http://127.0.0.1:8327/v1/responses", {
        headers: { upgrade: "websocket", "x-codex-routing-hint": `model=${model}` },
      });
      assert.equal(isOpencodeZenResponsesWebSocket(upgrade, config), true);
      const response = await handler(upgrade);
      assert.equal(response.status, 426);
      assert.equal(response.headers.get("x-codex-cliproxy-gateway"), "opencode-zen-http-only");
    }
    // 非 zen 模型、非 responses 路径、未启用开关三种情形都不拦截。
    const upgrade = (hint: string, url = "http://127.0.0.1:8327/v1/responses") => new Request(url, {
      headers: { upgrade: "websocket", "x-codex-routing-hint": `model=${hint}` },
    });
    assert.equal(isOpencodeZenResponsesWebSocket(upgrade("gpt-5.5"), config), false);
    assert.equal(isOpencodeZenResponsesWebSocket(upgrade(MODEL, "http://127.0.0.1:8327/v1/chat/completions"), config), false);
    assert.equal(isOpencodeZenResponsesWebSocket(upgrade(MODEL), { ...config, opencodeZen: false }), false);
    // 无升级头的普通 POST 不受影响。
    assert.equal(isOpencodeZenResponsesWebSocket(new Request("http://127.0.0.1:8327/v1/responses", { method: "POST" }), config), false);
  });
});

test("UA 接线：转发标头使用版本存储的当前 UA", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    // upstream 是 fixture 上的取值器：必须请求后经 fixture 读，解构会拿到请求前的空值。
    const store = { current: () => "opencode/latest/2.0.26/cli", refresh: async () => {} };
    const handler = fixture.create({}, { userAgentStore: store });
    const response = await handler(chatRequest());
    assert.equal(response.status, 200);
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.equal(up.headers["user-agent"], "opencode/latest/2.0.26/cli");
    assert.equal(up.headers["x-opencode-client"], "cli", "其余指纹段不受 UA 覆盖影响");
  });
});

test("目录条目 base_instructions 为官方 agent 提示词（与其它适配器一致）", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create();
    const response = await handler(new Request("http://127.0.0.1:8327/v1/models?client_version=0.50.0"));
    assert.equal(response.status, 200);
    const raw = await response.json() as Json;
    const zen = (raw.models as Json[]).filter((entry) => String(entry.slug).startsWith("opencode-zen/"));
    assert.ok(zen.length > 0, "Codex 形状目录应含 zen 条目");
    for (const entry of zen) {
      assert.equal(entry.base_instructions, OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, `${entry.slug} 应下发官方提示词`);
      const messages = entry.model_messages as { instructions_template?: string } | undefined;
      assert.equal(messages?.instructions_template, OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, `${entry.slug} 的 instructions_template 必须替换，否则客户端仍发官方提示词`);
    }
  });
});
