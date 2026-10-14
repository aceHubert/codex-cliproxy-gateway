import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginRegistry, type GatewayPlugin, type HttpRequestContext } from "@agent-proxy/plugin-api";
import { createPluginGatewayHandler, startPluginGateway, responsesWebSocketTarget } from "../apps/gateway/src/gateway.ts";
import { checkFrameRouting } from "../apps/gateway/src/realtime.ts";
import { resolvePaths, runWithInstancePaths } from "../apps/gateway/src/paths.ts";
import { codexCatalogFile } from "../apps/gateway/src/model-state.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

const TIMEOUT = { timeout: 60_000 };

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-plugin-gateway-"));
  const paths = resolvePaths({ HOME: directory, CODEX_HOME: path.join(directory, "codex") }, path.join(directory, "runtime"));
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [{ slug: "upstream-model" }] }));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 0, mountPath: "/v1", prefix: "cliproxy/",
    upstreamBaseUrl: "http://127.0.0.1:9/v1", officialBaseUrl: "http://127.0.0.1:9/official",
    catalogPath: paths.catalogFile,
  };
  return { directory, paths, config };
}

function plugin(overrides: Partial<GatewayPlugin> = {}): GatewayPlugin {
  return {
    id: "example", modelPatterns: ["example/*", "example-*/*"],
    handleHttp: async (context) => Response.json({ model: context.model }),
    getCatalog: () => ({ models: [{ slug: "example/model" }] }),
    refreshCatalog: async () => ({ models: [{ slug: "example/model" }] }),
    reloadCatalog: async () => ({ models: [{ slug: "example/model" }] }),
    ready: async () => {}, close: () => {}, ...overrides,
  };
}

function request(model: string, pathname = "/v1/responses") {
  return new Request(`http://127.0.0.1${pathname}`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer private-client-oauth" },
    body: JSON.stringify({ model, input: "测试", stream: false }) });
}

