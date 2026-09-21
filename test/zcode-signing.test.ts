import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  clientSigningVerifyRejection,
  parseClientSigningCredential,
  solveClientRequestPow,
  ZcodeClientSigning,
} from "../src/zcode/client-signing.ts";
import { createGatewayHandler } from "../src/gateway.ts";
import type { ZcodeProviderSnapshot, ZcodeFamily, ZcodeSelection } from "../src/zcode/config.ts";
import type { ZcodeIdentity } from "../src/zcode/request-context.ts";
import type { GatewayConfig } from "../src/types.ts";

const API_KEY_ID = "testkeyid7f3a";
const API_KEY_SECRET = "test-secret-4d51";
const API_KEY = `${API_KEY_ID}.${API_KEY_SECRET}`;
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const CLIENT_VERSION = "3.11.2";
const SESSION_ID = "sess-signing-0001";
const BASE_URL = "https://api.z.ai/api/anthropic";
const HANDSHAKE_URL = "https://api.z.ai/api/paas/c1f3a7e2/v2/client";

const IDENTITY: ZcodeIdentity = {
  appVersion: CLIENT_VERSION, language: "zh-CN", timezone: "Asia/Shanghai",
  platform: "darwin", arch: "arm64", osVersion: "25.6.0",
};

/** 测试侧独立实现的 HKDF（node:crypto），交叉验证 WebCrypto 路径的派生一致性。 */
function hkdf(secret: string, info: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(KDF_SALT, "utf8"),
    Buffer.from(info, "utf8"),
    32,
  ));
}

function expectedHandshakeSig(ts: string, nonce: string): string {
  return createHmac("sha256", hkdf(API_KEY_SECRET, "getSignKey_hmac"))
    .update(`get_sign_key\n${API_KEY_ID}\n${ts}\n${nonce}`)
    .digest("base64");
}

interface KeyFixture {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  privateCipher: string;
}

/** 按服务端规则生成 privateCipher：AES-GCM(HKDF(ed25519_priv))，AAD 为 apiKeyId。 */
async function keyFixture(): Promise<KeyFixture> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  // 注意 Uint8Array 不支持 toString("base64")，必须经 Buffer 转换。
  const plaintext = new TextEncoder().encode(Buffer.from(pkcs8).toString("base64"));
  const aesKey = await crypto.subtle.importKey("raw", hkdf(API_KEY_SECRET, "ed25519_priv"), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(API_KEY_ID), tagLength: 128 },
    aesKey,
    plaintext,
  ));
  const cipher = new Uint8Array(iv.byteLength + sealed.byteLength);
  cipher.set(iv, 0);
  cipher.set(sealed, iv.byteLength);
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, privateCipher: Buffer.from(cipher).toString("base64") };
}

/** 顺序可控的随机 hex：让 nonce 可预测，供独立复算签名。 */
function sequencedHex(values: string[]): (bytes: number) => string {
  let index = 0;
  return (bytes: number) => {
    const value = values[index % values.length]!;
    index += 1;
    assert.equal(value.length, bytes * 2, "预置随机 hex 长度必须与请求字节数匹配");
    return value;
  };
}

function handshakeResponse(privateCipher: string): Response {
  return Response.json({ code: 200, data: { privateCipher } });
}

/** 复核签名头：Ed25519 验签 + PoW 前导零，全部用与实现独立的 node:crypto/webcrypto。 */
async function verifySignatureHeaders(headers: Headers, publicKey: CryptoKey): Promise<void> {
  assert.equal(headers.get("x-app-id"), "zcode");
  assert.equal(headers.get("x-client-version"), CLIENT_VERSION);
  const sessionId = headers.get("x-session-id");
  assert.ok(sessionId, "签名头必须携带会话 id");
  const ts = headers.get("x-client-ts")!;
  const nonce = headers.get("x-client-nonce")!;
  assert.match(ts, /^\d+$/);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const pow = headers.get("x-client-pow")!;
  const prefix = createHash("sha256").update(`${API_KEY_ID}\nzcode\n${sessionId}\n${ts}`).digest("hex").slice(0, 32);
  const powDigest = createHash("sha256").update(`${prefix}\n${pow}`).digest();
  assert.equal(powDigest[0], 0, "PoW 必须满足 8 个前导零比特");
  const message = `${API_KEY_ID}\n${ts}\n${CLIENT_VERSION}\n${sessionId}\n${nonce}`;
  const valid = await crypto.subtle.verify(
    "Ed25519", publicKey, Buffer.from(headers.get("x-client-sig")!, "base64"), Buffer.from(message, "utf8"),
  );
  assert.ok(valid, "X-Client-Sig 必须能用握手下发的公钥验签通过");
}

