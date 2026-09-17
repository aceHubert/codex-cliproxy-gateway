import assert from "node:assert/strict";
import { test } from "node:test";
import { createZcodeResponse } from "../src/zcode/response.ts";
import { decodeZcodeThinking, type ZcodeToolMap } from "../src/zcode/wire.ts";

type Json = Record<string, any>;
const model = "z.ai/glm-5.3";
const tools: ZcodeToolMap = new Map([
  ["fn_encoded", { name: "original.function", custom: false }],
  ["custom_encoded", { name: "apply_patch", custom: true }],
]);
const start: Json = { type: "message_start", message: { id: "msg_upstream", model: "glm-5.3", usage: { input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 0 } } };
const textStart = (index = 0, text = ""): Json => ({ type: "content_block_start", index, content_block: { type: "text", text } });
const delta = (index: number, type: string, value: string): Json => ({ type: "content_block_delta", index, delta: { type, [type === "text_delta" ? "text" : type === "thinking_delta" ? "thinking" : type === "signature_delta" ? "signature" : "partial_json"]: value } });
const stop = (index: number): Json => ({ type: "content_block_stop", index });
const end = (reason = "end_turn"): Json[] => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 4 } }, { type: "message_stop" }];
const toolStart = (index: number, name: string, id: string, input: Json = {}): Json => ({ type: "content_block_start", index, content_block: { type: "tool_use", name, id, input } });
function wire(frames: Json[], crlf = false, multiline = false): string {
  return frames.map((frame) => {
    const data = multiline ? JSON.stringify(frame, null, 2).split("\n").map((line) => `data: ${line}`).join("\n") : `data: ${JSON.stringify(frame)}`;
    return `: keepalive\nevent: ${frame.type}\n${data}\n\n`;
  }).join("").replaceAll("\n", crlf ? "\r\n" : "\n");
}
function source(frames: Json[] | string, bytewise = false, crlf = false, multiline = false): Response {
  const bytes = new TextEncoder().encode(typeof frames === "string" ? frames : wire(frames, crlf, multiline));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const limit = bytewise ? offset + 1 : bytes.length;
      controller.enqueue(bytes.slice(offset, limit));
      offset = limit;
    },
  }, { highWaterMark: 0 }));
}
async function streamEvents(frames: Json[] | string, input?: Response): Promise<Json[]> {
  const response = await createZcodeResponse(input ?? source(frames), { model, tools, stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const text = await response.text();
  const events: Json[] = text.trim().split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
  assert.deepEqual(events.map((item) => item.sequence_number), events.map((_, index) => index));
  assert.equal(events[0]!.type, "response.created");
  assert.equal(events[1]!.type, "response.in_progress");
  assert.equal(events.filter((item) => ["response.completed", "response.failed", "response.incomplete"].includes(item.type)).length, 1);
  return events;
}

test("ZCode text emits stable ordered Responses events and complete cached usage", async () => {
  const frames = [start, textStart(5, "你"), delta(5, "text_delta", "好🌍"), stop(5), ...end()];
  const events = await streamEvents(frames);
  const completed = events.at(-1)!.response;
  assert.equal(completed.status, "completed");
  assert.equal(completed.model, model);
  assert.equal(completed.output[0].content[0].text, "你好🌍");
  assert.deepEqual(completed.usage, { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 } });
  const item = completed.output[0];
  const added = events.find((value) => value.type === "response.output_item.added")!;
  assert.equal(added.item.id, item.id);
  assert.equal(added.item.status, "in_progress");
  assert.deepEqual(added.item.content, []);
  for (const value of events.filter((value) => value.item_id)) { assert.equal(value.item_id, item.id); assert.equal(value.output_index, 0); }
  assert.equal(events.find((value) => value.type === "response.output_text.done")!.content_index, 0);
  assert.deepEqual(events.find((value) => value.type === "response.output_item.done")!.item, item);
  assert.ok(events.some((value) => value.type === "response.content_part.added"));
  assert.ok(events.some((value) => value.type === "response.content_part.done"));
  const json = await createZcodeResponse(source(frames), { model, tools, stream: false });
  assert.equal(json.status, 200);
  const data = await json.json() as Json;
  assert.equal(data.output[0].content[0].text, "你好🌍");
  assert.deepEqual(data.usage, completed.usage);
});

test("ZCode SSE survives bytewise UTF8, CRLF and multiple data lines", async () => {
  const frames = [start, textStart(), delta(0, "text_delta", "中文🧑‍💻"), stop(0), ...end()];
  const events = await streamEvents(frames, source(frames, true, true, true));
  assert.equal(events.at(-1)!.response.output[0].content[0].text, "中文🧑‍💻");
});

test("ZCode interleaved tool blocks retain names call ids and custom raw input", async () => {
  const frames = [start, textStart(0, "调用工具"), stop(0), toolStart(3, "fn_encoded", "call_original_1"), toolStart(4, "custom_encoded", "call_original_2"),
    delta(3, "input_json_delta", '{"path":'), delta(4, "input_json_delta", '{"input":"*** Begin'), delta(3, "input_json_delta", '"中文.txt"}'),
    stop(3), delta(4, "input_json_delta", ' Patch\\n*** End Patch"}'), stop(4), ...end("tool_use")];
  const events = await streamEvents(frames);
  const output = events.at(-1)!.response.output;
  assert.deepEqual(output.map((item: Json) => item.type), ["message", "function_call", "custom_tool_call"]);
  assert.equal(output[1].name, "original.function");
  assert.equal(output[1].call_id, "call_original_1");
  assert.equal(output[1].arguments, '{"path":"中文.txt"}');
  assert.equal(output[2].name, "apply_patch");
  assert.equal(output[2].call_id, "call_original_2");
  assert.equal(output[2].input, "*** Begin Patch\n*** End Patch");
  const custom = events.filter((item) => item.type.startsWith("response.custom_tool_call_input"));
  assert.equal(custom.length, 2);
  assert.equal(custom[0]!.delta, output[2].input);
  assert.equal(custom[1]!.input, output[2].input);
  assert.ok(!events.some((item) => item.type === "response.function_call_arguments.delta" && item.output_index === 2));
  const second = await streamEvents([start, textStart(0, "工具已完成"), stop(0), ...end()]);
  assert.equal(second.at(-1)!.response.output[0].content[0].text, "工具已完成");
});

test("ZCode tool initial input emits arguments and custom input without a delta", async () => {
  const events = await streamEvents([start, toolStart(0, "fn_encoded", "c1", { x: 1 }), stop(0), toolStart(1, "custom_encoded", "c2", { input: "hello" }), stop(1), ...end("tool_use")]);
  assert.equal(events.at(-1)!.response.output[0].arguments, '{"x":1}');
  assert.equal(events.at(-1)!.response.output[1].input, "hello");
});

test("ZCode thinking retains signatures and redacted content in opaque model-bound payloads", async () => {
  const frames = [start,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "先" } }, delta(0, "thinking_delta", "思考"), delta(0, "signature_delta", "sig_"), delta(0, "signature_delta", "end"), stop(0),
    { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "无签名" } }, stop(1),
    { type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "opaque" } }, stop(2), textStart(3, "答案"), stop(3), ...end()];
  const events = await streamEvents(frames);
  const output = events.at(-1)!.response.output;
  assert.equal(output[0].type, "reasoning");
  assert.deepEqual(output[0].summary, [{ type: "summary_text", text: "先思考" }]);
  assert.deepEqual(decodeZcodeThinking(output[0].encrypted_content, model), [{ type: "thinking", thinking: "先思考", signature: "sig_end" }]);
  assert.deepEqual(decodeZcodeThinking(output[1].encrypted_content, model), [{ type: "thinking", thinking: "无签名", signature: "" }]);
  assert.deepEqual(decodeZcodeThinking(output[2].encrypted_content, model), [{ type: "redacted_thinking", data: "opaque" }]);
  assert.equal(decodeZcodeThinking(output[0].encrypted_content, "different"), undefined);
  assert.equal(events.filter((item) => item.type === "response.reasoning_summary_text.done").length, 2);
  assert.ok(!events.filter((item) => item.type === "response.output_text.delta").some((item) => item.delta.includes("思考")));
});

