import assert from "node:assert/strict";
import test from "./host-test.ts";
import {
  convertOpencodeZenRequest,
  mergeOpencodeZenToolIdentities,
  renderOpencodeZenClientOutput,
} from "@agent-proxy/opencode-zen/convert";
import type { OpencodeZenModelProtocol } from "@agent-proxy/opencode-zen/catalog";
import { padOpencodeZenGateTools } from "@agent-proxy/opencode-zen/fingerprint";

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

/** 使用请求转换产生的身份表，验证公共输出层的工具类型还原。 */
async function renderResponses(
  upstream: ReadableStream<Uint8Array>,
  protocol: OpencodeZenModelProtocol,
  stream: boolean,
  tools: readonly unknown[] = [],
): Promise<Response> {
  const prepared = await convertOpencodeZenRequest("chat-completions", "responses", { input: "测试", tools });
  return renderOpencodeZenClientOutput(protocol, "responses",
    new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
    { model: "m", stream, tools: prepared.tools });
}

test("门禁工具身份只采纳实际 read/bash 占位，未知工具和未注入 shell 不获放行", async () => {
  const prepared = await convertOpencodeZenRequest("chat-completions", "responses", { input: "测试" });
  const result = mergeOpencodeZenToolIdentities(prepared.tools, padOpencodeZenGateTools([]));
  assert.deepEqual([...result.entries()], [
    ["read", { name: "read", custom: false }],
    ["bash", { name: "bash", custom: false }],
  ]);
  const untrusted = mergeOpencodeZenToolIdentities(prepared.tools, [
    { type: "function", function: { name: "read" } },
    { type: "function", function: { name: "shell" } },
    { type: "function", function: { name: "unknown_tool" } },
  ]);
  assert.deepEqual([...untrusted.keys()], ["read"]);
  assert.equal(prepared.tools.size, 0, "合并不修改客户端原始身份表");
});

test("门禁占位不覆盖客户端真实 function/custom/namespace 工具声明与响应类型", async () => {
  const declarations = [
    { name: "bash", custom: false, namespace: undefined, tools: [{
      type: "function", name: "bash", description: "真实命令工具",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }] },
    { name: "shell", custom: false, namespace: undefined, tools: [{
      type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "string" } } },
    }] },
    { name: "read", custom: true, namespace: undefined, tools: [{ type: "custom", name: "read", description: "真实文本工具" }] },
    { name: "read", custom: true, namespace: "client", tools: [{
      type: "namespace", name: "client", tools: [{ type: "custom", name: "read", description: "命名空间工具" }],
    }] },
  ];
  for (const declaration of declarations) {
    const prepared = await convertOpencodeZenRequest("chat-completions", "responses", { input: "测试", tools: declaration.tools });
    const originalTools = prepared.body.tools as Array<Record<string, unknown>>;
    const upstreamTools = padOpencodeZenGateTools(originalTools);
    for (const tool of originalTools) assert.ok(upstreamTools.includes(tool), "客户端定义原样保留");
    if (declaration.name === "shell") {
      assert.equal(upstreamTools.some((tool) => (tool as { function: { name: string } }).function.name === "bash"), false,
        "客户端已有 shell 满足门禁，不再垫 bash");
    }
    const merged = mergeOpencodeZenToolIdentities(prepared.tools, upstreamTools);
    for (const [name, identity] of prepared.tools) assert.deepEqual(merged.get(name), identity);
    const [mappedName, originalIdentity] = [...prepared.tools.entries()][0]!;
    assert.equal(originalIdentity.name, declaration.name);
    assert.equal(originalIdentity.custom, declaration.custom);
    const input = "中文正文\\路径\n第二行";
    const arguments_ = JSON.stringify(declaration.custom ? { input } : { command: "pwd" });
    const rendered = await renderOpencodeZenClientOutput("chat-completions", "responses",
      new Response(chatToolStream([{ id: "call_real_tool", name: mappedName, fragments: Array.from(arguments_) }]),
        { headers: { "content-type": "text/event-stream" } }),
      { model: "m", stream: true, tools: merged });
    const events = readSseEvents(await rendered.text());
    assert.ok(events.some((event) => event.type === "response.completed"));
    const item = events.find((event) => event.type === "response.output_item.done")!.item as Record<string, unknown>;
    assert.equal(item.name, declaration.name);
    assert.equal(item.namespace, declaration.namespace);
    assert.equal(item.type, declaration.custom ? "custom_tool_call" : "function_call");
    if (declaration.custom) {
      assert.equal(item.input, input);
      assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.delta")
        .map((event) => event.delta).join(""), input);
    } else assert.equal(item.arguments, arguments_);
  }
});

