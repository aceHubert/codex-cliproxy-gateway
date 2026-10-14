import { BridgeConversionError, convertRequest } from "@agent-proxy/llm-bridge";
import type { ToolIdentityMap } from "@agent-proxy/llm-bridge";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import { decodeCodebuddyReasoning } from "./wire.ts";

/**
 * CodeBuddy/WorkBuddy 请求准备：标准转换统一走 @agent-proxy/llm-bridge 的
 * convertRequest（Responses/Chat Completions/Anthropic → Chat Completions），
 * 插件只负责服务合同——单一 system 消息、强制上游流式、DeepSeek reasoning 信封
 * 回放、服务器内置工具剥离旁白与工具结果图片提升。
 */

export class CodebuddyRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodebuddyRequestError";
  }
}

export type CodebuddyToolMap = ToolIdentityMap;

export interface CodebuddyTranslatedRequest {
  body: Record<string, unknown>;
  tools: CodebuddyToolMap;
  dropped: string[];
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never {
  throw new CodebuddyRequestError(message);
}

/** 服务约束：只对 Responses 源有意义（状态会话与结构化输出不支持）。 */
function validateResponsesServiceConstraints(body: Json): void {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && body.previous_response_id !== "") {
    fail("CodeBuddy 不支持 previous_response_id；请提供完整 input 历史");
  }
  if (body.conversation !== undefined && body.conversation !== null && body.conversation !== "") {
    fail("CodeBuddy 不支持 conversation；请提供完整 input 历史");
  }
  if (body.background === true) fail("CodeBuddy 不支持 background 请求");
  for (const format of [body.response_format, isRecord(body.text) ? body.text.format : undefined]) {
    if (format !== undefined && (!isRecord(format) || format.type !== "text")) fail("CodeBuddy 不支持 Responses 的结构化输出格式");
  }
}

/**
 * Responses 源的服务前处理：剥离服务器内置工具声明（bridge 只认 function/custom/
 * namespace）；工具结果中的图片块提升为紧随其后的 user 消息（OpenAI Chat 的 tool
 * 消息只支持字符串），保持与 zcode 通道一致的顺序语义。
 */
function preProcessResponses(body: Json): { body: Json; dropped: string[] } {
  const dropped: string[] = [];
  const tools = Array.isArray(body.tools) ? body.tools.filter((raw): raw is Json => {
    if (!isRecord(raw)) fail("tools 包含无效声明");
    const type = raw.type;
    if (type === "function" || type === "custom" || type === "namespace") return true;
    dropped.push(typeof type === "string" ? type : "unknown");
    return false;
  }) : body.tools;
  let input = Array.isArray(body.input) ? body.input : body.input;
  input = Array.isArray(input) ? narrateServerCalls(validateToolOutputs(hoistResponsesToolImages(input))) : input;
  return { body: { ...body, ...(tools === body.tools ? {} : { tools }), ...(input === body.input ? {} : { input }) }, dropped };
}

/** 工具输出只允许文本/图片块；未知类型显式拒绝而不是静默丢弃。 */
function validateToolOutputs(items: unknown[]): unknown[] {
  for (const item of items) {
    if (!isRecord(item) || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) continue;
    const output = item.output ?? item.content;
    if (!Array.isArray(output)) continue;
    for (const part of output) {
      if (!isRecord(part)) fail("function_call_output 包含无效内容块");
      if (part.type !== "input_text" && part.type !== "output_text" && part.type !== "text" && part.type !== "input_image" && part.type !== "image") {
        fail(`function_call_output 包含不支持的内容块类型 ${String(part.type)}`);
      }
      if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text !== "string") {
        fail("工具输出文本必须是字符串");
      }
    }
  }
  return items;
}

/** 无法在上游执行的服务器调用历史降级为 assistant 文本旁白（保持位置）。 */
function narrateServerCalls(items: unknown[]): unknown[] {
  let changed = false;
  const result = items.map((item) => {
    if (!isRecord(item) || typeof item.type !== "string") return item;
    if (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "function_call_output" || item.type === "custom_tool_call_output") return item;
    if (!item.type.endsWith("_call") && item.type !== "mcp_list_tools" && item.type !== "mcp_list_resources") return item;
    changed = true;
    const action = isRecord(item.action) ? item.action : {};
    const query = [action.query, action.url].find((field): field is string => typeof field === "string" && field.length > 0);
    const detail = query ? `（查询：${query}）` : "";
    return { type: "message", role: "assistant", content: `[已省略服务器内置工具调用 ${item.type}${detail}；本通道不支持该工具]` };
  });
  return changed ? result : items;
}