test("parseClientSigningCredential 只接受单点分隔的 id.secret", () => {
  assert.deepEqual(parseClientSigningCredential(API_KEY), { apiKeyId: API_KEY_ID, apiKeySecret: API_KEY_SECRET });
  assert.equal(parseClientSigningCredential("no-separator"), undefined);
  assert.equal(parseClientSigningCredential("header.payload.signature"), undefined);
  assert.equal(parseClientSigningCredential(".leading"), undefined);
  assert.equal(parseClientSigningCredential("trailing."), undefined);
});

test("握手请求携带完整 key 鉴权，HMAC 签名可用独立实现复算", async () => {
  const fixture = await keyFixture();
  const calls: { url: string; init: RequestInit }[] = [];
  let clock = 1_700_000_000_000;
  const nonceHex = sequencedHex(["11223344556677889900aabbccddeeff", "fedcba9876543210fedcba9876543210"]);
  const signing = new ZcodeClientSigning({
    fetch: async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init.body)) as { apiKey: string; nonce: string; sig: string; ts: string };
      assert.equal(body.apiKey, API_KEY);
      assert.equal(body.sig, expectedHandshakeSig(body.ts, body.nonce));
      return handshakeResponse(fixture.privateCipher);
    },
    now: () => clock,
    randomHex: nonceHex,
  });
  const headers = new Headers({ "x-session-id": SESSION_ID });
  clock += 1_000;
  assert.equal(await signing.decorate(headers, { apiKey: API_KEY, baseUrl: BASE_URL, clientVersion: CLIENT_VERSION, sessionId: SESSION_ID }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, HANDSHAKE_URL);
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), API_KEY);
  await verifySignatureHeaders(headers, fixture.publicKey);
});

test("无点分隔的 key（JWT 或普通密钥）不签名也不握手", async () => {
  let handshakes = 0;
  const signing = new ZcodeClientSigning({ fetch: async () => { handshakes += 1; return handshakeResponse("x"); } });
  for (const apiKey of ["plain-secret", "header.payload.signature"]) {
    const headers = new Headers();
    assert.equal(await signing.decorate(headers, { apiKey, baseUrl: BASE_URL, clientVersion: CLIENT_VERSION, sessionId: SESSION_ID }), false);
    assert.equal(headers.get("x-client-sig"), null);
  }
  assert.equal(handshakes, 0);
});

test("握手失败 fail-open 并进入冷却，冷却期内不重复握手", async () => {
  const fixture = await keyFixture();
  let handshakes = 0;
  let clock = 0;
  let fail = true;
  const signing = new ZcodeClientSigning({
    fetch: async () => {
      handshakes += 1;
      return fail ? Response.json({ code: 500 }, { status: 200 }) : handshakeResponse(fixture.privateCipher);
    },
    now: () => clock,
    failureCooldownMs: 30_000,
  });
  const scope = { apiKey: API_KEY, baseUrl: BASE_URL, clientVersion: CLIENT_VERSION, sessionId: SESSION_ID };
  const headers = new Headers();
  assert.equal(await signing.decorate(headers, scope), false);
  assert.equal(headers.get("x-client-sig"), null);
  assert.equal(await signing.decorate(new Headers(), scope), false);
  assert.equal(handshakes, 1, "冷却期内不得重复握手");
  clock = 30_001;
  fail = false;
  assert.equal(await signing.decorate(new Headers(), scope), true, "冷却结束后恢复握手");
  assert.equal(handshakes, 2);
});

