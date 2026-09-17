import assert from "node:assert/strict";
import test from "node:test";
import {
  buildZcodeModelHeaders, buildZcodeSourceHeaders, createZcodeContexts,
  decorateZcodeBody, zcodePlan, type ZcodeIdentity,
} from "../src/zcode/request-context.ts";
import type { ZcodeProviderSnapshot } from "../src/zcode/config.ts";

const identity: ZcodeIdentity = {
  appVersion: "3.11.2", language: "zh-CN", timezone: "Asia/Shanghai",
  platform: "darwin", arch: "arm64", osVersion: "24.0.0",
};
function snapshot(providerID = "builtin:zai-coding-plan", apiKey = "key-a"): ZcodeProviderSnapshot {
  return { family: "zai", providerID, apiKey, baseURL: "https://api.z.ai/api/anthropic", modelIds: ["glm-5.3"] };
}
function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/responses", { headers });
}

test("套餐依据精确 builtin provider ID，模型请求按套餐使用正确鉴权", () => {
  assert.equal(zcodePlan(snapshot()), "coding-plan");
  assert.equal(zcodePlan(snapshot("builtin:zai-start-plan")), "start-plan");
  assert.equal(zcodePlan(snapshot("custom:zai-coding-plan")), "api-key");
  const context = { requestId: "req", traceId: "trace", queryId: "query", sessionId: "session", sessionType: "main" as const };
  for (const [plan, apiKey, hasKey] of [["coding-plan", "business", true], ["api-key", "custom", true], ["start-plan", "jwt", false]] as const) {
    const headers = buildZcodeModelHeaders(identity, context, plan, apiKey);
    assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
    assert.equal(headers.has("x-api-key"), hasKey);
  }
});

test("模型来源头为受控白名单且不含设备或授权信息", () => {
  const model = buildZcodeSourceHeaders(identity);
  assert.equal(model.get("http-referer"), "https://zcode.z.ai");
  assert.equal(model.get("user-agent"), "ZCode/3.11.2 ai-sdk/anthropic/3.0.81");
  assert.equal(model.get("x-zcode-agent"), "glm");
  for (const headers of [model]) {
    assert.equal(headers.get("x-device-mid"), null);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-client-language"), "zh-CN");
    assert.equal(headers.get("x-os-category"), "macos");
  }
  const unsafe = buildZcodeSourceHeaders({ ...identity, appVersion: "bad\nvalue", language: "\t", platform: "<bad>" });
  assert.equal(unsafe.get("x-zcode-app-version"), null);
  assert.equal(unsafe.get("user-agent"), "ZCode/unknown ai-sdk/anthropic/3.0.81");
  assert.equal(unsafe.get("x-client-language"), "unknown");
});

test("会话仅按受控 thread/session 与当前 provider/key 作用域稳定映射", () => {
  let time = 0;
  let serial = 0;
  const contexts = createZcodeContexts({ now: () => time, uuid: () => `id-${++serial}`, ttlMs: 900, maxEntries: 2 });
  const first = contexts.resolve(request({ "thread-id": "thread-a", "x-session-id": "attacker" }), snapshot());
  const again = contexts.resolve(request({ "thread-id": "thread-a", "x-session-id": "other" }), snapshot());
  assert.equal(first.sessionId, again.sessionId);
  assert.notEqual(first.requestId, again.requestId);
  assert.notEqual(first.traceId, again.traceId);
  assert.notEqual(first.queryId, again.queryId);
  assert.equal(first.sessionType, "main");
  assert.equal(contexts.resolve(request({ "thread-id": "thread-a", "x-codex-parent-thread-id": "parent" }), snapshot()).sessionType, "subagent");
  assert.equal(contexts.resolve(request(), snapshot()).sessionType, "other");
  assert.notEqual(first.sessionId, contexts.resolve(request({ "thread-id": "thread-a" }), snapshot("builtin:zai-coding-plan", "key-b")).sessionId);
  assert.notEqual(first.sessionId, contexts.resolve(request({ "thread-id": "thread-a" }), snapshot("custom:zai", "key-a")).sessionId);
  time = 901;
  assert.notEqual(first.sessionId, contexts.resolve(request({ "thread-id": "thread-a" }), snapshot()).sessionId);
  contexts.close();
  assert.throws(() => contexts.resolve(request(), snapshot()), /已关闭/);
});

test("会话上限驱逐旧映射，并拒绝不安全的入站会话标识", () => {
  let serial = 0;
  const contexts = createZcodeContexts({ uuid: () => `id-${++serial}`, maxEntries: 2 });
  const first = contexts.resolve(request({ "thread-id": "one" }), snapshot()).sessionId;
  contexts.resolve(request({ "thread-id": "two" }), snapshot());
  contexts.resolve(request({ "thread-id": "three" }), snapshot());
  assert.notEqual(first, contexts.resolve(request({ "thread-id": "one" }), snapshot()).sessionId);
  assert.equal(contexts.resolve(request({ "thread-id": "x".repeat(129) }), snapshot()).sessionType, "other");
  assert.equal(contexts.resolve(request({ "x-codex-parent-thread-id": "parent" }), snapshot()).sessionType, "subagent");
  assert.equal(contexts.resolve(request({ "thread-id": "one", "x-codex-parent-thread-id": "x".repeat(129) }), snapshot()).sessionType, "main");
});

test("正文克隆后只保留一个最后合法缓存点，并写入内部会话 metadata", () => {
  const original = {
    metadata: { keep: true, user_id: "caller" },
    messages: [
      { role: "system", content: [{ type: "text", text: "规则", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: [{ type: "text", text: "旧", cache_control: { type: "ephemeral" } }, { type: "image", source: {}, cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "私有", cache_control: { type: "ephemeral" } }, { type: "redacted_thinking", data: "x" }, { type: "tool_use", name: "read", input: {} }] },
    ],
    tools: [{ name: "unchanged", cache_control: { type: "ephemeral" } }],
  };
  const result = decorateZcodeBody(original, { requestId: "r", traceId: "t", queryId: "q", sessionId: "internal", sessionType: "main" });
  assert.deepEqual(original.messages[1].content[0].cache_control, { type: "ephemeral" });
  assert.deepEqual((result.messages as any[])[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal((result.messages as any[])[1].content[0].cache_control, undefined);
  assert.equal((result.messages as any[])[1].content[1].cache_control, undefined);
  assert.equal((result.messages as any[])[2].content[0].cache_control, undefined);
  assert.deepEqual((result.messages as any[])[2].content[2].cache_control, { type: "ephemeral" });
  assert.deepEqual(result.tools, original.tools);
  assert.deepEqual(result.metadata, { keep: true, user_id: JSON.stringify({ account_uuid: "", session_id: "internal" }) });
  assert.deepEqual(decorateZcodeBody(result, { requestId: "r", traceId: "t", queryId: "q", sessionId: "internal", sessionType: "main" }), result);
});


test("活跃会话按最后使用时间延长且 thread-id 与 session-id 不混用", () => {
  let time = 0;
  let counter = 0;
  const contexts = createZcodeContexts({ now: () => time, uuid: () => `value-${++counter}`, ttlMs: 900 });
  const active = contexts.resolve(request({ "thread-id": "same" }), snapshot()).sessionId;
  time = 800;
  assert.equal(contexts.resolve(request({ "thread-id": "same" }), snapshot()).sessionId, active);
  time = 1000;
  assert.equal(contexts.resolve(request({ "thread-id": "same" }), snapshot()).sessionId, active);
  assert.notEqual(contexts.resolve(request({ "session-id": "same" }), snapshot()).sessionId, active);
  contexts.close();
});