function hoistResponsesToolImages(items: unknown[]): unknown[] {
  const result: unknown[] = [];
  let hoisted = false;
  for (const item of items) {
    if (isRecord(item) && (item.type === "function_call_output" || item.type === "custom_tool_call_output")) {
      const output = item.output;
      if (Array.isArray(output)) {
        const texts: unknown[] = [];
        const images: unknown[] = [];
        for (const part of output) {
          if (!isRecord(part)) continue;
          if (part.type === "input_image" || part.type === "image") images.push(part);
          else texts.push(part);
        }
        if (images.length > 0) {
          hoisted = true;
          result.push({ ...item, output: texts });
          result.push({ type: "message", role: "user", content: images });
          continue;
        }
      }
    }
    result.push(item);
  }
  return hoisted ? result : items;
}

/** Anthropic 源：tool_result 块中的图片同样提升到紧随其后的 user 消息。 */
function preProcessAnthropic(body: Json): Json {
  if (!Array.isArray(body.messages)) return body;
  let hoisted = false;
  const messages: unknown[] = [];
  for (const raw of body.messages) {
    if (!isRecord(raw) || !Array.isArray(raw.content)) {
      messages.push(raw);
      continue;
    }
    let hasImageResult = false;
    for (const block of raw.content) {
      if (isRecord(block) && block.type === "tool_result" && Array.isArray(block.content)
        && block.content.some((entry) => isRecord(entry) && entry.type === "image")) {
        hasImageResult = true;
        break;
      }
    }
    if (!hasImageResult) {
      messages.push(raw);
      continue;
    }
    hoisted = true;
    const kept: unknown[] = [];
    const images: unknown[] = [];
    for (const block of raw.content) {
      if (isRecord(block) && block.type === "tool_result" && Array.isArray(block.content)) {
        const textParts: unknown[] = [];
        for (const entry of block.content) {
          if (isRecord(entry) && entry.type === "image") {
            images.push({ type: "image", source: entry.source });
          } else {
            textParts.push(entry);
          }
        }
        kept.push({ ...block, content: textParts });
      } else {
        kept.push(block);
      }
    }
    messages.push({ ...raw, content: kept });
    if (images.length > 0) messages.push({ role: "user", content: images });
  }
  return hoisted ? { ...body, messages } : body;
}

/** Chat 源：tool 消息内容数组中的 image_url 提升到紧随其后的 user 消息。 */
function preProcessChat(body: Json): Json {
  if (!Array.isArray(body.messages)) return body;
  let hoisted = false;
  const messages: unknown[] = [];
  for (const raw of body.messages) {
    if (!isRecord(raw) || raw.role !== "tool" || !Array.isArray(raw.content)) {
      messages.push(raw);
      continue;
    }
    const texts: unknown[] = [];
    const images: unknown[] = [];
    for (const part of raw.content) {
      if (isRecord(part) && part.type === "image_url") images.push(part);
      else texts.push(part);
    }
    if (images.length === 0) {
      messages.push(raw);
      continue;
    }
    hoisted = true;
    const text = texts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
    messages.push({ ...raw, content: text });
    messages.push({ role: "user", content: images });
  }
  return hoisted ? { ...body, messages } : body;
}

/**
 * DeepSeek reasoning 信封回放：把本适配器生成的 encrypted_content 解码回
 * reasoning_content，附着到其后首条 assistant 消息（与 main 的 pendingReasoning
 * 语义一致）。非 DeepSeek 模型的 reasoning 条目由桥接剥离。
 */
