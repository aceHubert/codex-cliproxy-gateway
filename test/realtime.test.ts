import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { managedCodexServiceToml, managedCodexToml } from "../src/cli.ts";
import { createGatewayHandler, startGateway } from "../src/gateway.ts";
import { renderLaunchAgent } from "../src/launchd.ts";
import { websocketLogFile } from "../src/request-log.ts";
import {
  checkFrameRouting,
  loadRealtimeProviderMode,
  proxyRealtimeCall,
  realtimeAccessError,
  realtimeWebSocketHandler,
  realtimeWebSocketTarget,
} from "../src/realtime.ts";
import { readRootTomlString, restoreRootTomlKeys } from "../src/toml.ts";
import type { GatewayConfig } from "../src/types.ts";

function config(officialBaseUrl: string): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl,
    cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: "/tmp/missing-catalog.json",
  };
}

test("managed config routes Realtime WebSockets through the gateway and restores prior values", () => {
  const source = [
    'openai_base_url = "https://old.example/v1"',
    'model_catalog_json = "/tmp/old.json"',
    'experimental_realtime_ws_base_url = "https://old-ws.example/v1"',
    'experimental_realtime_webrtc_call_base_url = "https://old-call.example/v1"',
    'model = "gpt-test"',
    "",
  ].join("\n");
  const gateway = "http://127.0.0.1:8320/v1";
  const managed = managedCodexToml(source, gateway);
  assert.equal(readRootTomlString(managed, "openai_base_url"), gateway);
  assert.equal(readRootTomlString(managed, "experimental_realtime_ws_base_url"), gateway);
  assert.equal(readRootTomlString(managed, "experimental_realtime_webrtc_call_base_url"), gateway);
  assert.equal(readRootTomlString(managed, "model_catalog_json"), undefined);

  const restored = restoreRootTomlKeys(managed, source, [
    "openai_base_url",
    "model_catalog_json",
    "experimental_realtime_ws_base_url",
    "experimental_realtime_webrtc_call_base_url",
  ]);
  assert.equal(readRootTomlString(restored, "openai_base_url"), "https://old.example/v1");
  assert.equal(readRootTomlString(restored, "model_catalog_json"), "/tmp/old.json");
  assert.equal(
    readRootTomlString(restored, "experimental_realtime_ws_base_url"),
    "https://old-ws.example/v1",
  );
  assert.equal(
    readRootTomlString(restored, "experimental_realtime_webrtc_call_base_url"),
    "https://old-call.example/v1",
  );
  assert.equal(readRootTomlString(restored, "model"), "gpt-test");
});

test("service config refresh preserves model catalog configuration", () => {
  const gateway = "http://127.0.0.1:9000/custom";
  const managed = managedCodexServiceToml([
    'openai_base_url = "https://old.example/v1"',
    'model_catalog_json = "/tmp/keep.json"',
    'model = "gpt-test"',
    "",
  ].join("\n"), gateway);
  assert.equal(readRootTomlString(managed, "openai_base_url"), gateway);
  assert.equal(readRootTomlString(managed, "experimental_realtime_ws_base_url"), gateway);
  assert.equal(readRootTomlString(managed, "experimental_realtime_webrtc_call_base_url"), gateway);
  assert.equal(readRootTomlString(managed, "model_catalog_json"), "/tmp/keep.json");
  assert.equal(readRootTomlString(managed, "model"), "gpt-test");
});

