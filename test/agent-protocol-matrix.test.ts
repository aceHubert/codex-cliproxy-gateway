import assert from "node:assert/strict";
import test from "./host-test.ts";
import { translateCodebuddyRequest } from "@agent-proxy/codebuddy/request";
import { CODEBUDDY_AGENT_SYSTEM_PROMPT } from "@agent-proxy/codebuddy/request-context";
import { createCodebuddyResponse as codebuddyClientResponse } from "@agent-proxy/codebuddy/response";
import { translateQoderRequest } from "@agent-proxy/qoder/request";
import { QODER_AGENT_SYSTEM_PROMPT } from "@agent-proxy/qoder/transport";
import { translateQoderResponse } from "@agent-proxy/qoder/response";
import { translateZcodeRequest } from "@agent-proxy/zcode/request";
import { ZCODE_AGENT_SYSTEM_PROMPT } from "@agent-proxy/zcode/request-context";
import { createZcodeClientResponse } from "@agent-proxy/zcode/response";
import { encodeZcodeThinking } from "@agent-proxy/zcode/wire";
import { translateAgyRequest } from "@agent-proxy/agy/request";

/**
 * 逐家三协议入口 fake 验收：每家至少覆盖 chat-completions 与 anthropic 来源的
 * 请求转换与一个客户端协议方向的完整输出（Responses 来源由既有套件覆盖）。
 */

type Json = Record<string, unknown>;

const encoder = new TextEncoder();