function replayReasoningEnvelope(sourceBody: Json, converted: Json, clientModel: string, replay: boolean): void {
  if (!replay) return;
  const reasoningTexts: string[] = [];
  const legacyTexts: string[] = [];
  const collect = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item) || item.type !== "reasoning") continue;
      const decoded = decodeCodebuddyReasoning(item.encrypted_content, clientModel);
      if (decoded !== undefined) {
        reasoningTexts.push(decoded);
        continue;
      }
      if (item.encrypted_content === undefined || item.encrypted_content === null) {
        // 兼容升级前的 item_* 历史形状：原始 reasoning_content 完整放在 summary。
        if (Array.isArray(item.summary)) {
          const parts: string[] = [];
          let valid = true;
          for (const raw of item.summary) {
            if (isRecord(raw) && raw.type === "summary_text" && typeof raw.text === "string") parts.push(raw.text);
            else valid = false;
          }
          if (valid && parts.length > 0) legacyTexts.push(parts.join(""));
        }
      }
    }
  };
  collect(sourceBody.input);
  const queue = [...reasoningTexts, ...legacyTexts];
  if (queue.length === 0) return;
  const messages = converted.messages as Json[];
  if (!Array.isArray(messages)) return;
  let pending = queue.shift();
  for (const message of messages) {
    if (message.role !== "assistant" || pending === undefined) continue;
    if (message.reasoning_content !== undefined) continue;
    message.reasoning_content = pending;
    pending = queue.shift();
  }
}

export function translateCodebuddyRequest(body: Json, upstreamModel: string, from: ClientProtocol = "responses"): CodebuddyTranslatedRequest {
  if (typeof upstreamModel !== "string" || !upstreamModel) fail("上游模型不能为空");
  let prepared = body;
  let dropped: string[] = [];
  if (from === "responses") {
    validateResponsesServiceConstraints(body);
    const pre = preProcessResponses(body);
    prepared = pre.body;
    dropped = pre.dropped;
  } else if (from === "anthropic") {
    prepared = preProcessAnthropic(body);
  } else {
    prepared = preProcessChat(body);
  }

  const clientModel = typeof body.model === "string" && body.model ? body.model : upstreamModel;
  const replay = /deepseek/i.test(upstreamModel);
  let converted: ReturnType<typeof convertRequest>;
  try {
    converted = convertRequest(from, "chat-completions", prepared, { model: upstreamModel });
  } catch (error: unknown) {
    if (error instanceof BridgeConversionError) throw new CodebuddyRequestError(error.message);
    throw error;
  }
  // 只把「工具声明」剥离计入旁白；reasoning history 项等服务类剥离不生成工具旁白。
  dropped = [...dropped, ...converted.notes
    .filter((note) => note.startsWith("已剥离内置工具声明") || note.startsWith("已剥离工具声明"))
    .map((note) => note.replace(/^已剥离(?:内置工具声明|工具声明)?\s*/, "").split("（")[0]!.trim())]
    .filter((entry) => entry.length > 0 && entry !== "unknown");
  replayReasoningEnvelope(body, converted.body, clientModel, replay && from === "responses");

  const messages = converted.body.messages as Json[];
  const systemParts: string[] = [];
  if (dropped.length > 0) {
    // 剥离后必须告知模型，否则模型会声称拥有已被移除的能力。
    systemParts.push(`本通道无法执行以下服务器内置工具，已从本请求移除：${dropped.join("、")}。请勿声称已使用这些工具。`);
  }
  let patchedMessages = messages;
  if (messages.length > 0 && messages[0]?.role === "system" && systemParts.length > 0) {
    patchedMessages = [{ ...messages[0]!, content: `${messages[0]!.content ?? ""}\n\n${systemParts.join("\n\n")}`.replace(/^\n\n/, "") }, ...messages.slice(1)];
  } else if (systemParts.length > 0) {
    patchedMessages = [{ role: "system", content: systemParts.join("\n\n") }, ...messages];
  } else if (messages.length === 0 || messages[0]?.role !== "system") {
    // 实测上游要求首条消息必须是 system prompt（空字符串即可）。
    patchedMessages = [{ role: "system", content: "" }, ...messages];
  }

  const translated: Json = {
    ...converted.body,
    // 上游始终走流式：非流式客户端由响应层聚合成完整 JSON（单一解析路径）。
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: converted.body.max_tokens ?? converted.body.max_completion_tokens ?? 16384,
    messages: patchedMessages,
  };
  delete translated.max_completion_tokens;
  return { body: translated, tools: converted.tools, dropped };
}
