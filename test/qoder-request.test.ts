import assert from "node:assert/strict";
import test from "./host-test.ts";
import { QoderRequestError, translateQoderRequest } from "@agent-proxy/qoder/request";
import { QODER_AGENT_SYSTEM_PROMPT } from "@agent-proxy/qoder/transport";

type Json = Record<string, unknown>;

test("Qoder 系统提示在顶层及首条消息保持一致，参数进入 parameters", async () => {
  const { body } = await translateQoderRequest({
    input: "你好", instructions: "请使用中文", max_output_tokens: 128,
    temperature: 0.2, reasoning: { effort: "low" }, parallel_tool_calls: false,
  }, "qfmodel");
  assert.equal(body.system, QODER_AGENT_SYSTEM_PROMPT, "官方 Qoder 提示词为 system 基底");
  assert.deepEqual((body.messages as Json[])[0], { role: "system", content: QODER_AGENT_SYSTEM_PROMPT });
  assert.ok(!JSON.stringify(body).includes("请使用中文"), "客户端 instructions 不进入上游");
  assert.deepEqual(body.parameters, { max_tokens: 128, temperature: 0.2, reasoning_effort: "low", parallel_tool_calls: false });
  assert.deepEqual(body.tools, []);
  assert.equal(body.model, undefined);
});

test("Qoder 客户端 developer 与 instructions 被官方提示词整体替换", async () => {
  const { body } = await translateQoderRequest({ input: [
    { role: "developer", content: [{ type: "input_text", text: "开发者规则" }] },
    { role: "user", content: "继续" },
  ], instructions: "系统规则" }, "qfmodel");
  assert.equal(body.system, QODER_AGENT_SYSTEM_PROMPT);
  assert.ok(!JSON.stringify(body).includes("系统规则") && !JSON.stringify(body).includes("开发者规则"));
  assert.deepEqual(((await translateQoderRequest({ input: "你好" }, "qfmodel")).body.messages as Json[])[0],
    { role: "system", content: QODER_AGENT_SYSTEM_PROMPT }, "无提示请求同样以官方提示词为基底");
});

test("Qoder 客户端 chat 源的 system 消息被官方提示词整体替换", async () => {
  const { body } = await translateQoderRequest({
    messages: [
      { role: "system", content: "You are Claude Code" },
      { role: "user", content: "你好" },
    ],
  }, "qfmodel", undefined, "chat-completions");
  assert.equal(body.system, QODER_AGENT_SYSTEM_PROMPT);
  const messages = body.messages as Json[];
  assert.deepEqual(messages[0], { role: "system", content: QODER_AGENT_SYSTEM_PROMPT });
  assert.ok(!JSON.stringify(body).includes("Claude Code"), "客户端 system 消息不进入上游");
});

test("Qoder 函数和 custom 工具声明及结果往返保持调用关联", async () => {
  const { body, tools } = await translateQoderRequest({
    input: [
      { role: "user", content: "读取文件" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
      { type: "function_call_output", call_id: "call_1", output: "文件内容" },
      { type: "custom_tool_call", call_id: "call_2", name: "patch", input: "补丁文本" },
      { type: "custom_tool_call_output", call_id: "call_2", output: "完成" },
    ],
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }, { type: "custom", name: "patch" }],
    tool_choice: { type: "function", name: "read" },
  }, "qfmodel");
  const messages = body.messages as Json[];
  assert.equal(messages[3]!.tool_call_id, "call_1");
  assert.deepEqual((messages[4]!.tool_calls as Json[])[0]!.function, { name: "patch", arguments: "{\"input\":\"补丁文本\"}" });
  assert.equal(messages[5]!.tool_call_id, "call_2");
  assert.deepEqual((body.parameters as Json).tool_choice, { type: "function", function: { name: "read" } });
  assert.equal(tools.get("patch")?.custom, true);
});

test("Qoder 不将未知服务器工具描述为可执行能力", async () => {
  const result = await translateQoderRequest({ input: "搜索", tools: [{ type: "web_search" }] }, "qfmodel");
  assert.deepEqual(result.dropped, ["web_search"]);
  assert.match(String(result.body.system), /无法执行.*web_search/);
});

test("Qoder 低中超高档位原样进入上游参数，未声明档位明确拒绝", async () => {
  const allowed = ["low", "medium", "xhigh"];
  for (const effort of allowed) {
    const request = await translateQoderRequest({ input: "你好", reasoning: { effort } }, "qfmodel", allowed);
    assert.equal((request.body.parameters as Json).reasoning_effort, effort);
  }
  for (const effort of ["high", "none", "max"]) {
    await assert.rejects(() => translateQoderRequest({ input: "你好", reasoning: { effort } }, "qfmodel", allowed), /不支持推理档位/);
  }
});

test("Qoder 拒绝无历史引用和孤立工具结果，错误明确标识 Qoder", async () => {
  for (const input of [
    { input: "你好", previous_response_id: "resp_missing" },
    { input: [{ type: "function_call_output", call_id: "unknown", output: "结果" }] },
    { input: "你好", max_output_tokens: -1 },
  ]) {
    await assert.rejects(() => translateQoderRequest(input, "qfmodel"), (error: unknown) => {
      assert.ok(error instanceof QoderRequestError);
      assert.doesNotMatch(error.message, /CodeBuddy/);
      return true;
    });
  }
});
