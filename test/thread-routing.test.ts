import test from "./host-test.ts";
import assert from "node:assert/strict";
import { ThreadRoutingError, ThreadRoutingState } from "../apps/gateway/src/thread-routing.ts";
import { createGatewayHandler, responsesWebSocketTarget } from "../apps/gateway/src/gateway-composition.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

const config: GatewayConfig = {
  host: "127.0.0.1", port: 0, mountPath: "/v1", prefix: "cliproxy/",
  upstreamBaseUrl: "https://proxy.invalid/v1", officialBaseUrl: "https://official.invalid/v1",
  catalogPath: "", zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
};

test("线程树在根会话双向切换后动态跟随，并记住省略的父关系", () => {
  const state = new ThreadRoutingState();
  state.resolve("root", undefined, "cliproxy", true);
  assert.equal(state.resolve("child", "root", "official", true), "cliproxy");
  assert.equal(state.resolve("guardian", "child", "official", false), "cliproxy");
  for (const route of ["official", "cliproxy", "official"] as const) {
    state.resolve("root", undefined, route, true);
    assert.equal(state.resolve("child", undefined, "official", true), route);
    assert.equal(state.resolve("guardian", undefined, "official", true), route);
    assert.equal(state.get("root"), route);
  }
});

test("已确认的根路由不会被过时的预热模型覆盖", () => {
  const state = new ThreadRoutingState();
  state.resolve("root", undefined, "cliproxy", false);
  state.resolve("root", undefined, "official", true);
  assert.equal(state.resolve("root", undefined, "cliproxy", false), "official");
  state.resolve("root", undefined, "cliproxy", true);
  assert.equal(state.resolve("root", undefined, "official", false), "cliproxy");
});

test("父路由未建立时保留关系并要求重试，父会话就绪后自动恢复", () => {
  const state = new ThreadRoutingState();
  assert.throws(() => state.resolve("guardian", "root", "official", false), ThreadRoutingError);
  state.resolve("root", undefined, "cliproxy", true);
  assert.equal(state.resolve("guardian", undefined, "official", true), "cliproxy");
  assert.equal(state.get("root"), "cliproxy");
});

test("无效父链不会损坏已有继承关系", () => {
  const state = new ThreadRoutingState();
  state.resolve("root", undefined, "cliproxy", true);
  state.resolve("child", "root", "official", true);
  assert.throws(() => state.resolve("root", "child", "official", true), ThreadRoutingError);
  assert.throws(() => state.resolve("child", "other", "official", true), ThreadRoutingError);
  assert.throws(() => state.resolve("self", "self", "official", true), ThreadRoutingError);
  assert.equal(state.get("child"), "cliproxy");
  assert.equal(state.get("root"), "cliproxy");
});