test("ZCode max_tokens produces incomplete with complete partial output", async () => {
  const events = await streamEvents([start, textStart(0, "未完"), stop(0), ...end("max_tokens")]);
  assert.equal(events.at(-1)!.type, "response.incomplete");
  assert.deepEqual(events.at(-1)!.response.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(events.at(-1)!.response.output[0].content[0].text, "未完");
});

test("ZCode upstream errors preserve original fields and finalize only once", async () => {
  const original = { type: "overloaded_error", message: "busy", request_id: "req1", details: { retryable: true } };
  const frames = [start, { type: "error", error: original }, ...end()];
  const events = await streamEvents(frames);
  assert.equal(events.at(-1)!.type, "response.failed");
  assert.deepEqual(events.at(-1)!.response.error.upstream_error, original);
  const response = await createZcodeResponse(source(frames), { model, tools, stream: false });
  assert.equal(response.status, 502);
  assert.equal((await response.json() as Json).error.code, "overloaded_error");
});

for (const [label, frames] of [
  ["invalid initial text", [start, { type: "content_block_start", index: 0, content_block: { type: "text", text: 1 } }]],
  ["bad JSON", wire([start]) + "event: content_block_start\ndata: {bad}\n\n"],
  ["premature EOF", [start, textStart(0, "partial")]],
  ["unfinished tool JSON", [start, toolStart(0, "fn_encoded", "c"), delta(0, "input_json_delta", '{"x":'), stop(0), ...end("tool_use")]],
  ["bad custom JSON", [start, toolStart(0, "custom_encoded", "c"), delta(0, "input_json_delta", '{"input":'), stop(0), ...end("tool_use")]],
  ["nonstring custom input", [start, toolStart(0, "custom_encoded", "c", { input: 5 }), stop(0), ...end("tool_use")]],
  ["open block at stop", [start, textStart(), ...end()]],
  ["missing stop reason", [start, { type: "message_stop" }]],
  ["unterminated SSE frame", wire([start]) + 'data: {"type":"message_stop"}'],
  ["unknown tool", [start, toolStart(0, "unknown", "c"), stop(0), ...end("tool_use")]],
] as [string, Json[] | string][]) {
  test(`ZCode rejects ${label} in streaming and JSON modes`, async () => {
    const events = await streamEvents(frames);
    assert.equal(events.at(-1)!.type, "response.failed");
    const response = await createZcodeResponse(source(frames), { model, tools, stream: false });
    assert.equal(response.status, 502);
    assert.equal((await response.json() as Json).status, "failed");
  });
}

test("ZCode downstream backpressure does not start background upstream reads and cancel aborts fetch", async () => {
  let reads = 0;
  let cancels = 0;
  let aborts = 0;
  const completed: Json[] = [];
  const bytes = new TextEncoder().encode(wire([start, textStart(), delta(0, "text_delta", "first")]));
  const upstream = new Response(new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(bytes); }, cancel() { cancels++; } }, { highWaterMark: 0 }));
  const response = await createZcodeResponse(upstream, { model, tools, stream: true, abort: () => { aborts++; }, onComplete: (value) => { completed.push(value); } });
  assert.equal(reads, 0);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  assert.equal(reads, 0);
  await reader.read();
  assert.equal(reads, 1);
  await reader.cancel();
  assert.equal(cancels, 1);
  assert.equal(aborts, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.status, "failed");
});