test("responses → chat 转换：instructions、工具历史、custom 工具与并行开关", async () => {
  const { body } = await convertOpencodeZenRequest("chat-completions", "responses", {
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
  // 源消息为内容块数组时保持数组形状（字段保形）。
  assert.deepEqual(messages[1], { role: "user", content: [{ type: "text", text: "look up 42" }] });
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

test("convertOpencodeZenRequest：同协议浅拷贝、chat → anthropic max_tokens 修正、chat → responses 结构", async () => {
  const input: Record<string, unknown> = {
    model: "opencode-zen/x",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    stream: false,
    max_tokens: 512,
  };
  const same = await convertOpencodeZenRequest("chat-completions", "chat-completions", input);
  assert.notEqual(same, input);
  assert.equal(same.body.max_tokens, 512);
  const anthropic = await convertOpencodeZenRequest("anthropic", "chat-completions", input);
  assert.equal(anthropic.body.max_tokens, 512, "llm-bridge 默认 1024 需被客户端值覆盖");
  assert.equal(anthropic.body.system, "sys");
  assert.ok(Array.isArray(anthropic.body.messages));
  const responses = await convertOpencodeZenRequest("responses", "chat-completions", input);
  assert.ok(Array.isArray(responses.body.input));
});

test("renderOpencodeZenClientOutput：chat ↔ responses 工具事件双向完整", async () => {
  const chatSse = [
    "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup_issue\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"issue\\\":42}\"}}]},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\n",
    "data: [DONE]\n\n",
  ].join("");
  const toResponses = await renderOpencodeZenClientOutput("chat-completions", "responses",
    new Response(streamOf(chatSse), { headers: { "content-type": "text/event-stream" } }),
    { model: "m", stream: true });
  const responsesText = await toResponses.text();
  assert.match(responsesText, /response\.function_call_arguments\.delta/);
  assert.match(responsesText, /lookup_issue/);
  assert.match(responsesText, /response\.completed/);

  const responsesSse = [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\",\"model\":\"m\"}}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup_issue\",\"arguments\":\"\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc1\",\"output_index\":0,\"delta\":\"{\\\"issue\\\":42}\"}\n\n",
    sseEvent({ type: "response.function_call_arguments.done", item_id: "fc1", output_index: 0, arguments: "{\"issue\":42}" }),
    sseEvent({ type: "response.output_item.done", output_index: 0, item: {
      id: "fc1", type: "function_call", call_id: "call_1", name: "lookup_issue", arguments: "{\"issue\":42}", status: "completed",
    } }),
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n",
  ].join("");
  const toChat = await renderOpencodeZenClientOutput("responses", "chat-completions",
    new Response(streamOf(responsesSse), { headers: { "content-type": "text/event-stream" } }),
    { model: "m", stream: true });
  const chatText = await toChat.text();
  assert.match(chatText, /tool_calls/);
  assert.match(chatText, /lookup_issue/);
  assert.match(chatText, /\[DONE\]/);
});

test("renderOpencodeZenClientOutput：responses 上游聚合为完整 response（非流式客户端）", async () => {
  const sse = [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"created_at\":123,\"status\":\"in_progress\",\"model\":\"muse-spark-1.3-contributor-free\"}}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"i1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"i1\",\"output_index\":0,\"content_index\":0,\"delta\":\"hello \"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"i1\",\"output_index\":0,\"content_index\":0,\"delta\":\"world\"}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc1\",\"type\":\"function_call\",\"call_id\":\"call_9\",\"name\":\"lookup_issue\",\"arguments\":\"\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc1\",\"output_index\":1,\"delta\":\"{\\\"issue\\\":9}\"}\n\n",
    sseEvent({ type: "response.function_call_arguments.done", item_id: "fc1", output_index: 1, arguments: "{\"issue\":9}" }),
    sseEvent({ type: "response.output_item.done", output_index: 1, item: {
      id: "fc1", type: "function_call", call_id: "call_9", name: "lookup_issue", arguments: "{\"issue\":9}", status: "completed",
    } }),
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"created_at\":123,\"status\":\"completed\",\"model\":\"muse-spark-1.3-contributor-free\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4,\"total_tokens\":7}}}\n\n",
  ].join("");
  const response = await renderOpencodeZenClientOutput("responses", "responses",
    new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } }),
    { model: "muse-spark-1.3-contributor-free", stream: false });
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.id, "r1");
  assert.equal(result.object, "response");
  assert.equal(result.status, "completed");
  assert.equal(result.model, "muse-spark-1.3-contributor-free");
  const output = result.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 2);
  assert.equal(output[0]!.type, "message");
  assert.deepEqual((output[0]!.content as Array<Record<string, unknown>>)[0], { type: "output_text", text: "hello world", annotations: [], logprobs: [] });
  assert.equal(output[1]!.type, "function_call");
  assert.equal(output[1]!.name, "lookup_issue");
  assert.equal(output[1]!.arguments, "{\"issue\":9}");
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
});

