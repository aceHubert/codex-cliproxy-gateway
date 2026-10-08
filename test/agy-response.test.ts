import assert from "node:assert/strict";
import test from "node:test";
import { createAgyResponse } from "../src/agy/response.ts";

const TIMEOUT = { timeout: 30_000 };
const TOOLS = new Map([
  ["shell", { name: "shell", custom: false }],
  ["apply_patch", { name: "apply_patch", custom: true }],
]);

function sse(frames: Array<Record<string, unknown>>): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function textFrame(text: string, finish?: string): Record<string, unknown> {
  return {
    response: {
      candidates: [finish
        ? { content: { role: "model", parts: [{ text }] }, finishReason: finish }
        : { content: { role: "model", parts: [{ text }] } }],
    },
  };
}

async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));
  const parsed: Array<Record<string, unknown>> = (await response.text()).split("\n\n").flatMap((block) => {
    const raw = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return raw ? [JSON.parse(raw)] : [];
  });
  assert.deepEqual(parsed.map((event) => event.sequence_number), parsed.map((_, index) => index));
  return parsed;
}

function finalResponse(parsed: Array<Record<string, unknown>>): Record<string, unknown> {
  const terminal = parsed.findLast((event) => String(event.type).startsWith("response."));
  assert.ok(terminal, "必须有终态事件");
  return terminal.response as Record<string, unknown>;
}

test("agy 响应转换：文本增量聚合成 message 条目并以 completed 结束", TIMEOUT, async () => {
  const response = await createAgyResponse(sse([
    textFrame("TCP "),
    textFrame("TIME_WAIT "),
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "是主动关闭方的残留状态" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 8, totalTokenCount: 158 } } },
  ]), { model: "agy/gemini-3.8-flash", tools: TOOLS, stream: true });
  const parsed = await events(response);
  assert.equal(parsed[0]!.type, "response.created");
  const deltas = parsed.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta);
  assert.equal(deltas.join(""), "TCP TIME_WAIT 是主动关闭方的残留状态");
  const final = finalResponse(parsed);
  assert.equal(final.status, "completed");
  assert.deepEqual(final.usage, { input_tokens: 120, output_tokens: 30, total_tokens: 158, output_tokens_details: { reasoning_tokens: 8 } });
  const message = (final.output as Array<Record<string, unknown>>)[0]!;
  assert.equal(message.type, "message");
  assert.equal(message.status, "completed");
});

test("agy 响应转换：thought parts 映射 reasoning 摘要且不进入正文", TIMEOUT, async () => {
  const response = await createAgyResponse(sse([
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "内部思考片段", thought: true }] } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "公开回答" }] }, finishReason: "STOP" }] } },
  ]), { model: "agy/gemini-3.8-flash", tools: TOOLS, stream: true });
  const parsed = await events(response);
  const reasoning = parsed.find((event) => event.type === "response.reasoning_summary_text.delta");
  assert.equal(reasoning?.delta, "内部思考片段");
  const final = finalResponse(parsed);
  const types = (final.output as Array<Record<string, unknown>>).map((item) => item.type);
  assert.deepEqual(types, ["reasoning", "message"]);
  const message = (final.output as Array<Record<string, unknown>>)[1]! as { content: Array<{ text: string }> };
  assert.equal(message.content[0]!.text, "公开回答");
});

test("agy 响应转换：functionCall 还原 function_call 与 custom_tool_call 条目", TIMEOUT, async () => {
  const response = await createAgyResponse(sse([
    { response: { candidates: [{ content: { role: "model", parts: [
      { functionCall: { name: "shell", args: { command: "git status" } } },
      { functionCall: { name: "apply_patch", args: { input: "*** patch ***" } } },
    ] }, finishReason: "STOP" }] } },
  ]), { model: "agy/gemini-3.8-flash", tools: TOOLS, stream: true });
  const parsed = await events(response);
  const final = finalResponse(parsed);
  const [call, custom] = final.output as Array<Record<string, unknown>>;
  assert.equal(call.type, "function_call");
  assert.equal(call.name, "shell");
  assert.equal(call.arguments, "{\"command\":\"git status\"}");
  assert.equal(call.status, "completed");
  assert.equal(custom.type, "custom_tool_call");
  assert.equal(custom.name, "apply_patch");
  assert.equal(custom.input, "*** patch ***");
});

