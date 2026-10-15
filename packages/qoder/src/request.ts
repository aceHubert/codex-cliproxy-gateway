import { BridgeConversionError, convertRequest } from "@agent-proxy/llm-bridge";
import type { ToolIdentityMap } from "@agent-proxy/llm-bridge";
import type { ClientProtocol } from "@agent-proxy/plugin-api";

/**
 * Qoder 请求准备：标准转换统一走 @agent-proxy/llm-bridge（四种客户端来源 →
 * Chat Completions 风格内层），本模块只负责 Qoder 私有 infer 信封的消息/参数布局
 * 与推理档位校验。不再依赖 CodeBuddy 适配器；codebuddy-reasoning-v1 旧信封按
 * 只读兼容处理。
 */

export class QoderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QoderRequestError";
  }
}

export interface QoderTranslatedRequest {
  /** 推理封套的消息字段；业务标识和模型配置由传输层添加。 */
  body: Record<string, unknown>;
  tools: ToolIdentityMap;
  dropped: string[];
}

type Json = Record<string, unknown>;

const CODEBUDDY_REASONING_PREFIX = "codebuddy-reasoning-v1:";

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 旧 codebuddy-reasoning-v1 信封只读解码；跨模型或损坏载荷返回 undefined。 */
function decodeLegacyReasoning(value: unknown, model: string): string | undefined {
  if (typeof value !== "string" || !value.startsWith(CODEBUDDY_REASONING_PREFIX)) return undefined;
  try {
    const data: unknown = JSON.parse(Buffer.from(value.slice(CODEBUDDY_REASONING_PREFIX.length), "base64").toString("utf8"));
    if (!isRecord(data) || data.model !== model || typeof data.reasoningContent !== "string") return undefined;
    return data.reasoningContent;
  } catch {
    return undefined;
  }
}

function legacySummaryText(item: Json): string | undefined {
  if (item.encrypted_content !== undefined && item.encrypted_content !== null) return undefined;
  if (!Array.isArray(item.summary)) return undefined;
  const parts: string[] = [];
  for (const raw of item.summary) {
    if (!isRecord(raw) || raw.type !== "summary_text" || typeof raw.text !== "string") return undefined;
    parts.push(raw.text);
  }
  return parts.length ? parts.join("") : undefined;
}

export async function translateQoderRequest(
  input: Json,
  modelKey: string,
  allowedEfforts?: string[],
  to: ClientProtocol = "responses",
): Promise<QoderTranslatedRequest> {
  const reasoning = input.reasoning;
  if (allowedEfforts && isRecord(reasoning)) {
    const effort = reasoning.effort;
    if (typeof effort === "string" && !allowedEfforts.includes(effort)) {
      throw new QoderRequestError(`Qoder 当前模型不支持推理档位 ${effort}，请从模型目录的可用档位选择`);
    }
  }
  const replay = /deepseek/i.test(modelKey);
  let converted;
  try {
    converted = await convertRequest("chat-completions", to, input, { model: modelKey });
  } catch (error) {
    if (error instanceof BridgeConversionError) throw new QoderRequestError(error.message);
    throw error;
  }

  // Qoder 服务要求首条消息为 system 且与顶层 system 一致；通用转换已把 instructions/
  // developer 合并为首条 system（C1 修复），无系统内容时补空。messages 缺失或非数组
  // 属于桥接合同破坏，给出可读错误而不是在 unshift 上抛 TypeError。
  const messages = Array.isArray(converted.body.messages) ? converted.body.messages as Json[] : (() => { throw new QoderRequestError("chat 目标请求体缺少 messages 数组"); })();
  if (messages[0]?.role !== "system") {
    messages.unshift({ role: "system", content: "" });
  }
  // 旧 codebuddy-reasoning-v1 信封按只读兼容回放到其后首条 assistant 消息。
  if (replay && to === "responses" && Array.isArray(input.input)) {
    const clientModel = typeof input.model === "string" && input.model ? input.model : modelKey;
    const queue: string[] = [];
    for (const item of input.input) {
      if (!isRecord(item) || item.type !== "reasoning") continue;
      const decoded = decodeLegacyReasoning(item.encrypted_content, clientModel) ?? legacySummaryText(item);
      if (decoded !== undefined) queue.push(decoded);
    }
    let pending = queue.shift();
    for (const message of messages) {
      if (message.role !== "assistant" || pending === undefined) continue;
      if (message.reasoning_content === undefined) {
        message.reasoning_content = pending;
        pending = queue.shift();
      }
    }
  }
  const parameters: Json = {};
  for (const field of ["max_tokens", "temperature", "top_p", "reasoning_effort", "tool_choice", "parallel_tool_calls"]) {
    if (converted.body[field] !== undefined) parameters[field] = converted.body[field];
  }
  // 被剥离的服务器内置工具来自桥接结构化字段，不解析 notes 文案。
  const dropped = converted.strippedTools.filter((entry) => entry.length > 0 && entry !== "unknown");
  if (dropped.length > 0 && typeof messages[0]!.content === "string") {
    messages[0]!.content = `${messages[0]!.content}\n\n本通道无法执行以下服务器内置工具，已从本请求移除：${dropped.join("、")}。请勿声称已使用这些工具。`.replace(/^\n\n/, "");
  }
  return {
    body: {
      system: messages[0]!.content,
      messages,
      tools: converted.body.tools ?? [],
      parameters,
    },
    tools: converted.tools,
    dropped,
  };
}
