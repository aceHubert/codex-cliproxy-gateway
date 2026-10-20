import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";
import { createGatewayHandler } from "../apps/gateway/src/gateway-composition.ts";
import { agentConfigEnabled } from "../apps/gateway/src/config.ts";
import { validateConfiguredPlugins } from "../apps/gateway/src/plugin-config.ts";
import { collectCompatibleModels } from "../apps/gateway/src/cli.ts";
import {
  OPENCODE_ZEN_CLIENT_USER_AGENT,
  OPENCODE_ZEN_AGENT_SYSTEM_PROMPT,
} from "@agent-proxy/opencode-zen/fingerprint";
import { getCodexBaselineEntry } from "@agent-proxy/models";
import { OPENCODE_SESSION_PATTERN } from "@agent-proxy/opencode-zen/session";
import { createOpencodeZenAdapter, normalizeOpencodeZenUpstreamError, validateOpencodeZenConfig } from "@agent-proxy/opencode-zen";
import type { OpencodeZenDependencies } from "@agent-proxy/opencode-zen";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

import { matchesPluginUpgrade } from "./plugin-routing-fixture.ts";

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
  const previousRuntimeHome = process.env.CODEX_CLIPROXY_HOME;
  process.env.CODEX_CLIPROXY_HOME = directory;
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: true,
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
  };
  fs.writeFileSync(path.join(directory, "cliproxy-catalog.json"), JSON.stringify({ models: [{ slug: "test-cpa", priority: 0 }] }));
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
          if (target.endsWith("/inference/v1/models")) {
            return Response.json({ object: "list", data: [
              { id: "nemotron-3.5-lightning-free" },
              { id: "exo-free" },
              { id: "claude-opus-5" },
            ] });
          }
          if (target.endsWith("/inference/v1/chat/completions")) {
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
    if (previousRuntimeHome === undefined) delete process.env.CODEX_CLIPROXY_HOME;
    else process.env.CODEX_CLIPROXY_HOME = previousRuntimeHome;
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
      fetchMetadata: async () => ({}), probeModel: async () => "chat-completions" as const,
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
    const zenUpstreamOnly = { ...config, upstreamOnly: true };
    const adapter = createOpencodeZenAdapter(zenUpstreamOnly, {
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

test("Zen 启动刷新强制重拉元数据：重启即手动更新窗口，不受元数据 TTL 限制", TIMEOUT, async () => {
  await fixture(async ({ config, directory }) => {
    // 预置「新鲜」磁盘缓存：ids 已含新上线模型，元数据（TTL 内新鲜）缺它的条目——
    // 若启动刷新不强制重拉元数据，目录会直接复用磁盘元数据，新模型继续无窗口字段。
    const ids = ["space-bunny-free", "deepseek-v4.1-flash-free"];
    fs.writeFileSync(path.join(directory, "opencode-zen-metadata.json"), `${JSON.stringify({
      fetched_at: Date.now(),
      content_hash: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
      ids,
      metadata: { fetched_at: Date.now(), models: { "space-bunny-free": { deprecated: false, free: true } } },
    }, null, 2)}\n`);
    let catalogFetches = 0;
    let metadataFetches = 0;
    const adapter = createOpencodeZenAdapter(config, {
      cacheDirectory: directory,
      projectId: "a".repeat(40),
      fetch: async () => { catalogFetches++; return Response.json({ data: ids.map((id) => ({ id })) }); },
      fetchMetadata: async () => {
        metadataFetches++;
        return { opencode: { models: {
          "space-bunny-free": { cost: { input: 0, output: 0 }, limit: { context: 1_048_576 } },
          "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 }, limit: { context: 200_000 } },
        } } };
      },
      userAgentStore: { current: () => OPENCODE_ZEN_CLIENT_USER_AGENT, refresh: async () => {} },
      setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    try {
      const catalog = await adapter.catalog();
      assert.equal(catalogFetches, 1, "启动强制拉模型列表");
      assert.equal(metadataFetches, 1, "启动强制重拉元数据（绕过 6 小时 TTL）");
      const deepseek = catalog.models.find((model) => model.slug === "opencode-zen/deepseek-v4.1-flash-free");
      assert.equal(deepseek?.context_window, 200_000, "新模型窗口随启动强制刷新就位");
    } finally { adapter.close(); }
  });
});

test("zen 配置校验：检查类型和环回监听，过时 prefix 不影响校验", () => {
  const base: GatewayConfig = {
    zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1", catalogPath: "/tmp/catalog.json",
  };
  assert.equal(agentConfigEnabled(base, "opencodeZen"), false);
  assert.equal(agentConfigEnabled({ ...base, opencodeZen: true }, "opencodeZen"), true);
  const upstreamOnlyView = { ...base, opencodeZen: true, upstreamOnly: true };
  assert.equal(agentConfigEnabled(upstreamOnlyView, "opencodeZen"), true);
  assert.throws(() => validateConfiguredPlugins({ ...base, opencodeZen: 1 as unknown as boolean }), /opencodeZen 必须为 boolean/);
  assert.throws(() => validateOpencodeZenConfig({ ...base, host: "0.0.0.0", opencodeZen: true }), /环回/);
  assert.doesNotThrow(() => validateOpencodeZenConfig({ ...base, prefix: "opencode-zen/", opencodeZen: true }));
  const loopbackView = { ...base, host: "0.0.0.0", opencodeZen: true, upstreamOnly: true };
  assert.throws(() => validateOpencodeZenConfig(loopbackView), /环回/);
});

test("上游错误归一化：分类为 zen_* 并原样透传上游描述", () => {
  const free403 = normalizeOpencodeZenUpstreamError(403, JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }));
  assert.equal(free403.status, 403);
  assert.equal(free403.type, "zen_free_tier_error");
  assert.equal(free403.message, "OpenCode's free tier can only be used from within OpenCode");
  const limited = normalizeOpencodeZenUpstreamError(429, JSON.stringify({ error: { type: "FreeUsageLimitError", message: "rate limited" } }));
  assert.equal(limited.status, 429);
  assert.equal(limited.type, "zen_rate_limited");
  assert.equal(limited.message, "rate limited");
  const gone = normalizeOpencodeZenUpstreamError(404, JSON.stringify({ error: { message: "model nemotron-not-exist not found" } }));
  assert.equal(gone.status, 404);
  assert.equal(gone.type, "zen_model_unavailable");
  assert.equal(gone.message, "model nemotron-not-exist not found");
  const generic = normalizeOpencodeZenUpstreamError(500, "internal");
  assert.equal(generic.status, 500);
  assert.equal(generic.type, "zen_upstream_error");
  // 上游没给 message 时才是中性兜底：只述事实，不含修复指引。
  assert.equal(generic.message, "internal");
  const emptyBody = normalizeOpencodeZenUpstreamError(429, "");
  assert.equal(emptyBody.type, "zen_rate_limited");
  assert.match(emptyBody.message, /限流/);
  assert.ok(!/指纹数据|fingerprint-data/.test(emptyBody.message), "兜底文案不得写死修复指引");
  // JSON 结构合法但没有描述：不透裸 JSON，走分类对应的中性兜底。
  const silentJson = normalizeOpencodeZenUpstreamError(503, JSON.stringify({ error: { type: "server_error" } }));
  assert.equal(silentJson.status, 503);
  assert.equal(silentJson.type, "zen_upstream_error");
  assert.ok(!silentJson.message.includes("{"), "不得把裸 JSON 当描述透给客户端");
  // `null` 等标量报文不得抛错。
  assert.equal(normalizeOpencodeZenUpstreamError(502, "null").type, "zen_upstream_error");
});

test("上游错误归一化：403 按上游 error.type 分归类，不再一律算门禁失效", () => {
  // 区域限制：同为 403，但详情是地区不可用——不能误报成指纹失效。
  const region = normalizeOpencodeZenUpstreamError(403, JSON.stringify({ type: "error", error: { type: "RegionError", message: "This model is not available in your country" } }));
  assert.equal(region.status, 403);
  assert.equal(region.type, "zen_region_error");
  assert.equal(region.message, "This model is not available in your country");
  // 门禁失效仍是 FreeTierError 归类。
  const gate = normalizeOpencodeZenUpstreamError(403, JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }));
  assert.equal(gate.type, "zen_free_tier_error");
});

test("上游错误归一化：403 server_error（模型端点失效）不归为门禁失效", () => {
  // 2026-10-14 实证：cat-jam-free 上游端点已下线，返回 403 server_error；
  // 旧实现按「任何 403 都是门禁」把它归成 zen_free_tier_error 并引导用户升级指纹。
  const body = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } });
  const result = normalizeOpencodeZenUpstreamError(403, body);
  assert.equal(result.status, 403);
  assert.equal(result.type, "zen_model_unavailable");
  assert.equal(result.message, "Upstream request failed: Endpoint is unavailable.");
  assert.ok(!/指纹|fingerprint/i.test(result.message), "不得把上游故障引导成升级指纹");
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