test("插件 HTTP 收到协议、操作与实际匹配前缀，错误不会调用默认链路", TIMEOUT, async () => {
  const { directory, config } = fixture();
  const originalFetch = globalThis.fetch;
  const contexts: HttpRequestContext[] = [];
  let upstreamCalls = 0;
  const registry = new PluginRegistry([plugin({ handleHttp: async (context) => {
    contexts.push(context);
    assert.equal((await context.body.json() as { model: string }).model, context.model);
    return Response.json({ error: { message: "插件拒绝" } }, { status: 400 });
  } })]);
  globalThis.fetch = (async () => { upstreamCalls++; return Response.json({}); }) as unknown as typeof fetch;
  const handler = createPluginGatewayHandler(config, registry, "proxy-key");
  try {
    for (const pathname of ["/v1/responses", "/v1/responses/compact", "/v1/chat/completions", "/v1/messages"]) {
      assert.equal((await handler(request("example-team/provider/model", pathname))).status, 400);
    }
    assert.deepEqual(contexts.map(({ from, operation }) => [from, operation]),
      [["responses", "generate"], ["responses", "compact"], ["chat-completions", "generate"], ["anthropic", "generate"]]);
    assert.ok(contexts.every((context) => context.matchedPattern === "example-*/*" && context.matchedPrefix === "example-team/"));
    assert.equal(upstreamCalls, 0);
    assert.equal((await handler(request("example/model", "/ui/api/config"))).status, 404);
    assert.equal((await handler(request("example/model", "/outside"))).status, 404);
    assert.equal(upstreamCalls, 0);
  } finally {
    handler.close(); globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("默认上游原样保留兼容协议并移除客户端 OAuth", TIMEOUT, async () => {
  const { directory, config } = fixture();
  const originalFetch = globalThis.fetch;
  let forwarded: Request | undefined;
  let pluginCalls = 0;
  const registry = new PluginRegistry([plugin({ handleHttp: () => { pluginCalls++; return Response.json({}); } })]);
  globalThis.fetch = (async (url, options) => {
    forwarded = new Request(url, options);
    return Response.json({ id: "already-compatible", choices: [{ message: { content: "测试" } }] });
  }) as typeof fetch;
  const handler = createPluginGatewayHandler({ ...config, upstreamOnly: true }, registry, "proxy-key");
  try {
    const response = await handler(request("upstream-model", "/v1/chat/completions"));
    assert.equal((await response.json() as { id: string }).id, "already-compatible");
    assert.equal(pluginCalls, 0);
    assert.equal(forwarded?.headers.get("authorization"), "Bearer proxy-key");
    assert.equal((await forwarded?.json() as { model: string }).model, "upstream-model");
  } finally {
    handler.close(); globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP-only 插件握手本地 426，回落后仍由同一插件处理", TIMEOUT, async () => {
  const { directory, config } = fixture();
  const originalFetch = globalThis.fetch;
  let pluginCalls = 0;
  let upstreamCalls = 0;
  const registry = new PluginRegistry([plugin({ handleHttp: () => { pluginCalls++; return Response.json({}); } })]);
  globalThis.fetch = (async () => { upstreamCalls++; return Response.json({}); }) as unknown as typeof fetch;
  const handler = createPluginGatewayHandler(config, registry, "proxy-key");
  try {
    const upgrade = new Request("http://127.0.0.1/v1/responses", {
      headers: { upgrade: "websocket", "x-codex-routing-hint": "model=example/model" },
    });
    assert.equal((await handler(upgrade)).status, 426);
    assert.equal(pluginCalls, 0); assert.equal(upstreamCalls, 0);
    assert.equal(responsesWebSocketTarget(upgrade, config, "key", new Set(), new Set(), registry), null);
    assert.equal((await handler(request("example/model"))).status, 200);
    assert.equal(pluginCalls, 1); assert.equal(upstreamCalls, 0);
    assert.equal(checkFrameRouting('{"type":"response.create","model":"example/model"}', "cliproxy", "cliproxy/",
      (model) => registry.match(model)?.plugin.id).kind, "reject");
    assert.equal(registry.match("EXAMPLE/model"), undefined);
  } finally {
    handler.close(); globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("静态目录使用插件就绪、刷新与纯磁盘重载，关闭幂等", TIMEOUT, async () => {
  const { directory, config, paths } = fixture();
  const calls: string[] = [];
  const registry = new PluginRegistry([plugin({
    ready: async () => { calls.push("ready"); },
    refreshCatalog: async () => { calls.push("refresh"); return { models: [{ slug: "example/model" }] }; },
    reloadCatalog: async () => { calls.push("reload"); return { models: [{ slug: "example/new-model" }] }; },
    close: () => { calls.push("close"); },
  })]);
  const handler = createPluginGatewayHandler({ ...config, upstreamOnly: true }, registry, "key", "invalid",
    new Set(), new Set(), undefined, undefined, paths);
  try {
    await Promise.all([handler.modelsReady(), handler.modelsReady()]);
    assert.deepEqual(calls, ["ready", "refresh"]);
    const initial = JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")) as { models: Array<{ slug: string }> };
    assert.deepEqual(initial.models.map((model) => model.slug), ["upstream-model", "example/model"]);
    await handler.reloadConfig({ ...config, excludedModels: ["example/new-model"] });
    assert.deepEqual(calls, ["ready", "refresh", "reload"]);
    assert.equal((await handler(request("example/new-model"))).status, 404);
    const next = JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")) as { models: Array<{ slug: string }> };
    assert.deepEqual(next.models.map((model) => model.slug), ["upstream-model"]);
  } finally {
    handler.close(); handler.close(); await registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(calls.filter((call) => call === "close").length, 1);
});

test("声明 WS 能力的插件收到真实服务器升级与会话事件", TIMEOUT, async () => {
  const { directory, config, paths } = fixture();
  let handledMessages = 0;
  const registry = new PluginRegistry([plugin({
    websocket: true,
    handleWebSocket: (context) => context.upgrade({
      message: (socket, data) => { handledMessages++; socket.send(`插件回声：${data}`); },
    }) ? undefined : new Response("升级失败", { status: 400 }),
  })]);
  const server = runWithInstancePaths(paths, () => startPluginGateway(config, registry));
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/responses`, {
      headers: { "x-codex-routing-hint": "model=example/model" },
    } as unknown as string[]);
    const message = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("测试");
      socket.onmessage = (event) => { resolve(String(event.data)); socket.close(); };
      socket.onerror = () => reject(new Error("插件 WS 连接失败"));
    });
    assert.equal(message, "插件回声：测试");
    const crossModelSocket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/responses`, {
      headers: { "x-codex-routing-hint": "model=example/model" },
    } as unknown as string[]);
    const closeCode = await new Promise<number>((resolve, reject) => {
      crossModelSocket.onopen = () => crossModelSocket.send(JSON.stringify({ model: "upstream-model" }));
      crossModelSocket.onclose = (event) => resolve(event.code);
      crossModelSocket.onerror = () => reject(new Error("跨模型 WS 测试连接失败"));
    });
    assert.equal(closeCode, 1008);
    assert.equal(handledMessages, 1, "跨插件或默认模型的帧不得送进既有插件会话");
  } finally {
    server.stop(true); await registry.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
