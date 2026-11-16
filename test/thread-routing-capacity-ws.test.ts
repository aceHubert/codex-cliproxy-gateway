import assert from "node:assert/strict";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { PluginRegistry } from "@agent-proxy/plugin-api";
import { startPluginGateway } from "../apps/gateway/src/gateway.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";
import { ThreadRoutingState } from "../apps/gateway/src/thread-routing.ts";
import test from "./host-test.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

test("真实 WS 容量满额拒绝无 hint 握手，已连接的失败父声明不发上游", { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread-capacity-ws-"));
  let dials = 0;
  const received: string[] = [];
  let delayHandshake = false;
  let releaseHandshake!: () => void;
  let reachedHandshake!: () => void;
  const waiting = new Promise<void>((resolve) => { reachedHandshake = resolve; });
  const release = new Promise<void>((resolve) => { releaseHandshake = resolve; });
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      dials++;
      if (delayHandshake) { reachedHandshake(); await release; }
      if (server.upgrade(request)) return;
      return new Response("升级失败", { status: 400 });
    },
    websocket: { message(ws, message) { received.push(String(message)); ws.send(message); } },
  });
  const state = new ThreadRoutingState([], { maxEntries: 2 });
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 0, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: `${upstream.url}v1`,
    catalogPath: "", zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
  };
  const gateway = startPluginGateway(config, new PluginRegistry([]), "invalid", undefined, undefined, undefined,
    { apiKey: "", runtimePaths: resolvePaths({}, directory), threadRoutes: state });
  const address = new URL("/v1/responses", gateway.url);
  address.protocol = "ws:";
  const Client = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;
  const clients: WebSocket[] = [];
  const connect = async (thread: string) => {
    const client = new Client(address, { headers: { "thread-id": thread, "x-codex-routing-hint": "model=cliproxy/model" } });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("握手超时")), 2_000);
      client.onopen = () => { clearTimeout(timer); resolve(); };
      client.onerror = () => { clearTimeout(timer); reject(new Error("握手失败")); };
    });
    return client;
  };
  const handshake = (thread: string, hinted: boolean) => new Promise<{ status: number; retry?: string; body: string }>((resolve, reject) => {
    const url = new URL(address);
    url.protocol = "http:";
    const request = httpRequest(url, { headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "thread-id": thread,
      ...(hinted ? { "x-codex-routing-hint": "model=cliproxy/model" } : {}),
    } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, retry: response.headers["retry-after"], body }));
    });
    request.on("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("不应完成握手")); });
    request.on("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("握手响应超时")));
    request.end();
  });
  try {
    const root = await connect("root");
    state.resolve("root", undefined, "cliproxy", true);
    const provisional = await connect("provisional");
    assert.equal(dials, 2);
    const rejected = await handshake("new-without-hint", false);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.retry, undefined);
    assert.match(rejected.body, /thread_routing_capacity_exhausted/);
    assert.equal(dials, 2);

    // 异步拨号期间的新父声明被拒，升级客户端前必须重新检查该线程。
    delayHandshake = true;
    const inFlight = handshake("provisional", true);
    await waiting;
    assert.throws(() => state.resolve("provisional", "unregistered-parent", "official", true));
    releaseHandshake();
    assert.equal((await inFlight).status, 503);
    delayHandshake = false;
    assert.equal(dials, 3);
    const closed = new Promise<CloseEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接未因容量拒绝而关闭")), 2_000);
      provisional.onclose = (event) => { clearTimeout(timer); resolve(event); };
    });
    // 省略 model 和 parent 的帧同样检查已经失败关闭的线程状态。
    provisional.send(JSON.stringify({ type: "response.create", input: [] }));
    assert.equal((await closed).code, 1012);
    assert.deepEqual(received, []);
    const retried = await handshake("provisional", false);
    assert.equal(retried.status, 503);
    assert.equal(dials, 3);
    const reply = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("旧根请求未完成")), 2_000);
      root.onmessage = () => { clearTimeout(timer); resolve(); };
    });
    root.send(JSON.stringify({ type: "response.create", model: "cliproxy/model", input: [] }));
    await reply;
    assert.equal(received.length, 1);

  } finally {
    releaseHandshake();
    for (const client of clients) client.close();
    gateway.stop(true);
    upstream.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