test("renderOpencodeZenClientOutput：chat 上游 → anthropic 客户端（新入口方向）", async () => {
  const chatSse = [
    "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"}}]}\n\n",
    "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n",
  ].join("");
  const response = await renderOpencodeZenClientOutput("chat-completions", "anthropic",
    new Response(streamOf(chatSse), { headers: { "content-type": "text/event-stream" } }),
    { model: "m", stream: true });
  const text = await response.text();
  assert.match(text, /message_start/);
  assert.match(text, /text_delta/);
  assert.match(text, /message_stop/);
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
  const events = readSseEvents(await (await renderResponses(upstream, "chat-completions", true, clientTools)).text());
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
    for (const stream of [true, false]) {
      const upstream = chatToolStream([{ id: "call_custom", name: "custom_editor", fragments: [JSON.stringify({ input })] }]);
      const response = await renderResponses(upstream, "chat-completions", stream, [{ type: "custom", name: "custom_editor" }]);
      let output: Array<Record<string, unknown>>;
      if (stream) {
        const events = readSseEvents(await response.text());
        assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.delta")
          .map((event) => event.delta).join(""), input);
        assert.ok(events.some((event) => event.type === "response.custom_tool_call_input.done" && event.input === input));
        output = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item as Record<string, unknown>);
      } else {
        const result = await response.json() as Record<string, unknown>;
        assert.equal(result.status, "completed");
        output = result.output as Array<Record<string, unknown>>;
      }
      const item = output.find((entry) => entry.name === "custom_editor")!;
      assert.ok(item);
      assert.equal(item.type, "custom_tool_call");
      assert.equal(item.call_id, "call_custom");
      assert.equal(item.input, input);
      assert.equal("arguments" in item, false);
    }
  }
});

