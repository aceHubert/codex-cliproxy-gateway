import assert from "node:assert/strict";
import { translateAgyRequest } from "@agent-proxy/agy/request";
import { createAgyResponse } from "@agent-proxy/agy/response";
import { createAgyNativeSearchStream } from "@agent-proxy/agy/search-loop";
import test from "./host-test.ts";

type Json = Record<string, any>;
const TIMEOUT = { timeout: 30_000 };

function sse(frames: Json[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function frame(parts: Json[], usage?: Json): Json {
  return { response: { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], ...(usage ? { usageMetadata: usage } : {}) } };
}

function setup(extra: Json = {}) {
  return translateAgyRequest({ input: "搜索杭州天气", tools: [{ type: "web_search" }], ...extra }, "gemini-4-hydrogen-high");
}

const result = {
  output: "杭州天气来源 citeturn1search0",
  results: [{ type: "text_result", ref_id: "turn1search0", title: "天气", url: "https://weather.example/hangzhou", domain: "weather.example", snippet: "杭州天气" }],
};

test("AGY 内置 web_search 声明为服务器保留函数，不再交给客户端工具映射", TIMEOUT, () => {
  const translated = setup({ tool_choice: { type: "web_search" } });
  assert.equal(translated.dropped.length, 0);
  assert.ok(translated.nativeSearchTool);
  assert.equal(translated.tools.has(translated.nativeSearchTool), false);
  const request = translated.wrapper.request as Json;
  const native = request.tools[0].functionDeclarations.find((tool: Json) => tool.name === translated.nativeSearchTool);
  assert.deepEqual(native.parameters.required, ["query"]);
  assert.equal(native.parameters.properties.query.type, "string");
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [translated.nativeSearchTool] } });
  assert.equal(setup({ tools: [{ type: "web_search", external_web_access: false }] }).nativeSearchTool, undefined);
  assert.deepEqual(setup({ tools: [{ type: "namespace", name: "unsafe", tools: [{ type: "web_search" }] }] }).dropped, ["web_search"]);
  assert.throws(() => setup({ tools: [{ type: "function", name: translated.nativeSearchTool, parameters: { type: "object" } }] }), /保留/);
  const settings = { filters: { allowed_domains: ["weather.example"] }, user_location: { type: "approximate", city: "杭州" }, search_context_size: "low" };
  const limited = setup({ tools: [{ type: "web_search", max_uses: 1, ...settings }] });
  assert.deepEqual(limited.nativeSearchSettings, settings);
  assert.equal(limited.nativeSearchLimit, 1);
  assert.equal(setup({ tools: [{ type: "web_search", max_uses: 20 }] }).nativeSearchLimit, 4);
  for (const max_uses of [0, -1, 1.5, "2"]) assert.throws(() => setup({ tools: [{ type: "web_search", max_uses }] }), /正整数/);
});

test("AGY 已执行搜索历史保留查询与安全来源，不再声称搜索不受支持", TIMEOUT, () => {
  const translated = setup({ input: [
    { type: "web_search_call", id: "ws_old", status: "completed", action: { query: "杭州天气" }, results: [
      { title: "气象来源", url: "https://weather.example/hangzhou?token=secret#section", snippet: "明日降水概率较低" },
      { title: "敏感链接", url: "https://private:secret@unsafe.example/path", snippet: "不应回放" },
      { title: "无效来源", url: "javascript:alert(1)", snippet: "不应回放" },
    ] },
    { type: "message", role: "user", content: "根据之前搜索回答" },
  ] });
  const history = JSON.stringify((translated.wrapper.request as Json).contents);
  assert.match(history, /已执行网页搜索/);
  assert.match(history, /杭州天气/);
  assert.match(history, /气象来源/);
  assert.match(history, /明日降水概率较低/);
  assert.match(history, /https:\/\/weather.example\/hangzhou/);
  assert.ok(!history.includes("本通道不支持"));
  assert.ok(!history.includes("secret") && !history.includes("javascript:") && !history.includes("unsafe.example"));
  assert.ok(!history.includes("functionCall") && !history.includes("thoughtSignature"));
});