test("Realtime provider mode ignores external profile files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "realtime-provider-"));
  const configToml = path.join(directory, "config.toml");
  const externalProfile = path.join(directory, "thirdparty.config.toml");
  try {
    fs.writeFileSync(configToml, 'model = "gpt-test"\n');
    assert.equal(loadRealtimeProviderMode(configToml), "builtin");
    fs.writeFileSync(configToml, 'model_provider = "openai"\n');
    assert.equal(loadRealtimeProviderMode(configToml), "configured");
    fs.writeFileSync(configToml, '[profiles.work]\nmodel_provider = "custom"\n');
    assert.equal(loadRealtimeProviderMode(configToml), "configured");
    fs.writeFileSync(configToml, 'model = "gpt-test"\n');
    fs.writeFileSync(externalProfile, 'model_provider = "thirdparty"\n');
    assert.equal(loadRealtimeProviderMode(configToml), "builtin");
    fs.rmSync(externalProfile);
    fs.writeFileSync(configToml, 'model_provider = [\n');
    assert.equal(loadRealtimeProviderMode(configToml), "invalid");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("launchd preserves custom CODEX_HOME for the provider snapshot", () => {
  const plist = renderLaunchAgent({
    bunPath: "/opt/bun",
    cliPath: "/opt/codex-cliproxy",
    configPath: "/tmp/gateway.json",
    codexHome: "/tmp/codex<&>",
    stdoutLog: "/tmp/out.log",
    stderrLog: "/tmp/err.log",
  });
  assert.match(plist, /<key>CODEX_HOME<\/key>/);
  assert.match(plist, /<string>\/tmp\/codex&lt;&amp;&gt;<\/string>/);
});

test("ChatGPT call-create converts multipart to backend JSON and preserves protocol headers", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init || {} };
    return new Response("answer-sdp", {
      status: 201,
      headers: {
        "content-type": "application/sdp",
        location: "/v1/live/rtc_test",
      },
    });
  }) as unknown as typeof fetch;
  const form = new FormData();
  form.set("sdp", "offer-sdp");
  form.set("session", JSON.stringify({ id: "remove-me", model: "gpt-realtime" }));
  try {
    const response = await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/live?trace=1", {
      method: "POST",
      headers: {
        authorization: "Bearer oauth",
        "chatgpt-account-id": "account",
        "openai-alpha": "quicksilver=v2",
        "x-oai-attestation": "attestation",
      },
      body: form,
    }), config("https://chatgpt.com/backend-api/codex"), "builtin");

    assert.ok(captured);
    const url = new URL(captured.url);
    assert.equal(url.pathname, "/backend-api/codex/realtime/calls");
    assert.equal(url.searchParams.get("trace"), "1");
    assert.equal(url.searchParams.get("intent"), "quicksilver");
    assert.equal(url.searchParams.get("architecture"), "avas");
    assert.deepEqual(JSON.parse(String(captured.init.body)), {
      sdp: "offer-sdp",
      session: { model: "gpt-realtime" },
    });
    const headers = new Headers(captured.init.headers);
    assert.equal(headers.get("authorization"), "Bearer oauth");
    assert.equal(headers.get("chatgpt-account-id"), "account");
    assert.equal(headers.get("x-oai-attestation"), "attestation");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("location"), "/v1/live/rtc_test");
    assert.equal(await response.text(), "answer-sdp");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI Frameless call-create keeps multipart and does not add AVAS query parameters", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init || {} };
    return new Response("answer");
  }) as unknown as typeof fetch;
  const form = new FormData();
  form.set("sdp", "offer");
  form.set("session", "{}");
  try {
    await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/live?model=gpt-realtime", {
      method: "POST",
      headers: { authorization: "Bearer api-key" },
      body: form,
    }), config("https://api.openai.com/v1"), "builtin");
    assert.ok(captured);
    const url = new URL(captured.url);
    assert.equal(url.pathname, "/v1/live");
    assert.equal(url.searchParams.get("model"), "gpt-realtime");
    assert.equal(url.searchParams.has("intent"), false);
    assert.equal(url.searchParams.has("architecture"), false);
    assert.match(new Headers(captured.init.headers).get("content-type") || "", /^multipart\/form-data/);
    assert.match(Buffer.from(captured.init.body as ArrayBuffer).toString("utf8"), /offer/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI AVAS call-create adds required query parameters", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    capturedUrl = String(url);
    return new Response("answer");
  }) as unknown as typeof fetch;
  const form = new FormData();
  form.set("sdp", "offer");
  form.set("session", "{}");
  try {
    await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/realtime/calls?trace=1", {
      method: "POST",
      headers: { authorization: "Bearer api-key" },
      body: form,
    }), config("https://api.openai.com/v1"), "builtin");
    const url = new URL(capturedUrl);
    assert.equal(url.pathname, "/v1/realtime/calls");
    assert.equal(url.searchParams.get("trace"), "1");
    assert.equal(url.searchParams.get("intent"), "quicksilver");
    assert.equal(url.searchParams.get("architecture"), "avas");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ChatGPT legacy application/sdp call-create remains raw", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    captured = init;
    return new Response("answer");
  }) as unknown as typeof fetch;
  try {
    await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/realtime/calls", {
      method: "POST",
      headers: {
        authorization: "Bearer oauth",
        "chatgpt-account-id": "account",
        "content-type": "application/sdp",
      },
      body: "offer-sdp",
    }), config("https://chatgpt.com/backend-api/codex"), "builtin");
    const url = new URL(capturedUrl);
    assert.equal(url.searchParams.has("intent"), false);
    assert.equal(url.searchParams.has("architecture"), false);
    assert.equal(new Headers(captured?.headers).get("content-type"), "application/sdp");
    assert.equal(Buffer.from(captured?.body as ArrayBuffer).toString("utf8"), "offer-sdp");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built-in API key requests bypass the ChatGPT backend", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuthorization = "";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuthorization = new Headers(init?.headers).get("authorization") || "";
    return new Response("answer");
  }) as unknown as typeof fetch;
  const form = new FormData();
  form.set("sdp", "offer");
  form.set("session", "{}");
  try {
    await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/live", {
      method: "POST",
      headers: { authorization: "Bearer official-api-key" },
      body: form,
    }), config("https://chatgpt.com/backend-api/codex"), "builtin");
    assert.equal(capturedUrl, "https://api.openai.com/v1/live");
    assert.equal(capturedAuthorization, "Bearer official-api-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Realtime access fails closed before forwarding third-party or missing credentials", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  }) as unknown as typeof fetch;
  try {
    const configured = await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/live", {
      method: "POST",
      headers: { authorization: "Bearer third-party" },
      body: "offer",
    }), config("https://chatgpt.com/backend-api/codex"), "configured");
    const invalid = await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/live", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: "offer",
    }), config("https://chatgpt.com/backend-api/codex"), "invalid");
    const missing = await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/live", {
      method: "POST",
      body: "offer",
    }), config("https://chatgpt.com/backend-api/codex"), "builtin");
    assert.equal(configured.status, 400);
    assert.equal(invalid.status, 503);
    assert.equal(missing.status, 401);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Realtime authorization is copied from each HTTP request and WebSocket handshake", async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization") || "");
    return new Response("answer");
  }) as unknown as typeof fetch;
  try {
    for (const token of ["first", "second"]) {
      await proxyRealtimeCall(new Request("http://127.0.0.1:8320/v1/realtime/calls", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/sdp",
        },
        body: "offer",
      }), config("https://api.openai.com/v1"), "builtin");
    }
    assert.deepEqual(authorizations, ["Bearer first", "Bearer second"]);

    const first = realtimeWebSocketTarget(new Request("http://127.0.0.1:8320/v1/realtime", {
      headers: { upgrade: "websocket", authorization: "Bearer first" },
    }), config("https://api.openai.com/v1"));
    const second = realtimeWebSocketTarget(new Request("http://127.0.0.1:8320/v1/realtime", {
      headers: { upgrade: "websocket", authorization: "Bearer second" },
    }), config("https://api.openai.com/v1"));
    assert.equal(first?.headers.authorization, "Bearer first");
    assert.equal(second?.headers.authorization, "Bearer second");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Realtime WebSocket access uses the same provider and authorization guard", () => {
  const request = new Request("http://127.0.0.1:8320/v1/realtime", {
    headers: { upgrade: "websocket", authorization: "Bearer third-party" },
  });
  assert.equal(realtimeAccessError(request, "configured")?.status, 400);
  assert.equal(realtimeAccessError(request, "invalid")?.status, 503);
  assert.equal(realtimeAccessError(new Request(request.url), "builtin")?.status, 401);
  assert.equal(realtimeAccessError(request, "builtin"), null);
});

