import assert from "node:assert/strict";
import test from "./host-test.ts";
import { translateAgyRequest, AgyRequestError } from "@agent-proxy/agy/request";
import { createAgyClientResponse } from "@agent-proxy/agy/response";

const TIMEOUT = { timeout: 30_000 };
type Json = Record<string, unknown>;

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

function parts(content: Json): Array<Record<string, unknown>> {
  return content.parts as Array<Record<string, unknown>>;
}

/** 早帧先下发、晚帧等待 release() 的上游流，用于断言渲染层增量下发。 */
function gatedSse(early: Array<Record<string, unknown>>, late: Array<Record<string, unknown>>): { response: Response; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const encoder = new TextEncoder();
  const encode = (frame: Record<string, unknown>): Uint8Array => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of early) controller.enqueue(encode(frame));
      await gate;
      for (const frame of late) controller.enqueue(encode(frame));
      controller.close();
    },
  });
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), release };
}

/** 带超时的读取：渲染层若整体缓冲会阻塞读取，超时即失败而非挂起整个测试。 */
async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number, message: string): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  try {
    const { value, done } = await Promise.race([reader.read(), timeout]);
    if (done) throw new Error("流在断言完成前意外结束");
    return value!;
  } finally {
    clearTimeout(timer);
  }
}

test("agy chat-completions 源：messages 归一为 contents，工具声明进入 functionDeclarations", TIMEOUT, () => {
  const { wrapper, tools } = translateAgyRequest({
    model: "agy/gemini-3.8-flash",
    max_tokens: 256,
    temperature: 0.3,
    reasoning_effort: "high",
    messages: [
      { role: "system", content: "系统规则" },
      { role: "user", content: "读取文件" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"command\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "文件列表" },
    ],
    tools: [{ type: "function", function: { name: "shell", description: "执行", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
    tool_choice: { type: "function", function: { name: "shell" } },
  }, "gemini-3.8-flash", "chat-completions");
  const request = wrapper.request as Json;
  const contents = request.contents as Array<Json>;
  // system → systemInstruction；user → user；assistant.tool_calls → model functionCall；tool → user functionResponse
  const systemInstruction = request.systemInstruction as Json;
  assert.equal((systemInstruction.parts as Array<Json>)[0]!.text, "系统规则");
  assert.deepEqual(contents[0]!.role, "user");
  assert.equal(parts(contents[1]!)[0]!.functionCall && (parts(contents[1]!)[0]!.functionCall as Json).name, "shell");
  assert.deepEqual((parts(contents[1]!)[0]!.functionCall as Json).args, { command: "ls" });
  const response = (parts(contents[2]!)[0]!.functionResponse as Json);
  assert.equal(response.name, "shell");
  assert.deepEqual(response.response, { output: "文件列表" });
  const declarations = ((request.tools as Array<Json>)[0]!.functionDeclarations as Array<Json>);
  assert.equal(declarations[0]!.name, "shell");
  const generationConfig = request.generationConfig as Json;
  assert.equal(generationConfig.maxOutputTokens, 256);
  assert.equal((generationConfig.thinkingConfig as Json).thinkingLevel, "high");
  const toolConfig = request.toolConfig as Json;
  assert.deepEqual(toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["shell"] } });
  assert.equal(tools.get("shell")?.name, "shell");
});

test("agy anthropic 源：tool_use/tool_result 归一为 functionCall/functionResponse，图片走 inlineData", TIMEOUT, () => {
  const { wrapper } = translateAgyRequest({
    model: "agy/gemini-3.8-flash",
    max_tokens: 256,
    system: [{ type: "text", text: "系统规则" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell", input: { command: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "目录" }] }] },
    ],
    tools: [{ name: "shell", description: "执行", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    tool_choice: { type: "any" },
  }, "gemini-3.8-flash", "anthropic");
  const request = wrapper.request as Json;
  const contents = request.contents as Array<Json>;
  const systemInstruction = request.systemInstruction as Json;
  assert.equal((systemInstruction.parts as Array<Json>)[0]!.text, "系统规则");
  const userParts = parts(contents[0]!);
  assert.equal(userParts[0]!.text, "看图");
  assert.deepEqual(userParts[1]!.inlineData, { mimeType: "image/png", data: "QUJD" });
  assert.deepEqual((parts(contents[1]!)[0]!.functionCall as Json).args, { command: "pwd" });
  assert.deepEqual((parts(contents[2]!)[0]!.functionResponse as Json).response, { output: "目录" });
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  const declarations = ((request.tools as Array<Json>)[0]!.functionDeclarations as Array<Json>);
  assert.equal(declarations[0]!.name, "shell");
});

test("agy chat 源非法工具参数显式拒绝", TIMEOUT, () => {
  assert.throws(() => translateAgyRequest({
    model: "agy/gemini-3.8-flash",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "not-json" } }] },
    ],
    tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
  }, "gemini-3.8-flash", "chat-completions"), AgyRequestError);
});

