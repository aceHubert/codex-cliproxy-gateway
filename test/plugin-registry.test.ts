import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileModelPattern, identifyClientEndpoint, LazyRequestBody, modelPatternsOverlap, PluginRegistry,
  type GatewayPlugin, type HttpRequestContext, type WebSocketRequestContext, type WebSocketSession,
} from "../packages/plugin-api/src/index.ts";

function plugin(id: string, modelPatterns: string[], overrides: Partial<GatewayPlugin> = {}): GatewayPlugin {
  return {
    id, modelPatterns,
    handleHttp: () => new Response(id),
    getCatalog: () => ({ models: [{ slug: `${id}/model` }] }),
    refreshCatalog: async () => ({ models: [{ slug: `${id}/fresh` }] }),
    reloadCatalog: async () => ({ models: [{ slug: `${id}/disk` }] }),
    ready: async () => {},
    close: () => {},
    ...overrides,
  };
}

function httpContext(model: string, from: "chat-completions" | "responses" | "anthropic" = "responses", operation: "generate" | "compact" = "generate"): Omit<HttpRequestContext, "matchedPattern" | "matchedPrefix"> {
  const request = new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model }) });
  return { request, url: new URL(request.url), model, from, operation, signal: request.signal, body: new LazyRequestBody(request) };
}

function wsContext(model: string, upgrade: WebSocketRequestContext["upgrade"] = () => false): Omit<WebSocketRequestContext, "matchedPattern" | "matchedPrefix"> {
  const { body: _body, ...context } = httpContext(model);
  return { ...context, upgrade };
}

test("模型匹配保留大小写、不透明后缀及实际通配前缀", () => {
  const registry = new PluginRegistry([plugin("zcode", ["zcode/*", "zcode-*/*"])]);
  const match = registry.match("zcode-team-coding-plan/model-a/variant");
  assert.equal(match?.matchedPattern, "zcode-*/*");
  assert.equal(match?.matchedPrefix, "zcode-team-coding-plan/");
  assert.equal(match?.model, "zcode-team-coding-plan/model-a/variant");
  assert.equal(registry.match("zcode/model-a")?.matchedPrefix, "zcode/");
  assert.equal(registry.match("zcode-/model-a")?.matchedPrefix, "zcode-/");
  for (const model of ["zcode/", "zcode-team", "zcode-team/", "Zcode/model", "othercode/model", "zcode-team/other/"]) {
    if (model === "zcode-team/other/") assert.ok(registry.match(model));
    else assert.equal(registry.match(model), undefined);
  }
  assert.equal(compileModelPattern("zcode-*/*").match("zcode-a/b/model")?.matchedPrefix, "zcode-a/");
  assert.equal(compileModelPattern("a*bc/*").match("a/xbc/model"), undefined);
});

test("精确、固定和通配模式按规定优先级归属", () => {
  const registry = new PluginRegistry([
    plugin("wild", ["zcode-*/*"]),
    plugin("fixed", ["zcode-team/*"]),
    plugin("exact", ["zcode-team/model"]),
  ]);
  assert.equal(registry.match("zcode-team/model")?.plugin.id, "exact");
  assert.equal(registry.match("zcode-team/another")?.plugin.id, "fixed");
  assert.equal(registry.match("zcode-other/model")?.plugin.id, "wild");
  assert.equal(compileModelPattern("zcode-team/model").match("zcode-team/model")?.matchedPrefix, "");
});

test("注册拒绝重复 ID、重复模式、同优先级重叠与非法模式", () => {
  assert.throws(() => new PluginRegistry([plugin("x", ["a"]), plugin("x", ["b"])]), /ID/);
  assert.throws(() => new PluginRegistry([plugin("x", ["a", "a"])]), /重复模型模式/);
  assert.throws(() => new PluginRegistry([plugin("x", ["a"]), plugin("y", ["a"])]), /重复模型模式/);
  assert.throws(() => new PluginRegistry([plugin("x", ["a/*"]), plugin("y", ["a/b/*"])]), /归属不明确/);
  assert.throws(() => new PluginRegistry([plugin("x", ["a*/*"]), plugin("y", ["*b/*"])]), /归属不明确/);
  assert.doesNotThrow(() => new PluginRegistry([plugin("x", ["a*/*"]), plugin("y", ["b*/*"])]));
  assert.doesNotThrow(() => new PluginRegistry([plugin("x", ["a*/*", "*b/*"])]));
  for (const pattern of ["", " ", "model*", "/*", "a//b/*"]) assert.throws(() => compileModelPattern(pattern));
});