test("gateway HTTP routing enforces the cached Realtime provider mode", async () => {
  const configuredHandler = createGatewayHandler(
    config("https://chatgpt.com/backend-api/codex"),
    "",
    "configured",
  );
  const request = () => new Request("http://127.0.0.1:8320/v1/live", {
    method: "POST",
    headers: { authorization: "Bearer third-party" },
    body: "offer",
  });
  assert.equal((await configuredHandler(request())).status, 400);
  assert.equal((await createGatewayHandler(
    config("https://chatgpt.com/backend-api/codex"),
    "",
  )(request())).status, 503);
});

test("Realtime WebSocket targets distinguish normal connections and sidebands", () => {
  const headers = {
    upgrade: "websocket",
    authorization: "Bearer token",
    "chatgpt-account-id": "account",
    "x-oai-attestation": "attestation",
    originator: "codex_work_desktop",
    host: "malicious.example",
    "sec-websocket-key": "client-generated",
    cookie: "secret",
  };
  const backend = config("https://chatgpt.com/backend-api/codex");
  const api = config("https://api.openai.com/v1");

  const backendNormal = realtimeWebSocketTarget(new Request(
    "http://127.0.0.1:8320/v1/live?model=gpt-realtime",
    { headers },
  ), backend);
  assert.equal(backendNormal?.url, "wss://chatgpt.com/backend-api/codex?model=gpt-realtime");

  const apiNormal = realtimeWebSocketTarget(new Request(
    "http://127.0.0.1:8320/v1/realtime?model=gpt-realtime",
    { headers },
  ), api);
  assert.equal(apiNormal?.url, "wss://api.openai.com/v1/realtime?model=gpt-realtime");

  const framelessSideband = realtimeWebSocketTarget(new Request(
    "http://127.0.0.1:8320/v1/live/rtc_test",
    { headers },
  ), backend);
  assert.equal(framelessSideband?.url, "wss://api.openai.com/v1/live/rtc_test");

  const v1Sideband = realtimeWebSocketTarget(new Request(
    "http://127.0.0.1:8320/v1/realtime?call_id=rtc_test",
    { headers },
  ), backend);
  assert.equal(v1Sideband?.url, "wss://api.openai.com/v1/realtime?call_id=rtc_test");
  // 转发改为黑名单式：除 hop-by-hop 与握手头外一律透传，避免上游新增头时被静默丢弃。
  // cookie 属于 end-to-end 头，HTTP 路径的 copyRequestHeaders 本来也透传，两条链路保持一致；
  // 它在日志里由 SENSITIVE_HEADERS 遮蔽，不会落盘。
  assert.deepEqual(framelessSideband?.headers, {
    authorization: "Bearer token",
    "chatgpt-account-id": "account",
    cookie: "secret",
    originator: "codex_work_desktop",
    "x-oai-attestation": "attestation",
  });
});