test("invalidate 后下一次请求重新握手", async () => {
  const fixture = await keyFixture();
  let handshakes = 0;
  const signing = new ZcodeClientSigning({
    fetch: async () => { handshakes += 1; return handshakeResponse(fixture.privateCipher); },
  });
  assert.equal(await signing.decorate(new Headers(), { apiKey: API_KEY, baseUrl: BASE_URL, clientVersion: CLIENT_VERSION, sessionId: SESSION_ID }), true);
  assert.equal(handshakes, 1);
  signing.invalidate(API_KEY, BASE_URL);
  assert.equal(await signing.decorate(new Headers(), { apiKey: API_KEY, baseUrl: BASE_URL, clientVersion: CLIENT_VERSION, sessionId: SESSION_ID }), true);
  assert.equal(handshakes, 2);
});

test("clientSigningVerifyRejection 识别 401 正文中的 VERIFY 拒绝原因", () => {
  assert.equal(clientSigningVerifyRejection(JSON.stringify({ msg: "VERIFY_SIGNATURE_INVALID" })), "VERIFY_SIGNATURE_INVALID");
  assert.equal(clientSigningVerifyRejection(JSON.stringify({ data: { reason: "VERIFY_APIKEY_EXPIRED" } })), "VERIFY_APIKEY_EXPIRED");
  assert.equal(clientSigningVerifyRejection(JSON.stringify({ error: { message: "VERIFY_SIGNATURE_INVALID" } })), "VERIFY_SIGNATURE_INVALID");
  assert.equal(clientSigningVerifyRejection(JSON.stringify({ msg: "quota exceeded" })), undefined);
  assert.equal(clientSigningVerifyRejection("not json"), undefined);
});

test("solveClientRequestPow 返回的解满足声明的前导零难度", () => {
  const ts = "1700000000001";
  const pow = solveClientRequestPow({ apiKeyId: API_KEY_ID, sessionId: SESSION_ID, ts });
  const prefix = createHash("sha256").update(`${API_KEY_ID}\nzcode\n${SESSION_ID}\n${ts}`).digest("hex").slice(0, 32);
  assert.equal(createHash("sha256").update(`${prefix}\n${pow}`).digest()[0], 0);
});

function snapshot(family: ZcodeFamily = "zai"): ZcodeProviderSnapshot {
  return {
    family,
    providerID: `${family}-test`,
    plan: "api-key" as ZcodeSelection["kind"],
    apiKey: API_KEY,
    baseURL: BASE_URL,
    modelIds: ["GLM-5.3"],
  };
}