test("ZCode AbortSignal interrupts pending upstream read and listener is cleaned up", async () => {
  let canceled = 0;
  let removed = 0;
  const signalController = new AbortController();
  const original = signalController.signal.removeEventListener.bind(signalController.signal);
  signalController.signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => { removed++; original(type, listener, options); };
  const response = await createZcodeResponse(new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() { canceled++; } }, { highWaterMark: 0 })), { model, tools, stream: true, signal: signalController.signal });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  const pending = reader.read();
  signalController.abort();
  assert.equal((await pending).done, true);
  assert.equal(canceled, 1);
  assert.equal(removed, 1);
});

test("ZCode throwing logging callbacks do not affect completed output", async () => {
  let completes = 0;
  const response = await createZcodeResponse(source([start, textStart(0, "ok"), stop(0), ...end()]), { model, tools, stream: false,
    onChunk() { throw new Error("logger"); }, onComplete() { completes++; throw new Error("logger"); } });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as Json).status, "completed");
  assert.equal(completes, 1);
});


test("ZCode failed response preserves partial thinking and marks the open item incomplete", async () => {
  const events = await streamEvents([start, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "partial" } }, delta(0, "signature_delta", "sig")]);
  const item = events.at(-1)!.response.output[0];
  assert.equal(item.status, "incomplete");
  assert.deepEqual(decodeZcodeThinking(item.encrypted_content, model), [{ type: "thinking", thinking: "partial", signature: "sig" }]);
});

