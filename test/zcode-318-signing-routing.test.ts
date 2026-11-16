import assert from "node:assert/strict";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createZcodeAdapter } from "@agent-proxy/zcode";
import { parseClientSigningCredential, ZcodeClientSigning } from "@agent-proxy/zcode/client-signing";
import { ZcodeConfigError } from "@agent-proxy/zcode/config";
import { ZcodeEndpointRouting } from "@agent-proxy/zcode/endpoint-routing";
import { maskedHeaders } from "../apps/gateway/src/request-log.ts";
import { gatewayFixturePaths, withFixtureAdapterHost } from "./gateway-fixture-paths.ts";
import test from "./host-test.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

const identity = { appVersion: "3.18.0", language: "zh-CN", timezone: "Asia/Shanghai", platform: "darwin", arch: "arm64", osVersion: "25.6.0" };
const from = "https://api.z.ai/api/anthropic/v1/messages";
const to = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";

function projectToken(payload: Record<string, unknown> = { token_use: "project_access", api_key: "project-key-id" }, header: Record<string, unknown> = { alg: "HS256", typ: "JWT", sign_type: "SIGN" }): string {
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture-signature`;
}

function mappingResponse(entries: unknown[]): Response {
  return Response.json({ code: 0, data: { proxyEndpoint: { mapping: entries } } });
}

test("3.18 项目令牌只接受官方项目访问类型，普通账号令牌不参与签名", () => {
  const token = projectToken();
  assert.deepEqual(parseClientSigningCredential(token), { apiKeyId: "project-key-id", apiKeySecret: token, handshakeField: "accessToken" });
  for (const value of [
    projectToken({ token_use: "access", api_key: "project-key-id" }),
    projectToken({ token_use: "project_access", api_key: " " }),
    projectToken({ token_use: "project_access", api_key: 10 }),
    projectToken(undefined, { alg: "RS256", typ: "JWT", sign_type: "SIGN" }),
    projectToken(undefined, { alg: "HS256", typ: "JWT" }),
    "invalid.payload.signature",
  ]) assert.equal(parseClientSigningCredential(value), undefined);
});

test("3.18 项目令牌握手独立复核 HMAC、私钥解密、Ed25519 与 PoW", async () => {
  const token = projectToken();
  const id = "project-key-id";
  const derive = (info: string) => new Uint8Array(hkdfSync("sha256", token, "WD_CLIENT_SIGN_KDF_SALT", info, 32));
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const plaintext = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", derive("ed25519_priv"), "AES-GCM", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, aes, new TextEncoder().encode(plaintext));
  const privateCipher = Buffer.concat([iv, new Uint8Array(encrypted)]).toString("base64");
  let handshakes = 0;
  const signing = new ZcodeClientSigning({ fetch: async (url, init) => {
    handshakes++;
    assert.equal(url, "https://api.z.ai/api/paas/c1f3a7e2/v2/client");
    assert.equal(new Headers(init.headers).get("authorization"), token);
    const body = JSON.parse(String(init.body)) as { apiKey?: string; accessToken: string; ts: string; nonce: string; sig: string };
    assert.equal(body.accessToken, token);
    assert.equal(body.apiKey, undefined);
    assert.equal(body.sig, createHmac("sha256", derive("getSignKey_hmac")).update(`get_sign_key\n${id}\n${body.ts}\n${body.nonce}`).digest("base64"));
    return Response.json({ code: 200, data: { privateCipher } });
  } });
  const scope = { apiKey: token, baseUrl: "https://api.z.ai/api/anthropic", clientVersion: "3.18.0", sessionId: "fixture-project-session" };
  const headers = new Headers();
  assert.equal(await signing.decorate(headers, scope), true);
  const timestamp = headers.get("x-client-ts")!;
  const nonce = headers.get("x-client-nonce")!;
  assert.equal(await crypto.subtle.verify("Ed25519", pair.publicKey, Buffer.from(headers.get("x-client-sig")!, "base64"), Buffer.from(`${id}\n${timestamp}\n3.18.0\n${scope.sessionId}\n${nonce}`)), true);
  const prefix = createHash("sha256").update(`${id}\nzcode\n${scope.sessionId}\n${timestamp}`).digest("hex").slice(0, 32);
  assert.equal(createHash("sha256").update(`${prefix}\n${headers.get("x-client-pow")}`).digest()[0], 0);
  assert.equal(await signing.decorate(new Headers(), scope), true);
  assert.equal(handshakes, 1);
  signing.invalidate(token, scope.baseUrl);
  assert.equal(await signing.decorate(new Headers(), scope), true);
  assert.equal(handshakes, 2);
});

test("3.18 动态映射只上报业务 Key ID，完整凭据留在本地", async () => {
  for (const [credential, id] of [["fixture-key.fixture-secret", "fixture-key"], [projectToken(), "project-key-id"], ["plain-secret", null]] as const) {
    const routing = new ZcodeEndpointRouting({ identity, fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-api-key-id"), id);
      assert.equal(headers.get("x-api-key"), null);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("x-zcode-agent"), null);
      return mappingResponse([{ from, to }]);
    } });
    assert.equal((await routing.resolve(from, credential)).url, to);
  }
});

test("3.18 同源 Ultra 映射惰性读取当前业务登录态，保留查询串且不缓存令牌", async () => {
  let jwt = "fixture-biz-jwt-one";
  let reads = 0;
  const routing = new ZcodeEndpointRouting({ identity, readZcodeJwt: () => { reads++; return jwt; }, fetch: async () => mappingResponse([{ from, to, zcodeAuthorizationHeader: "X-ZCode-Authorization" }]) });
  assert.deepEqual(await routing.resolve("https://api.z.ai/other"), { routed: false, url: "https://api.z.ai/other" });
  assert.equal(reads, 0);
  assert.deepEqual(await routing.resolve(`${from}?beta=true`), { routed: true, url: `${to}?beta=true`, headers: { "X-ZCode-Authorization": "Bearer fixture-biz-jwt-one" } });
  jwt = "Bearer fixture-biz-jwt-two";
  assert.equal((await routing.resolve(from)).headers?.["X-ZCode-Authorization"], jwt);
  assert.equal(reads, 2);
});

test("3.18 映射拒绝跨源、非 Ultra 路径及自定义凭据头，且不读取业务登录态", async () => {
  for (const [target, header] of [
    ["https://api.z.ai/api/v1/ultra/messages", "X-ZCode-Authorization"],
    ["https://zcode.z.ai/api/v1/other/messages", "X-ZCode-Authorization"],
    ["https://zcode.z.ai/api/v1/ultra-zai-evil/messages", "X-ZCode-Authorization"],
    [to, "Authorization"],
    [to, 10],
  ]) {
    let reads = 0;
    const routing = new ZcodeEndpointRouting({ identity, readZcodeJwt: () => { reads++; return "must-stay-local"; }, fetch: async () => mappingResponse([{ from, to: target, zcodeAuthorizationHeader: header }]) });
    assert.deepEqual(await routing.resolve(from), { routed: false, url: from });
    assert.equal(reads, 0);
  }
});

test("3.18 必需业务登录态缺失或读取失败时明确报错，原有无鉴权映射不读取令牌", async () => {
  for (const readZcodeJwt of [undefined, () => undefined, () => "  ", () => { throw new Error("fixture-private-secret"); }]) {
    const routing = new ZcodeEndpointRouting({ identity, readZcodeJwt, fetch: async () => mappingResponse([{ from, to, zcodeAuthorizationHeader: "X-ZCode-Authorization" }]) });
    await assert.rejects(routing.resolve(from), (error: unknown) => {
      assert.ok(error instanceof ZcodeConfigError);
      assert.match(error.message, /JWT.*重启网关/);
      assert.doesNotMatch(error.message, /fixture-private-secret/);
      return true;
    });
  }
  const routing = new ZcodeEndpointRouting({ identity, readZcodeJwt: () => { assert.fail("无鉴权映射无需读取登录态"); }, fetch: async () => mappingResponse([{ from, to }]) });
  assert.deepEqual(await routing.resolve(from), { routed: true, url: to });
  assert.deepEqual(maskedHeaders({ "X-ZCode-Authorization": "Bearer fixture-secret", "x-zcode-authorization": "fixture-secret", "x-request-id": "public-id" }), { "X-ZCode-Authorization": "***", "x-zcode-authorization": "***", "x-request-id": "public-id" });
});

test("Ultra 必需 JWT 读取失败通过正常转发入口返回503且不发送模型请求", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-ultra-jwt-error-"));
  const paths = gatewayFixturePaths(directory);
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    zcode: true, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
    officialBaseUrl: "https://official.invalid", upstreamBaseUrl: "https://upstream.invalid",
    catalogPath: path.join(directory, "catalog.json"), requestLogging: true,
  };
  let modelCalls = 0;
  const routing = new ZcodeEndpointRouting({ identity, readZcodeJwt: () => { throw new Error("fixture-private-secret"); }, fetch: async () => mappingResponse([{ from, to, zcodeAuthorizationHeader: "X-ZCode-Authorization" }]) });
  const adapter = withFixtureAdapterHost(config, paths, () => createZcodeAdapter(config, {
    identity, cacheDirectory: directory, endpointRouting: routing, clientSigning: null,
    configCache: { get: async () => ({ family: "zai", providerID: "zai-test", plan: "api-key", apiKey: "fixture-key.fixture-secret", baseURL: "https://api.z.ai/api/anthropic", modelIds: ["GLM-5.3"] }), close() {} },
    fetch: async () => { modelCalls++; throw new Error("模型请求不应发出"); },
  }));
  try {
    const response = await adapter.forward(new Request("http://127.0.0.1:8320/v1/responses"), { model: "zcode/glm-5.3", input: "fixture", stream: false });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.type, "configuration_error");
    assert.match(body.error.message, /JWT.*重启网关/);
    assert.equal(modelCalls, 0);
    const logs = fs.readdirSync(paths.logDir).map((name) => fs.readFileSync(path.join(paths.logDir, name), "utf8")).join("\n");
    assert.doesNotMatch(JSON.stringify(body) + logs, /fixture-private-secret/);
  } finally {
    adapter.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("3.18 Ultra 鉴权经过正常转发入口且错误回显和交换日志均遮蔽业务令牌", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-318-routing-"));
  const paths = gatewayFixturePaths(directory);
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    zcode: true, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
    officialBaseUrl: "https://official.invalid", upstreamBaseUrl: "https://upstream.invalid",
    catalogPath: path.join(directory, "catalog.json"), requestLogging: true,
  };
  const jwt = "fixture-biz-jwt-sensitive";
  const routing = new ZcodeEndpointRouting({ identity, readZcodeJwt: () => jwt, fetch: async () => mappingResponse([{ from, to, zcodeAuthorizationHeader: "X-ZCode-Authorization" }]) });
  const adapter = withFixtureAdapterHost(config, paths, () => createZcodeAdapter(config, {
    identity, cacheDirectory: directory, endpointRouting: routing, clientSigning: null,
    configCache: { get: async () => ({ family: "zai", providerID: "zai-test", plan: "api-key", apiKey: "fixture-key.fixture-secret", baseURL: "https://api.z.ai/api/anthropic", modelIds: ["GLM-5.3"] }), close() {} },
    fetch: async (url, init) => {
      assert.equal(url, to);
      assert.equal(new Headers(init.headers).get("x-zcode-authorization"), `Bearer ${jwt}`);
      const escaped = [...jwt].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
      return new Response(`{"error":{"message":"${escaped}"}}`, { status: 401, headers: { "content-type": "application/json" } });
    },
  }));
  try {
    const response = await adapter.forward(new Request("http://127.0.0.1:8320/v1/responses"), { model: "zcode/glm-5.3", input: "fixture", stream: false });
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.ok(!body.includes(jwt));
    assert.equal(JSON.parse(body).error.message, "***");
    const logs = fs.readdirSync(paths.logDir).map((name) => fs.readFileSync(path.join(paths.logDir, name), "utf8")).join("\n");
    assert.ok(logs.includes("x-zcode-authorization: ***"));
    assert.ok(!logs.includes(jwt));
  } finally {
    adapter.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("3.18 Ultra 视觉主请求、analyze_image 执行腿与续跑腿均保留中继鉴权和归因头", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-318-vision-routing-"));
  const paths = gatewayFixturePaths(directory);
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    zcode: true, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
    officialBaseUrl: "https://official.invalid", upstreamBaseUrl: "https://upstream.invalid",
    catalogPath: path.join(directory, "catalog.json"),
  };
  const jwt = "fixture-vision-biz-jwt";
  const routing = new ZcodeEndpointRouting({ identity, readZcodeJwt: () => jwt, fetch: async () => mappingResponse([{ from, to, zcodeAuthorizationHeader: "X-ZCode-Authorization" }]) });
  const calls: { url: string; headers: Headers; body: { max_tokens?: number; messages: { content: Record<string, unknown>[] }[] } }[] = [];
  const sse = (blocks: Record<string, unknown>[], stopReason = "end_turn") => new Response([
    { type: "message_start", message: { id: "msg-vision-routing", usage: { input_tokens: 4, output_tokens: 0 } } },
    ...blocks,
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ].map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const adapter = withFixtureAdapterHost(config, paths, () => createZcodeAdapter(config, {
    identity, cacheDirectory: directory, endpointRouting: routing, clientSigning: null,
    configCache: { get: async () => ({ family: "zai", providerID: "zai-test", plan: "api-key", apiKey: "fixture-key.fixture-secret", baseURL: "https://api.z.ai/api/anthropic", modelIds: ["GLM-5.3"] }), close() {} },
    fetch: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      if (calls.length === 1) return sse([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-vision-routing", name: "analyze_image", input: { imageSource: "https://cdn.invalid/image.png", prompt: "识别图片" } } },
        { type: "content_block_stop", index: 0 },
      ], "tool_use");
      if (calls.length === 2) return sse([
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "server-vision-routing", name: "analyze_image", input: {} } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "analyze_image_result_summary: 图片中有一张表格" } },
        { type: "content_block_stop", index: 1 },
      ]);
      return sse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "识别完成：表格" } },
        { type: "content_block_stop", index: 0 },
      ]);
    },
  }));
  try {
    const response = await adapter.forward(new Request("http://127.0.0.1:8320/v1/responses", { headers: { "anthropic-beta": "fixture-beta" } }), {
      model: "zcode/glm-5.3", stream: false,
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "看图片" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ] }],
    });
    assert.equal(response.status, 200);
    const result = await response.text();
    assert.match(result, /识别完成：表格/);
    assert.equal(calls.length, 3, "应依次完成主请求、一次视觉执行、一次续跑");
    for (const call of calls) {
      assert.equal(call.url, to);
      assert.equal(call.headers.get("x-zcode-authorization"), `Bearer ${jwt}`);
      assert.equal(call.headers.get("authorization"), "Bearer fixture-key.fixture-secret");
      assert.equal(call.headers.get("x-session-id"), calls[0]!.headers.get("x-session-id"));
      assert.equal(call.headers.get("x-zcode-trace-id"), calls[0]!.headers.get("x-zcode-trace-id"));
    }
    assert.equal(calls[0]!.headers.get("anthropic-beta"), "fixture-beta");
    assert.equal(calls[2]!.headers.get("anthropic-beta"), "fixture-beta");
    assert.equal(calls[1]!.body.max_tokens, 4096);
    assert.ok(calls[1]!.body.messages[0]!.content.some((block) => block.type === "image"));
    assert.ok(calls[2]!.body.messages.some((message) => message.content.some((block) => block.type === "tool_result")));
  } finally {
    adapter.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