test("chat/completions 转发：指纹标头注入、前缀剥除、占位垫补与强制流式注入", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create();
    const response = await handler(chatRequest(MODEL, { stream: true }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(await response.text(), /TIME_WAIT/);
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.equal(up.url, "https://opencode.ai/inference/v1/chat/completions");
    assert.equal(up.headers["user-agent"], OPENCODE_ZEN_CLIENT_USER_AGENT);
    assert.equal(up.headers.authorization, "Bearer public");
    assert.equal(up.headers["x-opencode-client"], "cli");
    assert.match(up.headers["x-opencode-project"], /^[0-9a-f]{40}$/);
    assert.match(up.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const session = up.headers["x-opencode-session"];
    assert.match(session, OPENCODE_SESSION_PATTERN);
    assert.equal(up.headers["x-opencode-session-id"], session, "门禁硬性要求（缺失 403）");
    assert.equal(up.headers["x-session-affinity"], session);
    assert.equal(up.headers["x-session-id"], session);
    // 请求体：剥前缀、强制流式、消息原样透传（无工具也合并官方定义）、缓存键对齐会话。
    assert.equal(up.body.model, "nemotron-3.5-lightning-free");
    assert.equal(up.body.stream, true);
    assert.equal(up.body.prompt_cache_key, session);
    assert.equal(String(up.body.messages[0].content), "解释 TCP TIME_WAIT 状态", "不注入模板，客户端消息原样在最前");
    assert.deepEqual(
      (up.body.tools as Json[]).map((tool) => tool.function.name),
      ["read"],
      "无工具流量同样合并官方 read 定义",
    );
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

test("会话连续性：Codex 的 session-id 头确定性复用同一上游会话，已带合规头原样透传", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const captured: string[] = [];
    const handler = create(undefined, {      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [] });
        if (target.endsWith("/inference/v1/chat/completions")) {
          const headers = new Headers(init?.headers);
          captured.push(headers.get("x-opencode-session") ?? "");
          assert.equal(headers.get("x-opencode-session-id"), headers.get("x-opencode-session"), "四件套镜像同一会话");
          return sse([chunkFrame({ content: "ok" }), chunkFrame({}, "stop")]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    // Codex 实发形态：session-id 与 thread-id 同值（另带 originator 等）。
    const codexHeaders = { "session-id": "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45", "thread-id": "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45", originator: "codex_exec" };
    await handler(chatRequest(MODEL, { stream: true }, codexHeaders));
    // 旧契约形态 x-session-id 与无 thread-id 的兜底同样稳定。
    await handler(chatRequest(MODEL, { stream: true }, { "X-Session-Id": "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45" }));
    await handler(chatRequest(MODEL, { stream: true }, { "session-id": "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45" }));
    await handler(chatRequest(MODEL, { stream: true }, { "thread-id": "another-conv" }));
    assert.equal(captured.length, 4);
    assert.equal(captured[0], captured[1], "同一外部会话（不同标头来源）必须派生同一 Zen 会话");
    assert.equal(captured[1], captured[2], "派生跨请求稳定（无进程内状态依赖）");
    assert.notEqual(captured[2], captured[3], "不同外部会话必须派生不同 Zen 会话");
    assert.match(captured[0], OPENCODE_SESSION_PATTERN);
    // 已带合法 x-opencode-session 的请求原样透传，不做转换。
    await handler(chatRequest(MODEL, { stream: true }, { "x-opencode-session": "ses_3a4ee6335ffedFB8f76BPU1Eb3", "session-id": "ignored" }));
    assert.equal(captured[4], "ses_3a4ee6335ffedFB8f76BPU1Eb3");
  });
});

test("非流式客户端：上游强制流式、网关聚合为完整 chat.completion JSON", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [] });
        if (target.endsWith("/inference/v1/chat/completions")) {
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
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [] });
        if (target.endsWith("/inference/v1/chat/completions")) {
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
    assert.ok(names.includes("read"), "门禁要求合并官方 read 定义");
    assert.equal(names.length, 2, "最小合并面：只补 read，不并入其余官方工具");
    assert.equal(String(up.body.messages[0].content), "解释 TCP TIME_WAIT 状态", "system 内容不注入模板（首条就是客户端消息）");
  });
});

