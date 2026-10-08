import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { QoderCredentials } from "../src/qoder/credentials.ts";
import { createQoderTransport, decodeQoderBody, encodeQoderBody, type QoderFetch } from "../src/qoder/transport.ts";

const CREDENTIAL: QoderCredentials = { region: "intl", clientProfile: "cli", accountUid: "synthetic-user", authDirectory: "/synthetic/auth", identity: "synthetic-identity",
  machineId: "synthetic-machine", organizationId: "synthetic-org", organizationTags: ["tag1", "tag2"], dataPolicyAgreed: true,
  accessToken: "synthetic-oauth-secret", expireTime: 2000000000, encryptUserInfo: "synthetic-encrypted-info", key: "synthetic-rsa-key" };

function signature(headers: Headers, body: string, path: string): void {
  const parts = headers.get("Authorization")!.slice("Bearer COSY.".length).split(".");
  assert.equal(parts[1], createHash("md5").update([parts[0], CREDENTIAL.key, "1000", body, path].join("\n")).digest("hex"));
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], "base64").toString("utf8")), { version: "v1", requestId: "synthetic-request", info: CREDENTIAL.encryptUserInfo, cosyVersion: "1.1.65", ideVersion: "" });
  const headerValues: string[] = [];
  headers.forEach((value) => headerValues.push(value));
  assert.ok(!JSON.stringify(headerValues).includes(CREDENTIAL.accessToken));
}

test("Qoder 请求编码以协议字母表和外三分之一交换保持 Unicode 字节", () => {
  assert.equal(encodeQoderBody("f"), "$&$D");
  for (const raw of ["", "abc", "中文😀", JSON.stringify({ message: "hello", n: 1 })]) {
    const encoded = encodeQoderBody(raw);
    if (encoded) assert.equal(decodeQoderBody(encoded), raw);
  }
  for (const value of ["bad\n", "!!!!", "?", "$$$$"]) assert.throws(() => decodeQoderBody(value));
});

test("国际目录 GET 对路径签名且只使用当前身份，禁止重定向", async () => {
  let called = false;
  const controller = new AbortController();
  const transport = createQoderTransport({ now: () => 1000000, requestId: () => "synthetic-request", fetch: (async (url, options) => {
    called = true;
    assert.equal(url, "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1");
    assert.equal(options?.method, "GET");
    assert.equal(options?.body, undefined);
    assert.equal(options?.redirect, "error");
    assert.equal(options?.signal, controller.signal);
    const headers = new Headers(options?.headers);
    signature(headers, "", "/api/v2/model/list");
    assert.equal(headers.get("Cosy-Organization-Tags"), "tag1,tag2");
    return Response.json({ chat: [{ key: "synthetic-model", enable: true }] });
  }) as QoderFetch });
  assert.deepEqual(await transport.fetchCatalog(CREDENTIAL, controller.signal), { chat: [{ key: "synthetic-model", enable: true }] });
  assert.equal(called, true);
});

test("推理对最终编码体签名，固定所选模型并返回原始 SSE", async () => {
  const stream = new Response("event:finish\ndata:{}\n\n", { headers: { "Content-Type": "text/event-stream" } });
  const transport = createQoderTransport({ now: () => 1000000, requestId: () => "synthetic-request", fetch: (async (url, options) => {
    assert.equal(url, "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1");
    assert.equal(options?.method, "POST");
    const headers = new Headers(options?.headers);
    const encoded = String(options?.body);
    signature(headers, encoded, "/api/v2/service/pro/sse/agent_chat_generation");
    assert.equal(headers.get("X-Model-Key"), "synthetic-flash");
    assert.equal(headers.get("X-Model-Source"), "system");
    const body = JSON.parse(decodeQoderBody(encoded));
    assert.deepEqual(body.messages, [{ role: "system", content: "system" }, { role: "user", content: "hello" }]);
    assert.deepEqual(body.model_config, { key: "synthetic-flash", format: "openai", source: "system" });
    assert.equal(body.session_id, "session-id");
    assert.equal(body.request_id, "request-id");
    assert.equal(body.request_set_id, body.request_id);
    assert.equal(body.stream, true);
    assert.ok(!encoded.includes(CREDENTIAL.accessToken));
    return stream;
  }) as QoderFetch });
  const response = await transport.infer(CREDENTIAL, { body: { system: "system", messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }], tools: [] }, modelKey: "synthetic-flash", modelConfig: { key: "must-not-route", format: "openai" }, sessionId: "session-id", requestId: "request-id" });
  assert.equal(response, stream);
  assert.match(await response.text(), /event:finish/);
});

test("凭据来源决定上游产品标识：CLI 走 cli/5/qodercli，桌面走 app/10/app", async () => {
  const seen: Array<{ product: string | null; clientType: string | null; sessionType: unknown }> = [];
  const capture = (async (_url: string | URL | Request, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    const body = options?.body ? JSON.parse(decodeQoderBody(String(options.body))) : {};
    seen.push({ product: headers.get("Cosy-Business-Product"), clientType: headers.get("Cosy-ClientType"), sessionType: body.session_type });
    return Response.json({ chat: [{ key: "m", enable: true }] });
  }) as QoderFetch;
  const transport = createQoderTransport({ now: () => 1000000, requestId: () => "r", fetch: capture });
  await transport.fetchCatalog(CREDENTIAL);
  await transport.fetchCatalog({ ...CREDENTIAL, clientProfile: "desktop" });
  await transport.infer(CREDENTIAL, { body: {}, modelKey: "m" });
  await transport.infer({ ...CREDENTIAL, clientProfile: "desktop" }, { body: {}, modelKey: "m" });
  assert.deepEqual(seen[0], { product: "cli", clientType: "5", sessionType: undefined });
  assert.deepEqual(seen[1], { product: "app", clientType: "10", sessionType: undefined });
  assert.deepEqual(seen[2], { product: "cli", clientType: "5", sessionType: "qodercli" });
  assert.deepEqual(seen[3], { product: "app", clientType: "10", sessionType: "app" });
});

test("上游错误正文不泄露令牌、账号或响应回显，授权错误附重新登录指引", async () => {
  for (const status of [401, 403, 429, 500]) {
    const transport = createQoderTransport({ fetch: async () => new Response(`secret ${CREDENTIAL.accessToken}`, { status }) });
    await assert.rejects(transport.fetchCatalog(CREDENTIAL), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes(CREDENTIAL.accessToken));
      if (status === 401 || status === 403) assert.match(error.message, /qoder login/);
      return true;
    });
  }
});

test("目录编码响应可解码，损坏目录失败且不透传原文", async () => {
  const encoded = encodeQoderBody(JSON.stringify({ chat: [] }));
  const transport = createQoderTransport({ fetch: async () => new Response(encoded) });
  assert.deepEqual(await transport.fetchCatalog(CREDENTIAL), { chat: [] });
  const invalid = createQoderTransport({ fetch: async () => new Response("synthetic-sensitive-invalid") });
  await assert.rejects(invalid.fetchCatalog(CREDENTIAL), /目录格式无效/);
});

test("网络异常不透传底层敏感文本，取消请求保留 AbortError", async () => {
  const transport = createQoderTransport({ fetch: async () => { throw new Error(CREDENTIAL.accessToken); } });
  await assert.rejects(transport.fetchCatalog(CREDENTIAL), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /网络请求失败/);
    assert.ok(!error.message.includes(CREDENTIAL.accessToken));
    return true;
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transport.fetchCatalog(CREDENTIAL, controller.signal), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});