test("自动机交集覆盖多通配、长字面量、多段前缀及不相交语言", () => {
  const overlap = (a: string, b: string) => modelPatternsOverlap(compileModelPattern(a), compileModelPattern(b));
  assert.equal(overlap("a*b*c*/*", "a*c*b*/*"), true);
  assert.equal(overlap("a*b*c/*", "a*b*d/*"), false);
  assert.equal(overlap("*x*/foo/*", "*y*/foo/*"), true);
  assert.equal(overlap("a*/foo/*", "a*/bar/*"), false);
  assert.equal(overlap("a*/foo/*", "a*/*"), true);
  assert.equal(overlap("abc", "abc/*"), false);
  assert.equal(overlap("abc/def", "abc/*"), true);
  const literal = "a".repeat(100);
  assert.equal(overlap(`${literal}*z/*`, `*${literal}z/*`), true);
  assert.equal(overlap("a/*", "A/*"), false);
});

test("惰性正文并发解析只读取一次且保留原始字节", async () => {
  let reads = 0;
  const request = new Request("http://localhost", { method: "POST", body: ' { "model": "zcode/a" }\n' });
  const original = request.arrayBuffer.bind(request);
  request.arrayBuffer = async () => { reads++; return original(); };
  const body = new LazyRequestBody(request);
  assert.equal(request.bodyUsed, false);
  const [raw, parsed, again] = await Promise.all([body.bytes(), body.json(), body.json()]);
  assert.equal(reads, 1);
  assert.equal(parsed, again);
  assert.deepEqual(parsed, { model: "zcode/a" });
  assert.equal(new TextDecoder().decode(raw), ' { "model": "zcode/a" }\n');
  raw.fill(0);
  assert.equal(new TextDecoder().decode(await body.bytes()), ' { "model": "zcode/a" }\n');
});

test("JSON 解析失败不会消耗第二次正文且原始字节仍然可用", async () => {
  const body = new LazyRequestBody(new Request("http://localhost", { method: "POST", body: "{broken" }));
  const first = body.json();
  await assert.rejects(first, SyntaxError);
  assert.equal(body.json(), first);
  assert.equal(new TextDecoder().decode(await body.bytes()), "{broken");
});

test("客户端入口识别覆盖 Chat Completions、Responses、Messages、compact 与本地路由边界", () => {
  assert.deepEqual(identifyClientEndpoint("/v1/chat/completions"), { from: "chat-completions", operation: "generate" });
  assert.deepEqual(identifyClientEndpoint("/v1/messages"), { from: "anthropic", operation: "generate" });
  assert.deepEqual(identifyClientEndpoint("/v1/responses"), { from: "responses", operation: "generate" });
  assert.deepEqual(identifyClientEndpoint("/v1/responses/compact"), { from: "responses", operation: "compact" });
  assert.deepEqual(identifyClientEndpoint("/proxy/responses", "/proxy/"), { from: "responses", operation: "generate" });
  assert.deepEqual(identifyClientEndpoint("/responses", "/"), { from: "responses", operation: "generate" });
  for (const path of ["/ui", "/v1/ui/api/config", "/v1/realtime", "/responses", "/v10/responses", "/v1/responses/extra", "/v1/responses/", "/v1/messages/count_tokens", "/v1/messages/"]) {
    assert.equal(identifyClientEndpoint(path), undefined);
  }
});