test("ZCode final event cleans up without waiting for another downstream read", async () => {
  const signalController = new AbortController();
  let removed = 0;
  let canceled = 0;
  const original = signalController.signal.removeEventListener.bind(signalController.signal);
  signalController.signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => { removed++; original(type, listener, options); };
  const data = new TextEncoder().encode(wire([start, ...end()]));
  const upstream = new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(data); }, cancel() { canceled++; } }, { highWaterMark: 0 }));
  const response = await createZcodeResponse(upstream, { model, tools, stream: true, signal: signalController.signal, abort: () => signalController.abort() });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  const terminal = await reader.read();
  assert.match(new TextDecoder().decode(terminal.value), /response.completed/);
  assert.equal(canceled, 1);
  assert.equal(removed, 1);
  await reader.cancel();
});

test("ZCode cancel before the first read still aborts and records a single failure", async () => {
  let aborted = 0;
  let completions = 0;
  const response = await createZcodeResponse(source([start, ...end()]), { model, tools, stream: true, abort() { aborted++; }, onComplete(value) { completions++; assert.equal(value.status, "failed"); } });
  await response.body!.cancel();
  assert.equal(aborted, 1);
  assert.equal(completions, 1);
});

test("ZCode namespaced function and custom calls preserve namespace in every item event", async () => {
  const namespacedTools: ZcodeToolMap = new Map([
    ["fn_encoded", { name: "read", namespace: "files", custom: false }],
    ["custom_encoded", { name: "patch", namespace: "files", custom: true }],
  ]);
  const response = await createZcodeResponse(source([start, toolStart(0, "fn_encoded", "f", { path: "a" }), stop(0), toolStart(1, "custom_encoded", "c", { input: "patch" }), stop(1), ...end("tool_use")]), { model, tools: namespacedTools, stream: true });
  const events = (await response.text()).trim().split("\n\n").map((chunk) => JSON.parse(chunk.split("\n")[1]!.slice(6)) as Json);
  const items = events.filter((value) => value.type === "response.output_item.added" || value.type === "response.output_item.done").map((value) => value.item);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((item) => [item.name, item.namespace]), [["read", "files"], ["read", "files"], ["patch", "files"], ["patch", "files"]]);
  assert.deepEqual(events.at(-1)!.response.output.map((item: Json) => [item.name, item.namespace]), [["read", "files"], ["patch", "files"]]);
});

const serverToolStart = (index: number, id: string, input: Json): Json => ({ type: "content_block_start", index, content_block: { type: "server_tool_use", id, name: "web_search_prime", input } });
const serverResultStart = (index: number, toolUseId: string, content: Json[]): Json => ({ type: "content_block_start", index, content_block: { type: "tool_result", tool_use_id: toolUseId, content } });