test("WebSocket bridge forwards client close code and reason to the upstream socket", () => {
  let forwarded: { code: number; reason: string } | undefined;
  const upstream = {
    readyState: WebSocket.OPEN,
    close(code: number, reason: string) { forwarded = { code, reason }; },
  } as unknown as WebSocket;
  const socket = {
    data: { url: "ws://example.invalid", headers: {}, upstream, queue: [], queuedBytes: 0 },
  } as unknown as Bun.ServerWebSocket<import("../src/realtime.ts").RealtimeSocketData>;
  realtimeWebSocketHandler.close?.(socket, 4001, "client-done");
  assert.deepEqual(forwarded, { code: 4001, reason: "client-done" });
});

test("frame routing guards against Codex reusing one socket across upstreams", () => {
  // 实测 Codex 会复用同一条连接达 88 秒并在其上切换模型，握手时选定的上游会失配。
  assert.equal(
    checkFrameRouting('{"type":"response.create","model":"gpt-5.6-luna"}', "official", "cliproxy/"),
    '{"type":"response.create","model":"gpt-5.6-luna"}',
    "official frame on an official socket passes through untouched",
  );
  assert.equal(
    checkFrameRouting('{"type":"response.create","model":"cliproxy/gpt-5.6-luna"}', "official", "cliproxy/"),
    null,
    "cliproxy frame on an official socket must be rejected, not sent to ChatGPT backend",
  );
  assert.equal(
    checkFrameRouting('{"type":"response.create","model":"gpt-5.6-luna"}', "cliproxy", "cliproxy/"),
    '{"type":"response.create","model":"gpt-5.6-luna"}',
    "an unprefixed title model stays on the established CPA route",
  );

  // 前缀是网关加的，CLIProxy 模型表里没有，必须与 HTTP 路径一样剥掉。
  const stripped = checkFrameRouting(
    '{"type":"response.create","model":"cliproxy/gpt-5.6-luna","input":[]}',
    "cliproxy",
    "cliproxy/",
  );
  assert.ok(stripped);
  assert.deepEqual(JSON.parse(stripped), {
    type: "response.create",
    model: "gpt-5.6-luna",
    input: [],
  });

  // 无 model 字段的控制帧与非 JSON 帧原样透传。
  assert.equal(
    checkFrameRouting('{"type":"response.cancel"}', "cliproxy", "cliproxy/"),
    '{"type":"response.cancel"}',
  );
  assert.equal(checkFrameRouting("not json at all", "official", "cliproxy/"), "not json at all");
  assert.equal(
    checkFrameRouting('{"type":"response.create","model":"gpt-5.6-sol"}', "cliproxy", ""),
    '{"type":"response.create","model":"gpt-5.6-sol"}',
    "CPA-only sockets forward every model without route switching",
  );
});