test("HTTP handler 接收所有协议与操作上下文且返回 SSE 或普通响应", async () => {
  const captured: HttpRequestContext[] = [];
  const registry = new PluginRegistry([plugin("zcode", ["zcode-*/*"], {
    handleHttp(context) {
      captured.push(context);
      return new Response(context.from === "responses" ? "{}" : "data: done\n\n", { headers: { "content-type": context.from === "responses" ? "application/json" : "text/event-stream" } });
    },
  })]);
  for (const [from, operation] of [["chat-completions", "generate"], ["responses", "generate"], ["responses", "compact"], ["anthropic", "generate"]] as const) {
    const context = httpContext("zcode-team/a", from, operation);
    const response = await registry.dispatchHttp(context, () => { throw new Error("意外进入 default"); });
    const actual = captured.at(-1)!;
    assert.equal(actual.request, context.request);
    assert.equal(actual.body, context.body);
    assert.equal(actual.signal, context.request.signal);
    assert.equal(actual.from, from);
    assert.equal(actual.operation, operation);
    assert.equal(actual.matchedPrefix, "zcode-team/");
    assert.equal(actual.matchedPattern, "zcode-*/*");
    assert.equal(response.headers.get("content-type"), from === "responses" ? "application/json" : "text/event-stream");
  }
});

test("派发前可按插件跳过候选，派发后的拒绝和错误不会回退 default", async () => {
  let defaultCalls = 0;
  let rejectedCalls = 0;
  const registry = new PluginRegistry([
    plugin("exact", ["a/model", "a/*"], { handleHttp: () => { rejectedCalls++; return new Response("拒绝", { status: 400 }); } }),
    plugin("wild", ["a*/*"]),
  ]);
  const fallback = () => { defaultCalls++; return new Response("default"); };
  const filtered: string[] = [];
  assert.equal(await (await registry.dispatchHttp(httpContext("a/model"), fallback, (candidate) => { filtered.push(candidate.id); return candidate.id !== "exact"; })).text(), "wild");
  assert.deepEqual(filtered, ["exact", "wild"]);
  assert.equal((await registry.dispatchHttp(httpContext("a/model"), fallback)).status, 400);
  assert.equal(rejectedCalls, 1);
  assert.equal(defaultCalls, 0);
  await registry.dispatchHttp(httpContext("other"), fallback);
  assert.equal(defaultCalls, 1);
  const broken = new PluginRegistry([plugin("bad", ["bad/*"], { handleHttp: () => { throw new Error("服务语义错误"); } })]);
  await assert.rejects(broken.dispatchHttp(httpContext("bad/model"), fallback), /服务语义错误/);
  assert.equal(defaultCalls, 1);
});

test("HTTP handler 不能通过 undefined 结果隐式回退 default", async () => {
  let defaultCalls = 0;
  const registry = new PluginRegistry([plugin("bad", ["bad/*"], { handleHttp: (() => undefined) as unknown as GatewayPlugin["handleHttp"] })]);
  await assert.rejects(registry.dispatchHttp(httpContext("bad/model"), () => { defaultCalls++; return new Response(); }), /必须返回 Response/);
  assert.equal(defaultCalls, 0);
});

test("HTTP-only WS 握手返回 426，HTTP 重试仍命中原插件", async () => {
  for (const websocket of [undefined, false]) {
    let httpCalls = 0;
    let wsCalls = 0;
    let upstreamCalls = 0;
    let defaultCalls = 0;
    const registry = new PluginRegistry([plugin("agent", ["agent/*"], {
      websocket,
      handleHttp: () => { httpCalls++; return new Response("SSE"); },
      handleWebSocket: () => { wsCalls++; upstreamCalls++; return new Response(); },
    })]);
    const response = await registry.dispatchWebSocket(wsContext("agent/model", () => { upstreamCalls++; return true; }), () => { defaultCalls++; return new Response(); });
    assert.equal(response?.status, 426);
    assert.equal(response?.headers.get("x-agent-proxy-websocket"), "unsupported");
    assert.equal(response?.headers.get("x-codex-cliproxy-gateway"), "agent-http-only");
    assert.deepEqual([httpCalls, wsCalls, upstreamCalls, defaultCalls], [0, 0, 0, 0]);
    assert.equal(await (await registry.dispatchHttp(httpContext("agent/model"), () => { defaultCalls++; return new Response(); })).text(), "SSE");
    assert.deepEqual([httpCalls, wsCalls, upstreamCalls, defaultCalls], [1, 0, 0, 0]);
  }
});