test("agy chat-completions 客户端渲染：SSE chunks 聚合与 [DONE] 顺序", TIMEOUT, async () => {
  const response = await createAgyClientResponse("chat-completions", sse([
    textFrame("TCP "),
    textFrame("TIME_WAIT "),
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "残留状态" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 } } },
  ]), { model: "agy/gemini-3.8-flash", tools: new Map(), stream: true });
  const text = await response.text();
  const frames = text.split("\n\n").filter(Boolean);
  assert.equal(frames.at(-1), "data: [DONE]");
  const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame.replace("data: ", "")) as Json);
  const content = chunks.map((chunk) => (((chunk.choices as Array<Json>)?.[0]?.delta as Json | undefined)?.content as string | undefined) ?? "").join("");
  assert.equal(content, "TCP TIME_WAIT 残留状态");
  const usageFrame = JSON.parse(frames.at(-2)!.replace("data: ", "")) as Json;
  assert.deepEqual(usageFrame.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
});

test("agy chat-completions 非流式聚合为完整 completion", TIMEOUT, async () => {
  const response = await createAgyClientResponse("chat-completions", sse([
    textFrame("答案"),
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } },
  ]), { model: "agy/gemini-3.8-flash", tools: new Map(), stream: false });
  const payload = await response.json() as Json;
  assert.equal(payload.object, "chat.completion");
  assert.equal((payload.choices as Array<Json>)[0]!.finish_reason, "stop");
});

test("agy anthropic 客户端渲染：message_start → 块生命周期 → message_stop", TIMEOUT, async () => {
  const response = await createAgyClientResponse("anthropic", sse([
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "内部", thought: true }] } }] } },
    textFrame("公开回答"),
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } } },
  ]), { model: "agy/gemini-3.8-flash", tools: new Map(), stream: true });
  const text = await response.text();
  assert.match(text, /message_start/);
  assert.match(text, /thinking_delta/);
  assert.match(text, /text_delta/);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /message_stop/);
});

test("agy anthropic 非流式聚合为完整 Message JSON", TIMEOUT, async () => {
  const response = await createAgyClientResponse("anthropic", sse([
    textFrame("答案"),
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } } },
  ]), { model: "agy/gemini-3.8-flash", tools: new Map(), stream: false });
  const payload = await response.json() as Json;
  assert.equal(payload.type, "message");
  assert.equal(payload.stop_reason, "end_turn");
  const content = payload.content as Array<Json>;
  const textBlock = content.find((block) => block.type === "text") as Json;
  assert.equal(textBlock.text, "答案");
  assert.deepEqual(payload.usage, { input_tokens: 2, output_tokens: 1 });
});

test("agy anthropic 流式工具调用：每个工具块只有一条带 name/id 的 content_block_start", TIMEOUT, async () => {
  const response = await createAgyClientResponse("anthropic", sse([
    textFrame("我来查询。"),
    { response: { candidates: [{ content: { role: "model", parts: [
      { functionCall: { name: "web_search", args: { query: "北京天气" } } },
      { functionCall: { name: "WebFetch", args: { url: "https://example.com" } } },
    ] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } } },
  ]), {
    model: "agy/gemini-3.8-flash",
    tools: new Map([["web_search", { name: "web_search", custom: false }], ["WebFetch", { name: "WebFetch", custom: false }]]),
    stream: true,
  });
  const text = await response.text();
  const starts = text.split("\n\n")
    .filter((frame) => frame.startsWith("event: content_block_start"))
    .map((frame) => JSON.parse(frame.split("\ndata: ")[1]!) as Json);
  // 回归：openTool 曾额外推送一条同 index、空 id/name 的重复 content_block_start。
  const indexes = starts.map((event) => event.index);
  assert.equal(new Set(indexes).size, indexes.length);
  const toolStarts = starts.map((event) => event.content_block as Json).filter((block) => block.type === "tool_use");
  assert.deepEqual(toolStarts.map((block) => block.name), ["web_search", "WebFetch"]);
  for (const block of toolStarts) {
    assert.ok(typeof block.id === "string" && block.id.length > 0);
  }
  assert.match(text, /input_json_delta/);
  assert.match(text, /"stop_reason":"tool_use"/);
});

test("agy anthropic 非流式工具调用：聚合出单个带 id/name/input 的 tool_use 块", TIMEOUT, async () => {
  const response = await createAgyClientResponse("anthropic", sse([
    { response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "shell", args: { command: "ls" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } } },
  ]), { model: "agy/gemini-3.8-flash", tools: new Map([["shell", { name: "shell", custom: false }]]), stream: false });
  const payload = await response.json() as Json;
  assert.equal(payload.stop_reason, "tool_use");
  const toolBlocks = (payload.content as Array<Json>).filter((block) => block.type === "tool_use");
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0]!.name, "shell");
  assert.ok(typeof toolBlocks[0]!.id === "string" && (toolBlocks[0]!.id as string).length > 0);
  assert.deepEqual(toolBlocks[0]!.input, { command: "ls" });
});