test("上游 403/429 归一化为带指引的错误；网络故障 502", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const forbidden = create(undefined, {
      fetch: async (url) => {
        if (String(url).endsWith("/inference/v1/models")) return Response.json({ data: [] });
        return new Response(JSON.stringify({ error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }), { status: 403, headers: { "content-type": "application/json" } });
      },
    });
    const denied = await forbidden(chatRequest(MODEL, { stream: true }));
    assert.equal(denied.status, 403);
    const payload = await denied.json() as Json;
    assert.equal(payload.error.type, "zen_free_tier_error");
    assert.equal(payload.error.message, "OpenCode's free tier can only be used from within OpenCode");

    const limited = create(undefined, {
      fetch: async (url) => {
        if (String(url).endsWith("/inference/v1/models")) return Response.json({ data: [] });
        return new Response(JSON.stringify({ error: { type: "FreeUsageLimitError", message: "too many" } }), { status: 429 });
      },
    });
    const throttled = await limited(chatRequest(MODEL, { stream: true }));
    assert.equal(throttled.status, 429);
    assert.equal(((await throttled.json()) as Json).error.type, "zen_rate_limited");

    const broken = create(undefined, {
      fetch: async (url) => {
        if (String(url).endsWith("/inference/v1/models")) return Response.json({ data: [] });
        throw new Error("connection reset");
      },
    });
    const failed = await broken(chatRequest(MODEL, { stream: true }));
    assert.equal(failed.status, 502);
    assert.equal(((await failed.json()) as Json).error.type, "upstream_error");
  });
});

test("Responses 入口：responses 协议模型直通（模型替换 + 指纹标头，SSE 原样）", TIMEOUT, async () => {
  const nativeStream = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\"}}\n\n"
    + `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "native_custom", call_id: "native_call", name: "apply_patch", input: "*** Begin Patch\n*** End Patch", status: "completed" } })}\n\n`
    + "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n";
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "echo-responses-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: { "echo-responses-free": { provider: { npm: "@ai-sdk/openai" } } } } });
        }
        if (target.endsWith("/inference/v1/responses")) {
          fixture.upstream = { url: target, headers: headersToObject(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
          return new Response(nativeStream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        throw new Error(`未模拟调用 ${target}`);
      },
      probeModel: async () => "chat-completions",
    });
    // 协议路由依赖元数据：先触发一次目录刷新（/v1/models）再发 responses 请求。
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opencode-zen/echo-responses-free",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }],
        stream: true,
      }),
    }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text, nativeStream, "原生 Responses 的 custom 调用应原样直通");
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.equal(up.url, "https://opencode.ai/inference/v1/responses");
    assert.equal(up.body.model, "echo-responses-free");
    assert.deepEqual((up.body.tools as Json[]).find((tool) => tool.name === "apply_patch"), { type: "custom", name: "apply_patch", format: { type: "text" } });
    assert.equal(up.headers["user-agent"], OPENCODE_ZEN_CLIENT_USER_AGENT);
    assert.match(up.headers["x-opencode-session"] ?? "", OPENCODE_SESSION_PATTERN);
    assert.match(up.body.prompt_cache_key ?? "", OPENCODE_SESSION_PATTERN);
  });
});

