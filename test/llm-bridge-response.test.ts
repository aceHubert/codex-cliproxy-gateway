import assert from "node:assert/strict";
import test from "node:test";
import {
  ResponsesOutputShell,
  clientErrorResponse,
  createAnthropicClientOutput,
  createChatCompletionsClientOutput,
  createClientResponse,
  createGeminiClientOutput,
  createResponsesClientOutput,
  parseUpstreamEvents,
  readSseFrames,
} from "@agent-proxy/llm-bridge";
import type { BridgeStreamEvent } from "@agent-proxy/llm-bridge";

type Json = Record<string, unknown>;

const encoder = new TextEncoder();

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function chatSse(deltas: Array<Record<string, unknown>>, options: { finish?: string; usage?: unknown } = {}): ReadableStream<Uint8Array> {
  const frames = deltas.map((delta) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "up-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  if (options.finish) {
    frames.push(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "up-model", choices: [{ index: 0, delta: {}, finish_reason: options.finish }] })}\n\n`);
  }
  if (options.usage) {
    frames.push(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage: options.usage })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  return sseStream(frames);
}

async function collectEvents(events: AsyncGenerator<BridgeStreamEvent>): Promise<BridgeStreamEvent[]> {
  const result: BridgeStreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function eventsOf(list: BridgeStreamEvent[]): AsyncGenerator<BridgeStreamEvent> {
  return (async function* () {
    for (const event of list) yield event;
  })();
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function readResponsesEvents(response: Response): Promise<Json[]> {
  const text = await readAll(response.body!);
  return text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!) as Json);
}

async function settlesWithin<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("final Promise 未及时完成")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("严格 SSE 解析：多行 data、注释、CRLF 与截断流报错", async () => {
  const frames: Array<{ event?: string; data: string } | "[DONE]"> = [];
  for await (const frame of readSseFrames(sseStream([
    ": keep-alive\n\n",
    "event: one\r\n",
    "data: {\"a\":\r\n",
    "data: 1}\r\n\r\n",
    "data: [DONE]\n\n",
  ]))) {
    frames.push(frame);
  }
  assert.deepEqual(frames[0], { event: "one", data: '{"a":\n1}' });
  assert.equal(frames[1], "[DONE]");
  // 截断流：帧未收到空行就 EOF 必须报错。
  await assert.rejects(async () => {
    for await (const _ of readSseFrames(sseStream(["data: {\"broken\"\n"]))) void _;
  });
});

test("chat 上游解析：reasoning_content/refusal/工具增量/usage 明细", async () => {
  const upstream = new Response(chatSse([
    { reasoning_content: "think" },
    { content: "hel" },
    { content: "lo" },
    { refusal: "" },
    { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{\"a\":" } }] },
    { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
  ], {
    finish: "tool_calls",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } },
  }), { headers: { "content-type": "text/event-stream" } });
  const events = await collectEvents(parseUpstreamEvents("chat-completions", upstream, "model"));
  assert.equal(events[0]?.type, "message_start");
  const thinking = events.find((event) => event.type === "content_delta" && event.delta.thinking);
  assert.equal(thinking?.type === "content_delta" ? thinking.delta.thinking : undefined, "think");
  const texts = events.filter((event) => event.type === "content_delta" && event.delta.text).map((event) => (event as { delta: { text: string } }).delta.text).join("");
  assert.equal(texts, "hello");
  const end = events.at(-1)!;
  assert.equal(end.type, "message_end");
  if (end.type === "message_end") {
    assert.equal(end.stop_reason, "tool_calls");
    assert.equal(end.usage?.inputTokens, 10);
    assert.equal(end.usage?.cachedInputTokens, 4);
    assert.equal(end.usage?.reasoningTokens, 2);
  }
});

test("chat 非流式上游重放为同一事件序列", async () => {
  const upstream = Response.json({
    id: "chatcmpl-9",
    model: "up",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  const events = await collectEvents(parseUpstreamEvents("chat-completions", upstream, "model"));
  assert.equal(events.filter((event) => event.type === "content_delta").length, 1);
  assert.equal(events.at(-1)?.type, "message_end");
});

test("Responses 客户端输出：事件序号连续、快照聚合与一次终态", async () => {
  const result = await createResponsesClientOutput(eventsOf([
    { type: "message_start", id: "up-1", model: "up-model" },
    { type: "content_delta", delta: { thinking: "reason" } },
    { type: "content_delta", delta: { text: "hel" } },
    { type: "content_delta", delta: { text: "lo" } },
    { type: "tool_call_start", tool_call: { id: "mapped_name", name: "mapped_name" } },
    { type: "tool_call_delta", tool_call: { id: "mapped_name", arguments_delta: "{\"input\":\"txt\"}" } },
    { type: "tool_call_end", tool_call: { id: "mapped_name" } },
    { type: "message_end", stop_reason: "tool_calls", usage: { inputTokens: 7, outputTokens: 3 } },
  ]), {
    model: "display/model",
    stream: true,
    toolIdentities: new Map([["mapped_name", { name: "原始名", custom: true, namespace: "ns" }]]),
  });
  const text = await readAll(result.response.body!);
  const frames = text.split("\n\n").filter((line) => line.length > 0);
  const events = frames.map((frame) => JSON.parse(frame.split("\ndata: ")[1]!) as Record<string, unknown>);
  const types = events.map((event) => event.type);
  assert.deepEqual(types[0], "response.created");
  assert.deepEqual(types[1], "response.in_progress");
  assert.ok(types.includes("response.output_text.delta"));
  assert.ok(types.includes("response.reasoning_summary_text.delta"));
  assert.ok(types.includes("response.function_call_arguments.delta") === false);
  assert.ok(types.includes("response.custom_tool_call_input.delta"));
  const terminal = types.filter((type) => type === "response.completed");
  assert.equal(terminal.length, 1);
  const sequenceNumbers = events.map((event) => event.sequence_number as number);
  for (let index = 1; index < sequenceNumbers.length; index++) {
    assert.equal(sequenceNumbers[index], sequenceNumbers[index - 1]! + 1);
  }
  const completed = events.at(-1) as { response: Record<string, unknown> };
  const output = completed.response.output as Array<Record<string, unknown>>;
  const call = output.find((item) => item.type === "custom_tool_call") as Record<string, unknown>;
  assert.equal(call.name, "原始名");
  assert.equal(call.namespace, "ns");
  assert.equal(call.input, "txt");
  assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.delta").map((event) => event.delta).join(""), call.input);
  assert.equal(events.find((event) => event.type === "response.custom_tool_call_input.done")?.input, call.input);
  assert.deepEqual(completed.response.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
  assert.equal((completed.response as { model: string }).model, "display/model");
});

test("Responses custom 与 function 混合调用：分别缓冲、解包并恢复任意名称与命名空间", async () => {
  const input = '*** Begin Patch\n*** Add File: 中文.txt\n+一行"引号"与\\路径\n*** End Patch';
  const wrapped = JSON.stringify({ input });
  const events: BridgeStreamEvent[] = [
    { type: "message_start", id: "up", model: "up" },
    { type: "tool_call_start", tool_call: { id: "custom", name: "wrapped_custom" } },
    { type: "tool_call_start", tool_call: { id: "function", name: "wrapped_function" } },
    { type: "tool_call_start", tool_call: { id: "empty", name: "wrapped_empty" } },
    { type: "tool_call_delta", tool_call: { id: "function", arguments_delta: '{"path":' } },
    { type: "tool_call_delta", tool_call: { id: "empty", arguments_delta: '{"input":' } },
    // 按单个字符分片，覆盖中文、换行、引号与反斜杠转义的任意边界。
    ...Array.from(wrapped, (arguments_delta): BridgeStreamEvent => ({ type: "tool_call_delta", tool_call: { id: "custom", arguments_delta } })),
    { type: "tool_call_delta", tool_call: { id: "function", arguments_delta: '"目录"}' } },
    { type: "tool_call_delta", tool_call: { id: "empty", arguments_delta: '""}' } },
    { type: "tool_call_end", tool_call: { id: "function" } },
    { type: "tool_call_end", tool_call: { id: "custom" } },
    { type: "tool_call_end", tool_call: { id: "empty" } },
    { type: "message_end", stop_reason: "tool_calls" },
  ];
  for (const stream of [true, false]) {
    const result = await createResponsesClientOutput(eventsOf(events), {
      model: "m", stream,
      toolIdentities: new Map([
        ["wrapped_custom", { name: "任意自定义工具", custom: true, namespace: "编辑器" }],
        ["wrapped_function", { name: "读取文件", custom: false, namespace: "文件" }],
        ["wrapped_empty", { name: "另一个工具", custom: true }],
      ]),
    });
    const frames = stream ? await readResponsesEvents(result.response) : [];
    const payload = stream ? await result.final : await result.response.json() as Json;
    const output = payload!.output as Json[];
    const custom = output.find((item) => item.call_id === "custom")!;
    assert.equal(custom.type, "custom_tool_call");
    assert.equal(custom.name, "任意自定义工具");
    assert.equal(custom.namespace, "编辑器");
    assert.equal(custom.input, input);
    assert.equal(custom.status, "completed");
    assert.equal("arguments" in custom, false);
    const fn = output.find((item) => item.call_id === "function")!;
    assert.equal(fn.type, "function_call");
    assert.equal(fn.arguments, '{"path":"目录"}');
    const empty = output.find((item) => item.call_id === "empty")!;
    assert.equal(empty.type, "custom_tool_call");
    assert.equal(empty.name, "另一个工具");
    assert.equal(empty.input, "");
    assert.equal(empty.status, "completed");
    assert.equal("namespace" in empty, false);
    if (stream) {
      const deltas = frames.filter((event) => event.type === "response.custom_tool_call_input.delta");
      assert.equal(deltas.length, 1);
      assert.equal(deltas.map((event) => event.delta).join(""), custom.input);
      assert.equal(frames.find((event) => event.type === "response.custom_tool_call_input.done")?.input, custom.input);
      const done = frames.find((event) => event.type === "response.output_item.done" && (event.item as Json).call_id === "custom")!;
      assert.equal((done.item as Json).input, custom.input);
      assert.equal(frames.find((event) => event.type === "response.custom_tool_call_input.done" && event.item_id === empty.id)?.input, "");
      assert.equal(frames.filter((event) => event.type === "response.function_call_arguments.delta").map((event) => event.delta).join(""), fn.arguments);
    }
  }
});

test("ResponsesOutputShell custom 收尾选项不会重复正文，空 input 也正常完成", () => {
  for (const customToolInputAtClose of [undefined, false, true]) {
    for (const input of ["正文\n下一行", ""]) {
      const shell = new ResponsesOutputShell({ model: "m", customToolInputAtClose });
      shell.start();
      shell.openToolCall("custom", { id: "call", name: "任意工具", custom: true });
      const wrapped = JSON.stringify({ input });
      shell.appendToolArguments("custom", wrapped.slice(0, 5));
      shell.appendToolArguments("custom", wrapped.slice(5));
      assert.equal(shell.drain().some((event) => event.type === "response.custom_tool_call_input.delta"), false);
      shell.closeBlock("custom");
      shell.terminal("completed");
      const frames = shell.drain();
      const deltas = frames.filter((event) => event.type === "response.custom_tool_call_input.delta");
      assert.equal(deltas.length, input ? 1 : 0);
      assert.equal(deltas.map((event) => event.delta).join(""), input);
      assert.equal(frames.find((event) => event.type === "response.custom_tool_call_input.done")?.input, input);
      assert.equal((shell.finalResponse!.output as Json[])[0]?.input, input);
    }
  }
});

test("Responses custom 无效参数产生 failed，禁止发布包装或可执行正文", async () => {
  for (const arguments_delta of ['{"input":', '{}', '{"input":1}', '[]', 'null', '"文本"']) {
    for (const stream of [true, false]) {
      const result = await createResponsesClientOutput(eventsOf([
        { type: "message_start", id: "up", model: "up" },
        { type: "tool_call_start", tool_call: { id: "custom", name: "wrapped" } },
        { type: "tool_call_delta", tool_call: { id: "custom", arguments_delta } },
        { type: "tool_call_end", tool_call: { id: "custom" } },
        { type: "message_end", stop_reason: "tool_calls" },
      ]), { model: "m", stream, toolIdentities: new Map([["wrapped", { name: "编辑", custom: true }]]) });
      const frames = stream ? await readResponsesEvents(result.response) : [];
      const payload = stream ? await result.final : await result.response.json() as Json;
      assert.equal(payload!.status, "failed", arguments_delta);
      assert.equal((payload!.error as Json).code, "upstream_protocol_error");
      assert.equal((payload!.output as Json[])[0]?.status, "incomplete");
      assert.equal((payload!.output as Json[])[0]?.input, "");
      assert.equal(frames.some((event) => event.type === "response.custom_tool_call_input.delta" || event.type === "response.custom_tool_call_input.done"), false);
      if (!stream) assert.equal(result.response.status, 502);
    }
  }
});

test("Responses custom 在 EOF 或缺少工具完成事件时失败，完整参数也不提前发布", async () => {
  for (const arguments_delta of ['{"input":"完整补丁"}', '{"input":"半截']) {
    for (const toolEnded of [true, false]) {
      for (const messageEnded of [true, false]) {
        if (toolEnded && messageEnded) continue;
        for (const stream of [true, false]) {
          const list: BridgeStreamEvent[] = [
            { type: "message_start", id: "up", model: "up" },
            { type: "tool_call_start", tool_call: { id: "custom", name: "wrapped" } },
            { type: "tool_call_delta", tool_call: { id: "custom", arguments_delta } },
          ];
          if (toolEnded) list.push({ type: "tool_call_end", tool_call: { id: "custom" } });
          if (messageEnded) list.push({ type: "message_end", stop_reason: "tool_calls" });
          const result = await createResponsesClientOutput(eventsOf(list), { model: "m", stream, toolIdentities: new Map([["wrapped", { name: "编辑", custom: true }]]) });
          const frames = stream ? await readResponsesEvents(result.response) : [];
          const payload = stream ? await result.final : await result.response.json() as Json;
          assert.equal(payload!.status, "failed");
          assert.match(String((payload!.error as Json).message), /提前断开/);
          assert.equal((payload!.output as Json[])[0]?.input, "");
          assert.equal(frames.some((event) => event.type === "response.custom_tool_call_input.delta" || event.type === "response.custom_tool_call_input.done"), false);
        }
      }
    }
  }
});

test("Responses custom 截断终态保留 incomplete，不解包或发布未确认的工具输入", async () => {
  for (const stop_reason of ["length", "content_filter"] as const) {
    for (const arguments_delta of ['{"input":"完整补丁"}', '{"input":"半截']) {
      for (const toolEnded of [true, false]) {
        for (const stream of [true, false]) {
          const list: BridgeStreamEvent[] = [
            { type: "message_start", id: "up", model: "up" },
            { type: "tool_call_start", tool_call: { id: "custom", name: "wrapped" } },
            { type: "tool_call_delta", tool_call: { id: "custom", arguments_delta } },
          ];
          if (toolEnded) list.push({ type: "tool_call_end", tool_call: { id: "custom" } });
          list.push({ type: "message_end", stop_reason });
          const result = await createResponsesClientOutput(eventsOf(list), { model: "m", stream, toolIdentities: new Map([["wrapped", { name: "编辑", custom: true }]]) });
          const frames = stream ? await readResponsesEvents(result.response) : [];
          const payload = stream ? await result.final : await result.response.json() as Json;
          assert.equal(payload!.status, "incomplete");
          assert.equal((payload!.incomplete_details as Json).reason, stop_reason === "length" ? "max_output_tokens" : "content_filter");
          assert.equal((payload!.output as Json[])[0]?.status, "incomplete");
          assert.equal((payload!.output as Json[])[0]?.input, "");
          assert.equal(frames.some((event) => event.type === "response.custom_tool_call_input.delta" || event.type === "response.custom_tool_call_input.done"), false);
        }
      }
    }
  }
});

test("Responses 非流式聚合 JSON 与同语义流式一致", async () => {
  const base = [
    { type: "message_start", id: "up", model: "up" },
    { type: "content_delta", delta: { text: "hi" } },
    { type: "message_end", stop_reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
  ] as BridgeStreamEvent[];
  const nonStream = await createResponsesClientOutput(eventsOf(base), { model: "m", stream: false });
  const payload = await nonStream.response.json() as Record<string, unknown>;
  assert.equal(payload.status, "completed");
  assert.equal(payload.object, "response");
  const output = payload.output as Array<Record<string, unknown>>;
  assert.equal((output[0]?.content as Array<Record<string, unknown>>)[0]?.text, "hi");
});

test("Responses 输出：上游错误产生 failed 终态且只出现一次", async () => {
  const result = await createResponsesClientOutput(eventsOf([
    { type: "message_start", id: "up", model: "up" },
    { type: "content_delta", delta: { text: "partial" } },
    { type: "error", error: { message: "upstream boom", code: "500" } },
    { type: "message_end", stop_reason: "stop" },
  ]), { model: "m", stream: true });
  const text = await readAll(result.response.body!);
  const events = text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]!) as Record<string, unknown>);
  const failed = events.filter((event) => event.type === "response.failed");
  assert.equal(failed.length, 1);
  assert.equal((events.at(-1) as { response: { error: { message: string } } }).response.error.message, "upstream boom");
});

test("chat-completions 客户端输出：分片可拼接、usage 帧与 [DONE] 终止顺序", async () => {
  const result = await createChatCompletionsClientOutput(eventsOf([
    { type: "message_start", id: "x", model: "up" },
    { type: "content_delta", delta: { text: "he" } },
    { type: "content_delta", delta: { text: "llo" } },
    { type: "message_end", stop_reason: "stop", usage: { inputTokens: 2, outputTokens: 2 } },
  ]), { model: "display", stream: true });
  const text = await readAll(result.response.body!);
  const frames = text.split("\n\n").filter(Boolean);
  assert.equal(frames.at(-1), "data: [DONE]");
  const usageFrame = JSON.parse(frames.at(-2)!.replace("data: ", "")) as Record<string, unknown>;
  assert.deepEqual(usageFrame.choices, []);
  assert.deepEqual(usageFrame.usage, { input_tokens: 2, output_tokens: 2, total_tokens: 4 });
  const chunks = frames.slice(0, -2).map((frame) => JSON.parse(frame.replace("data: ", "")) as Record<string, unknown>);
  const delta = chunks.map((chunk) => ((chunk.choices as Array<Record<string, unknown>>)[0]?.delta as Record<string, unknown>)?.content ?? "").join("");
  assert.equal(delta, "hello");
  const finish = (chunks.at(-1)?.choices as Array<Record<string, unknown>>)[0]?.finish_reason;
  assert.equal(finish, "stop");
  const modelNames = new Set(chunks.map((chunk) => chunk.model));
  assert.deepEqual([...modelNames], ["display"]);
});

test("chat-completions 非流式聚合为完整 completion JSON", async () => {
  const result = await createChatCompletionsClientOutput(eventsOf([
    { type: "message_start", id: "x", model: "up" },
    { type: "content_delta", delta: { text: "hi" } },
    { type: "message_end", stop_reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
  ]), { model: "m", stream: false });
  const payload = await result.response.json() as Record<string, unknown>;
  assert.equal(payload.object, "chat.completion");
  const choice = (payload.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  const message = choice.message as Record<string, unknown>;
  assert.equal(message.content, "hi");
  assert.equal(choice.finish_reason, "stop");
  assert.deepEqual(payload.usage, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
});

test("anthropic 客户端输出：message_start/块生命周期/message_delta/message_stop", async () => {
  const result = await createAnthropicClientOutput(eventsOf([
    { type: "message_start", id: "up", model: "up" },
    { type: "content_delta", delta: { thinking: "reason" } },
    { type: "thinking_signature", signature: "sig" },
    { type: "content_delta", delta: { text: "hi" } },
    { type: "tool_call_start", tool_call: { id: "c1", name: "mapped" } },
    { type: "tool_call_delta", tool_call: { id: "c1", arguments_delta: "{\"a\":" } },
    { type: "tool_call_delta", tool_call: { id: "c1", arguments_delta: "1}" } },
    { type: "tool_call_end", tool_call: { id: "c1" } },
    { type: "message_end", stop_reason: "tool_calls", usage: { inputTokens: 5, outputTokens: 4 } },
  ]), {
    model: "display",
    stream: true,
    toolIdentities: new Map([["mapped", { name: "原始", custom: false }]]),
  });
  const text = await readAll(result.response.body!);
  const types = text.split("\n\n").filter(Boolean).map((frame) => frame.split("\n")[0]?.replace("event: ", ""));
  assert.equal(types[0], "message_start");
  assert.ok(types.includes("content_block_start"));
  assert.ok(types.includes("content_block_delta"));
  assert.ok(types.includes("content_block_stop"));
  assert.equal(types.at(-1), "message_stop");
  const messageDelta = text.split("\n\n").find((frame) => frame.includes("message_delta"))!;
  assert.ok(messageDelta.includes('"stop_reason":"tool_use"'));
  assert.ok(messageDelta.includes('"output_tokens":4'));
  const toolStart = text.split("\n\n").find((frame) => frame.includes("tool_use"))!;
  assert.ok(toolStart.includes('"name":"原始"'));
});

test("anthropic 非流式聚合为完整 Message JSON", async () => {
  const result = await createAnthropicClientOutput(eventsOf([
    { type: "message_start", id: "up", model: "up" },
    { type: "content_delta", delta: { text: "hi" } },
    { type: "message_end", stop_reason: "stop", usage: { inputTokens: 2, outputTokens: 1 } },
  ]), { model: "m", stream: false });
  const payload = await result.response.json() as Record<string, unknown>;
  assert.equal(payload.type, "message");
  assert.equal(payload.stop_reason, "end_turn");
  const content = payload.content as Array<Record<string, unknown>>;
  assert.deepEqual(content, [{ type: "text", text: "hi" }]);
  assert.deepEqual(payload.usage, { input_tokens: 2, output_tokens: 1 });
});

test("createClientResponse：chat 上游 → 三种客户端协议同语义", async () => {
  const upstream = (): Response => new Response(chatSse([
    { content: "hi" },
    { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
  ], { finish: "tool_calls", usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { "content-type": "text/event-stream" } });

  const responses = await createClientResponse("responses", upstream(), { upstreamProtocol: "chat-completions", model: "m", stream: false });
  const responsesPayload = await responses.response.json() as Record<string, unknown>;
  assert.equal(responsesPayload.status, "completed");
  assert.ok((responsesPayload.output as Array<Record<string, unknown>>).some((item) => item.type === "function_call"));

  const chat = await createClientResponse("chat-completions", upstream(), { upstreamProtocol: "chat-completions", model: "m", stream: false });
  const chatPayload = await chat.response.json() as Record<string, unknown>;
  const choice = (chatPayload.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(choice.finish_reason, "tool_calls");

  const anthropic = await createClientResponse("anthropic", upstream(), { upstreamProtocol: "chat-completions", model: "m", stream: false });
  const anthropicPayload = await anthropic.response.json() as Record<string, unknown>;
  assert.equal(anthropicPayload.stop_reason, "tool_use");
  assert.ok((anthropicPayload.content as Array<Record<string, unknown>>).some((block) => block.type === "tool_use"));
});

test("取消传播：signal 中止时输出 failed 终态并调用 abort 回调", async () => {
  const controller = new AbortController();
  let aborted = false;
  const slowEvents = (async function* () {
    yield { type: "message_start", id: "x", model: "up" } as BridgeStreamEvent;
    yield { type: "content_delta", delta: { text: "partial" } } as BridgeStreamEvent;
    await new Promise(() => {});
  })();
  const result = await createResponsesClientOutput(slowEvents, {
    model: "m",
    stream: true,
    signal: controller.signal,
    abort: () => {
      aborted = true;
    },
  });
  const reader = result.response.body!.getReader();
  const first = await reader.read();
  assert.ok(first.value !== undefined);
  controller.abort();
  await reader.cancel().catch(() => undefined);
  assert.equal(aborted, true);
  const final = await result.final;
  assert.equal(final?.status, "failed");
});

test("ResponsesOutputShell：插件直接驱动，序号连续且 raw 条目可折叠", () => {
  const shell = new ResponsesOutputShell({ model: "m" });
  shell.start();
  shell.appendText("hi");
  const rawIndex = shell.addRawItem({ id: "ws_1", type: "web_search_call", status: "in_progress", action: { type: "search", query: "q" } });
  shell.appendThinking("think");
  shell.closeRawItem(rawIndex, (item) => {
    item.results = [{ type: "web_search_result", text: "r" }];
  });
  shell.closeAllBlocks();
  shell.terminal("completed");
  const events = shell.drain();
  const types = events.map((event) => event.type);
  assert.deepEqual(types[0], "response.created");
  assert.ok(types.includes("response.output_item.added"));
  assert.ok(types.includes("response.output_item.done"));
  assert.equal(types.at(-1), "response.completed");
  const sequence = events.map((event) => event.sequence_number as number);
  for (let index = 1; index < sequence.length; index++) {
    assert.equal(sequence[index], sequence[index - 1]! + 1);
  }
  assert.equal(shell.terminal("failed"), undefined, "终态只允许一次");
});

test("gemini 上游 STOP/MAX_TOKENS 正确映射，responses 客户端不再误报失败", async () => {
  // 缺陷回归：STOP/MAX_TOKENS 未映射时落到 other，渲染器严格报错导致正常完成 502。
  // 真实 gemini 流的 usageMetadata 与 finishReason 同帧（库按帧序消费，拆帧会丢 usage）。
  const upstream = (finishReason: string, usage?: Json): Response => new Response(sseStream([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "完成" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ finishReason }], ...(usage ? { usageMetadata: usage } : {}) })}\n\n`,
  ]), { headers: { "content-type": "text/event-stream" } });

  const completed = await createClientResponse("responses", upstream("STOP", { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }), { upstreamProtocol: "gemini", model: "m", stream: false });
  const payload = await completed.response.json() as Record<string, unknown>;
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });

  const truncated = await createClientResponse("responses", upstream("MAX_TOKENS"), { upstreamProtocol: "gemini", model: "m", stream: false });
  const truncatedPayload = await truncated.response.json() as Record<string, unknown>;
  assert.equal(truncatedPayload.status, "incomplete");
  assert.deepEqual(truncatedPayload.incomplete_details, { reason: "max_output_tokens" });

  const filtered = await createClientResponse("responses", upstream("SAFETY"), { upstreamProtocol: "gemini", model: "m", stream: false });
  const filteredPayload = await filtered.response.json() as Record<string, unknown>;
  assert.equal(filteredPayload.status, "incomplete");
  assert.deepEqual(filteredPayload.incomplete_details, { reason: "content_filter" });
});