test("agy 响应转换：MAX_TOKENS 与安全类 finishReason 归为 incomplete", TIMEOUT, async () => {
  const length = finalResponse(await events(await createAgyResponse(sse([
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "截断" }] }, finishReason: "MAX_TOKENS" }] } },
  ]), { model: "agy/gemini-3.8-flash", tools: TOOLS, stream: true })));
  assert.equal(length.status, "incomplete");
  assert.deepEqual(length.incomplete_details, { reason: "max_output_tokens" });

  const safety = finalResponse(await events(await createAgyResponse(sse([
    { response: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }] } },
  ]), { model: "agy/gemini-3.8-flash", tools: TOOLS, stream: true })));
  assert.equal(safety.status, "incomplete");
  assert.deepEqual(safety.incomplete_details, { reason: "content_filter" });
});

test("agy 响应转换：上游错误帧走 sanitizeError，不回显原始正文", TIMEOUT, async () => {
  const response = await createAgyResponse(sse([
    { error: { code: 429, message: "SECRET quota exceeded SECRET", status: "RESOURCE_EXHAUSTED" } },
  ]), {
    model: "agy/gemini-3.8-flash", tools: TOOLS, stream: true,
    sanitizeError: () => ({ code: "agy_rate_or_quota_limit", message: "Antigravity 上游限流或账号额度受限，请检查用量后重试" }),
  });
  const parsed = await events(response);
  const final = finalResponse(parsed);
  assert.equal(final.status, "failed");
  const text = JSON.stringify(final);
  assert.ok(!text.includes("SECRET"));
  assert.match(text, /agy_rate_or_quota_limit/);
});

test("agy 响应转换：非流式客户端聚合为完整 JSON", TIMEOUT, async () => {
  const response = await createAgyResponse(sse([
    textFrame("聚合"),
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "结果" }] }, finishReason: "STOP" }] } },
  ]), { model: "agy/gemini-3.8-flash", tools: TOOLS, stream: false });
  assert.ok(response.headers.get("content-type")?.includes("application/json"));
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.status, "completed");
  assert.equal((payload.output as Array<Record<string, unknown>>)[0]!.type, "message");
});

test("agy 响应转换：promptFeedback 阻断归为 incomplete(content_filter)", TIMEOUT, async () => {
  const final = finalResponse(await events(await createAgyResponse(sse([
    { response: { candidates: [], promptFeedback: { blockReason: "SAFETY" } } },
  ]), { model: "agy/gemini-3.8-flash", tools: TOOLS, stream: true })));
  assert.equal(final.status, "incomplete");
  assert.deepEqual(final.incomplete_details, { reason: "content_filter" });
});

test("agy 响应：函数调用的 thoughtSignature 以 agn1 信封随 reasoning 项下发", TIMEOUT, async () => {
  const signature = "EqIESIGabc123==";
  const sse = [
    { response: { candidates: [{ content: { role: "model", parts: [
      { text: "先调用工具查询。", thought: true },
      { thoughtSignature: signature },
      { functionCall: { name: "shell", args: { command: "curl wttr.in" } } },
    ] } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] } },
  ];
  const response = await createAgyResponse(new Response(
    sse.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ), {
    model: "agy/gemini-3.8-flash",
    tools: new Map([["shell", { name: "shell", custom: false }]]),
    stream: false,
  });
  const payload = await response.json() as Record<string, any>;
  const items = payload.output as Array<Record<string, any>>;
  const sigIndex = items.findIndex((item) => item.type === "reasoning" && String(item.encrypted_content ?? "").startsWith("agn1:"));
  const callIndex = items.findIndex((item) => item.type === "function_call");
  assert.ok(sigIndex >= 0, "必须下发携带签名的 reasoning 项");
  assert.ok(callIndex === sigIndex + 1, "签名 reasoning 项必须紧邻其函数调用");
  assert.equal(items[sigIndex]!.encrypted_content, `agn1:${signature}`);
});