test("Responses 入口：muse-spark 剥离 additional_tools 信封并原样提升工具声明，剥离 web_search 参数", TIMEOUT, async () => {
  const nativeStream = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\"}}\n\n"
    + "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n";
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "muse-spark-1.3-contributor-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: { "muse-spark-1.3-contributor-free": { provider: { npm: "@ai-sdk/openai" } } } } });
        }
        if (target.endsWith("/inference/v1/responses")) {
          fixture.upstream = { url: target, headers: headersToObject(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
          return new Response(nativeStream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        throw new Error(`未模拟调用 ${target}`);
      },
      probeModel: async () => "chat-completions",
    });
    // 协议路由依赖元数据：先触发一次目录刷新（/v1/models）再发 responses 请求。
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    // Codex 0.162 线格式：全部工具声明在 input[0] 的 additional_tools 信封项里。
    const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opencode-zen/muse-spark-1.3-contributor-free",
        input: [
          { type: "additional_tools", role: "developer", tools: [
            { type: "namespace", name: "functions", tools: [
              { type: "function", name: "send_user_message_async", description: "send", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, strict: false },
              { type: "custom", name: "exec", format: { type: "text" } },
            ] },
            { type: "namespace", name: "repl", tools: [{ type: "custom", name: "js", format: { type: "text" } }] },
            { type: "web_search", search_content_types: ["news"] },
          ] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
        tools: [{ type: "web_search_preview", search_content_types: ["news"] }],
        stream: true,
      }),
    }));
    assert.equal(response.status, 200);
    await response.text();
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    const input = up.body.input as Json[];
    assert.equal(input.length, 1, "additional_tools 信封项应从 input 剥离");
    assert.equal(input[0]!.type, "message");
    const tools = up.body.tools as Json[];
    const namespaced = tools.find((tool) => tool.type === "namespace")!;
    assert.deepEqual(namespaced, { type: "namespace", name: "functions", description: "functions", tools: [
      { type: "function", name: "send_user_message_async", description: "send", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, strict: false },
    ] }, "namespace 声明原样提升（空 description 以名字占位、custom 工具丢弃），不展平不改名");
    assert.equal(tools.some((tool) => tool.type === "namespace" && tool.name === "repl"), false, "内层只剩 custom 的 namespace 应整体丢弃");
    assert.equal(tools.some((tool) => tool.type === "custom"), false, "custom 工具声明应被丢弃");
    assert.equal(tools.some((tool) => tool.type === "function" && tool.name === "read"), true, "门禁 read 工具应仍在场");
    assert.equal("search_content_types" in (tools.find((tool) => tool.type === "web_search") ?? {}), false, "web_search 的 search_content_types 应剥离");
    assert.deepEqual(tools.find((tool) => tool.type === "web_search_preview"), { type: "web_search_preview", search_content_types: ["news"] }, "web_search_preview 的参数应保留");
  });
});

test("Responses 入口：非 muse-spark 的 responses 协议模型不受净化影响", TIMEOUT, async () => {
  const nativeStream = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\"}}\n\n";
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "gpt-echo-responses" }] });
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: { "gpt-echo-responses": { provider: { npm: "@ai-sdk/openai" } } } } });
        }
        if (target.endsWith("/inference/v1/responses")) {
          fixture.upstream = { url: target, headers: headersToObject(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
          return new Response(nativeStream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        throw new Error(`未模拟调用 ${target}`);
      },
      probeModel: async () => "chat-completions",
    });
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opencode-zen/gpt-echo-responses",
        input: [
          { type: "additional_tools", role: "developer", tools: [
            { type: "web_search", search_content_types: ["news"] },
            { type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
          ] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
        stream: true,
      }),
    }));
    assert.equal(response.status, 200);
    await response.text();
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    const input = up.body.input as Json[];
    assert.equal(input.length, 2, "原生 Responses 保留 additional_tools 的历史位置");
    assert.deepEqual(input[0]!.tools, [
      { type: "web_search", search_content_types: ["news"] },
      { type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ], "非 muse-spark 原样保留声明和搜索参数");
    assert.ok((up.body.tools as Json[]).some((tool) => tool.name === "read"), "历史信封里的 read 不替代门禁所检查的顶层声明");
  });
});