test("agy anthropic 流式渲染增量下发：思考事件先于上游终帧到达客户端", TIMEOUT, async () => {
  const gated = gatedSse(
    [{ response: { candidates: [{ content: { role: "model", parts: [{ text: "先思考一段", thought: true }] } }] } }],
    [textFrame("正文")],
  );
  const response = await createAgyClientResponse("anthropic", gated.response, { model: "agy/gemini-3.8-flash", tools: new Map(), stream: true });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  try {
    // 回归：渲染层曾把全部事件缓冲到上游流结束才一次性下发，思考阶段客户端收不到字节。
    while (!received.includes("thinking_delta")) {
      received += decoder.decode(await readWithTimeout(reader, 2_000, "上游终帧挂起时应能持续读到思考增量"), { stream: true });
    }
    assert.ok(received.includes("先思考一段"));
    gated.release();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  assert.match(received, /text_delta/);
  assert.match(received, /message_stop/);
});

test("agy chat-completions 流式渲染增量下发：内容块先于上游终帧到达客户端", TIMEOUT, async () => {
  const gated = gatedSse(
    [textFrame("流式正文")],
    [{ response: { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } }],
  );
  const response = await createAgyClientResponse("chat-completions", gated.response, { model: "agy/gemini-3.8-flash", tools: new Map(), stream: true });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  try {
    while (!received.includes("流式正文")) {
      received += decoder.decode(await readWithTimeout(reader, 2_000, "上游终帧挂起时应能先读到正文增量"), { stream: true });
    }
    gated.release();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  assert.match(received, /\[DONE\]/);
});

test("agy gemini 流式渲染增量下发：文本 part 先于上游终帧到达客户端", TIMEOUT, async () => {
  const gated = gatedSse(
    [textFrame("增量文本")],
    [{ response: { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } }],
  );
  const response = await createAgyClientResponse("gemini", gated.response, { model: "agy/gemini-3.8-flash", tools: new Map(), stream: true });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  try {
    while (!received.includes("增量文本")) {
      received += decoder.decode(await readWithTimeout(reader, 2_000, "上游终帧挂起时应能先读到文本 part"), { stream: true });
    }
    gated.release();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  assert.match(received, /"finishReason":"STOP"/);
});

test("agy anthropic 渲染下发音签：thoughtSignature 成为 thinking 块的 agn1 signature", TIMEOUT, async () => {
  const upstreamFrames = () => [
    { response: { candidates: [{ content: { role: "model", parts: [
      { text: "思考摘要", thought: true },
      { thoughtSignature: "sig-abc" },
      { functionCall: { name: "shell", args: { command: "ls" } } },
    ] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } } },
  ];
  const tools = new Map([["shell", { name: "shell", custom: false }]]);
  const streamed = await createAgyClientResponse("anthropic", sse(upstreamFrames()), { model: "agy/gemini-3.8-flash", tools, stream: true });
  const text = await streamed.text();
  assert.match(text, /signature_delta/);
  assert.match(text, /"signature":"agn1:sig-abc"/);
  assert.match(text, /"name":"shell"/);
  const aggregated = await createAgyClientResponse("anthropic", sse(upstreamFrames()), { model: "agy/gemini-3.8-flash", tools, stream: false });
  const payload = await aggregated.json() as Json;
  const signed = (payload.content as Array<Json>).find((block) => block.type === "thinking" && typeof block.signature === "string" && (block.signature as string).startsWith("agn1:")) as Json;
  assert.equal(signed.signature, "agn1:sig-abc");
  assert.ok((payload.content as Array<Json>).some((block) => block.type === "tool_use" && block.name === "shell"));
});

test("agy anthropic 请求回挂：签名 thinking 块的 agn1 信封挂回 functionCall.thoughtSignature", TIMEOUT, () => {
  const { wrapper } = translateAgyRequest({
    model: "agy/gemini-3.8-flash",
    max_tokens: 256,
    messages: [
      { role: "user", content: [{ type: "text", text: "列目录" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "模型私有思考", signature: "agn1:sig-abc" },
        { type: "tool_use", id: "t1", name: "shell", input: { command: "ls" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "列表" }] }] },
    ],
  }, "gemini-3.8-flash", "anthropic");
  const flatParts = ((wrapper.request as Json).contents as Array<Json>).flatMap((entry) => entry.parts as Array<Json>);
  const callPart = flatParts.find((part) => part.functionCall !== null && typeof part.functionCall === "object") as Json;
  assert.equal(callPart.thoughtSignature, "sig-abc");
  assert.deepEqual((callPart.functionCall as Json).args, { command: "ls" });
  // 签名 thinking 块的私有思考文本不回放。
  assert.ok(!flatParts.some((part) => typeof part.text === "string" && part.text.includes("模型私有思考")));
});