test("WebSocket bridge records lifecycle events into the live route log", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-realtime-ws-log-"));
  try {
    const upstream = {
      readyState: WebSocket.OPEN,
      send() {},
      close() {},
    } as unknown as WebSocket;
    const socket = {
      data: {
        url: "wss://api.openai.com/v1/live/rtc_test",
        headers: {},
        upstream,
        queue: [],
        queuedBytes: 0,
        log: { dir: logDir, maxLogs: 0 },
        logFile: websocketLogFile("v1-live", "01a01960-3a52-7311-9258-f9144ad58b65"),
      },
    } as unknown as Bun.ServerWebSocket<import("../src/realtime.ts").RealtimeSocketData>;

    realtimeWebSocketHandler.message?.(socket, '{"type":"session.update"}');
    realtimeWebSocketHandler.close?.(socket, 1006, "");

    // 整条会话聚合到一个文件：文件名带 ws 传输标识与 session-id。
    const file = fs.readdirSync(logDir).find((name) => name === "cliproxy-v1-live-ws-01a01960-3a52-7311-9258-f9144ad58b65.log");
    assert.ok(file, `expected a live log, found: ${fs.readdirSync(logDir).join(", ") || "(empty)"}`);
    const log = fs.readFileSync(path.join(logDir, file), "utf8");
    assert.match(log, /\[realtime\] ws-send wss:\/\/api\.openai\.com\/v1\/live\/rtc_test \{"type":"session\.update"\}/);
    // 1006 是排查 sideband 静默挂起的关键信号，必须落盘。
    assert.match(log, /\[realtime\] ws-client-close .*"code":1006/);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("route mismatch closes downstream 1012 without sending the frame upstream", () => {
  const sent: unknown[] = [];
  let upstreamClosed: { code: number; reason: string } | undefined;
  const upstream = {
    readyState: WebSocket.OPEN,
    send(frame: unknown) { sent.push(frame); },
    close(code: number, reason: string) { upstreamClosed = { code, reason }; },
  } as unknown as WebSocket;
  const downstreamClosed: Array<{ code: number; reason: string }> = [];
  let pinned = 0;
  const socket = {
    data: {
      url: "wss://official.example/v1/responses",
      headers: {},
      upstream,
      queue: [],
      queuedBytes: 0,
      routeKind: "official",
      prefix: "cliproxy/",
      pinCpaThread() { pinned += 1; },
    },
    close(code: number, reason: string) { downstreamClosed.push({ code, reason }); },
  } as unknown as Bun.ServerWebSocket<import("../src/realtime.ts").RealtimeSocketData>;

  realtimeWebSocketHandler.message?.(
    socket,
    '{"type":"response.create","model":"cliproxy/gpt-5.6-luna"}',
  );

  assert.deepEqual(sent, []);
  assert.equal(pinned, 1);
  assert.deepEqual(downstreamClosed, [{ code: 1012, reason: "Model routing changed; reconnect required" }]);
  assert.deepEqual(upstreamClosed, { code: 1000, reason: "Model routing changed" });
});

test("CPA route keeps an unprefixed Luna title frame on the CPA upstream", () => {
  const sent: unknown[] = [];
  const upstream = {
    readyState: WebSocket.OPEN,
    send(frame: unknown) { sent.push(frame); },
    close() { throw new Error("CPA title frame must not close the upstream"); },
  } as unknown as WebSocket;
  const socket = {
    data: {
      url: "wss://cliproxy.example/v1/responses",
      headers: {},
      upstream,
      queue: [],
      queuedBytes: 0,
      routeKind: "cliproxy",
      prefix: "cliproxy/",
    },
    close() { throw new Error("CPA title frame must not close the downstream"); },
  } as unknown as Bun.ServerWebSocket<import("../src/realtime.ts").RealtimeSocketData>;
  const frame = '{"type":"response.create","model":"gpt-5.6-luna","input":[]}';

  realtimeWebSocketHandler.message?.(socket, frame);

  assert.deepEqual(sent, [frame]);
});

// 升级转发的前提：拨号上游是异步的，必须确认 Bun 允许在 fetch 内 await 之后再
// server.upgrade（oven-sh/bun#8986 已修复，且仅影响带子协议的请求；这里验证本机运行时）。
test("server.upgrade completes after awaiting inside the fetch handler", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (server.upgrade(request)) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, message) { ws.send(message); },
    },
  });
  const url = new URL("/await-upgrade-spike", server.url);
  url.protocol = "ws:";
  const client = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("upgrade after await timed out")), 3_000);
      client.onerror = () => {
        clearTimeout(timer);
        reject(new Error("upgrade after await failed"));
      };
      client.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("echo timed out")), 3_000);
      client.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      client.send("roundtrip");
    });
    assert.equal(reply, "roundtrip");
  } finally {
    client.close();
    server.stop(true);
  }
});

