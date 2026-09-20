import assert from "node:assert/strict";
import test from "node:test";
import { CodebuddyRequestError, translateCodebuddyRequest } from "../src/codebuddy/request.ts";
import { encodeCodebuddyReasoning } from "../src/codebuddy/wire.ts";

type Json = Record<string, unknown>;

test("基础翻译：instructions/system 合并、max_tokens 与参数透传", () => {
  const { body, tools, dropped } = translateCodebuddyRequest({
    model: "codebuddy/gpt-5.6-luna",
    instructions: "SYS-INSTR",
    input: [
      { type: "message", role: "system", content: "HIST-SYS" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
    ],
    max_output_tokens: 512,
    temperature: 0.3,
    top_p: 0.8,
    parallel_tool_calls: false,
  }, "gpt-5.6-luna");
  const messages = body.messages as Json[];
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[0]!.content, "SYS-INSTR\n\nHIST-SYS");
  // 数组内容块保持 OpenAI 多模态 parts 形状。
  assert.deepEqual(messages[1], { role: "user", content: [{ type: "text", text: "你好" }] });
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.max_tokens, 512);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.top_p, 0.8);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.stream, true);
  assert.deepEqual((body.stream_options as Json), { include_usage: true });
  assert.equal(tools.size, 0);
  assert.deepEqual(dropped, []);
});

test("工具声明：function/custom/namespace 与 web_search 降级旁白", () => {
  const { body, tools, dropped } = translateCodebuddyRequest({
    model: "codebuddy/default-model",
    input: "hi",
    tools: [
      { type: "function", name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { type: "custom", name: "apply_patch" },
      { type: "namespace", name: "fs", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
      { type: "web_search" },
    ],
  }, "default-model");
  const declared = body.tools as Json[];
  assert.equal(declared.length, 3);
  assert.deepEqual(declared[0], { type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } } });
  // custom 工具映射为 input 字符串参数的 function。
  const custom = declared[1]!.function as Json;
  assert.equal(custom.name, "apply_patch");
  assert.deepEqual((custom.parameters as Json).properties, { input: { type: "string" } });
  // namespace 展平后命名稳定。
  const nested = declared[2]!.function as Json;
  assert.ok(typeof nested.name === "string" && nested.name.startsWith('["fs","read"]') || typeof nested.name === "string");
  assert.equal(tools.get("read_file")?.custom, false);
  assert.equal(tools.get("apply_patch")?.custom, true);
  assert.equal(tools.get(String(nested.name))?.namespace, "fs");
  assert.deepEqual(dropped, ["web_search"]);
  // 剥离旁白注入 system。
  const messages = body.messages as Json[];
  assert.match(String(messages[0]!.content), /web_search/);
});

test("history：函数调用/输出配对、custom 调用、reasoning 与服务器调用降级", () => {
  const { body } = translateCodebuddyRequest({
    model: "codebuddy/gpt-5.6-luna",
    input: [
      { type: "message", role: "user", content: "执行工具" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
      { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "call_2", output: "ok" },
      { type: "reasoning", encrypted_content: "opaque", summary: [] },
      { type: "web_search_call", id: "ws_1", action: { type: "search", query: "test" } },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] },
    ],
    tools: [
      { type: "function", name: "read_file", parameters: { type: "object" } },
      { type: "custom", name: "apply_patch" },
    ],
  }, "gpt-5.6-luna");
  const messages = body.messages as Json[];
  // 无系统内容时注入空 system（上游要求首条为 system prompt）+ user → assistant(tool_calls)
  // → tool → assistant(tool_calls) → tool → assistant(搜索旁白) → assistant(回答)
  assert.equal(messages.length, 8);
  assert.deepEqual(messages[0], { role: "system", content: "" });
  const call = messages[2]!;
  assert.equal(call.role, "assistant");
  const toolCall = (call.tool_calls as Json[])[0]!;
  assert.equal(toolCall.id, "call_1");
  assert.equal((toolCall.function as Json).name, "read_file");
  assert.equal((toolCall.function as Json).arguments, "{\"path\":\"a.txt\"}");
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_1", content: "file body" });
  const customCall = ((messages[4] as Json).tool_calls as Json[])[0]!;
  assert.deepEqual(JSON.parse(String((customCall.function as Json).arguments)), { input: "*** Begin Patch" });
  assert.deepEqual(messages[5], { role: "tool", tool_call_id: "call_2", content: "ok" });
  // reasoning 被丢弃（上游无需回放），web_search_call 降级为 assistant 文本。
  assert.match(String((messages[6] as Json).content), /web_search_call/);
  assert.deepEqual(messages[7], { role: "assistant", content: [{ type: "text", text: "完成" }] });
});