test("Responses 入口：chat 协议模型经严格转换（模板注入 + tool 历史重建）", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "nemotron-3.5-lightning-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: { "nemotron-3.5-lightning-free": {} } } });
        }
        if (target.endsWith("/inference/v1/chat/completions")) {
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
          { type: "additional_tools", role: "developer", tools: [
            { type: "function", name: "lookup_issue", description: "lookup", parameters: { type: "object", properties: { issue: { type: "number" } } } },
          ] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "look up 42" }] },
          { type: "function_call", call_id: "call_1", name: "lookup_issue", arguments: "{\"issue\":42}" },
          { type: "function_call_output", call_id: "call_1", output: "issue 42: example" },
        ],
        stream: true,
      }),
    }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /issue 42 done/);
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.equal(up.url, "https://opencode.ai/inference/v1/chat/completions");
    const messages = up.body.messages as Json[];
    assert.ok(String(messages[0]!.content).startsWith("SYS-INSTR"), "客户端 instructions 原样成为首条 system（不注入模板）");
    assert.ok(messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls[0].id === "call_1"));
    assert.ok(messages.some((message) => message.role === "tool" && message.tool_call_id === "call_1"));
    assert.deepEqual((up.body.tools as Json[]).map((tool) => tool.function.name), ["lookup_issue", "read"], "真实工具先保留，再增补门禁 read");
    assert.equal(up.body.stream, true);
  });
});

test("Responses 增补的 custom 工具经过 Zen 门禁后仍可调用并还原命名空间", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "nemotron-3.5-lightning-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: { "nemotron-3.5-lightning-free": {} } } });
        }
        if (target.endsWith("/inference/v1/chat/completions")) {
          const body = JSON.parse(String(init?.body)) as Json;
          const tools = body.tools as Json[];
          const exec = tools.find((tool) => tool.function.name !== "read");
          assert.ok(exec, "门禁 read 之外必须保留真实工具");
          assert.equal(tools.length, 2);
          return sse([
            chunkFrame({ role: "assistant", tool_calls: [{
              index: 0, id: "call_exec", type: "function",
              function: { name: exec.function.name, arguments: JSON.stringify({ input: "return 1;" }) },
            }] }),
            chunkFrame({}, "tool_calls"),
          ]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, stream: false, input: [
        { type: "additional_tools", role: "developer", tools: [{
          type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "执行工具", format: { type: "text" } }],
        }] },
        { role: "user", content: "执行工具" },
      ] }),
    }));
    assert.equal(response.status, 200);
    const result = await response.json() as Json;
    const call = (result.output as Json[]).find((item) => item.type === "custom_tool_call");
    assert.ok(call);
    assert.equal(call.name, "exec");
    assert.equal(call.namespace, "functions");
    assert.equal(call.call_id, "call_exec");
    assert.equal(call.input, "return 1;");
  });
});