test("ZCode server tool blocks fold into one web_search_call item with results", async () => {
  const frames = [start,
    serverToolStart(0, "call_abc123", { search_query: "最新 GLM" }), stop(0),
    textStart(1, ""), delta(1, "text_delta", "搜索完成"), stop(1),
    serverResultStart(2, "call_abc123", [{ type: "text", text: "结果 A" }]), stop(2),
    ...end()];
  const events = await streamEvents(frames);
  const output = events.at(-1)!.response.output;
  assert.deepEqual(output.map((item: Json) => item.type), ["web_search_call", "message"]);
  const item = output[0];
  assert.equal(item.id, "ws_call_abc123");
  assert.deepEqual(item.action, { type: "search", query: "最新 GLM" });
  assert.deepEqual(item.results, [{ type: "web_search_result", text: "结果 A" }]);
  assert.equal(item.status, "completed");
  const added = events.find((value) => value.type === "response.output_item.added" && value.item?.type === "web_search_call")!;
  assert.equal(added.item.status, "in_progress");
  assert.equal(added.item.results, undefined);
  const done = events.find((value) => value.type === "response.output_item.done" && value.item?.type === "web_search_call")!;
  assert.equal(done.item.results.length, 1);
});

test("ZCode server tool without result block closes at turn end and accumulates json deltas", async () => {
  const frames = [start,
    serverToolStart(0, "call_x", {}),
    delta(0, "input_json_delta", '{"quer'), delta(0, "input_json_delta", 'y":"增量查询"}'),
    stop(0), ...end()];
  const events = await streamEvents(frames);
  const item = events.at(-1)!.response.output[0];
  assert.equal(item.type, "web_search_call");
  assert.deepEqual(item.action, { type: "search", query: "增量查询" });
  assert.equal(item.status, "completed");
  assert.equal(item.results, undefined);
});

test("ZCode unknown content block types are ignored without failing the stream", async () => {
  const frames = [start,
    { type: "content_block_start", index: 0, content_block: { type: "future_block", data: 1 } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "被忽略" } },
    stop(0),
    { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "call_y", name: "other_server_tool", input: {} } }, stop(1),
    { type: "content_block_start", index: 2, content_block: { type: "tool_result", tool_use_id: "call_missing", content: [] } }, stop(2),
    textStart(3, "正常"), stop(3), ...end()];
  const events = await streamEvents(frames);
  const output = events.at(-1)!.response.output;
  assert.equal(output.length, 1);
  assert.equal(output[0].content[0].text, "正常");
});

const gatewayVisionTools = new Map<string, { name: string; custom: boolean; gateway?: string }>([
  ["analyze_image", { name: "analyze_image", custom: false, gateway: "analyze_image" }],
]);