test("Bun gateway bridges Realtime WebSocket text, binary, headers, and close", async () => {
  let handshakeAuthorization: string | null = null;
  let upstreamClose: { code: number; reason: string } | undefined;
  let resolveUpstreamClose!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => { resolveUpstreamClose = resolve; });
  // upstream-first 的确定性验证：上游握手被闸门挡住期间，客户端必须拿不到 101。
  let releaseUpstream!: () => void;
  const upstreamGate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      handshakeAuthorization = request.headers.get("authorization");
      await upstreamGate;
      if (server.upgrade(request)) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, message) { ws.send(message); },
      close(_ws, code, reason) {
        upstreamClose = { code, reason };
        resolveUpstreamClose();
      },
    },
  });
  const gateway = startGateway(config(`${upstream.url}v1`), "builtin");
  const url = new URL("/v1/live", gateway.url);
  url.protocol = "ws:";
  const ClientWebSocket = WebSocket as unknown as new (
    url: string | URL,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  const client = new ClientWebSocket(url, { headers: { authorization: "Bearer bridge-test" } });
  client.binaryType = "arraybuffer";
  const messages: Array<string | Uint8Array> = [];

  try {
    let clientOpened = false;
    const bridged = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket bridge timed out")), 3_000);
      client.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket bridge failed"));
      };
      client.onopen = () => {
        clientOpened = true;
        client.send("hello");
        client.send(new Uint8Array([1, 2, 3]));
      };
      client.onmessage = (event) => {
        messages.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
        if (messages.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    // 上游闸门未放开前客户端不得完成握手——upstream-first 的核心时序。
    await Bun.sleep(80);
    assert.equal(clientOpened, false);
    releaseUpstream();
    await bridged;
    assert.equal(handshakeAuthorization, "Bearer bridge-test");
    assert.equal(messages[0], "hello");
    assert.deepEqual([...messages[1] as Uint8Array], [1, 2, 3]);
    client.close(1000, "done");
    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Close propagation timed out")), 3_000)),
    ]);
    assert.equal(upstreamClose?.code, 1000);
  } finally {
    client.close();
    gateway.stop(true);
    upstream.stop(true);
  }
});