function upstreamSse(text = "签名链路答案"): Response {
  const frames = [
    { type: "message_start", message: { id: "msg_signing", usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

type GatewayHarness = {
  handler: ReturnType<typeof createGatewayHandler>;
  handshakes: { body: Record<string, unknown>; authorization: string }[];
  modelCalls: Headers[];
};

/** 走 createGatewayHandler 的端到端链路：握手与模型请求都由注入的 fetch 承接。 */
async function withGateway(
  options: { verifyRejectFirst?: boolean; handshakeFail?: boolean; keyFixture: KeyFixture },
  run: (harness: GatewayHarness) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-zcode-signing-"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/", zcode: true, upstreamOnly: false,
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
  };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [] }));
  const handshakes: { body: Record<string, unknown>; authorization: string }[] = [];
  const modelCalls: Headers[] = [];
  const currentCache = { get: async () => snapshot(), close: () => {} };
  const handler = createGatewayHandler(config, "fake-cpa-key", "invalid", new Set<string>(), new Set<string>(),
    path.join(directory, "models-cache.json"), {
      planCaches: { "api-key": currentCache } as Partial<Record<ZcodeSelection["kind"], typeof currentCache>>,
      identity: IDENTITY,
      endpointRouting: null,
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/api/paas/c1f3a7e2/v2/client")) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          handshakes.push({ body, authorization: new Headers(init.headers).get("authorization") ?? "" });
          if (options.handshakeFail) return Response.json({ code: 500 }, { status: 200 });
          const sig = body.sig;
          assert.equal(sig, expectedHandshakeSig(String(body.ts), String(body.nonce)), "网关握手签名必须与独立实现一致");
          return handshakeResponse(options.keyFixture.privateCipher);
        }
        if (target.endsWith("/v1/messages")) {
          modelCalls.push(new Headers(init.headers));
          if (options.verifyRejectFirst && modelCalls.length === 1) {
            return Response.json({ msg: "VERIFY_SIGNATURE_INVALID" }, { status: 401 });
          }
          return upstreamSse();
        }
        throw new Error(`测试未模拟的上游请求：${target}`);
      },
    });
  try {
    await run({ handler, handshakes, modelCalls });
  } finally {
    handler.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function decoded(response: Response): Promise<Record<string, any>> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return await response.json() as Record<string, any>;
  const events = (await response.text()).split("\n\n").flatMap((chunk) => {
    const raw = chunk.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return raw && raw !== "[DONE]" ? [JSON.parse(raw)] : [];
  });
  const final = events.findLast((item: Record<string, unknown>) => item.type === "response.completed");
  assert.ok(final, "SSE 必须结束于完成事件");
  return final.response as Record<string, any>;
}

function modelRequest(): Request {
  return new Request("http://127.0.0.1:8320/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fake-chatgpt-oauth" },
    body: JSON.stringify({ model: "zcode/glm-5.3", input: "你好" }),
  });
}

test("网关为模型请求附加逐请求签名，VERIFY 拒绝后重握手并重签一次", async () => {
  const fixture = await keyFixture();
  await withGateway({ verifyRejectFirst: true, keyFixture: fixture }, async ({ handler, handshakes, modelCalls }) => {
    const response = await handler(modelRequest());
    assert.equal(response.status, 200);
    assert.equal((await decoded(response)).status, "completed");
    assert.equal(handshakes.length, 2, "VERIFY 拒绝后必须作废密钥并重新握手");
    assert.equal(modelCalls.length, 2);
    for (const headers of modelCalls) await verifySignatureHeaders(headers, fixture.publicKey);
    assert.notEqual(
      modelCalls[0]!.get("x-client-nonce"), modelCalls[1]!.get("x-client-nonce"),
      "两次发送的 nonce 不得复用",
    );
    assert.equal(handshakes[0]!.authorization, API_KEY);
    assert.equal(handshakes[1]!.body.apiKey, API_KEY);
  });
});

test("握手失败时 fail-open：模型请求按未签名继续并成功返回", async () => {
  const fixture = await keyFixture();
  await withGateway({ handshakeFail: true, keyFixture: fixture }, async ({ handler, handshakes, modelCalls }) => {
    const response = await handler(modelRequest());
    assert.equal(response.status, 200);
    assert.equal(handshakes.length, 1);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0]!.get("x-client-sig"), null, "失败后不得残留任何签名头");
    assert.equal(modelCalls[0]!.get("authorization"), `Bearer ${API_KEY}`);
  });
});

test("连续模型请求复用握手私钥且每次签名值不同", async () => {
  const fixture = await keyFixture();
  await withGateway({ keyFixture: fixture }, async ({ handler, handshakes, modelCalls }) => {
    for (let index = 0; index < 2; index += 1) {
      const response = await handler(modelRequest());
      assert.equal(response.status, 200);
    }
    assert.equal(handshakes.length, 1, "同一 key+origin 的私钥必须缓存复用");
    assert.equal(modelCalls.length, 2);
    for (const headers of modelCalls) await verifySignatureHeaders(headers, fixture.publicKey);
    assert.notEqual(modelCalls[0]!.get("x-client-sig"), modelCalls[1]!.get("x-client-sig"));
  });
});