function chatSse(deltas: Array<Json>, finish = "stop"): Response {
  const frames = deltas.map((delta) => `data: ${JSON.stringify({ id: "chatcmpl-m", object: "chat.completion.chunk", model: "up", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  frames.push(`data: ${JSON.stringify({ id: "chatcmpl-m", object: "chat.completion.chunk", model: "up", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

function anthropicSse(frames: Array<Json>): Response {
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function readText(response: Response): Promise<string> {
  return await response.text();
}

/* ------------------------------ CodeBuddy ------------------------------ */

test("CodeBuddy chat 源：messages 转换与 reasoning_effort 透传", async () => {
  const { body } = await translateCodebuddyRequest({
    model: "codebuddy/m",
    messages: [
      { role: "system", content: "服务提示" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    max_completion_tokens: 128,
    reasoning_effort: "high",
  }, "m", "chat-completions");
  const messages = body.messages as Array<Json>;
  assert.equal(messages[0]!.content, CODEBUDDY_AGENT_SYSTEM_PROMPT, "官方主提示词整体替换客户端 system");
  const assistant = messages[2]!;
  assert.equal((assistant.tool_calls as Array<Json>)[0]!.id, "c1");
  const tool = messages[3]!;
  assert.equal(tool.tool_call_id, "c1");
  assert.equal(body.max_tokens, 128);
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.stream, true);
});

test("CodeBuddy anthropic 源：tool_use/tool_result 配对与 system 投影", async () => {
  const { body } = await translateCodebuddyRequest({
    model: "codebuddy/m",
    max_tokens: 64,
    system: "服务提示",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
    tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
  }, "m", "anthropic");
  const messages = body.messages as Array<Json>;
  assert.equal(messages[0]!.content, CODEBUDDY_AGENT_SYSTEM_PROMPT, "官方主提示词整体替换顶层 system");
  const assistant = messages[2]!;
  assert.equal(((assistant.tool_calls as Array<Json>)[0]!.function as Json).name, "f");
  assert.equal(messages[3]!.tool_call_id, "t1");
  assert.equal(body.max_tokens, 64);
});

test("CodeBuddy chat 上游 → anthropic 客户端流式渲染", async () => {
  const upstream = chatSse([{ content: "你好" }]);
  const response = await codebuddyClientResponse("anthropic", upstream, {
    model: "codebuddy-intl/m", tools: new Map(), stream: true,
  });
  const text = await readText(response);
  assert.match(text, /message_start/);
  assert.match(text, /text_delta/);
  assert.match(text, /message_stop/);
});

test("CodeBuddy chat 上游 → chat-completions 客户端透传语义", async () => {
  const upstream = chatSse([{ content: "直接回答" }], "stop");
  const response = await codebuddyClientResponse("chat-completions", upstream, {
    model: "codebuddy-intl/m", tools: new Map(), stream: false,
  });
  const payload = await response.json() as Json;
  assert.equal(payload.object, "chat.completion");
  assert.equal(((payload.choices as Array<Json>)[0]!.message as Json).content, "直接回答");
});

/* ------------------------------- Qoder -------------------------------- */

test("Qoder chat 源：私有信封的 messages/tools/parameters 布局", async () => {
  const { body, tools } = await translateQoderRequest({
    model: "qoder-intl/m",
    messages: [
      { role: "system", content: "系统" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    max_tokens: 128,
  }, "qfmodel", undefined, "chat-completions");
  assert.equal(body.system, QODER_AGENT_SYSTEM_PROMPT, "官方提示词整体替换客户端 system 消息");
  const messages = body.messages as Array<Json>;
  assert.equal(messages[0]!.role, "system");
  const assistant = messages[2]!;
  assert.equal((assistant.tool_calls as Array<Json>)[0]!.id, "c1");
  assert.deepEqual((body.parameters as Json).max_tokens, 128);
  assert.equal(tools.get("f")?.name, "f");
});

test("Qoder anthropic 源：tool_use/tool_result 进入信封历史", async () => {
  const { body } = await translateQoderRequest({
    model: "qoder-intl/m",
    max_tokens: 64,
    system: "系统",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
    tools: [{ name: "f", input_schema: { type: "object" } }],
  }, "qfmodel", undefined, "anthropic");
  const messages = body.messages as Array<Json>;
  const assistant = messages[2]!;
  assert.equal(((assistant.tool_calls as Array<Json>)[0]!.function as Json).name, "f");
  assert.equal(messages[3]!.tool_call_id, "t1");
});

test("Qoder chat 上游 → anthropic 客户端流式渲染（信封解包后渲染）", async () => {
  const envelope = (chunk: Json): string => `data: ${JSON.stringify({ body: JSON.stringify(chunk) })}\n\n`;
  const upstreamText = envelope({ choices: [{ index: 0, delta: { content: "排队后回答" }, finish_reason: null }] })
    + envelope({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    // 真实信封的内层 [DONE] 是裸字符串，不是 JSON 文本。
    + `data: ${JSON.stringify({ body: "[DONE]" })}\n\n`
    + "event: finish\ndata: {}\n\n";
  const upstream = new Response(upstreamText, { headers: { "content-type": "text/event-stream" } });
  const response = await translateQoderResponse("anthropic", upstream, {
    model: "qoder-intl/m", tools: new Map(), stream: true,
  });
  const text = await readText(response);
  assert.match(text, /message_start/);
  assert.match(text, /排队后回答/);
  assert.match(text, /message_stop/);
});

/* ------------------------------- ZCode -------------------------------- */

test("ZCode chat 源：messages → anthropic 体，thinking 预算表生效", async () => {
  const { body, tools } = await translateZcodeRequest({
    model: "zcode/GLM-5.3",
    messages: [
      { role: "system", content: "服务提示" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    max_tokens: 4096,
    reasoning_effort: "high",
  }, "glm-5.3", "chat-completions");
  assert.equal(body.system, ZCODE_AGENT_SYSTEM_PROMPT, "官方提示词整体替换客户端 system 消息");
  const messages = body.messages as Array<Json>;
  // anthropic 形状：user → assistant(tool_use) → user(tool_result)；tool 结果并入 user。
  const assistant = messages[1]!;
  assert.equal(((assistant.content as Array<Json>)[0] as Json).type, "tool_use");
  assert.equal(((messages[2]!.content as Array<Json>)[0] as Json).type, "tool_result");
  assert.equal(body.max_tokens, 4096);
  assert.equal((body.thinking as Json).budget_tokens, 4096 - 1, "high 档 8192 被上限压缩");
  assert.equal(tools.size >= 1, true);
});

test("ZCode anthropic 源：原生 thinking 输入按服务能力校验", async () => {
  const { body } = await translateZcodeRequest({
    model: "zcode/GLM-5.3",
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }, "glm-5.3", "anthropic");
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2048 });
  await assert.rejects(() => translateZcodeRequest({
    model: "zcode/GLM-5.3",
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }, "glm-5.3", "anthropic"), /必须小于 max_tokens/);
});

test("ZCode anthropic 上游 → chat-completions 客户端流式渲染", async () => {
  const clientModel = "zcode/GLM-5.3";
  const upstream = anthropicSse([
    { type: "message_start", message: { id: "m1", model: "glm-5.3", usage: { input_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "跨协议回答" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);
  const response = await createZcodeClientResponse("chat-completions", upstream, {
    model: clientModel, tools: new Map(), stream: true,
  });
  const text = await readText(response);
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /跨协议回答/);
  assert.match(text, /\[DONE\]/);
});

test("ZCode anthropic 上游 → anthropic 客户端经 Responses 外壳同语义渲染", async () => {
  const clientModel = "zcode/GLM-5.3";
  const upstream = anthropicSse([
    { type: "message_start", message: { id: "m1", model: "glm-5.3", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "私有思考" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "回答" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
  const response = await createZcodeClientResponse("anthropic", upstream, {
    model: clientModel, tools: new Map(), stream: true,
  });
  const text = await readText(response);
  assert.match(text, /message_start/);
  assert.match(text, /thinking_delta/);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /message_stop/);
  void encoder;
  void encodeZcodeThinking;
});


/* ------------------------------ gemini 客户端源 ------------------------------ */

test("CodeBuddy gemini 源：contents 工具轮转换为 chat 上游体", async () => {
  const { body } = await translateCodebuddyRequest({
    contents: [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ functionCall: { name: "f", args: { a: 1 } } }] },
      { role: "user", parts: [{ functionResponse: { name: "f", response: "ok" } }] },
    ],
    systemInstruction: "sys",
    tools: [{ functionDeclarations: [{ name: "f", parametersJsonSchema: { type: "object" } }] }],
  }, "gpt-5.6-luna", "gemini");
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "system");
  const assistant = messages[2]!;
  assert.ok(Array.isArray(assistant.tool_calls));
  const tool = messages[3]!;
  assert.equal(tool.role, "tool");
  const callId = ((assistant.tool_calls as Array<Record<string, unknown>>)[0] as { id?: string })?.id;
  assert.equal(tool.tool_call_id, callId);
  assert.equal(tool.content, JSON.stringify("ok"));
});

test("ZCode gemini 源：generationConfig.maxOutputTokens 进入 anthropic 上限", async () => {
  const { body } = await translateZcodeRequest({
    contents: [{ role: "user", parts: [{ text: "你好" }] }],
    generationConfig: { maxOutputTokens: 77 },
  }, "glm-5.3", "gemini");
  assert.equal(body.max_tokens, 77);
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
  assert.equal(messages.length, 1);
});

test("Qoder gemini 源：转换为 chat 内层后仍进入私有信封布局", async () => {
  const { body } = await translateQoderRequest({
    contents: [{ role: "user", parts: [{ text: "你好" }] }],
    systemInstruction: "sys",
    generationConfig: { maxOutputTokens: 64 },
  }, "qfmodel", undefined, "gemini");
  // qoder 信封把模型与参数移入私有布局，chat 内层不带 model。
  assert.equal(body.model, undefined);
  assert.ok(Array.isArray(body.messages));
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "system");
  assert.deepEqual(body.parameters, { max_tokens: 64 });
});

test("AGY gemini 源：contents 归一为 responses 风格输入", async () => {
  const { wrapper } = await translateAgyRequest({
    contents: [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "f", response: "ok" } }] },
    ],
    systemInstruction: "sys",
  }, "gemini-3.8-flash", "gemini");
  assert.ok(JSON.stringify(wrapper).includes("hi"));
});


test("ZCode anthropic 源：同协议统一经桥接，消息/工具/选择消费转换结果", async () => {
  const source = {
    model: "zcode/glm-5.3",
    system: "SYS",
    max_tokens: 300,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
    tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "f" },
    stop_sequences: ["END"],
  };
  const snapshot = structuredClone(source);
  const { body, tools } = await translateZcodeRequest(source, "glm-5.3", "anthropic");
  assert.deepEqual(source, snapshot, "调用方原始请求必须保持不变");
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
  assert.equal(messages.length, 3);
  const assistant = messages[1]!;
  const blocks = assistant.content as Array<Record<string, unknown>>;
  assert.equal(blocks.filter((block) => block.type === "tool_use").length, 1);
  assert.equal(body.system, ZCODE_AGENT_SYSTEM_PROMPT, "官方提示词整体替换同协议客户端的顶层 system");
  assert.equal(body.max_tokens, 300);
  assert.deepEqual(body.stop_sequences, ["END"]);
  const choice = body.tool_choice as Record<string, unknown>;
  assert.equal(choice.type, "tool");
  assert.equal(tools.size, 1);
  assert.ok(tools.has("f"));
});