test("Messages 入口：chat 协议模型经转换渲染为 Anthropic 事件，anthropic 协议模型直通", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "nemotron-3.5-lightning-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          return Response.json({ opencode: { models: { "nemotron-3.5-lightning-free": {} } } });
        }
        if (target.endsWith("/inference/v1/chat/completions")) {
          fixture.upstream = { url: target, headers: headersToObject(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
          return sse([
            chunkFrame({ role: "assistant", content: "chat 源回答" }),
            chunkFrame({}, "stop"),
          ]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    // /v1/messages：chat 协议模型 → 单跳转换 + Anthropic 事件渲染。
    const response = await handler(new Request("http://127.0.0.1:8327/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opencode-zen/nemotron-3.5-lightning-free",
        system: "SYS-INSTR",
        max_tokens: 512,
        messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
        stream: true,
      }),
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /message_start/);
    assert.match(body, /chat 源回答/);
    assert.match(body, /message_stop/);
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.equal(up.url, "https://opencode.ai/inference/v1/chat/completions");
    const messages = up.body.messages as Json[];
    assert.ok(messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("你好")));
  });

  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "nemotron-3.5-lightning-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          // 元数据 provider.npm 决定模型端点协议（@ai-sdk/anthropic → /messages 直通）；
          // 元数据存在的模型不进入探针，协议由 npm 映射而来。
          return Response.json({ opencode: { models: { "nemotron-3.5-lightning-free": { provider: { npm: "@ai-sdk/anthropic" } } } } });
        }
        if (target.endsWith("/inference/v1/messages")) {
          upstreamSeen = true;
          return new Response(anthropicSse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    let upstreamSeen = false;
    // anthropic 协议模型直通：原协议请求体替换模型 id 后原样返回；handler 消费
    // dependencies.fetch，直通 mock 与目录 mock 走同一注入点。
    const anthropicSse = [
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"up\",\"role\":\"assistant\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"直通回答\"}}",
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}",
    ].join("\n\n") + "\n\n";
    // protocol() 同步读目录缓存：先用 /v1/models 预热（内部等待目录刷新完成），
    // 探针裁决为 anthropic 后转发才走直通分支。
    const warmup = await handler(new Request("http://127.0.0.1:8327/v1/models"));
    await warmup.text();
    const passthrough = await handler(new Request("http://127.0.0.1:8327/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opencode-zen/nemotron-3.5-lightning-free",
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "直通" }] }],
        stream: true,
      }),
    }));
    assert.equal(passthrough.status, 200);
    const text = await passthrough.text();
    assert.match(text, /直通回答/);
    assert.match(text, /message_stop/);
    assert.ok(upstreamSeen, "anthropic 协议模型必须直通上游 /messages");
  });
});
for (const stream of [true, false]) {
  test(`Responses 入口：chat 上游的 custom 与 function 调用按客户端声明还原（stream=${stream}）`, TIMEOUT, async () => {
    const patch = "*** Begin Patch\n*** Update File: 中文.txt\n@@\n-旧内容\n+包含\\路径与\"引号\"的新内容\n*** End Patch";
    const aliasInput = "第二个自定义工具\n独立输入";
    const calls = [
      { id: "call_patch", name: "apply_patch", arguments: JSON.stringify({ input: patch }) },
      { id: "call_alias", name: "submit_edit", arguments: JSON.stringify({ input: aliasInput }) },
      { id: "call_lookup", name: "lookup_issue", arguments: JSON.stringify({ issue: 42 }) },
    ];
    const frames = [chunkFrame({ role: "assistant" })];
    calls.forEach((call, index) => {
      frames.push(chunkFrame({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }));
      // 按字符拆分，确保中文、换行与转义跨上游分片仍能完整还原。
      for (const character of call.arguments) {
        frames.push(chunkFrame({ tool_calls: [{ index, function: { arguments: character } }] }));
      }
    });
    frames.push(chunkFrame({}, "tool_calls"));
    await fixture(async (fixture) => {
      const handler = fixture.create();
      const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL, input: "修改文件并查询问题", stream,
          tools: [
            { type: "custom", name: "apply_patch", format: { type: "text" } },
            { type: "custom", name: "submit_edit", format: { type: "text" } },
            { type: "function", name: "lookup_issue", parameters: { type: "object", properties: { issue: { type: "number" } } } },
          ],
        }),
      }));
      assert.equal(response.status, 200);
      let output: Json[];
      if (stream) {
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
        const events = (await response.text()).split("\n")
          .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
          .map((line) => JSON.parse(line.slice(5)) as Json);
        output = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item as Json);
        for (const [name, input] of [["apply_patch", patch], ["submit_edit", aliasInput]]) {
          const item = output.find((entry) => entry.name === name);
          assert.ok(item, `必须返回 ${name} 调用`);
          const deltas = events.filter((event) => event.type === "response.custom_tool_call_input.delta" && event.item_id === item.id);
          assert.equal(deltas.map((event) => event.delta).join(""), input);
          assert.ok(events.some((event) => event.type === "response.custom_tool_call_input.done" && event.item_id === item.id && event.input === input));
          assert.ok(events.some((event) => event.type === "response.output_item.added" && event.item?.id === item.id && event.item.type === "custom_tool_call"));
          assert.ok(!events.some((event) => event.type.startsWith("response.function_call_arguments.") && event.item_id === item.id));
        }
      } else {
        assert.match(response.headers.get("content-type") ?? "", /application\/json/);
        const payload = await response.json() as Json;
        assert.equal(payload.object, "response");
        assert.equal(payload.status, "completed");
        output = payload.output as Json[];
      }
      assert.equal(output.length, calls.length);
      for (const [name, callId, input] of [["apply_patch", "call_patch", patch], ["submit_edit", "call_alias", aliasInput]]) {
        const item = output.find((entry) => entry.name === name);
        assert.ok(item, `必须按工具名还原 ${name}`);
        assert.equal(item.type, "custom_tool_call");
        assert.equal(item.call_id, callId);
        assert.equal(item.input, input);
        assert.equal(item.status, "completed");
        assert.ok(!("arguments" in item));
      }
      const lookup = output.find((entry) => entry.name === "lookup_issue");
      assert.ok(lookup);
      assert.equal(lookup.type, "function_call");
      assert.equal(lookup.call_id, "call_lookup");
      assert.equal(lookup.arguments, JSON.stringify({ issue: 42 }));
      assert.ok(!("input" in lookup));
      const upstream = fixture.upstream as NonNullable<Fixture["upstream"]>;
      const tools = upstream.body.tools as Json[];
      for (const name of ["apply_patch", "submit_edit"]) {
        const tool = tools.find((entry) => entry.function.name === name);
        assert.equal(tool?.type, "function");
        assert.deepEqual(tool?.function.parameters.required, ["input"]);
      }
      assert.ok(tools.some((tool) => tool.function.name === "read"), "合并门禁要求的官方 read 定义");
      assert.equal(upstream.body.stream, true);
    }, () => sse(frames));
  });
}

for (const stream of [true, false]) {
  test(`Responses 入口：无原 tools 时合并的官方 read 定义保持 function 调用（stream=${stream}）`, TIMEOUT, async () => {
    const arguments_ = "{}";
    await fixture(async (fixture) => {
      const handler = fixture.create();
      const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "查询工作目录", stream }),
      }));
      assert.equal(response.status, 200);
      let output: Json[];
      if (stream) {
        const events = (await response.text()).split("\n")
          .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
          .map((line) => JSON.parse(line.slice(5)) as Json);
        assert.ok(events.some((event) => event.type === "response.completed"));
        output = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item as Json);
      } else {
        const result = await response.json() as Json;
        assert.equal(result.status, "completed");
        output = result.output as Json[];
      }
      assert.equal(output.length, 1);
      const call = output.find((item) => item.name === "read");
      assert.ok(call);
      assert.equal(call.type, "function_call");
      assert.equal(call.call_id, `call_gate_read`);
      assert.equal(call.arguments, arguments_);
      assert.ok(!("input" in call));
      const upstream = fixture.upstream as NonNullable<Fixture["upstream"]>;
      const tools = upstream.body.tools as Json[];
      assert.deepEqual(tools.map((tool) => tool.function.name), ["read"]);
      for (const tool of tools) {
        assert.ok(Object.keys(tool.function.parameters ?? {}).length > 0, "合并的是官方真实定义（空 schema 占位已被门禁拒绝）");
      }
    }, () => sse([
      chunkFrame({ tool_calls: [{ index: 0, id: "call_gate_read", type: "function", function: { name: "read", arguments: arguments_ } }] }),
      chunkFrame({}, "tool_calls"),
    ]));
  });

  test(`Responses 入口：不在客户端或门禁合并中的名称仍然失败（stream=${stream}）`, TIMEOUT, async () => {
    await fixture(async ({ create }) => {
      const response = await create()(new Request("http://127.0.0.1:8327/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "测试", stream,
          tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }],
        }),
      }));
      if (stream) {
        assert.equal(response.status, 200);
        const events = (await response.text()).split("\n")
          .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
          .map((line) => JSON.parse(line.slice(5)) as Json);
        assert.ok(events.some((event) => event.type === "response.failed"));
        assert.equal(events.some((event) => event.type === "response.completed"), false);
      } else {
        assert.equal(response.status, 502);
        const result = await response.json() as Json;
        assert.equal(result.status, "failed");
      }
    }, () => sse([
      chunkFrame({ tool_calls: [{ index: 0, id: "call_unknown", type: "function", function: { name: "not_an_injected_tool", arguments: "{}" } }] }),
      chunkFrame({}, "tool_calls"),
    ]));
  });
}

