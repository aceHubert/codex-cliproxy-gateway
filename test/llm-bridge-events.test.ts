import assert from "node:assert/strict";
import test from "node:test";
import { createClientResponse, parseUpstreamEvents, readSseFrames, sseFrameBytes } from "@agent-proxy/llm-bridge";
import type { ClientProtocol, BridgeStreamEvent } from "@agent-proxy/llm-bridge";

type Json = Record<string, unknown>;

function upstream(frames: Array<Uint8Array>): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function collect(protocol: ClientProtocol, frames: Array<Uint8Array>): Promise<BridgeStreamEvent[]> {
  const result: BridgeStreamEvent[] = [];
  for await (const event of parseUpstreamEvents(protocol, upstream(frames), "model")) result.push(event);
  return result;
}

function chat(delta: Json, finishReason: string | null = null): Uint8Array {
  return sseFrameBytes(undefined, { id: "chat", choices: [{ index: 0, delta, finish_reason: finishReason }] });
}

test("Chat 物理 EOF 缺少结束信号时不产生成功终态或工具结束", async () => {
  const seen: BridgeStreamEvent[] = [];
  const response = upstream([chat({ tool_calls: [{ index: 0, id: "call", function: { name: "edit", arguments: '{"input":"补丁"}' } }] })]);
  await assert.rejects(async () => {
    for await (const event of parseUpstreamEvents("chat-completions", response, "model")) seen.push(event);
  }, /结束信号前意外 EOF/);
  assert.equal(seen.some((event) => event.type === "message_end" || event.type === "tool_call_end"), false);
});

