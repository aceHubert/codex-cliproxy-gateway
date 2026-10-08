import assert from "node:assert/strict";
import test from "node:test";
import { translateQoderResponse } from "../src/qoder/response.ts";
import { translateQoderRequest } from "../src/qoder/request.ts";

type Json = Record<string, unknown>;
const encoder = new TextEncoder();
const options = { model: "qoder/international/qfmodel", tools: new Map(), stream: false };
function envelope(chunk: Json | string, status = 200): string {
  return `data: ${JSON.stringify({ statusCodeValue: status, body: typeof chunk === "string" ? chunk : JSON.stringify(chunk) })}\n\n`;
}
function delta(value: Json, finishReason: string | null = null): Json {
  return { choices: [{ index: 0, delta: value, finish_reason: finishReason }] };
}
function upstream(text: string, chunkSize = 0): Response {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = chunkSize ? Math.min(offset + chunkSize, bytes.length) : bytes.length;
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
const finish = "event: finish\ndata: {}\n\n";

test("Qoder 信封 SSE 聚合中文、推理和 usage，保留 billable=false 原值", async () => {
  const text = envelope(delta({ reasoning_content: "思考" }))
    + envelope(delta({ content: "你好" }, "stop"))
    + envelope({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 }, credits: 0.001, original_credits: 0.002, billable: false } })
    + envelope("[DONE]") + finish;
  let observed: Json | undefined;
  const response = await translateQoderResponse(upstream(text, 1), { ...options, onComplete: (value) => { observed = value; } });
  const result = await response.json() as Json;
  assert.equal(response.status, 200);
  assert.equal(result.status, "completed");
  const output = result.output as Json[];
  assert.deepEqual(output[0]!.summary, [{ type: "summary_text", text: "思考" }]);
  assert.equal((output[1]!.content as Json[])[0]!.text, "你好");
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 2 }, credits: 0.001, original_credits: 0.002, billable: false });
  assert.deepEqual(observed, result);
});

test("Qoder 流式 Responses 序号连续且完成事件包含计费字段", async () => {
  const input = envelope(delta({ content: "完成" }, "stop"))
    + envelope({ usage: { prompt_tokens: 2, completion_tokens: 1, billable: false } }) + finish;
  const response = await translateQoderResponse(upstream(input), { ...options, stream: true });
  const events = (await response.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!) as Json);
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.ok(events.some((event) => event.type === "response.output_text.delta" && event.delta === "完成"));
  const result = events.at(-1)!.response as Json;
  assert.equal((result.usage as Json).billable, false);
  assert.equal(result.status, "completed");
});

test("Qoder 内层 DONE 后继续读取 usage，并拒绝缺失 finish 的断流", async () => {
  for (const input of [envelope(delta({ content: "部分回答" }, "stop")), envelope("[DONE]")]) {
    const response = await translateQoderResponse(upstream(input), options);
    const result = await response.json() as Json;
    assert.equal(response.status, 502);
    assert.equal(result.status, "failed");
    assert.match(String((result.error as Json).message), /缺少 finish/);
  }
});

test("Qoder 重编号 index=0 的并行工具调用且能返回工具结果继续请求", async () => {
  const declaration = ["read", "list"].map((name) => ({ type: "function", name, parameters: { type: "object" } }));
  const initial = translateQoderRequest({ input: "调用两个工具", tools: declaration }, "qfmodel");
  const input = envelope(delta({ tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: "{\"path\":" } }] }))
    + envelope(delta({ tool_calls: [{ index: 0, function: { arguments: "\"a\"}" } }] }))
    + envelope(delta({ tool_calls: [{ index: 0, id: "call_list", type: "function", function: { name: "list", arguments: "{}" } }] }, "tool_calls")) + finish;
  const response = await translateQoderResponse(upstream(input), { ...options, tools: initial.tools });
  const result = await response.json() as Json;
  const calls = result.output as Json[];
  assert.deepEqual(calls.map((call) => call.call_id), ["call_read", "call_list"]);
  assert.deepEqual(calls.map((call) => call.arguments), ["{\"path\":\"a\"}", "{}"]);
  const resumed = translateQoderRequest({ input: [
    { role: "user", content: "调用两个工具" }, ...calls,
    { type: "function_call_output", call_id: "call_read", output: "文件" },
    { type: "function_call_output", call_id: "call_list", output: "目录" },
  ], tools: declaration }, "qfmodel");
  assert.deepEqual((resumed.body.messages as Json[]).filter((message) => message.role === "tool").map((message) => message.tool_call_id), ["call_read", "call_list"]);
});

