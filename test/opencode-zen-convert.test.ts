import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateOpencodeZenResponsesStream,
  convertOpencodeZenRequest,
  responsesToChatBody,
  translateOpencodeZenStream,
} from "../src/opencode/convert.ts";

const encoder = new TextEncoder();
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

test("responses → chat 严格转换：instructions、工具历史、custom 工具与并行开关", () => {
  const body = responsesToChatBody({
    instructions: "SYS-INSTR",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "look up 42" }] },
      { type: "function_call", call_id: "call_1", name: "lookup_issue", arguments: "{\"issue\":42}" },
      { type: "function_call", call_id: "call_2", name: "lookup_issue", arguments: "{\"issue\":43}" },
      { type: "function_call_output", call_id: "call_1", output: "42: example" },
      { type: "custom_tool_call", call_id: "call_3", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "call_3", output: "ok" },
      { type: "reasoning", id: "rs_1", summary: [] },
    ],
    tools: [
      { type: "function", name: "lookup_issue", description: "lookup", parameters: { type: "object", properties: { issue: { type: "number" } } } },
      { type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar", syntax: "lark", definition: "x" } },
    ],
    parallel_tool_calls: false,
    tool_choice: "auto",
    max_output_tokens: 256,
  });
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], { role: "system", content: "SYS-INSTR" });
  assert.deepEqual(messages[1], { role: "user", content: "look up 42" });
  // 相邻 function_call 合并进同一条 assistant 消息，tool 输出按序跟进。
  const assistant = messages[2] as { role: string; tool_calls: Array<{ id: string }> };
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ["call_1", "call_2"]);
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_1", content: "42: example" });
  const custom = messages[4] as { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
  assert.equal(custom.tool_calls[0]!.id, "call_3");
  assert.equal(custom.tool_calls[0]!.function.name, "apply_patch");
  assert.deepEqual(JSON.parse(custom.tool_calls[0]!.function.arguments), { input: "*** Begin Patch" });
  assert.deepEqual(messages[5], { role: "tool", tool_call_id: "call_3", content: "ok" });
  assert.equal(messages.length, 6, "reasoning 条目丢弃");
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.max_tokens, 256);
  const tools = body.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name), ["lookup_issue", "apply_patch"]);
  assert.deepEqual((tools[1]!.function.parameters.properties as Record<string, unknown>).input, { type: "string" });
});

test("convertOpencodeZenRequest：同协议浅拷贝、chat → anthropic max_tokens 修正、chat → responses 结构", () => {
  const input: Record<string, unknown> = {
    model: "opencode-zen/x",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    stream: false,
    max_tokens: 512,
  };
  const same = convertOpencodeZenRequest("chat", "chat", input);
  assert.notEqual(same, input);
  assert.equal(same.max_tokens, 512);
  const anthropic = convertOpencodeZenRequest("chat", "anthropic", input);
  assert.equal(anthropic.max_tokens, 512, "llm-bridge 默认 1024 需被客户端值覆盖");
  assert.equal(anthropic.system, "sys");
  assert.ok(Array.isArray(anthropic.messages));
  const responses = convertOpencodeZenRequest("chat", "responses", input);
  assert.ok(Array.isArray(responses.input));
});

test("translateOpencodeZenStream：chat ↔ responses 工具事件双向完整", async () => {
  const chatSse = [
    "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup_issue\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"issue\\\":42}\"}}]},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\n",
    "data: [DONE]\n\n",
  ].join("");
  const toResponses = await new Response(translateOpencodeZenStream(streamOf(chatSse), "chat", "responses")).text();
  assert.match(toResponses, /response\.function_call_arguments\.delta/);
  assert.match(toResponses, /lookup_issue/);
  assert.match(toResponses, /response\.completed/);
  const responsesSse = [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\",\"model\":\"m\"}}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup_issue\",\"arguments\":\"\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc1\",\"output_index\":0,\"delta\":\"{\\\"issue\\\":42}\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n",
  ].join("");
  const toChat = await new Response(translateOpencodeZenStream(streamOf(responsesSse), "responses", "chat")).text();
  assert.match(toChat, /tool_calls/);
  assert.match(toChat, /lookup_issue/);
  assert.match(toChat, /\[DONE\]/);
});

test("aggregateOpencodeZenResponsesStream：文本、函数调用与 usage 聚合为完整 response", async () => {
  const sse = [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"created_at\":123,\"status\":\"in_progress\",\"model\":\"muse-spark-1.3-contributor-free\"}}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"i1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"i1\",\"output_index\":0,\"content_index\":0,\"delta\":\"hello \"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"i1\",\"output_index\":0,\"content_index\":0,\"delta\":\"world\"}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc1\",\"type\":\"function_call\",\"call_id\":\"call_9\",\"name\":\"lookup_issue\",\"arguments\":\"\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc1\",\"output_index\":1,\"delta\":\"{\\\"issue\\\":9}\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"created_at\":123,\"status\":\"completed\",\"model\":\"muse-spark-1.3-contributor-free\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4,\"total_tokens\":7}}}\n\n",
  ].join("");
  const result = await aggregateOpencodeZenResponsesStream(streamOf(sse));
  assert.equal(result.id, "r1");
  assert.equal(result.object, "response");
  assert.equal(result.status, "completed");
  assert.equal(result.model, "muse-spark-1.3-contributor-free");
  const output = result.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 2);
  assert.equal(output[0]!.type, "message");
  assert.deepEqual((output[0]!.content as Array<Record<string, unknown>>)[0], { type: "output_text", text: "hello world" });
  assert.equal(output[1]!.type, "function_call");
  assert.equal(output[1]!.name, "lookup_issue");
  assert.equal(output[1]!.arguments, "{\"issue\":9}");
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
});