test("chat → responses 未声明 custom 的同名工具仍然使用 function 协议", async () => {
  const args = JSON.stringify({ input: "补丁正文" });
  const upstream = chatToolStream([{ id: "call_function", name: "apply_patch", fragments: [args] }]);
  const events = readSseEvents(await (await renderResponses(upstream, "chat-completions", true, [
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
    const response = await renderResponses(upstream, "chat-completions", true, [{ type: "custom", name: "apply_patch" }]);
    const events = readSseEvents(await response.text());
    assert.equal(events.some((event) => event.type === "response.completed"), false, args);
    const failed = events.find((event) => event.type === "response.failed");
    assert.ok(failed, args);
    assert.match(JSON.stringify(failed), /apply_patch|custom|input/i, args);
    const jsonResponse = await renderResponses(
      chatToolStream([{ id: "call_invalid", name: "apply_patch", fragments: [args] }]),
      "chat-completions", false, [{ type: "custom", name: "apply_patch" }],
    );
    assert.equal(jsonResponse.status, 502, args);
    assert.equal((await jsonResponse.json() as Record<string, unknown>).status, "failed", args);
  }
});

test("chat → responses custom 调用提前结束时不产出成功完成事件", async () => {
  for (const args of ["{\"input\":", JSON.stringify({ input: "完整参数仍需要调用结束标记" })]) {
    const text = `data: ${JSON.stringify({
      id: "chat_cutoff", object: "chat.completion.chunk", choices: [{ index: 0, finish_reason: null, delta: {
        tool_calls: [{ index: 0, id: "call_cutoff", type: "function", function: { name: "apply_patch", arguments: args } }],
      } }],
    })}\n\n`;
    const response = await renderResponses(streamOf(text), "chat-completions", true, [{ type: "custom", name: "apply_patch" }]);
    const events = readSseEvents(await response.text());
    assert.equal(events.some((event) => event.type === "response.custom_tool_call_input.done"), false);
    assert.equal(events.some((event) => event.type === "response.output_item.done"), false);
    assert.equal(events.some((event) => event.type === "response.completed"), false);
    assert.ok(events.some((event) => event.type === "response.failed" || event.type === "response.incomplete"));
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
  const render = (stream: boolean) => renderResponses(streamOf(text), "anthropic", stream, [{ type: "custom", name: "apply_patch" }]);
  const events = readSseEvents(await (await render(true)).text());
  assert.equal(events.some((event) => event.type === "response.custom_tool_call_input.done"), false);
  assert.equal(events.some((event) => event.type === "response.completed"), false);
  assert.ok(events.some((event) => event.type === "response.failed" || event.type === "response.incomplete"));
  const payload = await (await render(false)).json() as Record<string, unknown>;
  assert.notEqual(payload.status, "completed");
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
  for (const [protocol, text] of [["anthropic", anthropic], ["gemini", google]] as const) {
    const streamResponse = await renderResponses(streamOf(text), protocol, true, [{ type: "custom", name: "apply_patch" }]);
    const events = readSseEvents(await streamResponse.text());
    assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.delta")
      .map((event) => event.delta).join(""), input, protocol);
    assert.ok(events.some((event) => event.type === "response.completed"), protocol);
    const response = await renderResponses(streamOf(text), protocol, false, [{ type: "custom", name: "apply_patch" }]);
    const result = await response.json() as Record<string, unknown>;
    const item = (result.output as Array<Record<string, unknown>>).find((entry) => entry.name === "apply_patch")!;
    assert.ok(item, protocol);
    assert.equal(item.type, "custom_tool_call", protocol);
    assert.equal(item.input, input, protocol);
    assert.equal(typeof item.call_id, "string");
    assert.ok(item.call_id);
    const { body: request } = await convertOpencodeZenRequest("chat-completions", "responses", { input: [item, { type: "custom_tool_call_output", call_id: item.call_id, output: "补丁已应用" }] });
    const messages = request.messages as Array<Record<string, unknown>>;
    const call = (messages[0]!.tool_calls as Array<Record<string, unknown>>)[0]!;
    assert.equal(call.id, item.call_id);
    const function_ = call.function as Record<string, unknown>;
    assert.equal(function_.name, "apply_patch");
    assert.deepEqual(JSON.parse(String(function_.arguments)), { input });
    assert.deepEqual(messages[1], { role: "tool", tool_call_id: item.call_id, content: "补丁已应用" });
  }
});

test("renderOpencodeZenClientOutput：原生 custom input 增量、done 及条目完成事件聚合保留正文和标识", async () => {
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
    const response = await renderResponses(streamOf(events.map(sseEvent).join("")), "responses", false,
      [{ type: "custom", name: "apply_patch" }]);
    const result = await response.json() as Record<string, unknown>;
    const output = result.output as Array<Record<string, unknown>>;
    assert.equal(output.length, 1, mode);
    assert.equal(output[0]!.type, "custom_tool_call", mode);
    assert.equal(output[0]!.input, input, mode);
    assert.equal(output[0]!.call_id, item.call_id, mode);
    assert.equal(output[0]!.name, item.name, mode);
    assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  }
});

test("renderOpencodeZenClientOutput：失败或未完成的 custom 响应保留终态", async () => {
  const item = { type: "custom_tool_call", id: "ctc_failed", call_id: "call_failed", name: "apply_patch", input: "补丁正文", status: "completed" };
  for (const status of ["failed", "incomplete"]) {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: `response.${status}`, response: { id: "response_failed", status } },
    ];
    const response = await renderResponses(streamOf(events.map(sseEvent).join("")), "responses", false,
      [{ type: "custom", name: "apply_patch" }]);
    const result = await response.json() as Record<string, unknown>;
    assert.equal(result.status, status);
    for (const output of result.output as Array<Record<string, unknown>>) {
      assert.equal(output.type, "custom_tool_call");
      assert.notEqual(output.status, "completed", "失败或未完成响应不能返回已完成的 custom 条目");
      assert.equal(output.input, "", "失败或未完成响应不能发布 custom 可执行正文");
    }
    const streamResponse = await renderResponses(streamOf(events.map(sseEvent).join("")), "responses", true,
      [{ type: "custom", name: "apply_patch" }]);
    const renderedEvents = readSseEvents(await streamResponse.text());
    assert.equal(renderedEvents.some((event) => event.type === "response.completed"), false);
    assert.equal(renderedEvents.some((event) => event.type === "response.custom_tool_call_input.done"), false);
    assert.equal(renderedEvents.filter((event) => event.type === "response.custom_tool_call_input.delta")
      .map((event) => event.delta).join(""), "");
  }
});

