import assert from "node:assert/strict";
import test from "node:test";
import { createCodebuddyResponse } from "../src/codebuddy/response.ts";
import type { CodebuddyToolMap } from "../src/codebuddy/request.ts";
import { decodeCodebuddyReasoning } from "../src/codebuddy/wire.ts";

type Json = Record<string, any>;

function toolsMap(entries: Array<[string, { name: string; custom: boolean }]> = []): CodebuddyToolMap {
  return new Map(entries);
}

function chunk(delta: Json, finishReason: string | null = null, usage?: Json): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

function sse(frames: string[]): Response {
  return new Response(frames.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

async function completed(response: Response): Promise<Json> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return await response.json() as Json;
  const text = await response.text();
  const events = text.split("\n\n").flatMap((block) => {
    const raw = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return raw && raw !== "[DONE]" ? [JSON.parse(raw)] : [];
  });
  assert.ok(events.every((event: Json) => typeof event.sequence_number === "number"), "事件必须携带连续序号");
  const final = events.findLast((event: Json) => event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed");
  assert.ok(final, `SSE 必须结束于终态事件：${text.slice(0, 400)}`);
  return final.response;
}

test("文本流：message 条目生命周期与 usage 汇总", async () => {
  const upstream = sse([
    chunk({ role: "assistant", content: "你" }),
    chunk({ content: "好" }),
    chunk({}, "stop", { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, prompt_tokens_details: { cached_tokens: 3 } }),
  ]);
  const response = await createCodebuddyResponse(upstream, { model: "codebuddy/gpt-5.6-luna", tools: toolsMap(), stream: true });
  const result = await completed(response);
  assert.equal(result.status, "completed");
  assert.equal(result.model, "codebuddy/gpt-5.6-luna");
  const message = result.output[0];
  assert.equal(message.type, "message");
  assert.equal(message.status, "completed");
  assert.equal(message.content[0].type, "output_text");
  assert.equal(message.content[0].text, "你好");
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 2, total_tokens: 9, input_tokens_details: { cached_tokens: 3 } });
});

test("非流式客户端：SSE 聚合为完整 Responses JSON", async () => {
  const upstream = sse([
    chunk({ reasoning_content: "想一想" }),
    chunk({ content: "答案" }),
    chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9, completion_tokens_details: { reasoning_tokens: 2 } }),
  ]);
  const response = await createCodebuddyResponse(upstream, { model: "codebuddy/deepseek-m", tools: toolsMap(), stream: false });
  assert.ok(response.headers.get("content-type")?.includes("application/json"));
  const result = await response.json() as Json;
  assert.equal(result.status, "completed");
  assert.equal(result.output[0].type, "reasoning");
  assert.equal(result.output[0].summary[0].text, "想一想");
  assert.equal(decodeCodebuddyReasoning(result.output[0].encrypted_content, "codebuddy/deepseek-m"), "想一想");
  assert.equal(result.output[1].content[0].text, "答案");
  assert.deepEqual(result.usage.output_tokens_details, { reasoning_tokens: 2 });
});

test("reasoning_content 映射为 reasoning 摘要条目与增量事件", async () => {
  const upstream = sse([
    chunk({ reasoning_content: "思" }),
    chunk({ reasoning_content: "考" }),
    chunk({ content: "答" }),
    chunk({}, "stop"),
  ]);
  const response = await createCodebuddyResponse(upstream, { model: "deepseek-m", tools: toolsMap(), stream: true });
  const text = await response.text();
  assert.match(text, /event: response.reasoning_summary_text.delta/);
  assert.match(text, /event: response.reasoning_summary_part.done/);
  assert.match(text, /event: response.output_text.delta/);
  const result = await completed(new Response(text, { headers: { "content-type": "text/event-stream" } }));
  assert.equal(result.output[0].type, "reasoning");
  assert.equal(result.output[0].summary[0].text, "思考");
  assert.equal(decodeCodebuddyReasoning(result.output[0].encrypted_content, "deepseek-m"), "思考");
  assert.equal(result.output[1].content[0].text, "答");
});

test("空 reasoning_content 仍保留可回放的字段存在性", async () => {
  const upstream = sse([
    chunk({ reasoning_content: "" }),
    chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } }] }),
    chunk({}, "tool_calls"),
  ]);
  const response = await createCodebuddyResponse(upstream, {
    model: "codebuddy/deepseek-v4.1-flash",
    tools: toolsMap([["read_file", { name: "read_file", custom: false }]]),
    stream: false,
  });
  const result = await response.json() as Json;
  assert.equal(result.output[0].type, "reasoning");
  assert.deepEqual(result.output[0].summary, []);
  assert.equal(decodeCodebuddyReasoning(result.output[0].encrypted_content, "codebuddy/deepseek-v4.1-flash"), "");
  assert.equal(result.output[1].type, "function_call");
});