test("WebSocket 声明必须为布尔且提供实际入口", () => {
  assert.throws(() => new PluginRegistry([plugin("bad", ["bad/*"], { websocket: true })]), /handleWebSocket/);
  assert.throws(() => new PluginRegistry([plugin("bad", ["bad/*"], { websocket: "true" as unknown as boolean })]), /布尔/);
});

test("WS handler 通过真实 upgrade 及会话回调接管连接", async () => {
  let registered: WebSocketSession | undefined;
  let message = "";
  let defaultCalls = 0;
  const registry = new PluginRegistry([plugin("agent", ["agent-*/*"], {
    websocket: true,
    handleWebSocket(context) {
      assert.equal(context.matchedPrefix, "agent-provider/");
      assert.equal(context.upgrade({ message: (_socket, data) => { message = String(data); } }), true);
      return undefined;
    },
  })]);
  const result = await registry.dispatchWebSocket(wsContext("agent-provider/model", (session) => { registered = session; return true; }), () => { defaultCalls++; return new Response(); });
  assert.equal(result, undefined);
  assert.ok(registered);
  await registered.message({ send: () => {}, close: () => {} }, "hello");
  assert.equal(message, "hello");
  assert.equal(defaultCalls, 0);
});

test("WS 升级失败及插件握手拒绝不会进入 default", async () => {
  let defaults = 0;
  const fallback = () => { defaults++; return new Response(); };
  const rejected = new PluginRegistry([plugin("agent", ["agent/*"], { websocket: true, handleWebSocket: () => new Response("拒绝", { status: 403 }) })]);
  assert.equal((await rejected.dispatchWebSocket(wsContext("agent/model"), fallback))?.status, 403);
  const failed = new PluginRegistry([plugin("agent", ["agent/*"], { websocket: true, handleWebSocket: (context) => { context.upgrade({ message: () => {} }); return undefined; } })]);
  await assert.rejects(failed.dispatchWebSocket(wsContext("agent/model"), fallback), /未升级/);
  assert.equal(defaults, 0);
  await failed.dispatchWebSocket(wsContext("other/model"), fallback);
  assert.equal(defaults, 1);
});

test("注册器目录与 refresh、纯磁盘 reload、就绪和 close 保持分离", async () => {
  const events: string[] = [];
  const registry = new PluginRegistry([plugin("agent", ["agent/*"], {
    getCatalog: () => { events.push("catalog"); return { models: [{ slug: "agent/cached" }] }; },
    refreshCatalog: async () => { events.push("network"); return { models: [{ slug: "agent/fresh" }] }; },
    reloadCatalog: async () => { events.push("disk"); return { models: [{ slug: "agent/reloaded" }] }; },
    ready: async () => { events.push("ready"); },
    close: () => { events.push("close"); },
  })]);
  await registry.ready();
  assert.equal((await registry.getCatalog()).models[0].slug, "agent/cached");
  assert.equal((await registry.reloadCatalog()).models[0].slug, "agent/reloaded");
  assert.equal((await registry.refreshCatalog()).models[0].slug, "agent/fresh");
  const first = registry.close();
  assert.equal(registry.close(), first);
  await first;
  assert.deepEqual(events, ["ready", "catalog", "disk", "network", "close"]);
});

test("一个插件关闭失败仍关闭其它插件并共享失败回执", async () => {
  let closed = 0;
  const registry = new PluginRegistry([
    plugin("a", ["a/*"], { close: () => { throw new Error("关闭失败"); } }),
    plugin("b", ["b/*"], { close: () => { closed++; } }),
  ]);
  const result = registry.close();
  await assert.rejects(result, AggregateError);
  assert.equal(closed, 1);
  assert.equal(registry.close(), result);
});
