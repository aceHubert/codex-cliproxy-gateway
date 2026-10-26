import type { ClientProtocol } from "@agent-proxy/plugin-api";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Responses input 的 history 项是否为 system/developer 消息。客户端系统提示词
 * 的实际载体：Codex 按 model_messages.instructions_template 渲染后以首条
 * developer 消息发出，body 反而没有 instructions 字段，两类载体都要剥。
 */
function isResponsesSystemItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (item.type !== undefined && item.type !== "message") return false;
  return item.role === "system" || item.role === "developer";
}

function isChatSystemMessage(message: unknown): boolean {
  return isRecord(message) && (message.role === "system" || message.role === "developer");
}

function omitField(body: Json, field: string): Json {
  if (!(field in body)) return body;
  const copy = { ...body };
  delete copy[field];
  return copy;
}

/**
 * 客户端系统提示词剥离：转换层官方 agent 提示词注入（整体替换语义）的第一步。
 * 按客户端入口协议返回剥离全部系统级内容的新请求体——responses 的 instructions
 * 与 input 中的 system/developer 消息、chat-completions 的 system/developer
 * 消息、anthropic 的顶层 system、gemini 的 systemInstruction。尽力剥离：形状
 * 异常的条目不做处理，交由后续标准转换校验报错，本函数不抛错，调用方原始对象
 * 保持不变。调用方随后把官方 agent 提示词种入上游系统槽，网关旁白拼在其后。
 */
export function stripClientSystemPrompt(protocol: ClientProtocol, body: Json): Json {
  if (protocol === "responses") {
    const base = omitField(body, "instructions");
    if (Array.isArray(body.input) && body.input.some(isResponsesSystemItem)) {
      return { ...base, input: body.input.filter((item) => !isResponsesSystemItem(item)) };
    }
    return base;
  }
  if (protocol === "chat-completions") {
    if (!Array.isArray(body.messages) || !body.messages.some(isChatSystemMessage)) return body;
    return { ...body, messages: body.messages.filter((message) => !isChatSystemMessage(message)) };
  }
  if (protocol === "anthropic") return omitField(body, "system");
  return omitField(body, "systemInstruction");
}