for (const stream of [true, false]) {
  test(`Messages 入口：chat 上游合并的官方 read 调用返回 Anthropic 工具条目（stream=${stream}）`, TIMEOUT, async () => {
    await fixture(async (fixture) => {
      const response = await fixture.create()(new Request("http://127.0.0.1:8327/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, system: "客户端系统指令", max_tokens: 512,
          messages: [{ role: "user", content: "测试占位调用" }], stream,
        }),
      }));
      assert.equal(response.status, 200);
      let content: Json[];
      if (stream) {
        const events = (await response.text()).split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)) as Json);
        assert.ok(events.some((event) => event.type === "message_stop"));
        content = events.filter((event) => event.type === "content_block_start").map((event) => event.content_block as Json);
        assert.ok(events.some((event) => event.type === "message_delta" && event.delta.stop_reason === "tool_use"));
      } else {
        const message = await response.json() as Json;
        assert.equal(message.stop_reason, "tool_use");
        content = message.content as Json[];
      }
      const call = content.find((item) => item.type === "tool_use" && item.name === "read");
      assert.ok(call);
      assert.equal(call.id, `call_message_read`);
      assert.deepEqual(call.input, {});
      const upstream = fixture.upstream as NonNullable<Fixture["upstream"]>;
      assert.deepEqual((upstream.body.tools as Json[]).map((tool) => tool.function.name), ["read"]);
      assert.equal(upstream.body.messages[0].content, "客户端系统指令", "不注入 OpenCode 模板");
      assert.equal(upstream.body.stream, true);
    }, () => sse([
      chunkFrame({ tool_calls: [{ index: 0, id: "call_message_read", type: "function", function: { name: "read", arguments: "{}" } }] }),
      chunkFrame({}, "tool_calls"),
    ]));
  });

  test(`Messages 入口：上游门禁错误保留原始描述（stream=${stream}）`, TIMEOUT, async () => {
    const message = "OpenCode's free tier can only be used from within OpenCode";
    await fixture(async ({ create }) => {
      const handler = create(undefined, {
        fetch: async (url) => {
          if (String(url).endsWith("/inference/v1/models")) return Response.json({ data: [] });
          return Response.json({ error: { type: "FreeTierError", message } }, { status: 403 });
        },
      });
      const response = await handler(new Request("http://127.0.0.1:8327/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 512, messages: [{ role: "user", content: "测试" }], stream }),
      }));
      assert.equal(response.status, 403);
      const payload = await response.json() as Json;
      assert.equal(payload.error.type, "zen_free_tier_error");
      assert.equal(payload.error.message, message);
    });
  });
}

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
      if (target.startsWith("https://chatgpt.com/")) {
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
        if (target.endsWith("/inference/v1/models")) {
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
      probeModel: async (id) => (id === "jev-1.13-free" ? "drop" : "chat-completions"),
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

test("Zen WebSocket 握手本地拒绝，令客户端降级 HTTPS/SSE", TIMEOUT, async () => {
  await fixture(async ({ create, config }) => {
    const handler = create();
    for (const model of [MODEL, "opencode-zen/exo-free"]) {
      const upgrade = new Request("http://127.0.0.1:8327/v1/responses", {
        headers: { upgrade: "websocket", "x-codex-routing-hint": `model=${model}` },
      });
      assert.equal(matchesPluginUpgrade(upgrade, config, "opencode-zen"), true);
      const response = await handler(upgrade);
      assert.equal(response.status, 426);
      assert.equal(response.headers.get("x-codex-cliproxy-gateway"), "opencode-zen-http-only");
    }
    // 非 zen 模型、非 responses 路径、未启用开关三种情形都不拦截。
    const upgrade = (hint: string, url = "http://127.0.0.1:8327/v1/responses") => new Request(url, {
      headers: { upgrade: "websocket", "x-codex-routing-hint": `model=${hint}` },
    });
    assert.equal(matchesPluginUpgrade(upgrade("gpt-5.5"), config, "opencode-zen"), false);
    assert.equal(matchesPluginUpgrade(upgrade("OPENCODE-ZEN/exo-free"), config, "opencode-zen"), false, "插件模式区分大小写");
    assert.equal(matchesPluginUpgrade(upgrade(MODEL, "http://127.0.0.1:8327/v1/chat/completions"), config, "opencode-zen"), false);
    assert.equal(matchesPluginUpgrade(upgrade(MODEL), { ...config, opencodeZen: false }, "opencode-zen"), false);
    // 无升级头的普通 POST 不受影响。
    assert.equal(matchesPluginUpgrade(new Request("http://127.0.0.1:8327/v1/responses", { method: "POST" }), config, "opencode-zen"), false);
  });
});

test("Zen 大写前缀不命中插件，默认链路保留原始模型", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const handler = create();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => Response.json({ defaultModel: (await new Request(input, init).json() as Json).model })) as typeof fetch;
    try {
      const response = await handler(new Request("http://127.0.0.1:8327/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "OPENCODE-ZEN/exo-free", input: "测试" }),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { defaultModel: "OPENCODE-ZEN/exo-free" });
    } finally { globalThis.fetch = originalFetch; }
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

test("目录条目提示词回落：保留官方 Codex 提示词，不再替换为 OpenCode 模板", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create();
    const response = await handler(new Request("http://127.0.0.1:8327/v1/models?client_version=0.50.0"));
    assert.equal(response.status, 200);
    const raw = await response.json() as Json;
    const zen = (raw.models as Json[]).filter((entry) => String(entry.slug).startsWith("opencode-zen/"));
    assert.ok(zen.length > 0, "Codex 形状目录应含 zen 条目");
    const base = getCodexBaselineEntry();
    for (const entry of zen) {
      assert.equal(entry.base_instructions, base.base_instructions, `${entry.slug} 保留快照基底官方提示词`);
      assert.notEqual(entry.base_instructions, OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, `${entry.slug} 不再下发 OpenCode 提示词`);
      const messages = entry.model_messages as { instructions_template?: string } | undefined;
      assert.equal(messages?.instructions_template, (base.model_messages as { instructions_template?: string }).instructions_template, `${entry.slug} 的 instructions_template 同步回落（只改 base_instructions 无效）`);
    }
  });
});


test("gemini 客户端入口：URL 携带模型与流式，gemini 协议模型直通上游", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "exo-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          // 元数据 provider.npm 映射 @ai-sdk/google → gemini 端点协议。
          return Response.json({ opencode: { models: { "exo-free": { provider: { npm: "@ai-sdk/google" } } } } });
        }
        if (target.includes("/inference/v1/models/") && target.includes(":streamGenerateContent")) {
          fixture.upstream = { url: target, headers: headersToObject(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
          return new Response([
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "gemini 直通回答" }], role: "model" } }] })}`,
            `data: ${JSON.stringify({ candidates: [{ content: { role: "model" }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })}`,
          ].join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    // 目录预热：protocol() 同步读缓存后 gemini 转发走直通分支。
    const warmup = await handler(new Request("http://127.0.0.1:8327/v1/models"));
    await warmup.text();
    // gemini 客户端入口：model 与流式均由 URL 路径表达。
    const response = await handler(new Request("http://127.0.0.1:8327/v1/models/opencode-zen%2Fexo-free:streamGenerateContent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "你好" }] }] }),
    }));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /gemini 直通回答/);
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    assert.match(up.url, /\/inference\/v1\/models\/exo-free:streamGenerateContent\?alt=sse$/);
    assert.equal((up.body.contents as Json[])[0]?.role, "user");
  });
});

test("gemini 客户端入口：chat 协议模型单跳转换并渲染回 Gemini SSE", TIMEOUT, async () => {
  await fixture(async (fixture) => {
    const handler = fixture.create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/inference/v1/models")) return Response.json({ data: [{ id: "exo-free" }] });
        if (target === "https://models.opencode.ai/api.json") {
          // 元数据缺失时探针裁决协议；直接给出 chat 探针结果。
          return Response.json({ opencode: { models: {} } });
        }
        if (target.endsWith("/inference/v1/chat/completions")) {
          fixture.upstream = { url: target, headers: headersToObject(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
          return sse([
            chunkFrame({ role: "assistant", content: "chat 转 gemini 回答" }),
            chunkFrame({}, "stop"),
          ]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    const warmup = await handler(new Request("http://127.0.0.1:8327/v1/models"));
    await warmup.text();
    const response = await handler(new Request("http://127.0.0.1:8327/v1/models/opencode-zen%2Fexo-free:generateContent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "你好" }] }], systemInstruction: "sys" }),
    }));
    assert.equal(response.status, 200);
    const completion = await response.json() as Json;
    const candidate = (completion.candidates as Json[])[0]!;
    const parts = (candidate.content as Json).parts as Json[];
    assert.equal(parts.map((part) => part.text ?? "").join(""), "chat 转 gemini 回答");
    assert.equal(candidate.finishReason, "STOP");
    const up = fixture.upstream as NonNullable<Fixture["upstream"]>;
    const messages = up.body.messages as Json[];
    assert.ok(messages.some((message) => message.role === "system" && String(message.content).includes("sys")));
    assert.ok(messages.some((message) => JSON.stringify(message.content).includes("你好")));
  });
});