test("tool_calls：参数增量聚合，custom 工具还原为 custom_tool_call", async () => {
  const tools = toolsMap([
    ["read_file", { name: "read_file", custom: false }],
    ["apply_patch", { name: "apply_patch", custom: true }],
  ]);
  const upstream = sse([
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"pa" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "th\":\"x\"}" } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "apply_patch", arguments: "{\"input\":\"*** patch\"}" } }] }),
    chunk({}, "tool_calls"),
  ]);
  const response = await createCodebuddyResponse(upstream, { model: "m", tools, stream: false });
  const result = await response.json() as Json;
  assert.equal(result.status, "completed");
  const call = result.output[0];
  assert.equal(call.type, "function_call");
  assert.equal(call.call_id, "call_a");
  assert.equal(call.name, "read_file");
  assert.deepEqual(JSON.parse(call.arguments), { path: "x" });
  assert.equal(call.status, "completed");
  const custom = result.output[1];
  assert.equal(custom.type, "custom_tool_call");
  assert.equal(custom.call_id, "call_b");
  assert.equal(custom.name, "apply_patch");
  assert.equal(custom.input, "*** patch");
});

test("refusal 映射为 refusal 内容分部", async () => {
  const upstream = sse([
    chunk({ refusal: "不能" }),
    chunk({ refusal: "帮忙" }),
    chunk({}, "stop"),
  ]);
  const response = await createCodebuddyResponse(upstream, { model: "m", tools: toolsMap(), stream: false });
  const result = await response.json() as Json;
  const message = result.output[0];
  assert.equal(message.type, "message");
  assert.equal(message.content[0].type, "refusal");
  assert.equal(message.content[0].refusal, "不能帮忙");
});

test("finish_reason length/content_filter 映射为 incomplete", async () => {
  for (const [reason, expected] of [["length", "max_output_tokens"], ["content_filter", "content_filter"]] as const) {
    const upstream = sse([chunk({ content: "部分" }, reason)]);
    const response = await createCodebuddyResponse(upstream, { model: "m", tools: toolsMap(), stream: false });
    const result = await response.json() as Json;
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.incomplete_details, { reason: expected });
  }
});

test("上游 error 帧转 failed，未声明的工具报错", async () => {
  const errorFrame = `data: ${JSON.stringify({ error: { message: "quota exceeded", code: 429 } })}\n\n`;
  const failed = await createCodebuddyResponse(new Response(errorFrame, { headers: { "content-type": "text/event-stream" } }), {
    model: "m", tools: toolsMap(), stream: false,
  });
  const result = await failed.json() as Json;
  assert.equal(result.status, "failed");
  assert.equal(result.error.message, "quota exceeded");

  const undeclared = sse([chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "ghost", arguments: "{}" } }] }), chunk({}, "tool_calls")]);
  const response = await createCodebuddyResponse(undeclared, { model: "m", tools: toolsMap(), stream: false });
  const rejected = await response.json() as Json;
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error.message, /未声明的工具/);
});

test("整包 JSON 上游重放为同一事件序列", async () => {
  const upstream = Response.json({
    id: "chatcmpl-full",
    object: "chat.completion",
    created: 2,
    model: "gpt-5.6-luna",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "整包回答", reasoning_content: "推理" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
  });
  const response = await createCodebuddyResponse(upstream, { model: "codebuddy/m", tools: toolsMap(), stream: false });
  const result = await response.json() as Json;
  assert.equal(result.status, "completed");
  assert.equal(result.output[0].type, "reasoning");
  assert.equal(result.output[0].encrypted_content, undefined, "非 DeepSeek 不生成本地回传载荷");
  assert.equal(result.output[1].content[0].text, "整包回答");
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 3, total_tokens: 6 });
});

test("整包 JSON 保留空 reasoning_content 并为并行工具补 index", async () => {
  const upstream = Response.json({
    id: "chatcmpl-full-tools",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read_a", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "read_b", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    }],
  });
  const tools = toolsMap([
    ["read_a", { name: "read_a", custom: false }],
    ["read_b", { name: "read_b", custom: false }],
  ]);
  const response = await createCodebuddyResponse(upstream, {
    model: "codebuddy/deepseek-v4.1-flash", tools, stream: false,
  });
  const result = await response.json() as Json;
  assert.equal(result.status, "completed");
  assert.equal(decodeCodebuddyReasoning(result.output[0].encrypted_content, result.model), "");
  assert.deepEqual(result.output.slice(1).map((item: Json) => [item.type, item.call_id, item.name]), [
    ["function_call", "call_a", "read_a"],
    ["function_call", "call_b", "read_b"],
  ]);
});

test("无效 SSE JSON 与不支持的 finish_reason 报协议错误", async () => {
  const bad = new Response("data: {oops\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const response = await createCodebuddyResponse(bad, { model: "m", tools: toolsMap(), stream: false });
  assert.equal(response.status, 502);
  const result = await response.json() as Json;
  assert.equal(result.status, "failed");

  const weird = sse([chunk({ content: "x" }, "function_call")]);
  const response2 = await createCodebuddyResponse(weird, { model: "m", tools: toolsMap(), stream: false });
  assert.equal(response2.status, 502);
});