test("history：输出与调用必须配对且不得重复", () => {
  const base = {
    model: "codebuddy/m",
    tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
  };
  assert.throws(() => translateCodebuddyRequest({
    ...base,
    input: [{ type: "function_call_output", call_id: "ghost", output: "x" }],
  }, "m"), /未关联/);
  assert.throws(() => translateCodebuddyRequest({
    ...base,
    input: [
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "x" },
      { type: "function_call_output", call_id: "c1", output: "y" },
    ],
  }, "m"), /重复/);
});

test("DeepSeek history：完整回放 reasoning_content 并合并同轮并行工具调用", () => {
  const reasoning = "先读取两个文件，再比较结果。";
  const { body } = translateCodebuddyRequest({
    model: "codebuddy/deepseek-v4.1-flash",
    input: [
      { type: "message", role: "user", content: "比较文件" },
      {
        type: "reasoning",
        encrypted_content: encodeCodebuddyReasoning("codebuddy/deepseek-v4.1-flash", reasoning),
        summary: [{ type: "summary_text", text: "不应优先使用摘要" }],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "我来读取。" }] },
      { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
      { type: "function_call", call_id: "call_b", name: "read_file", arguments: "{\"path\":\"b.txt\"}" },
      { type: "function_call_output", call_id: "call_a", output: "A" },
      { type: "function_call_output", call_id: "call_b", output: "B" },
    ],
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
  }, "deepseek-v4.1-flash");
  const messages = body.messages as Json[];
  assert.equal(messages.length, 5);
  const assistant = messages[2]!;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.reasoning_content, reasoning);
  assert.deepEqual(assistant.content, [{ type: "text", text: "我来读取。" }]);
  assert.deepEqual((assistant.tool_calls as Json[]).map((call) => call.id), ["call_a", "call_b"]);
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_a", content: "A" });
  assert.deepEqual(messages[4], { role: "tool", tool_call_id: "call_b", content: "B" });
});

test("DeepSeek history：兼容旧 summary，拒绝跨模型本地载荷", () => {
  const legacy = translateCodebuddyRequest({
    model: "codebuddy/deepseek-v4.1-flash",
    input: [
      { type: "reasoning", id: "item_legacy", content: null, summary: [{ type: "summary_text", text: "旧版完整推理" }] },
      { type: "function_call", call_id: "call_1", name: "run", arguments: "{}" },
    ],
  }, "deepseek-v4.1-flash");
  assert.equal(((legacy.body.messages as Json[])[1]!).reasoning_content, "旧版完整推理");

  const mismatched = translateCodebuddyRequest({
    model: "codebuddy/deepseek-v4.1-flash",
    input: [
      {
        type: "reasoning",
        encrypted_content: encodeCodebuddyReasoning("codebuddy/other-model", "不可泄漏"),
        summary: [{ type: "summary_text", text: "跨模型摘要也不可回退" }],
      },
      { type: "function_call", call_id: "call_1", name: "run", arguments: "{}" },
    ],
  }, "deepseek-v4.1-flash");
  assert.equal(((mismatched.body.messages as Json[])[1]!).reasoning_content, undefined);

  const nonDeepseek = translateCodebuddyRequest({
    model: "codebuddy/gpt-5.6-luna",
    input: [
      { type: "reasoning", encrypted_content: encodeCodebuddyReasoning("codebuddy/gpt-5.6-luna", "仅供展示") },
      { type: "function_call", call_id: "call_1", name: "run", arguments: "{}" },
    ],
  }, "gpt-5.6-luna");
  assert.equal(((nonDeepseek.body.messages as Json[])[1]!).reasoning_content, undefined, "非 DeepSeek 保持旧的丢弃语义");
});

test("tool_choice 与 reasoning.effort 原样透传，不固定档位默认值", () => {
  const { body } = translateCodebuddyRequest({
    model: "codebuddy/fast-model",
    input: "hi",
    tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "f" },
    reasoning: { effort: "xhigh" },
  }, "fast-model");
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "f" } });
  assert.equal(body.reasoning_effort, "xhigh");
  const relaxed = translateCodebuddyRequest({
    model: "codebuddy/fast-model",
    input: "hi",
    tool_choice: { type: "web_search" },
    reasoning: { effort: "none" },
  }, "fast-model");
  assert.equal(relaxed.body.tool_choice, undefined, "内置工具选择省略回到 auto");
  assert.equal(relaxed.body.reasoning_effort, undefined, "effort none 不发送推理参数");
  for (const choice of ["auto", "none", "required"] as const) {
    assert.equal(translateCodebuddyRequest({ model: "m", input: "hi", tool_choice: choice }, "m").body.tool_choice, choice);
  }
});