test("convertOpencodeZenRequest：同协议原生 responses custom 声明和调用保持不变", async () => {
  const input = {
    input: [{ id: "ctc_native", type: "custom_tool_call", call_id: "call_native", name: "apply_patch", input: "原生补丁", status: "completed" }],
    tools: [{ type: "custom", name: "apply_patch" }],
  };
  const prepared = await convertOpencodeZenRequest("responses","responses", input);
  assert.deepEqual(prepared.body, input);
});

test("renderOpencodeZenClientOutput：取消信号唤醒挂起的上游读取并输出失败终态", { timeout: 60_000 }, async () => {
  const cancellation = new AbortController();
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  let markWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "chat_pending", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "等待后续帧" }, finish_reason: null }],
      })}\n\n`));
    },
    pull() {
      // 首帧消费后上游保持打开，用取消回调唤醒下一次读取。
      markWaiting();
    },
  }, { highWaterMark: 0 });
  let abortCalls = 0;
  const response = await renderOpencodeZenClientOutput("chat-completions", "responses",
    new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
    {
      model: "m", stream: true, signal: cancellation.signal,
      abort() {
        abortCalls++;
        upstreamController.error(new Error("上游读取已取消"));
      },
    });
  const body = response.text();
  await waiting;
  cancellation.abort();
  const events = readSseEvents(await body);
  assert.ok(abortCalls > 0, "取消必须传播到上游读取生命周期");
  assert.equal(events.some((event) => event.type === "response.completed"), false);
  const failed = events.filter((event) => event.type === "response.failed");
  assert.equal(failed.length, 1, "取消只产生一次失败终态");
  assert.match(JSON.stringify(failed[0]), /response_cancelled/);
});