test("ZCode 网关代执行工具被吸收并在续跑腿中继续产出连续事件", async () => {
  const legOne = wire([
    start,
    textStart(0, "先看图"), stop(0),
    toolStart(1, "analyze_image", "call_vision_1"),
    delta(1, "input_json_delta", '{"imageSource":"https://cdn/'),
    delta(1, "input_json_delta", 'x.png","prompt":"识别"}'),
    stop(1),
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
  const legTwo = wire([start, textStart(0, "识别完成：表格"), stop(0), ...end()]);
  const executed: Json[] = [];
  const continued: Array<Array<{ call: Json; result: string }>> = [];
  const response = await createZcodeResponse(source(legOne), {
    model, tools: gatewayVisionTools as unknown as ZcodeToolMap, stream: true,
    gatewayTools: {
      maxContinuations: 3,
      execute: async (call) => { executed.push(call as unknown as Json); return "识别结果文本"; },
      nextUpstream: async (calls) => { continued.push(calls as Array<{ call: Json; result: string }>); return source(legTwo); },
    },
  });
  const text = await response.text();
  const events: Json[] = text.trim().split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
  assert.deepEqual(events.map((item) => item.sequence_number), events.map((_, index) => index));
  assert.equal(events.filter((item) => item.type === "response.completed").length, 1);
  assert.deepEqual(executed, [{ id: "call_vision_1", name: "analyze_image", input: { imageSource: "https://cdn/x.png", prompt: "识别" } }]);
  assert.equal(continued.length, 1);
  assert.equal(continued[0][0].result, "识别结果文本");
  const output = events.at(-1)!.response.output;
  assert.deepEqual(output.map((item: Json) => item.type), ["message", "message", "message", "message"]);
  assert.equal(output[0].content[0].text, "先看图");
  // 吸收的调用复刻 z.ai 内置工具旁白：Input 卡片在执行前流出，Output 卡片在执行后流出。
  assert.equal(output[1].content[0].text, "**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{\"imageSource\":\"https://cdn/x.png\",\"prompt\":\"识别\"}\n```\n*Executing on server...*\n");
  assert.equal(output[2].content[0].text, "**Output:**\n**analyze_image_result_summary:** [{\"text\": \"识别结果文本\", \"type\": \"text\"}]");
  assert.equal(output[3].content[0].text, "识别完成：表格");
  assert.ok(!events.some((item) => item.type === "response.output_item.added" && item.item?.type === "function_call"));
});

test("ZCode 网关工具执行失败降级为错误 tool_result，续跑仍继续", async () => {
  const legOne = wire([start, toolStart(0, "analyze_image", "call_v2"), stop(0), { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" }]);
  const legTwo = wire([start, textStart(0, "无法识别"), stop(0), ...end()]);
  let degraded: string | undefined;
  const response = await createZcodeResponse(source(legOne), {
    model, tools: gatewayVisionTools as unknown as ZcodeToolMap, stream: true,
    gatewayTools: {
      maxContinuations: 3,
      execute: async () => { throw new Error("boom"); },
      nextUpstream: async (calls) => { degraded = calls[0]!.result; return source(legTwo); },
    },
  });
  const text = await response.text();
  const events: Json[] = text.trim().split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
  assert.match(degraded!, /analyze_image 执行失败：boom/);
  // 降级结果同样出现在 Output 旁白卡片里，调用过程对客户端保持可见。
  const output = events.at(-1)!.response.output;
  assert.match(output[0]!.content[0].text, /Z\.ai Built-in Tool: analyze_image/);
  assert.match(output[1]!.content[0].text, /analyze_image 执行失败：boom/);
});

test("ZCode 达到续跑上限时吸收调用并按本腿正常收尾", async () => {
  const frames = wire([start, textStart(0, "文本"), stop(0), toolStart(1, "analyze_image", "call_v3"), stop(1), { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" }]);
  let nextLegs = 0;
  const response = await createZcodeResponse(source(frames), {
    model, tools: gatewayVisionTools as unknown as ZcodeToolMap, stream: true,
    gatewayTools: { maxContinuations: 0, execute: async () => "不应执行", nextUpstream: async () => { nextLegs++; throw new Error("不应续跑"); } },
  });
  const text = await response.text();
  const events: Json[] = text.trim().split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
  assert.equal(nextLegs, 0);
  assert.equal(events.at(-1)!.type, "response.completed");
  // 达到上限的调用既不执行也不旁白，保持静默丢弃。
  assert.deepEqual(events.at(-1)!.response.output.map((item: Json) => item.type), ["message"]);
});

test("ZCode 网关工具调用未续跑时补未执行旁白，避免 Executing 卡片悬挂", async () => {
  const frames = wire([start, toolStart(0, "analyze_image", "call_v4"), stop(0), { type: "message_delta", delta: { stop_reason: "max_tokens" } }, { type: "message_stop" }]);
  const response = await createZcodeResponse(source(frames), {
    model, tools: gatewayVisionTools as unknown as ZcodeToolMap, stream: true,
    gatewayTools: { maxContinuations: 3, execute: async () => "不应执行", nextUpstream: async () => { throw new Error("不应续跑"); } },
  });
  const text = await response.text();
  const events: Json[] = text.trim().split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
  const terminal = events.at(-1)!;
  assert.equal(terminal.type, "response.incomplete");
  const texts = terminal.response.output.map((item: Json) => item.content[0].text);
  assert.match(texts[0], /\*Executing on server\.\.\.\*\n$/);
  assert.match(texts[1], /analyze_image 调用未执行：本次响应未发起网关续跑。/);
});