test("Chat finish_reason 后的 usage 帧与合理 DONE 结束保留工具参数及终态", async () => {
  for (const done of [false, true]) {
    const frames = [
      chat({ tool_calls: [{ index: 0, id: "call", function: { name: "edit", arguments: '{"input":' } }] }),
      chat({ tool_calls: [{ index: 0, function: { arguments: '"中文"}' } }] }, "tool_calls"),
      sseFrameBytes(undefined, { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
    ];
    if (done) frames.push(sseFrameBytes(undefined, "[DONE]"));
    const events = await collect("chat-completions", frames);
    assert.deepEqual(events.at(-1), { type: "message_end", stop_reason: "tool_calls", raw_stop_reason: "tool_calls", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
    assert.equal(events.filter((event) => event.type === "tool_call_delta").map((event) => event.tool_call.arguments_delta).join(""), '{"input":"中文"}');
    assert.equal(events.filter((event) => event.type === "tool_call_end").length, 1);
  }
  const compatible = await collect("chat-completions", [chat({ content: "完成" }), sseFrameBytes(undefined, "[DONE]")]);
  assert.equal(compatible.at(-1)?.type, "message_end");
  await assert.rejects(collect("chat-completions", [sseFrameBytes(undefined, "[DONE]")]), /消息开始前/);
});

function anthropicFrames(): Uint8Array[] {
  return [
    sseFrameBytes("message_start", { message: { id: "message", usage: { input_tokens: 8, cache_read_input_tokens: 3 } } }),
    sseFrameBytes("content_block_start", { index: 0, content_block: { type: "tool_use", id: "call", name: "edit" } }),
    sseFrameBytes("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"中文"}' } }),
    sseFrameBytes("content_block_stop", { index: 0 }),
    sseFrameBytes("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }),
  ];
}

test("Anthropic 缺 message_stop 的 EOF 及没有合法结束信息的 DONE 都明确失败", async () => {
  await assert.rejects(collect("anthropic", anthropicFrames()), /message_stop 前意外 EOF/);
  await assert.rejects(collect("anthropic", [
    ...anthropicFrames().slice(0, 3), sseFrameBytes(undefined, "[DONE]"),
  ]), /消息完成前/);
  await assert.rejects(collect("anthropic", [
    ...anthropicFrames().slice(0, 3), sseFrameBytes("message_stop", {}),
  ]), /缺少完整消息结束信息/);
});

test("Anthropic 合法 message_stop 与兼容 DONE 保留工具参数、原因与 usage", async () => {
  for (const terminal of [sseFrameBytes("message_stop", {}), sseFrameBytes(undefined, "[DONE]")]) {
    const events = await collect("anthropic", [...anthropicFrames(), terminal]);
    assert.deepEqual(events.at(-1), { type: "message_end", stop_reason: "tool_calls", raw_stop_reason: "tool_use", usage: { inputTokens: 8, cachedInputTokens: 3, outputTokens: 2 } });
    assert.equal(events.filter((event) => event.type === "tool_call_delta").map((event) => event.tool_call.arguments_delta).join(""), '{"input":"中文"}');
    assert.equal(events.filter((event) => event.type === "tool_call_end").length, 1);
  }
});

test("Gemini 缺 finishReason 的 EOF 或 DONE 不由库合成 end_turn", async () => {
  const content = sseFrameBytes(undefined, { candidates: [{ content: { parts: [{ text: "未完成" }] } }] });
  for (const frames of [[content], [content, sseFrameBytes(undefined, "[DONE]")]]) {
    await assert.rejects(collect("gemini", frames), /finishReason 前意外 EOF/);
  }
});

test("Gemini 保留工具、思考与 finishReason 后的独立 usage 明细", async () => {
  const events = await collect("gemini", [
    sseFrameBytes(undefined, { candidates: [{ content: { parts: [{ thought: true, text: "思考" }, { functionCall: { name: "edit", args: { input: "中文" } } }] } }] }),
    sseFrameBytes(undefined, { candidates: [{ finishReason: "MAX_TOKENS" }] }),
    sseFrameBytes(undefined, { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7, thoughtsTokenCount: 1 } }),
  ]);
  assert.deepEqual(events.at(-1), { type: "message_end", stop_reason: "length", raw_stop_reason: "MAX_TOKENS", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, reasoningTokens: 1 } });
  assert.ok(events.some((event) => event.type === "content_delta" && event.delta.thinking === "思考"));
  assert.equal(events.filter((event) => event.type === "tool_call_delta").map((event) => event.tool_call.arguments_delta).join(""), '{"input":"中文"}');
});

test("Responses 缺终态、错误终态或工具未结束不能当作完成", async () => {
  const start = sseFrameBytes("response.created", { response: { id: "response" } });
  for (const frames of [[start], [start, sseFrameBytes(undefined, "[DONE]")]]) {
    await assert.rejects(collect("responses", frames), /终态前/);
  }
  await assert.rejects(collect("responses", [start,
    sseFrameBytes("response.completed", { response: { status: "in_progress" } }),
  ]), /终态事件与响应状态不一致/);
  await assert.rejects(collect("responses", [start,
    sseFrameBytes("response.output_item.added", { item: { id: "item", call_id: "call", type: "function_call", name: "edit" } }),
    sseFrameBytes("response.completed", { response: { status: "completed" } }),
  ]), /缺少完整消息结束信息/);
  const failed = await collect("responses", [start, sseFrameBytes("response.failed", { response: { status: "failed" } })]);
  assert.equal(failed.at(-1)?.type, "error");
  assert.equal(failed.some((event) => event.type === "message_end"), false);
  const completed = await collect("responses", [start,
    sseFrameBytes("response.completed", { response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }),
    sseFrameBytes(undefined, "[DONE]"),
  ]);
  assert.deepEqual(completed.at(-1), { type: "message_end", stop_reason: "stop", raw_stop_reason: "completed", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
});

test("Responses 原生 custom 按调用独立包装输入，支持增量、input done 和 item done", async () => {
  for (const mode of ["delta", "input_done", "item_done"] as const) {
    for (const input of ["", '*** Begin Patch\n+中文"引号"与\\路径\n*** End Patch']) {
      const item = { id: "custom_item", call_id: "custom_call", type: "custom_tool_call", name: "edit", input: "" };
      const frames = [sseFrameBytes("response.created", { response: { id: "response" } }),
        sseFrameBytes("response.output_item.added", { output_index: 0, item })];
      if (mode === "delta") {
        frames.push(sseFrameBytes("response.custom_tool_call_input.delta", { item_id: item.id, delta: input.slice(0, 6) }),
          sseFrameBytes("response.custom_tool_call_input.delta", { output_index: 0, delta: input.slice(6) }));
      }
      if (mode !== "item_done") frames.push(sseFrameBytes("response.custom_tool_call_input.done", { output_index: 0, input }));
      // input.done 与 item.done 同时出现时，只能输出一次包装参数和一次工具结束。
      if (mode !== "input_done") frames.push(sseFrameBytes("response.output_item.done", { output_index: 0, item: { ...item, input } }));
      frames.push(sseFrameBytes("response.completed", { response: { status: "completed" } }));
      const events = await collect("responses", frames);
      const deltas = events.filter((event) => event.type === "tool_call_delta");
      assert.equal(deltas.length, 1, mode);
      assert.equal(deltas[0]!.tool_call.id, item.call_id);
      assert.equal(deltas[0]!.tool_call.arguments_delta, JSON.stringify({ input }));
      assert.equal(events.filter((event) => event.type === "tool_call_end").length, 1, mode);
      assert.equal(events.at(-1)?.type, "message_end");
    }
  }
});

test("Responses 原生 custom 交错输入由各自 done 的权威正文补齐，整包 JSON 不重复包装", async () => {
  const items = ["甲", "乙"].map((input, output_index) => ({ output_index, item: {
    id: `item_${output_index}`, call_id: `call_${output_index}`, type: "custom_tool_call", name: "edit", input,
  } }));
  const events = await collect("responses", [
    sseFrameBytes("response.created", { response: { id: "response" } }),
    ...items.map(({ output_index, item }) => sseFrameBytes("response.output_item.added", { output_index, item: { ...item, input: "" } })),
    sseFrameBytes("response.custom_tool_call_input.delta", { output_index: 0, delta: "甲的部分输入" }),
    sseFrameBytes("response.custom_tool_call_input.delta", { item_id: "item_1", delta: "乙的部分输入" }),
    sseFrameBytes("response.custom_tool_call_input.done", { item_id: "item_1", input: "乙" }),
    sseFrameBytes("response.output_item.done", items[0]),
    sseFrameBytes("response.completed", { response: { status: "completed" } }),
  ]);
  const calls = events.filter((event) => event.type === "tool_call_delta");
  assert.deepEqual(calls.map((event) => event.tool_call), [
    { id: "call_1", arguments_delta: '{"input":"乙"}' },
    { id: "call_0", arguments_delta: '{"input":"甲"}' },
  ]);
  const jsonEvents: BridgeStreamEvent[] = [];
  for await (const event of parseUpstreamEvents("responses", Response.json({ output: [items[0]!.item], status: "completed" }), "model")) jsonEvents.push(event);
  assert.deepEqual(jsonEvents.find((event) => event.type === "tool_call_delta"), {
    type: "tool_call_delta", tool_call: { id: "call_0", arguments_delta: '{"input":"甲"}' },
  });
});

test("Responses 未结束 custom 的 incomplete 保持未完成，failed 明确失败", async () => {
  const start = sseFrameBytes("response.output_item.added", { output_index: 0, item: {
    id: "item", call_id: "call", type: "custom_tool_call", name: "edit", input: "",
  } });
  const delta = sseFrameBytes("response.custom_tool_call_input.delta", { output_index: 0, delta: "未完成补丁" });
  const incomplete = await collect("responses", [start, delta,
    sseFrameBytes("response.incomplete", { response: { id: "response", status: "incomplete" } }),
  ]);
  assert.deepEqual(incomplete.at(-1), { type: "message_end", stop_reason: "length", raw_stop_reason: "incomplete", usage: undefined });
  assert.equal(incomplete.some((event) => event.type === "tool_call_delta" || event.type === "tool_call_end"), false);
  const failed = await collect("responses", [start, delta,
    sseFrameBytes("response.failed", { response: { status: "failed" } }),
  ]);
  assert.equal(failed.at(-1)?.type, "error");
  assert.equal(failed.some((event) => event.type === "tool_call_delta" || event.type === "tool_call_end" || event.type === "message_end"), false);
});

test("Responses SSE 与 JSON 的 incomplete 缺失或未知原因保留未完成，failed 保留上游错误", async () => {
  const item = { id: "item", call_id: "call", type: "custom_tool_call", name: "edit", input: "未完成补丁" };
  for (const source of ["sse", "json"] as const) {
    for (const reason of [undefined, "unknown_reason", "max_output_tokens", "content_filter"]) {
      const response = { id: "response", status: "incomplete", output: [item], ...(reason ? { incomplete_details: { reason } } : {}) };
      const payload = source === "json" ? Response.json(response) : upstream([
        sseFrameBytes("response.output_item.added", { output_index: 0, item: { ...item, input: "" } }),
        sseFrameBytes("response.output_item.done", { output_index: 0, item }),
        sseFrameBytes("response.incomplete", { response }),
      ]);
      const result = await createClientResponse("responses", payload, { upstreamProtocol: "responses", model: "model", stream: false,
        toolIdentities: new Map([["edit", { name: "edit", custom: true }]]) });
      const json = await result.response.json() as Json;
      assert.equal(json.status, "incomplete", source);
      assert.deepEqual(json.incomplete_details, { reason: reason === "content_filter" ? "content_filter" : "max_output_tokens" });
      const tool = (json.output as Json[])[0]!;
      assert.equal(tool.input, "", source);
      assert.equal(tool.status, "incomplete", source);
    }
    const response = { status: "failed", output: [item], error: { message: "上游明确失败", code: "provider_failure" } };
    const payload = source === "json" ? Response.json(response) : upstream([sseFrameBytes("response.failed", { response })]);
    const result = await createClientResponse("responses", payload, { upstreamProtocol: "responses", model: "model", stream: false });
    const json = await result.response.json() as Json;
    assert.equal(json.status, "failed", source);
    assert.equal((json.error as Json).message, response.error.message, source);
    assert.equal((json.error as Json).code, response.error.code, source);
  }
});

test("Responses custom 完成输入类型错误必须失败，不能静默回退到空字符串或旧增量", async () => {
  const item = { id: "item", call_id: "call", type: "custom_tool_call", name: "edit", input: "" };
  for (const input of [null, 42, { text: "非法对象" }, []]) {
    for (const type of ["response.custom_tool_call_input.done", "response.output_item.done"]) {
      const frames = [sseFrameBytes("response.created", { response: { id: "response" } }),
        sseFrameBytes("response.output_item.added", { output_index: 0, item }),
        sseFrameBytes("response.custom_tool_call_input.delta", { output_index: 0, delta: "旧的合法增量" }),
        sseFrameBytes(type, type === "response.custom_tool_call_input.done" ? { output_index: 0, input } : { output_index: 0, item: { ...item, input } }),
        sseFrameBytes("response.completed", { response: { status: "completed" } }),
      ];
      await assert.rejects(collect("responses", frames), /custom 完成输入必须是字符串/);
    }
  }
  for (const input of [undefined, null, 42, { text: "非法对象" }, []]) {
    await assert.rejects(async () => {
      for await (const event of parseUpstreamEvents("responses", Response.json({ status: "completed", output: [{ ...item, input }] }), "model")) void event;
    }, /completed custom 输入必须是字符串/);
  }
  const fallback = await collect("responses", [
    sseFrameBytes("response.output_item.added", { output_index: 0, item }),
    sseFrameBytes("response.custom_tool_call_input.delta", { output_index: 0, delta: "合法增量" }),
    sseFrameBytes("response.custom_tool_call_input.done", { output_index: 0 }),
    sseFrameBytes("response.completed", { response: { status: "completed" } }),
  ]);
  assert.equal(fallback.find((event) => event.type === "tool_call_delta")?.tool_call.arguments_delta, '{"input":"合法增量"}');
});

test("Responses custom 损坏的增量不得被静默忽略后发布残缺正文", async () => {
  const item = { id: "ctc", call_id: "call", name: "apply_patch", type: "custom_tool_call", input: "" };
  for (const delta of [undefined, null, 42, {}, []]) {
    await assert.rejects(collect("responses", [
      sseFrameBytes("response.output_item.added", { output_index: 0, item }),
      sseFrameBytes("response.custom_tool_call_input.delta", { output_index: 0, delta: "已有正文" }),
      sseFrameBytes("response.custom_tool_call_input.delta", { output_index: 0, delta }),
      sseFrameBytes("response.custom_tool_call_input.done", { output_index: 0 }),
      sseFrameBytes("response.completed", { response: { status: "completed" } }),
    ]), /增量必须是字符串/);
  }
});

test("Responses 终态后的工具调用不会并入已结束的响应", async () => {
  for (const status of ["completed", "incomplete"]) {
    const seen: BridgeStreamEvent[] = [];
    const response = upstream([
      sseFrameBytes("response.created", { response: { id: "resp", status: "in_progress" } }),
      sseFrameBytes(`response.${status}`, { response: { status } }),
      sseFrameBytes("response.output_item.added", { output_index: 0, item: { id: "fc", call_id: "call", name: "edit", type: "function_call" } }),
      sseFrameBytes("response.function_call_arguments.delta", { output_index: 0, delta: "{}" }),
      sseFrameBytes("response.output_item.done", { output_index: 0, item: { id: "fc", call_id: "call", type: "function_call" } }),
      sseFrameBytes(undefined, "[DONE]"),
    ]);
    await assert.rejects(async () => {
      for await (const event of parseUpstreamEvents("responses", response, "model")) seen.push(event);
    }, /终态后返回额外数据帧/);
    assert.equal(seen.some((event) => event.type === "tool_call_start"), false);
  }
});

test("两个并发 SSE 请求在 Unicode 字节中间切片时不会共享解码状态", async () => {
  const streams = ["中文", "😀火箭"].map((value) => {
    const bytes = new TextEncoder().encode(`data: ${value}\n\n`);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: () => void;
    const waiting = new Promise<void>((resolve) => { signal = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(next) { controller = next; controller.enqueue(bytes.slice(0, 7)); },
      // 下一次读取说明当前请求已把首个多字节字符的一部分交给解码器。
      pull() { signal(); },
    }, { highWaterMark: 0 });
    return { value, bytes, controller, waiting, iterator: readSseFrames(body) };
  });
  const pending = streams.map((stream) => stream.iterator.next());
  const framesPromise = Promise.all(pending);
  // 若解码提前失败，直接报告错误，不能因另一个请求仍待数据而卡住测试。
  await Promise.race([Promise.all(streams.map((stream) => stream.waiting)), framesPromise]);
  for (const stream of streams) {
    stream.controller.enqueue(stream.bytes.slice(7));
    stream.controller.close();
  }
  const frames = await framesPromise;
  for (let index = 0; index < streams.length; index++) {
    assert.deepEqual(frames[index]!.value, { event: undefined, data: streams[index]!.value });
    assert.equal((await streams[index]!.iterator.next()).done, true);
  }
});