test("bridge open flushes queued frames to the pre-dialed upstream", () => {
  const sent: unknown[] = [];
  const upstream = {
    readyState: WebSocket.OPEN,
    send(frame: unknown) { sent.push(frame); },
  } as unknown as WebSocket;
  const socket = {
    data: {
      url: "ws://example.invalid",
      headers: {},
      upstream,
      queue: ["queued-frame"],
      queuedBytes: 12,
    },
  } as unknown as Bun.ServerWebSocket<import("../src/realtime.ts").RealtimeSocketData>;
  realtimeWebSocketHandler.open?.(socket);
  assert.deepEqual(sent, ["queued-frame"]);
  assert.equal(socket.data.queue.length, 0);
  assert.equal(socket.data.queuedBytes, 0);
});

test("bridge closes with 1011 when the upstream socket is missing", () => {
  const closed: Array<{ code: number; reason: string }> = [];
  const socket = {
    data: { url: "ws://example.invalid", headers: {}, queue: [], queuedBytes: 0 },
    close(code: number, reason: string) { closed.push({ code, reason }); },
  } as unknown as Bun.ServerWebSocket<import("../src/realtime.ts").RealtimeSocketData>;
  realtimeWebSocketHandler.open?.(socket);
  assert.deepEqual(closed, [{ code: 1011, reason: "Realtime upstream WebSocket is unavailable" }]);
});