test("AGY 原生搜索在服务器执行，签名和中文结果回填同模型并生成一次完整响应", TIMEOUT, async () => {
  const translated = setup({ tool_choice: "required" });
  const toolName = translated.nativeSearchTool!;
  const initial = sse([frame([
    { text: "我需要核对来源。", thought: true },
    { functionCall: { id: "native-call", name: toolName, args: { query: "杭州明天天气", domain: "weather.example" } }, thoughtSignature: "real-signature" },
  ], { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 17 })]);
  let searches = 0;
  let continued: Json | undefined;
  const wrapped = createAgyNativeSearchStream(initial, translated.wrapper, toolName, {
    signal: new AbortController().signal,
    async search(query, domain) {
      searches++;
      assert.equal(query, "杭州明天天气");
      assert.equal(domain, "weather.example");
      return result;
    },
    async infer(body) {
      continued = structuredClone(body);
      return sse([frame([{ text: "杭州明日天气已核查。" }], { promptTokenCount: 15, candidatesTokenCount: 4, totalTokenCount: 19 })]);
    },
  });
  const response = await createAgyResponse(wrapped, { model: "agy/gemini-4-hydrogen", tools: translated.tools, stream: false });
  const payload = await response.json() as Json;
  assert.equal(response.status, 200);
  assert.equal(payload.status, "completed");
  assert.equal(searches, 1);
  assert.equal(continued!.model, "gemini-4-hydrogen-high");
  assert.notEqual(continued!.requestId, translated.wrapper.requestId, "每轮模型请求使用独立请求 ID");
  const replay = continued!.request.contents.slice(-2);
  assert.equal(replay[0].role, "model");
  assert.equal(replay[0].parts[1].thoughtSignature, "real-signature");
  assert.equal(replay[0].parts[1].functionCall.id, "native-call");
  assert.deepEqual(replay[1].parts[0].functionResponse, { name: toolName, id: "native-call", response: result });
  assert.deepEqual(continued!.request.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  const search = payload.output.find((item: Json) => item.type === "web_search_call");
  assert.equal(search.action.query, "杭州明天天气");
  assert.equal(search.status, "completed");
  assert.deepEqual(search.results, result.results);
  assert.ok(!payload.output.some((item: Json) => item.type === "function_call" || item.type === "custom_tool_call"));
  assert.equal(payload.output.find((item: Json) => item.type === "message").content[0].text, "杭州明日天气已核查。");
  assert.deepEqual(payload.usage, { input_tokens: 27, output_tokens: 6, total_tokens: 36, output_tokens_details: { reasoning_tokens: 3 } });
});

test("AGY 无搜索输出仍逐帧到达，不等待整个上游轮次结束", TIMEOUT, async () => {
  const translated = setup();
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) { producer = controller; } }));
  const wrapped = createAgyNativeSearchStream(upstream, translated.wrapper, translated.nativeSearchTool!, {
    signal: new AbortController().signal,
    async search() { throw new Error("不应执行搜索"); },
    async infer() { throw new Error("不应续轮"); },
  });
  const reader = wrapped.body!.getReader();
  producer.enqueue(encoder.encode(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "首段" }] } }] } })}\n\n`));
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /首段/);
  producer.enqueue(encoder.encode(`data: ${JSON.stringify(frame([{ text: "尾段" }]))}\n\n`));
  producer.close();
  let remaining = "";
  while (true) { const next = await reader.read(); if (next.done) break; remaining += new TextDecoder().decode(next.value); }
  assert.match(remaining, /尾段/);
  assert.match(remaining, /STOP/);
});

test("AGY 独立签名帧续轮时挂到后续搜索函数，不回放孤立签名部件", TIMEOUT, async () => {
  const translated = setup();
  let replay: Json | undefined;
  const wrapped = createAgyNativeSearchStream(sse([
    { response: { candidates: [{ content: { parts: [{ thoughtSignature: "detached-signature" }] } }] } },
    frame([{ functionCall: { name: translated.nativeSearchTool, args: { query: "query" } } }]),
  ]), translated.wrapper, translated.nativeSearchTool!, {
    signal: new AbortController().signal,
    async search() { return result; },
    async infer(body) { replay = structuredClone(body); return sse([frame([{ text: "完成" }])]); },
  });
  await wrapped.text();
  const parts = replay!.request.contents.at(-2).parts;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].thoughtSignature, "detached-signature");
  assert.equal(parts[0].functionCall.name, translated.nativeSearchTool);
});

test("AGY 普通客户端函数调用保持原样，不被原生搜索执行器执行", TIMEOUT, async () => {
  const translated = setup({ tools: [{ type: "web_search" }, { type: "function", name: "shell", parameters: { type: "object" } }] });
  const wrapped = createAgyNativeSearchStream(sse([frame([{ functionCall: { name: "shell", args: { command: "pwd" } }, thoughtSignature: "client-signature" }])]), translated.wrapper, translated.nativeSearchTool!, {
    signal: new AbortController().signal,
    async search() { throw new Error("不应执行搜索"); },
    async infer() { throw new Error("不应续轮"); },
  });
  const response = await createAgyResponse(wrapped, { model: "agy/test", tools: translated.tools, stream: false });
  const payload = await response.json() as Json;
  assert.equal(payload.status, "completed");
  assert.equal(payload.output.find((item: Json) => item.type === "function_call").name, "shell");
  assert.ok(payload.output.some((item: Json) => item.encrypted_content === "agn1:client-signature"));
});

test("AGY 混合内部搜索和客户端函数时明确失败，避免未配对工具或重复执行", TIMEOUT, async () => {
  const translated = setup({ tools: [{ type: "web_search" }, { type: "function", name: "shell", parameters: { type: "object" } }] });
  let invoked = 0;
  const wrapped = createAgyNativeSearchStream(sse([frame([
    { functionCall: { name: translated.nativeSearchTool, args: { query: "query" } } },
    { functionCall: { name: "shell", args: {} } },
  ])]), translated.wrapper, translated.nativeSearchTool!, {
    signal: new AbortController().signal,
    async search() { invoked++; return result; },
    async infer() { invoked++; return sse([]); },
  });
  const payload = await (await createAgyResponse(wrapped, { model: "agy/test", tools: translated.tools, stream: false })).json() as Json;
  assert.equal(payload.status, "failed");
  assert.match(payload.error.message, /分步调用/);
  assert.ok(!payload.output.some((item: Json) => item.type === "function_call" || item.type === "custom_tool_call"), "混合轮次失败前不应向客户端发布可执行调用");
  assert.equal(invoked, 0);
});

test("AGY 每个请求最多执行四次原生搜索，达到限制后不继续调用搜索", TIMEOUT, async () => {
  const translated = setup();
  const next = () => sse([frame([{ functionCall: { name: translated.nativeSearchTool, args: { query: "query" } } }])]);
  let searches = 0;
  const wrapped = createAgyNativeSearchStream(next(), translated.wrapper, translated.nativeSearchTool!, {
    signal: new AbortController().signal,
    async search() { searches++; return result; },
    async infer() { return next(); },
  });
  const payload = await (await createAgyResponse(wrapped, { model: "agy/test", tools: translated.tools, stream: false })).json() as Json;
  assert.equal(payload.status, "failed");
  assert.match(payload.error.message, /最多 4 次/);
  assert.equal(searches, 4);
  assert.equal(payload.output.filter((item: Json) => item.type === "web_search_call").length, 4);
});

test("AGY 原生搜索的取消信号传到执行器，不进行后续模型调用", TIMEOUT, async () => {
  const translated = setup();
  const abort = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let inferred = false;
  const wrapped = createAgyNativeSearchStream(sse([frame([{ functionCall: { name: translated.nativeSearchTool, args: { query: "query" } } }])]), translated.wrapper, translated.nativeSearchTool!, {
    signal: abort.signal,
    async search(_query, _domain, signal) {
      entered();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      return result;
    },
    async infer() { inferred = true; return sse([]); },
  });
  const reading = wrapped.text();
  await started;
  abort.abort();
  await reading;
  assert.equal(inferred, false);
});

test("AGY web_search.max_uses 限制为一次时不执行第二次搜索", TIMEOUT, async () => {
  const translated = setup({ tools: [{ type: "web_search", max_uses: 1 }] });
  const next = () => sse([frame([{ functionCall: { name: translated.nativeSearchTool, args: { query: "query" } } }])]);
  let searches = 0;
  const wrapped = createAgyNativeSearchStream(next(), translated.wrapper, translated.nativeSearchTool!, {
    signal: new AbortController().signal,
    maxSearches: translated.nativeSearchLimit,
    async search() { searches++; return result; },
    async infer() { return next(); },
  });
  const payload = await (await createAgyResponse(wrapped, { model: "agy/test", tools: translated.tools, stream: false })).json() as Json;
  assert.equal(payload.status, "failed");
  assert.match(payload.error.message, /最多 1 次/);
  assert.equal(searches, 1);
});