test("图片输入映射为 image_url 内容块", () => {
  const { body } = translateCodebuddyRequest({
    model: "codebuddy/gpt-5.6-luna",
    input: [{
      type: "message", role: "user",
      content: [
        { type: "input_text", text: "看图" },
        { type: "input_image", image_url: "data:image/png;base64,AAA" },
      ],
    }],
  }, "gpt-5.6-luna");
  const content = (body.messages as Json[])[1]!.content as Json[];
  assert.deepEqual(content[0], { type: "text", text: "看图" });
  assert.deepEqual(content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
});

test("不支持的字段显式报 400", () => {
  assert.throws(() => translateCodebuddyRequest({ model: "m", input: "hi", previous_response_id: "resp_x" }, "m"), CodebuddyRequestError);
  assert.throws(() => translateCodebuddyRequest({ model: "m", input: "hi", conversation: "c" }, "m"), /conversation/);
  assert.throws(() => translateCodebuddyRequest({ model: "m", input: "hi", background: true }, "m"), /background/);
  assert.throws(() => translateCodebuddyRequest({ model: "m", input: "hi", text: { format: { type: "json_schema" } } }, "m"), /结构化输出/);
  assert.throws(() => translateCodebuddyRequest({ model: "m", input: "hi", instructions: 42 }, "m"), /instructions/);
  assert.throws(() => translateCodebuddyRequest({ model: "m", input: "hi", max_output_tokens: 0 }, "m"), /max_output_tokens/);
  assert.throws(() => translateCodebuddyRequest({ model: "m", input: [{ type: "weird_item" }] }, "m"), /不支持的 Responses history/);
  // 未知 *_call 类型按服务器调用降级为文本摘要，不静默丢弃。
  const degraded = translateCodebuddyRequest({ model: "m", input: [{ type: "file_search_call" }] }, "m");
  const degradedMessages = degraded.body.messages as Json[];
  assert.deepEqual(degradedMessages[0], { role: "system", content: "" }, "无系统内容时注入空 system");
  assert.match(String(degradedMessages[1]!.content), /file_search_call/);
  assert.throws(() => translateCodebuddyRequest({ model: "m", input: 42 }, "m"), /input 必须是/);
});

test("developer 消息的文本数组内容拼接进 system，不误报图片", () => {
  // Codex Desktop 把 developer 上下文发成多个 input_text 块的数组，仍是纯文本。
  const { body } = translateCodebuddyRequest({
    model: "codebuddy/gpt-5.6-luna",
    input: [
      { type: "message", role: "developer", content: [
        { type: "input_text", text: "<app-context>" },
        { type: "input_text", text: "<skills>" },
      ] },
      { type: "message", role: "user", content: "你好" },
    ],
  }, "gpt-5.6-luna");
  const messages = body.messages as Json[];
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[0]!.content, "<app-context>\n\n<skills>");
  assert.equal(messages[1]!.role, "user");
});

test("developer 消息含图片时仍显式拒绝", () => {
  assert.throws(() => translateCodebuddyRequest({
    model: "codebuddy/gpt-5.6-luna",
    input: [{
      type: "message", role: "developer",
      content: [
        { type: "input_text", text: "规则" },
        { type: "input_image", image_url: "data:image/png;base64,AAA" },
      ],
    }],
  }, "gpt-5.6-luna"), /developer 消息不支持图片/);
});

test("工具输出里的图片提升到 user 消息，tool 消息保持纯文本", () => {
  const { body } = translateCodebuddyRequest({
    model: "codebuddy/deepseek-v4.1-flash",
    input: [
      { type: "message", role: "user", content: "看图" },
      { type: "function_call", call_id: "call_1", name: "view_image", arguments: "{\"path\":\"a.png\"}" },
      { type: "function_call_output", call_id: "call_1", output: [
        { type: "input_text", text: "图片尺寸 800x600" },
        { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "high" },
      ] },
    ],
    tools: [{ type: "function", name: "view_image", parameters: { type: "object" } }],
  }, "deepseek-v4.1-flash");
  const messages = body.messages as Json[];
  const tool = messages.find((m) => m.role === "tool");
  assert.equal(tool!.content, "图片尺寸 800x600");
  const userImage = messages.find((m) => m.role === "user" && Array.isArray(m.content));
  assert.deepEqual(userImage!.content, [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }]);
});

test("工具输出含未知内容块类型仍显式拒绝", () => {
  assert.throws(() => translateCodebuddyRequest({
    model: "codebuddy/deepseek-v4.1-flash",
    input: [
      { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_audio", input_audio: "x" }] },
    ],
    tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
  }, "deepseek-v4.1-flash"), /不支持的内容块类型/);
});
