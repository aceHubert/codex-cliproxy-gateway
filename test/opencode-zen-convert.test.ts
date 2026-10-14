import assert from "node:assert/strict";
import test from "./host-test.ts";
import {
  aggregateOpencodeZenResponsesStream,
  convertOpencodeZenRequest,
  responsesToChatBody,
  translateOpencodeZenStream,
} from "@agent-proxy/opencode-zen/convert";

const encoder = new TextEncoder();
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseEvent(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function readSseEvents(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n").flatMap((frame) => frame.split("\n")
    .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>));
}

function chatToolStream(calls: Array<{ id: string; name: string; fragments: string[] }>): ReadableStream<Uint8Array> {
  const deltas: Array<Record<string, unknown>> = [{
    tool_calls: calls.map((call, index) => ({
      index, id: call.id, type: "function", function: { name: call.name, arguments: "" },
    })),
  }];
  const count = Math.max(...calls.map((call) => call.fragments.length));
  for (let part = 0; part < count; part++) {
    deltas.push({ tool_calls: calls.flatMap((call, index) => part < call.fragments.length
      ? [{ index, function: { arguments: call.fragments[part] } }]
      : []) });
  }
  const frames = deltas.map((delta) => `data: ${JSON.stringify({
    id: "chat_tools", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  frames.push(`data: ${JSON.stringify({
    id: "chat_tools", object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  })}\n\n`, "data: [DONE]\n\n");
  return streamOf(frames.join(""));
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

test("chat → responses 按客户端声明还原 custom 工具并保留并行 function 调用", async () => {
  const patch = "*** Begin Patch\n*** Add File: 中文.txt\n+引号：\"你好\"，路径：C:\\临时\n*** End Patch";
  const args = JSON.stringify({ input: patch });
  // 每个字符单独分片，使 JSON 转义、中文及换行都经过参数缓冲。
  const upstream = chatToolStream([
    { id: "call_patch", name: "apply_patch", fragments: Array.from(args) },
    { id: "call_lookup", name: "lookup_issue", fragments: ["{\"issue\":", "42}"] },
  ]);
  const clientTools = [
    { type: "custom", name: "apply_patch" },
    { type: "function", name: "lookup_issue", parameters: { type: "object" } },
  ];
  const events = readSseEvents(await new Response(translateOpencodeZenStream(upstream, "chat", "responses", clientTools)).text());
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  const added = events.filter((event) => event.type === "response.output_item.added")
    .map((event) => event.item as Record<string, unknown>);
  const custom = added.find((item) => item.name === "apply_patch")!;
  assert.ok(custom);
  assert.equal(custom.type, "custom_tool_call");
  assert.equal(custom.call_id, "call_patch");
  assert.equal(custom.input, "");
  assert.equal("arguments" in custom, false);
  assert.equal(added.find((item) => item.name === "lookup_issue")!.type, "function_call");

  const inputEvents = events.filter((event) => event.type === "response.custom_tool_call_input.delta");
  assert.equal(inputEvents.map((event) => event.delta).join(""), patch);
  for (const event of inputEvents) assert.equal(event.item_id, custom.id);
  const inputDone = events.find((event) => event.type === "response.custom_tool_call_input.done")!;
  assert.equal(inputDone.input, patch);
  assert.equal(inputDone.item_id, custom.id);
  assert.equal(events.filter((event) => event.type === "response.function_call_arguments.delta")
    .map((event) => event.delta).join(""), "{\"issue\":42}");

  const doneItems = events.filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item as Record<string, unknown>);
  const patchDone = doneItems.find((item) => item.name === "apply_patch")!;
  assert.equal(patchDone.type, "custom_tool_call");
  assert.equal(patchDone.call_id, "call_patch");
  assert.equal(patchDone.input, patch);
  assert.equal(patchDone.id, custom.id);
  assert.equal("arguments" in patchDone, false);
  const completed = events.find((event) => event.type === "response.completed")!.response as Record<string, unknown>;
  const output = completed.output as Array<Record<string, unknown>>;
  assert.deepEqual(output.find((item) => item.name === "apply_patch"), patchDone);
  assert.equal(output.find((item) => item.name === "lookup_issue")!.arguments, "{\"issue\":42}");
});

test("chat → responses custom 恢复使用任意声明名称并接受空 input", async () => {
  for (const input of ["", "首行\n次行\\\"尾部"]) {
    const upstream = chatToolStream([{ id: "call_custom", name: "custom_editor", fragments: [JSON.stringify({ input })] }]);
    const translated = translateOpencodeZenStream(upstream, "chat", "responses", [{ type: "custom", name: "custom_editor" }]);
    const result = await aggregateOpencodeZenResponsesStream(translated);
    const item = (result.output as Array<Record<string, unknown>>).find((entry) => entry.name === "custom_editor")!;
    assert.ok(item);
    assert.equal(item.type, "custom_tool_call");
    assert.equal(item.call_id, "call_custom");
    assert.equal(item.input, input);
    assert.equal("arguments" in item, false);
  }
});

test("chat → responses 未声明 custom 的同名工具仍然使用 function 协议", async () => {
  const args = JSON.stringify({ input: "补丁正文" });
  const upstream = chatToolStream([{ id: "call_function", name: "apply_patch", fragments: [args] }]);
  const events = readSseEvents(await new Response(translateOpencodeZenStream(upstream, "chat", "responses", [
    { type: "function", name: "apply_patch", parameters: { type: "object" } },
  ])).text());
  assert.equal(events.some((event) => event.type === "response.custom_tool_call_input.delta"), false);
  const item = events.find((event) => event.type === "response.output_item.added")!.item as Record<string, unknown>;
  assert.equal(item.type, "function_call");
  assert.equal(events.filter((event) => event.type === "response.function_call_arguments.delta")
    .map((event) => event.delta).join(""), args);
});

test("chat → responses custom 参数损坏、缺失或非字符串 input 时明确失败", async () => {
  for (const args of ["{\"input\":", "{}", "{\"input\":42}", "{\"input\":null}", "[\"patch\"]"]) {
    const upstream = chatToolStream([{ id: "call_invalid", name: "apply_patch", fragments: [args] }]);
    const translated = translateOpencodeZenStream(upstream, "chat", "responses", [{ type: "custom", name: "apply_patch" }]);
    await assert.rejects(new Response(translated).text(), /apply_patch|custom|input/i, args);
  }
});

test("chat → responses custom 调用提前结束时不产出成功完成事件", async () => {
  for (const args of ["{\"input\":", JSON.stringify({ input: "完整参数仍需要调用结束标记" })]) {
    const text = `data: ${JSON.stringify({
      id: "chat_cutoff", object: "chat.completion.chunk", choices: [{ index: 0, finish_reason: null, delta: {
        tool_calls: [{ index: 0, id: "call_cutoff", type: "function", function: { name: "apply_patch", arguments: args } }],
      } }],
    })}\n\n`;
    const reader = translateOpencodeZenStream(streamOf(text), "chat", "responses", [{ type: "custom", name: "apply_patch" }]).getReader();
    const decoder = new TextDecoder();
    let emitted = "";
    await assert.rejects(async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        emitted += decoder.decode(value, { stream: true });
      }
    }, /custom|未完成|提前断开/i);
    const events = readSseEvents(emitted);
    assert.equal(events.some((event) => event.type === "response.custom_tool_call_input.done"), false);
    assert.equal(events.some((event) => event.type === "response.output_item.done"), false);
    assert.equal(events.some((event) => event.type === "response.completed"), false);
  }
});

test("anthropic → responses 工具条目完成但响应未完成就断开时拒绝成功聚合", async () => {
  const input = "*** Begin Patch\n+仍需等待响应完成\n*** End Patch";
  const text = [
    { type: "message_start", message: { id: "anthropic_cutoff", model: "model", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_cutoff", name: "apply_patch", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ input }) } },
    { type: "content_block_stop", index: 0 },
  ].map(sseEvent).join("");
  const translate = () => translateOpencodeZenStream(streamOf(text), "anthropic", "responses", [{ type: "custom", name: "apply_patch" }]);
  const reader = translate().getReader();
  const decoder = new TextDecoder();
  let emitted = "";
  await assert.rejects(async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      emitted += decoder.decode(value, { stream: true });
    }
  }, /custom|未完成|断开|Responses/i);
  const events = readSseEvents(emitted);
  assert.equal(events.some((event) => event.type === "response.output_item.done"), true);
  assert.equal(events.some((event) => event.type === "response.completed"), false);
  await assert.rejects(aggregateOpencodeZenResponsesStream(translate()), /custom|未完成|断开|Responses/i);
});

test("anthropic 与 google → responses custom 工具解包后可聚合并重新转换请求历史", async () => {
  const input = "*** Begin Patch\n+中文引号\"与\\路径\n*** End Patch";
  const args = JSON.stringify({ input });
  const anthropic = [
    { type: "message_start", message: { id: "anthropic_custom", model: "model", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_anthropic", name: "apply_patch", input: {} } },
    ...Array.from(args).map((fragment) => ({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: fragment } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 1, output_tokens: 2 } },
    { type: "message_stop" },
  ].map(sseEvent).join("");
  const google = `data: ${JSON.stringify({
    modelVersion: "model", candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "apply_patch", args: { input } } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
  })}\n\n`;
  for (const [protocol, text] of [["anthropic", anthropic], ["google", google]] as const) {
    const translated = translateOpencodeZenStream(streamOf(text), protocol, "responses", [{ type: "custom", name: "apply_patch" }]);
    const result = await aggregateOpencodeZenResponsesStream(translated);
    const item = (result.output as Array<Record<string, unknown>>).find((entry) => entry.name === "apply_patch")!;
    assert.ok(item, protocol);
    assert.equal(item.type, "custom_tool_call", protocol);
    assert.equal(item.input, input, protocol);
    assert.equal(typeof item.call_id, "string");
    assert.ok(item.call_id);
    const request = responsesToChatBody({ input: [item, { type: "custom_tool_call_output", call_id: item.call_id, output: "补丁已应用" }] });
    const messages = request.messages as Array<Record<string, unknown>>;
    const call = (messages[0]!.tool_calls as Array<Record<string, unknown>>)[0]!;
    assert.equal(call.id, item.call_id);
    const function_ = call.function as Record<string, unknown>;
    assert.equal(function_.name, "apply_patch");
    assert.deepEqual(JSON.parse(String(function_.arguments)), { input });
    assert.deepEqual(messages[1], { role: "tool", tool_call_id: item.call_id, content: "补丁已应用" });
  }
});

test("aggregateOpencodeZenResponsesStream：custom input 增量、done 及条目完成事件保留正文和标识", async () => {
  const input = "*** Begin Patch\n+中文与\\反斜杠\n*** End Patch";
  const item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_custom", name: "apply_patch", input, status: "completed" };
  for (const mode of ["delta", "input_done", "item_done"]) {
    const events: Array<Record<string, unknown>> = [
      { type: "response.created", response: { id: "response_custom", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, input: "", status: "in_progress" } },
    ];
    if (mode === "delta") {
      events.push(
        { type: "response.custom_tool_call_input.delta", item_id: item.id, output_index: 0, delta: input.slice(0, 12) },
        { type: "response.custom_tool_call_input.delta", output_index: 0, delta: input.slice(12) },
        { type: "response.custom_tool_call_input.done", item_id: item.id, output_index: 0, input },
        { type: "response.output_item.done", output_index: 0, item },
      );
    } else if (mode === "input_done") {
      events.push({ type: "response.custom_tool_call_input.done", item_id: item.id, output_index: 0, input });
    } else {
      events.push({ type: "response.output_item.done", output_index: 0, item });
    }
    events.push({ type: "response.completed", response: { id: "response_custom", status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
    const result = await aggregateOpencodeZenResponsesStream(streamOf(events.map(sseEvent).join("")));
    assert.deepEqual(result.output, [item], mode);
    assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  }
});

test("aggregateOpencodeZenResponsesStream：失败或未完成的 custom 响应保留终态", async () => {
  const item = { type: "custom_tool_call", id: "ctc_failed", call_id: "call_failed", name: "apply_patch", input: "补丁正文", status: "completed" };
  for (const status of ["failed", "incomplete"]) {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "response_failed", status } },
    ];
    const result = await aggregateOpencodeZenResponsesStream(streamOf(events.map(sseEvent).join("")));
    assert.equal(result.status, status);
    assert.deepEqual(result.output, [item]);
  }
});

test("translateOpencodeZenStream：原生 responses custom 调用直通保持原始流和事件", async () => {
  const text = sseEvent({ type: "response.output_item.done", output_index: 0, item: {
    id: "ctc_native", type: "custom_tool_call", call_id: "call_native", name: "apply_patch", input: "原生补丁", status: "completed",
  } });
  const original = streamOf(text);
  const result = translateOpencodeZenStream(original, "responses", "responses", [{ type: "custom", name: "apply_patch" }]);
  assert.equal(result, original);
  assert.equal(await new Response(result).text(), text);
});