test("responses WebSocket probe is forwarded to the hinted upstream", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-responses-ws-log-"));
  let handshakeUrl = "";
  let handshakeAuthorization: string | null = null;
  let handshakeBeta: string | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      handshakeUrl = request.url;
      handshakeAuthorization = request.headers.get("authorization");
      handshakeBeta = request.headers.get("openai-beta");
      if (server.upgrade(request)) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, message) { ws.send(message); },
    },
  });
  const gateway = startGateway(
    { ...config(`${upstream.url}v1`), requestLogging: true, logDir },
    "builtin",
  );
  const url = new URL("/v1/responses", gateway.url);
  url.protocol = "ws:";
  const ClientWebSocket = WebSocket as unknown as new (
    url: string | URL,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  const client = new ClientWebSocket(url, {
    headers: {
      authorization: "Bearer official-oauth",
      "openai-beta": "responses_websockets=2026-02-06",
      "x-codex-routing-hint": "model=gpt-5.6-luna",
    },
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("responses WS forwarding timed out")), 3_000);
      client.onerror = () => {
        clearTimeout(timer);
        reject(new Error("responses WS forwarding failed"));
      };
      client.onopen = () => client.send("hello-over-ws");
      client.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
    });
    assert.equal(reply, "hello-over-ws");
    assert.equal(handshakeUrl, `${upstream.url}v1/responses`);
    assert.equal(handshakeAuthorization, "Bearer official-oauth");
    assert.equal(handshakeBeta, "responses_websockets=2026-02-06");
    const logFile = fs.readdirSync(logDir).find((name) => /^cliproxy-v1-responses-ws-[\w-]+\.log$/.test(name));
    assert.ok(logFile, `expected a v1-responses log, found: ${fs.readdirSync(logDir).join(", ") || "(empty)"}`);
    assert.match(fs.readFileSync(path.join(logDir, logFile), "utf8"), /\[realtime\] ws-dial ws:\/\//);
  } finally {
    client.close();
    gateway.stop(true);
    upstream.stop(true);
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

/** 用原始 TCP 发 WebSocket 升级请求，读回首行响应头——fetch 会剥离 upgrade 头，只能走裸socket。 */
function rawUpgradeRequest(url: URL, extraHeaders: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    void Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        data(socket, chunk) {
          resolve(new TextDecoder().decode(chunk));
          socket.end();
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).then((socket) => {
      const head = [
        `GET ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
      ].join("\r\n");
      socket.write(`${head}\r\n\r\n`);
    });
  });
}

test("responses WebSocket dial failure falls back to 426 negotiation semantics", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-responses-ws-fail-"));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("no websocket here", { status: 404 });
    },
  });
  const gateway = startGateway(
    { ...config(`${upstream.url}v1`), requestLogging: true, logDir },
    "builtin",
  );
  try {
    const head = await rawUpgradeRequest(new URL("/v1/responses", gateway.url), {
      "x-codex-routing-hint": "model=gpt-5.6-luna",
    });
    assert.match(head, /^HTTP\/1\.1 426/);
    assert.match(head, /x-codex-cliproxy-gateway: websocket-upstream-unavailable/);
    const files = fs.readdirSync(logDir);
    // 协商失败不进错误摘要，但 ws-dial-failed 留在分组日志里可追溯。
    assert.equal(files.some((name) => name.startsWith("cliproxy-error-")), false);
    const logText = files
      .filter((name) => name.startsWith("cliproxy-v1-responses-"))
      .map((name) => fs.readFileSync(path.join(logDir, name), "utf8"))
      .join("");
    assert.match(logText, /ws-dial-failed/);
  } finally {
    gateway.stop(true);
    upstream.stop(true);
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("slow upstream handshakes within the dial budget still bridge instead of 426", { timeout: 30_000 }, async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-responses-ws-slow-"));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      // 5.8s 卡在旧 5s 截断与新预算之间，复现经 CF 偶发的慢握手（实测 5771ms 那次）。
      await Bun.sleep(5_800);
      if (server.upgrade(request)) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, message) { ws.send(message); },
    },
  });
  const gateway = startGateway(
    { ...config(`${upstream.url}v1`), requestLogging: true, logDir },
    "builtin",
  );
  const url = new URL("/v1/responses", gateway.url);
  url.protocol = "ws:";
  const ClientWebSocket = WebSocket as unknown as new (
    url: string | URL,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  const client = new ClientWebSocket(url, {
    headers: {
      "openai-beta": "responses_websockets=2026-02-06",
      "x-codex-routing-hint": "model=gpt-5.6-luna",
    },
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("slow handshake bridge timed out")), 15_000);
      client.onerror = () => {
        clearTimeout(timer);
        reject(new Error("client socket errored; expected the slow handshake to bridge"));
      };
      client.onopen = () => client.send("slow-handshake-echo");
      client.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
    });
    assert.equal(reply, "slow-handshake-echo");
  } finally {
    client.close();
    gateway.stop(true);
    upstream.stop(true);
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("realtime sideband dial failure surfaces as 502 instead of a silent 101", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sideband-fail-"));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("gone", { status: 404 });
    },
  });
  const gateway = startGateway(
    { ...config(`${upstream.url}v1`), requestLogging: true, logDir },
    "builtin",
  );
  try {
    const head = await rawUpgradeRequest(new URL("/v1/live", gateway.url), {
      authorization: "Bearer sideband-oauth",
    });
    assert.match(head, /^HTTP\/1\.1 502/);
    assert.match(head, /x-codex-cliproxy-gateway: realtime-upstream-unavailable/);
    // 真实故障必须进错误摘要（原先的表现是 101 后静默断开）。
    const errorFiles = fs.readdirSync(logDir).filter((name) => name.startsWith("cliproxy-error-"));
    assert.ok(errorFiles.length > 0, "expected an error digest entry for the sideband dial failure");
    const digest = errorFiles.map((name) => fs.readFileSync(path.join(logDir, name), "utf8")).join("");
    assert.match(digest, /-> 502 !!!/);
    assert.match(digest, /Realtime upstream WebSocket failed/);
  } finally {
    gateway.stop(true);
    upstream.stop(true);
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
