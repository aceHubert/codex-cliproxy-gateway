import assert from "node:assert/strict";
import test from "node:test";
import { stripClientSystemPrompt } from "@agent-proxy/llm-bridge";

type Json = Record<string, unknown>;

test("responses 源剥离 instructions 与 input 中的 system/developer 消息", () => {
  const body: Json = {
    model: "m",
    instructions: "You are Codex",
    input: [
      { type: "message", role: "developer", content: "官方 Codex 模板渲染出的首条 developer 消息" },
      { type: "message", role: "system", content: "系统规则" },
      { type: "message", role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { type: "function_call", name: "f", call_id: "c1", arguments: "{}" },
    ],
  };
  const snapshot = structuredClone(body);
  const result = stripClientSystemPrompt("responses", body);
  assert.deepEqual(body, snapshot, "调用方原始请求保持不变");
  assert.notEqual(result, body, "返回剥离后的新对象");
  assert.equal("instructions" in result, false);
  const input = result.input as Json[];
  assert.deepEqual(input.map((item) => item.role ?? item.type), ["user", "assistant", "function_call"]);
});

test("responses 源的字符串 input 与非消息项原样保留", () => {
  const body: Json = { model: "m", instructions: "p", input: "hello" };
  const result = stripClientSystemPrompt("responses", body);
  assert.equal(result.input, "hello");
  assert.equal("instructions" in result, false);
});

test("chat-completions 源剥离 system/developer 消息并保留其余消息", () => {
  const body: Json = {
    model: "m",
    messages: [
      { role: "system", content: "You are a helper" },
      { role: "developer", content: "dev rules" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  };
  const result = stripClientSystemPrompt("chat-completions", body);
  assert.deepEqual((result.messages as Json[]).map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(body.messages as Json[], [
    { role: "system", content: "You are a helper" },
    { role: "developer", content: "dev rules" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ], "调用方原始请求保持不变");
});

test("anthropic 源剥离顶层 system（字符串与块数组两种形态）", () => {
  const textForm: Json = { model: "m", system: "You are Claude Code", messages: [{ role: "user", content: "hi" }] };
  const strippedText = stripClientSystemPrompt("anthropic", textForm);
  assert.equal("system" in strippedText, false);
  assert.equal((strippedText.messages as Json[]).length, 1, "user 消息不受影响");
  assert.equal(textForm.system, "You are Claude Code", "调用方原始请求保持不变");

  const blocksForm: Json = { system: [{ type: "text", text: "规则" }], messages: [] };
  assert.equal("system" in stripClientSystemPrompt("anthropic", blocksForm), false);
});

test("gemini 源剥离 systemInstruction（字符串与 parts 两种形态）", () => {
  const textForm: Json = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  textForm.systemInstruction = "You are Gemini";
  assert.equal("systemInstruction" in stripClientSystemPrompt("gemini", textForm), false);
  assert.equal(textForm.systemInstruction, "You are Gemini", "调用方原始请求保持不变");

  const partsForm: Json = { contents: [], systemInstruction: { parts: [{ text: "规则" }] } };
  assert.equal("systemInstruction" in stripClientSystemPrompt("gemini", partsForm), false);
});

test("形状异常的请求体不抛错，交由后续标准转换校验", () => {
  const odd: Json = { input: 42, messages: "not-array" };
  assert.equal((stripClientSystemPrompt("responses", odd) as Json).input, 42);
  assert.equal(stripClientSystemPrompt("chat-completions", odd).messages, "not-array");
  assert.equal("system" in stripClientSystemPrompt("anthropic", odd), false);
  assert.equal("systemInstruction" in stripClientSystemPrompt("gemini", odd), false);
});