test("主会话与 side 独立切换，子线程跟随所属根，历史图片 turn 仍走原上游", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; model?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { model?: string } : undefined;
    calls.push({ url: String(input), headers: new Headers(init?.headers), model: body?.model });
    return new Response("ok");
  }) as typeof fetch;
  const state = new ThreadRoutingState();
  const turns = new Set<string>();
  const handler = createGatewayHandler(config, "proxy-key", "invalid", state, turns);
  const send = async (thread: string, model: string, extra: Record<string, string> = {}) => {
    const response = await handler(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer official-oauth", "thread-id": thread,
        "x-codex-routing-hint": `model=${model}`, ...extra },
      body: JSON.stringify({ model, input: "hi" }),
    }));
    assert.equal(response.status, 200);
    return calls.at(-1)!;
  };
  try {
    await send("root", "cliproxy/model");
    await send("side", "cliproxy/model", { "x-codex-turn-metadata": JSON.stringify({
      thread_source: "user", history_initialization: "warm_fork", forked_from_thread_id: "root", turn_id: "side-cpa-turn",
    }) });
    assert.equal((await send("guardian", "codex-auto-review", { "x-codex-parent-thread-id": "side",
      "x-codex-turn-metadata": JSON.stringify({ turn_id: "inherited-cpa-turn" }) })).url,
      "https://proxy.invalid/v1/responses");
    assert.equal((await send("grandchild", "gpt-helper", { "x-codex-parent-thread-id": "guardian" })).url,
      "https://proxy.invalid/v1/responses");

    const switched = await send("side", "gpt-official");
    assert.equal(switched.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(switched.headers.get("authorization"), "Bearer official-oauth");
    assert.equal(state.get("root"), "cliproxy");
    assert.equal((await send("guardian", "codex-auto-review")).url, switched.url);
    assert.equal((await send("grandchild", "gpt-helper")).url, switched.url);

    const probe = responsesWebSocketTarget(new Request("http://localhost/v1/responses", {
      headers: { upgrade: "websocket", authorization: "Bearer official-oauth", "thread-id": "side",
        "x-codex-routing-hint": "model=cliproxy/old-prewarm-model" },
    }), config, "proxy-key", state, turns);
    assert.equal(probe?.routeKind, "official");
    assert.equal(probe?.headers.authorization, "Bearer official-oauth");

    const image = await handler(new Request("http://localhost/v1/images/generations", {
      method: "POST", headers: { "content-type": "application/json", "x-codex-image-turn-id": "side-cpa-turn" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "icon" }),
    }));
    assert.equal(image.status, 200);
    assert.equal(calls.at(-1)?.url, "https://proxy.invalid/v1/images/generations");
    assert.equal(calls.at(-1)?.headers.get("authorization"), "Bearer proxy-key");
    const inheritedImage = await handler(new Request("http://localhost/v1/images/generations", {
      method: "POST", headers: { "content-type": "application/json", "x-codex-image-turn-id": "inherited-cpa-turn" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "icon" }),
    }));
    assert.equal(inheritedImage.status, 200);
    assert.equal(calls.at(-1)?.url, "https://proxy.invalid/v1/images/generations");

    assert.equal((await send("side", "cliproxy/next-model")).url, "https://proxy.invalid/v1/responses");
    assert.equal((await send("guardian", "codex-auto-review")).url, "https://proxy.invalid/v1/responses");
    await send("root", "gpt-official");
    assert.equal(state.get("side"), "cliproxy");
    assert.equal((await send("title", "gpt-title")).url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(state.get("side"), "cliproxy");
  } finally {
    handler.close();
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 正文模型覆盖旧 hint，预热正文不覆盖已经确认的根选择", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const hints: Array<string | null> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    hints.push(new Headers(init?.headers).get("x-codex-routing-hint"));
    return new Response("ok");
  }) as unknown as typeof fetch;
  const state = new ThreadRoutingState(["root"]);
  const handler = createGatewayHandler(config, "proxy-key", "invalid", state);
  const request = (model: string, generate = true, hint = "cliproxy/old-default") => new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "thread-id": "root",
      "x-codex-routing-hint": `model=${hint}` },
    body: JSON.stringify({ model, generate, input: [] }),
  });
  try {
    assert.equal((await handler(request("gpt-official"))).status, 200);
    assert.equal(state.get("root"), "official");
    assert.equal(calls.at(-1), "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(hints.at(-1), null);
    assert.equal((await handler(request("cliproxy/old-default", false))).status, 200);
    assert.equal(state.get("root"), "official");
    assert.equal(calls.at(-1), "https://chatgpt.com/backend-api/codex/responses");
    assert.equal((await handler(request("cliproxy/current-model", true, "gpt-old-official"))).status, 200);
    assert.equal(state.get("root"), "cliproxy");
    assert.equal(calls.at(-1), "https://proxy.invalid/v1/responses");
    assert.equal(hints.at(-1), null);
  } finally {
    handler.close();
    globalThis.fetch = originalFetch;
  }
});

test("父路由缺失的 HTTP 请求返回可恢复错误且不向任何上游发送", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response("unexpected"); }) as unknown as typeof fetch;
  const handler = createGatewayHandler(config, "proxy-key", "invalid", new ThreadRoutingState());
  try {
    const response = await handler(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "thread-id": "child", "x-codex-parent-thread-id": "unknown",
        "x-codex-routing-hint": "model=gpt-helper" }, body: JSON.stringify({ model: "gpt-helper" }),
    }));
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
  } finally {
    handler.close();
    globalThis.fetch = originalFetch;
  }
});