test("Qoder custom 工具响应还原 input，命名空间保持稳定", async () => {
  const translated = translateQoderRequest({ input: "修改", tools: [{ type: "namespace", name: "fs", tools: [{ type: "custom", name: "patch" }] }] }, "qfmodel");
  const name = [...translated.tools.keys()][0]!;
  const response = await translateQoderResponse(upstream(envelope(delta({ tool_calls: [{ id: "call_patch", index: 0, type: "function", function: { name, arguments: "{\"input\":\"补丁\"}" } }] }, "tool_calls")) + finish), { ...options, tools: translated.tools });
  const item = ((await response.json() as Json).output as Json[])[0]!;
  assert.equal(item.type, "custom_tool_call");
  assert.equal(item.input, "补丁");
  assert.equal(item.name, "patch");
  assert.equal(item.namespace, "fs");
});

test("Qoder 长度截断标记 incomplete 而不是 failed", async () => {
  const response = await translateQoderResponse(upstream(envelope(delta({ content: "未完" }, "length")) + finish), options);
  const result = await response.json() as Json;
  assert.equal(response.status, 200);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.incomplete_details, { reason: "max_output_tokens" });
});

test("Qoder 非 200 信封返回 failed 并经过错误脱敏回调", async () => {
  const response = await translateQoderResponse(upstream(envelope({ code: "unauthorized", message: "敏感上游信息" }, 401)), {
    ...options, sanitizeError: (error) => ({ ...error, message: "请重新登录 Qoder CLI" }),
  });
  const result = await response.json() as Json;
  assert.equal(response.status, 502);
  assert.equal((result.error as Json).message, "请重新登录 Qoder CLI");
});

test("Qoder 错误信封保留状态和数字代码，兼容 msg 字段供安全分类", async () => {
  let original: Json | undefined;
  const response = await translateQoderResponse(upstream(envelope({ code: 403, msg: "token expired" }, 401)), {
    ...options, sanitizeError: (error) => {
      original = error.upstream_error as Json;
      return { code: "safe_auth_error", message: "请更新登录" };
    },
  });
  const payload = await response.json() as Json;
  assert.equal(original!.status, 401);
  assert.equal(original!.code, "403");
  assert.equal(original!.message, "token expired");
  assert.equal((payload.error as Json).upstream_error, undefined);
});

test("Qoder 拒绝畸形信封、无效 UTF-8 和残缺 SSE", async () => {
  for (const text of ["data: {broken}\n\n", "data: {}", envelope({ choices: [] }).replace(/\n\n$/, ""), "data: [DONE]\n\n"]) {
    const response = await translateQoderResponse(upstream(text), options);
    const result = await response.json() as Json;
    assert.equal(response.status, 502);
    assert.equal(result.status, "failed");
    assert.doesNotMatch(String((result.error as Json).message), /CodeBuddy/);
  }
  const bad = new Response(new Uint8Array([0xff]), { headers: { "content-type": "text/event-stream" } });
  assert.equal((await translateQoderResponse(bad, options)).status, 502);
});

test("Qoder finish 后释放上游读取并执行中止回调", async () => {
  let canceled = false;
  let aborted = false;
  const source = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(envelope(delta({ content: "完成" }, "stop")) + finish)); },
    cancel() { canceled = true; },
  }));
  const response = await translateQoderResponse(source, { ...options, abort: () => { aborted = true; } });
  assert.equal(response.status, 200);
  assert.equal(canceled, true);
  assert.equal(aborted, true);
});

test("Qoder 客户端取消会释放没有 finish 的上游连接", { timeout: 1000 }, async () => {
  let canceled = false;
  const source = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(envelope(delta({ content: "开始" })))); },
    cancel() { canceled = true; },
  }));
  const controller = new AbortController();
  const response = await translateQoderResponse(source, { ...options, stream: true, signal: controller.signal });
  const reader = response.body!.getReader();
  while (true) {
    const frame = new TextDecoder().decode((await reader.read()).value);
    if (frame.includes("response.output_text.delta")) break;
  }
  const pending = reader.read();
  controller.abort();
  await pending;
  await reader.cancel();
  assert.equal(canceled, true);
});