test("gemini 整包 JSON 上游 → chat 客户端聚合", async () => {
  const upstream = Response.json({
    candidates: [{ content: { parts: [{ text: "你好" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
  });
  const result = await createClientResponse("chat-completions", upstream, { upstreamProtocol: "gemini", model: "m", stream: false });
  const payload = await result.response.json() as Record<string, unknown>;
  const choice = (payload.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(choice.finish_reason, "stop");
  assert.equal((choice.message as Record<string, unknown>).content, "你好");
});

test("gemini SSE 上游 → anthropic 客户端流式", async () => {
  const upstream = new Response(sseStream([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\n\n`,
  ]), { headers: { "content-type": "text/event-stream" } });
  const result = await createClientResponse("anthropic", upstream, { upstreamProtocol: "gemini", model: "m", stream: true });
  const text = await readAll(result.response.body!);
  assert.match(text, /message_start/);
  assert.match(text, /text_delta/);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /message_stop/);
});

test("chat 工具 id/name/arguments 分帧可关联：待定调用在 name 到达后补发", async () => {
  // 上游把 id、name、arguments 拆进不同帧；先到的 arguments 必须缓存并在 start 后按序补发。
  const upstream = new Response(sseStream([
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "up", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: {} }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "up", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "up", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "1}" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "up", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]), { headers: { "content-type": "text/event-stream" } });
  const events = await collectEvents(parseUpstreamEvents("chat-completions", upstream, "model"));
  const starts = events.filter((event) => event.type === "tool_call_start") as Array<{ tool_call: { id: string; name: string } }>;
  const deltas = events.filter((event) => event.type === "tool_call_delta") as Array<{ tool_call: { id: string; arguments_delta: string } }>;
  const ends = events.filter((event) => event.type === "tool_call_end");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.tool_call.name, "f");
  assert.equal(starts[0]!.tool_call.id, "call_1");
  assert.equal(deltas.map((event) => event.tool_call.arguments_delta).join(""), '{"a":1}');
  assert.equal(ends.length, 1);
});

test("客户端错误外壳：三种协议返回各自标准形状", () => {
  const chat = clientErrorResponse("chat-completions", "bad", { status: 400 });
  const anthropic = clientErrorResponse("anthropic", "bad", { status: 400 });
  assert.equal(chat.status, 400);
  assert.equal(anthropic.status, 400);
});

test("Chat 与 Anthropic 流式 final 返回与非流式相同的完整聚合结果", async () => {
  const list: BridgeStreamEvent[] = [
    { type: "message_start", id: "up", model: "up" },
    { type: "content_delta", delta: { thinking: "思考", text: "正文" } },
    { type: "thinking_signature", signature: "签名" },
    { type: "tool_call_start", tool_call: { id: "call", name: "编辑" } },
    { type: "tool_call_delta", tool_call: { id: "call", arguments_delta: '{"input":' } },
    { type: "tool_call_delta", tool_call: { id: "call", arguments_delta: '"完整内容"}' } },
    { type: "tool_call_end", tool_call: { id: "call" } },
    { type: "message_end", stop_reason: "tool_calls", usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 } },
  ];
  for (const create of [createChatCompletionsClientOutput, createAnthropicClientOutput]) {
    const completed: Json[] = [];
    const streaming = await create(eventsOf(list), { model: "m", stream: true, onComplete: (payload) => completed.push(payload) });
    await readAll(streaming.response.body!);
    const final = await settlesWithin(streaming.final);
    assert.ok(final);
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0], final);
    const nonStreaming = await create(eventsOf(list), { model: "m", stream: false });
    const payload = await nonStreaming.response.json() as Json;
    assert.deepEqual(await settlesWithin(nonStreaming.final), payload);
    const { id: _streamId, created: _streamCreated, ...streamFields } = final;
    const { id: _jsonId, created: _jsonCreated, ...jsonFields } = payload;
    assert.deepEqual(streamFields, jsonFields);
  }
});

test("所有流式输出在首次读取前取消也会完成 final Promise", async () => {
  for (const create of [createResponsesClientOutput, createChatCompletionsClientOutput, createAnthropicClientOutput]) {
    const result = await create(eventsOf([]), { model: "m", stream: true });
    await result.response.body!.cancel();
    const final = await settlesWithin(result.final);
    if (create === createResponsesClientOutput) assert.equal(final?.status, "failed");
    else assert.equal(final, undefined);
  }
});

test("Chat 与 Anthropic 上游错误和迭代器异常都会完成 final 并输出错误帧", async () => {
  for (const create of [createChatCompletionsClientOutput, createAnthropicClientOutput]) {
    for (const throws of [true, false]) {
      const source = (async function* (): AsyncGenerator<BridgeStreamEvent> {
        yield { type: "message_start", id: "up", model: "up" };
        yield { type: "content_delta", delta: { text: "部分内容" } };
        if (throws) throw new Error("上游读取异常");
        yield { type: "error", error: { message: "上游错误" } };
      })();
      let completed = false;
      const result = await create(source, { model: "m", stream: true, onComplete: () => { completed = true; } });
      const text = await readAll(result.response.body!);
      assert.match(text, /上游读取异常|上游错误/);
      assert.equal(await settlesWithin(result.final), undefined);
      assert.equal(completed, false);
    }
  }
});

test("Chat 与 Anthropic AbortSignal 唤醒挂起源并完成 final，首次读取前中止同样生效", async () => {
  for (const create of [createChatCompletionsClientOutput, createAnthropicClientOutput]) {
    for (const beforeRead of [true, false]) {
      const controller = new AbortController();
      let wake!: () => void;
      let waiting!: () => void;
      const reachedWait = new Promise<void>((resolve) => { waiting = resolve; });
      const blocked = new Promise<void>((resolve) => { wake = resolve; });
      const source = (async function* (): AsyncGenerator<BridgeStreamEvent> {
        yield { type: "message_start", id: "up", model: "up" };
        waiting();
        await blocked;
        throw new Error("上游读取已取消");
      })();
      let aborted = false;
      const result = await create(source, { model: "m", stream: true, signal: controller.signal, abort: () => { aborted = true; wake(); } });
      const drain = beforeRead ? undefined : readAll(result.response.body!);
      if (!beforeRead) await settlesWithin(reachedWait);
      controller.abort();
      assert.equal(aborted, true);
      assert.equal(await settlesWithin(result.final), undefined);
      if (drain) await settlesWithin(drain);
      else await result.response.body!.cancel();
    }
  }
});


/* ============================ gemini 客户端输出 ============================ */

test("gemini 客户端流式输出：增量 parts 帧 + 终态 finishReason/usageMetadata", async () => {
  const result = await createGeminiClientOutput(eventsOf([
    { type: "message_start", id: "x", model: "up" },
    { type: "content_delta", delta: { text: "he" } },
    { type: "content_delta", delta: { text: "llo" } },
    { type: "tool_call_start", tool_call: { id: "c1", name: "f" } },
    { type: "tool_call_delta", tool_call: { id: "c1", arguments_delta: '{"a":1}' } },
    { type: "tool_call_end", tool_call: { id: "c1" } },
    { type: "message_end", stop_reason: "tool_calls", usage: { inputTokens: 2, outputTokens: 3 } },
  ]), { model: "display", stream: true });
  const text = await readAll(result.response.body!);
  const frames = text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.replace("data: ", "")) as Record<string, unknown>);
  const textParts = frames
    .flatMap((frame) => ((frame.candidates as Array<Record<string, unknown>>)?.[0]?.content as { parts?: Array<Record<string, unknown>> })?.parts ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  assert.equal(textParts, "hello");
  const terminal = frames.at(-1)!;
  const terminalCandidate = (terminal.candidates as Array<Record<string, unknown>>)[0]!;
  assert.equal(terminalCandidate.finishReason, "STOP");
  const fcParts = frames
    .flatMap((frame) => ((frame.candidates as Array<Record<string, unknown>>)?.[0]?.content as { parts?: Array<Record<string, unknown>> })?.parts ?? [])
    .filter((part) => part.functionCall !== undefined);
  assert.equal(fcParts.length, 1);
  assert.deepEqual((fcParts[0]!.functionCall as Record<string, unknown>).args, { a: 1 });
  const usage = terminal.usageMetadata as Record<string, unknown>;
  assert.equal(usage.promptTokenCount, 2);
  assert.equal(usage.candidatesTokenCount, 3);
  assert.equal(usage.totalTokenCount, 5);
  const modelVersions = new Set(frames.map((frame) => frame.modelVersion));
  assert.deepEqual([...modelVersions], ["display"]);
});

test("gemini 客户端非流式聚合为完整 GenerateContentResponse", async () => {
  const result = await createGeminiClientOutput(eventsOf([
    { type: "message_start", id: "x", model: "up" },
    { type: "content_delta", delta: { thinking: "内部" } },
    { type: "content_delta", delta: { text: "hi" } },
    { type: "message_end", stop_reason: "length", usage: { inputTokens: 1, outputTokens: 2 } },
  ]), { model: "display", stream: false });
  const completion = await result.response.json() as Record<string, unknown>;
  const candidate = (completion.candidates as Array<Record<string, unknown>>)[0]!;
  assert.equal(candidate.finishReason, "MAX_TOKENS");
  const parts = (candidate.content as { parts: Array<Record<string, unknown>> }).parts;
  assert.deepEqual(parts[0], { text: "内部", thought: true });
  assert.deepEqual(parts[1], { text: "hi" });
  const usage = completion.usageMetadata as Record<string, unknown>;
  assert.equal(usage.totalTokenCount, 3);
});

test("gemini 客户端流中错误帧返回 Google 错误形状并终止", async () => {
  const result = await createGeminiClientOutput(eventsOf([
    { type: "message_start", id: "x", model: "up" },
    { type: "error", error: { message: "boom" } },
  ]), { model: "m", stream: true });
  const text = await readAll(result.response.body!);
  const frame = JSON.parse(text.replace("data: ", "")) as Record<string, unknown>;
  const error = frame.error as Record<string, unknown>;
  assert.equal(error.message, "boom");
  assert.ok(error.status);
});
