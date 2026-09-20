import { createHash } from "node:crypto";
import { decodeCodebuddyReasoning } from "./wire.ts";

/**
 * Codex Responses → OpenAI Chat Completions 请求转换。
 *
 * llm-bridge 的 openaiResponsesToUniversal 会丢弃 instructions、parallel_tool_calls、
 * function_call 历史与 custom 工具（实测），因此这里按 ZCode request.ts 的严格风格
 * 手写全量转换：不支持的字段显式报 400，不支持的内置工具降级为系统旁白。
 */

export class CodebuddyRequestError extends Error {
  constructor(message: string) { super(message); this.name = "CodebuddyRequestError"; }
}

export interface CodebuddyToolIdentity {
  name: string;
  custom: boolean;
  namespace?: string;
}
export type CodebuddyToolMap = Map<string, CodebuddyToolIdentity>;

export interface CodebuddyTranslatedRequest {
  body: Record<string, unknown>;
  tools: CodebuddyToolMap;
  dropped: string[];
}

type ChatContentPart = Record<string, unknown>;
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  reasoning_content?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function fail(message: string): never { throw new CodebuddyRequestError(message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} 必须是字符串`);
  return value;
}
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${field} 必须是正整数`);
  return value;
}
function safeToolName(name: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  const base = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "tool_") || "tool";
  return `${base.slice(0, 48)}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

function imagePart(part: Record<string, unknown>): ChatContentPart {
  const source = part.image_url ?? part.url;
  const url = typeof source === "string" ? source : record(source) ? source.url : undefined;
  if (typeof url !== "string" || !url) fail("input_image 缺少 image_url");
  return { type: "image_url", image_url: { url } };
}

function contentParts(value: unknown, field: string): string | ChatContentPart[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) fail(`${field} 必须是字符串或内容数组`);
  const parts: ChatContentPart[] = [];
  for (const raw of value) {
    if (!record(raw)) fail(`${field} 包含无效内容块`);
    if (raw.type === "input_text" || raw.type === "output_text" || raw.type === "text") {
      parts.push({ type: "text", text: string(raw.text, `${field}.text`) });
    } else if (raw.type === "input_image" || raw.type === "image") {
      parts.push(imagePart(raw));
    } else {
      fail(`${field} 包含不支持的内容块类型 ${String(raw.type)}`);
    }
  }
  return parts;
}

/**
 * system/developer 消息只能进 Chat 的单一 system 文本，因此把文本块拼接成字符串。
 * 客户端（如 Codex Desktop）常把 developer 内容发成多个 input_text 块的数组，
 * 这仍然是纯文本；只有真正含图片等非文本块时才拒绝。
 */
function systemContent(value: unknown, field: string): string {
  const parts = contentParts(value, field);
  if (typeof parts === "string") return parts;
  return parts.map((part) => {
    if (part.type !== "text") fail(`${field}不支持图片等非文本内容块`);
    return part.text as string;
  }).join("\n\n");
}

function toolIdentity(rawName: unknown, rawNamespace?: unknown): { name: string; original: string; namespace?: string } {
  const original = string(rawName, "工具 name");
  if (!original) fail("工具 name 不能为空");
  const namespace = rawNamespace === undefined || rawNamespace === null ? undefined : string(rawNamespace, "工具 namespace");
  if (namespace === "") fail("工具 namespace 不能为空");
  const name = safeToolName(namespace === undefined ? original : JSON.stringify([namespace, original]));
  return { name, original, ...(namespace === undefined ? {} : { namespace }) };
}

const CUSTOM_TOOL_PARAMETERS = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false,
};

function callArguments(value: unknown, custom: boolean): string {
  if (custom) return JSON.stringify({ input: string(value, "custom_tool_call.input") });
  if (record(value)) return JSON.stringify(value);
  if (typeof value !== "string") fail("function_call 的 arguments 必须是 JSON 对象或 JSON 字符串");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!record(parsed)) fail("function_call 的 arguments 必须解码为 JSON 对象");
    return value;
  } catch (cause) {
    if (cause instanceof CodebuddyRequestError) throw cause;
    fail("function_call 的 arguments 不是有效 JSON 对象");
  }
}

interface ToolResultContent {
  /** 文本部分：进 OpenAI Chat 的 tool 消息（该角色只支持字符串）。 */
  text: string;
  /** 图片部分：OpenAI 的 tool 消息放不了多模态，提升到紧随其后的 user 消息再上传。 */
  images: ChatContentPart[];
}

function toolResult(value: unknown): ToolResultContent {
  if (typeof value === "string") return { text: value, images: [] };
  if (Array.isArray(value)) {
    const texts: string[] = [];
    const images: ChatContentPart[] = [];
    for (const part of value) {
      if (!record(part)) fail("function_call_output 包含无效内容块");
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        const text = string(part.text, "工具输出文本");
        if (text) texts.push(text);
      } else if (part.type === "input_image" || part.type === "image") {
        images.push(imagePart(part));
      } else {
        fail(`function_call_output 包含不支持的内容块类型 ${String(part.type)}`);
      }
    }
    return { text: texts.join(""), images };
  }
  return { text: JSON.stringify(value ?? null), images: [] };
}

function serverCallSummary(item: Record<string, unknown>): string {
  const action = record(item.action) ? item.action : {};
  const query = [action.query, action.url].find((field): field is string => typeof field === "string" && field.length > 0);
  const detail = query ? `（查询：${query}）` : "";
  return `[已省略服务器内置工具调用 ${String(item.type)}${detail}；本通道不支持该工具]`;
}

function legacyReasoningContent(item: Record<string, unknown>): string | undefined {
  if (typeof item.id !== "string" || !item.id.startsWith("item_")) return undefined;
  if (item.content !== undefined && item.content !== null) return undefined;
  if (!Array.isArray(item.summary)) return undefined;
  const parts: string[] = [];
  for (const raw of item.summary) {
    if (!record(raw) || raw.type !== "summary_text" || typeof raw.text !== "string") return undefined;
    parts.push(raw.text);
  }
  return parts.length ? parts.join("") : undefined;
}

function appendContent(current: ChatMessage["content"], next: ChatMessage["content"]): ChatMessage["content"] {
  if (current === "") return next;
  if (next === "") return current;
  const left = typeof current === "string" ? [{ type: "text", text: current }] : current;
  const right = typeof next === "string" ? [{ type: "text", text: next }] : next;
  return [...left, ...right];
}

function translateTools(value: unknown): { tools: Array<Record<string, unknown>>; map: CodebuddyToolMap; dropped: Set<string> } {
  const tools: Array<Record<string, unknown>> = [];
  const map: CodebuddyToolMap = new Map();
  const dropped = new Set<string>();
  function visit(entries: unknown, namespace?: string, description?: string): void {
    if (!Array.isArray(entries)) fail("tools 必须是数组");
    for (const raw of entries) {
      if (!record(raw)) fail("tools 包含无效声明");
      if (raw.type === "namespace") {
        if (namespace !== undefined) fail("namespace 内仅支持 function 或 custom 工具");
        const segment = string(raw.name, "namespace.name");
        if (!segment) fail("namespace.name 不能为空");
        visit(raw.tools, segment, typeof raw.description === "string" ? raw.description : undefined);
        continue;
      }
      if (raw.type === "web_search") {
        dropped.add("web_search");
        continue;
      }
      if (raw.type !== "function" && raw.type !== "custom") {
        dropped.add(typeof raw.type === "string" ? raw.type : "unknown");
        continue;
      }
      const identity = toolIdentity(raw.name, namespace);
      if (map.has(identity.name)) fail(`工具名映射冲突：${identity.original}`);
      const custom = raw.type === "custom";
      if (!custom && !record(raw.parameters)) fail(`function 工具 ${identity.original} 缺少对象 parameters`);
      const details = [description, typeof raw.description === "string" ? raw.description : undefined].filter((item) => item !== undefined);
      tools.push({
        type: "function",
        function: {
          name: identity.name,
          ...(details.length ? { description: details.join("\n\n") } : {}),
          parameters: custom ? CUSTOM_TOOL_PARAMETERS : raw.parameters,
        },
      });
      map.set(identity.name, { name: identity.original, custom, ...(namespace === undefined ? {} : { namespace }) });
    }
  }
  if (value !== undefined) visit(value);
  return { tools, map, dropped };
}

export function translateCodebuddyRequest(body: Record<string, unknown>, upstreamModel: string): CodebuddyTranslatedRequest {
  if (typeof upstreamModel !== "string" || !upstreamModel) fail("上游模型不能为空");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && body.previous_response_id !== "") {
    fail("CodeBuddy 不支持 previous_response_id；请提供完整 input 历史");
  }
  if (body.conversation !== undefined && body.conversation !== null && body.conversation !== "") {
    fail("CodeBuddy 不支持 conversation；请提供完整 input 历史");
  }
  if (body.background === true) fail("CodeBuddy 不支持 background 请求");
  for (const format of [body.response_format, record(body.text) ? body.text.format : undefined]) {
    if (format !== undefined && (!record(format) || format.type !== "text")) fail("CodeBuddy 不支持 Responses 的结构化输出格式");
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") fail("instructions 必须是字符串");
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") fail("parallel_tool_calls 必须是布尔值");

  const maxTokens = body.max_output_tokens === undefined ? 16384 : positiveInteger(body.max_output_tokens, "max_output_tokens");
  const convertedTools = translateTools(body.tools);
  const messages: ChatMessage[] = [];
  const system: string[] = [];
  const calls = new Map<string, "function_call" | "custom_tool_call">();
  const results = new Set<string>();
  const clientModel = typeof body.model === "string" ? body.model : upstreamModel;
  const replayReasoning = /deepseek/i.test(upstreamModel);
  let pendingReasoning: string | undefined;
  let activeAssistant: ChatMessage | undefined;

  const resetAssistantTurn = (): void => {
    pendingReasoning = undefined;
    activeAssistant = undefined;
  };
  const assistantMessage = (content: ChatMessage["content"]): ChatMessage => {
    if (activeAssistant && messages.at(-1) === activeAssistant) {
      activeAssistant.content = appendContent(activeAssistant.content, content);
      return activeAssistant;
    }
    const message: ChatMessage = {
      role: "assistant",
      content,
      ...(pendingReasoning === undefined ? {} : { reasoning_content: pendingReasoning }),
    };
    pendingReasoning = undefined;
    messages.push(message);
    activeAssistant = message;
    return message;
  };

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!record(item)) fail("input 包含非对象 history 项");
      if (item.type === "reasoning") {
        activeAssistant = undefined;
        if (!replayReasoning) continue;
        const preserved = decodeCodebuddyReasoning(item.encrypted_content, clientModel);
        // 兼容升级前由本适配器生成的 item_* 历史：旧版本把原始
        // reasoning_content 完整放进 summary；新响应优先使用模型绑定信封。
        const reasoning = item.encrypted_content === undefined || item.encrypted_content === null
          ? legacyReasoningContent(item)
          : preserved;
        if (reasoning !== undefined) pendingReasoning = `${pendingReasoning ?? ""}${reasoning}`;
        continue;
      }
      if (item.type === "message" || item.type === undefined) {
        if (item.role === "system" || item.role === "developer") {
          resetAssistantTurn();
          system.push(systemContent(item.content, `${item.role} 消息`));
          continue;
        }
        if (item.role !== "user" && item.role !== "assistant") fail(`不支持的消息 role ${String(item.role)}`);
        const content = contentParts(item.content, `${item.role} 消息`);
        if (item.role === "assistant") assistantMessage(content);
        else {
          resetAssistantTurn();
          messages.push({ role: "user", content });
        }
        continue;
      }
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const identity = toolIdentity(item.name, item.namespace);
        const custom = item.type === "custom_tool_call";
        const callId = string(item.call_id ?? item.id, `${item.type}.call_id`);
        if (calls.has(callId)) fail(`history 中重复的工具调用 ID ${callId}`);
        calls.set(callId, item.type);
        const message = assistantMessage("");
        (message.tool_calls ??= []).push({
          id: callId,
          type: "function",
          function: { name: identity.name, arguments: callArguments(custom ? item.input : item.arguments, custom) },
        });
        continue;
      }
      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        const callId = string(item.call_id, `${item.type}.call_id`);
        const callType = calls.get(callId);
        if (!callType || (item.type === "function_call_output") !== (callType === "function_call")) {
          fail(`${item.type} 未关联到同一 input 中匹配的工具调用 ${callId}`);
        }
        if (results.has(callId)) fail(`history 中重复的工具输出 ID ${callId}`);
        results.add(callId);
        resetAssistantTurn();
        const result = toolResult(item.output ?? item.content);
        messages.push({ role: "tool", tool_call_id: callId, content: result.text });
        // OpenAI Chat 的 tool 消息只能放字符串；图片块转成 image_url 后提到 user 消息上传，
        // 与 zcode 通道一致：tool 消息保持纯文本，图片走多模态消息。
        if (result.images.length) {
          messages.push({ role: "user", content: result.images });
        }
        continue;
      }
      if (typeof item.type === "string" && (item.type.endsWith("_call") || item.type === "mcp_list_tools" || item.type === "mcp_list_resources")) {
        // 其余服务器执行的历史调用无法在上游执行，降级为文本摘要。
        assistantMessage(serverCallSummary(item));
        activeAssistant = undefined;
        continue;
      }
      fail(`不支持的 Responses history 项类型 ${typeof item.type === "string" ? item.type : "unknown"}`);
    }
  } else {
    fail("input 必须是字符串或数组");
  }

  if (convertedTools.dropped.size) {
    // 剥离后必须告知模型，否则模型会声称拥有已被移除的能力。
    system.push(`本通道无法执行以下服务器内置工具，已从本请求移除：${[...convertedTools.dropped].join("、")}。请勿声称已使用这些工具。`);
  }
  if (system.length === 0 && body.instructions === undefined) {
    // 实测上游要求首条消息必须是 system prompt（空字符串即可）；无任何系统内容时
    // 注入空 system，不改变模型行为。
    system.push("");
  }

  const translated: Record<string, unknown> = {
    model: upstreamModel,
    // 上游始终走流式：非流式客户端由响应层聚合成完整 JSON（单一解析路径）。
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    messages: [
      ...(system.length ? [{ role: "system", content: [...(body.instructions ? [body.instructions] : []), ...system].join("\n\n") } as ChatMessage] : []),
      ...messages,
    ],
  };
  if (convertedTools.tools.length) translated.tools = convertedTools.tools;
  if (body.temperature !== undefined) translated.temperature = body.temperature;
  if (body.top_p !== undefined) translated.top_p = body.top_p;
  if (body.parallel_tool_calls !== undefined) translated.parallel_tool_calls = body.parallel_tool_calls;
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (choice === "auto" || choice === "none" || choice === "required") translated.tool_choice = choice;
    else if (record(choice) && (choice.type === "function" || choice.type === "custom")) {
      const identity = toolIdentity(choice.name, choice.namespace);
      if (!convertedTools.map.has(identity.name)) fail(`工具选择引用了未声明的工具 ${identity.original}`);
      translated.tool_choice = { type: "function", function: { name: identity.name } };
    } else if (record(choice) && typeof choice.type === "string" && choice.type !== "") {
      // 指向服务器内置工具的选择无法跨格式表达，省略让上游回到默认 auto。
    } else fail("不支持的 tool_choice");
  }
  if (body.reasoning !== undefined) {
    if (!record(body.reasoning)) fail("reasoning 必须是对象");
    const effort = body.reasoning.effort;
    if (effort !== undefined) {
      if (typeof effort !== "string") fail("reasoning.effort 必须是字符串");
      // effort 原样透传（档位与具体模型的默认档由服务端解析），none 表示不启用推理。
      if (effort !== "none") translated.reasoning_effort = effort;
    }
  }
  return { body: translated, tools: convertedTools.map, dropped: [...convertedTools.dropped] };
}
