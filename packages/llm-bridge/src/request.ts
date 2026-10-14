/**
 * 统一请求转换 convertRequest(from, to, body, options)。
 *
 * 以 npm llm-bridge 2.0.1 为底座：跨协议方向先做源协议最小规范化，再调用库的
 * Universal 转换，最后只针对已实测证明的缺口（L1–L6、C1/C2 与 anthropic 工具轮
 * 配对、assistant 工具内容污染）补齐结果；from === to 时结构化克隆直通，不执行
 * 任何厂商政策。工具身份（custom / namespace 安全名）在声明、调用历史与 named
 * tool_choice 间共用同一映射，映射表随结果返回供响应侧还原。
 */

import { createHash } from "node:crypto";
import {
  anthropicToUniversal,
  openaiToUniversal,
  openaiResponsesToUniversal,
  universalToAnthropic,
  universalToGoogle,
  universalToOpenAI,
  universalToOpenaiResponses,
} from "llm-bridge";
import type { UniversalBody, UniversalContent, UniversalMessage, UniversalTool } from "llm-bridge";
import {
  BridgeConversionError,
  type BridgeProtocol,
  type ConvertRequestOptions,
  type ConvertRequestResult,
  type ToolIdentity,
  type ToolIdentityMap,
} from "./types.ts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never {
  throw new BridgeConversionError(message);
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) fail(`${field} 必须是非空字符串`);
  return value;
}
function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${field} 必须是正整数`);
  return value;
}
function safeJsonParse(value: string, field: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (!isRecord(parsed)) fail(`${field} 必须解码为 JSON 对象`);
    return parsed;
  } catch (error) {
    if (error instanceof BridgeConversionError) throw error;
    fail(`${field} 不是有效 JSON 对象`);
  }
}

/** 内置可逆安全名映射：与 main 适配器的 safeToolName 等价（折叠非法字符 + 哈希后缀）。 */
function defaultSafeToolName(name: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  const base = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "tool_") || "tool";
  return `${base.slice(0, 48)}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

const CUSTOM_TOOL_PARAMETERS: Json = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false,
};

/* ============================== 工具身份注册表 ============================== */

class ToolRegistry {
  readonly map: ToolIdentityMap = new Map();
  constructor(
    private readonly notes: string[],
    private readonly nameMapper: ConvertRequestOptions["mapToolName"],
  ) {}

  mapName(name: string, namespace?: string): string {
    if (this.nameMapper) {
      const mapped = this.nameMapper({ name, namespace });
      if (typeof mapped !== "string" || !mapped) fail("mapToolName 必须返回非空字符串");
      return mapped;
    }
    return defaultSafeToolName(namespace === undefined ? name : JSON.stringify([namespace, name]));
  }

  register(original: string, namespace: string | undefined, custom: boolean): string {
    const mapped = this.mapName(original, namespace);
    const existing = this.map.get(mapped);
    if (existing && (existing.name !== original || existing.namespace !== namespace)) {
      fail(`工具名映射冲突：${original}`);
    }
    this.map.set(mapped, { name: original, custom, ...(namespace === undefined ? {} : { namespace }) });
    return mapped;
  }

  /** 按原始身份（name + namespace）反查映射名。 */
  mappedFor(name: string, namespace?: string): string | undefined {
    for (const [mapped, identity] of this.map) {
      if (identity.name === name && identity.namespace === namespace) return mapped;
    }
    return undefined;
  }

  note(message: string): void {
    this.notes.push(message);
  }
}

/* ============================ Responses 源规范化 ============================ */

interface ToolDeclaration {
  mapped: string;
  custom: boolean;
  parameters: Json;
  strict?: boolean;
  description: string;
  raw: Json;
  namespace?: string;
}

/** 收集 Responses 工具声明（function/custom/namespace 展平），注册身份并返回声明表。 */
function collectResponsesTools(source: Json, registry: ToolRegistry): ToolDeclaration[] {
  const declarations: ToolDeclaration[] = [];
  const visit = (entries: unknown, namespace?: string, namespaceDescription?: string): void => {
    if (entries === undefined) return;
    if (!Array.isArray(entries)) fail("tools 必须是数组");
    for (const raw of entries) {
      if (!isRecord(raw)) fail("tools 包含无效声明");
      if (raw.type === "namespace") {
        if (namespace !== undefined) fail("namespace 内仅支持 function 或 custom 工具");
        const segment = requiredString(raw.name, "namespace.name");
        visit(raw.tools, segment, typeof raw.description === "string" ? raw.description : namespaceDescription);
        continue;
      }
      if (raw.type !== "function" && raw.type !== "custom") {
        registry.note(`已剥离内置工具声明 ${String(raw.type)}（服务器内置工具由插件前处理决定回放或降级）`);
        continue;
      }
      const custom = raw.type === "custom";
      const original = requiredString(raw.name, "工具 name");
      const mapped = registry.register(original, namespace, custom);
      if (!custom && !isRecord(raw.parameters)) fail(`function 工具 ${original} 缺少对象 parameters`);
      const details = [namespaceDescription, typeof raw.description === "string" ? raw.description : undefined]
        .filter((entry): entry is string => entry !== undefined);
      declarations.push({
        mapped,
        custom,
        parameters: custom ? CUSTOM_TOOL_PARAMETERS : (raw.parameters as Json),
        strict: typeof raw.strict === "boolean" ? raw.strict : undefined,
        description: details.join("\n\n"),
        raw,
        namespace,
      });
    }
  };
  visit(source.tools);
  return declarations;
}

/** 工具输出内容 → 文本；结构化块合并为可读文本而不是 JSON.stringify 整个数组。 */
/** Responses 消息内容 → Universal 内容；覆盖库对 output_text 等类型的 JSON.stringify 兜底。 */
function buildResponsesMessageContent(content: unknown, field: string): { content: UniversalContent[]; wasArray: boolean } {
  if (typeof content === "string") {
    return { content: [{ type: "text", text: content }], wasArray: false };
  }
  if (!Array.isArray(content)) fail(`${field} 必须是字符串或内容数组`);
  const parts: UniversalContent[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) fail(`${field} 包含无效内容块`);
    if (raw.type === "input_text" || raw.type === "output_text" || raw.type === "text" || raw.type === "summary_text") {
      if (typeof raw.text !== "string") fail(`${field}.text 必须是字符串`);
      parts.push({ type: "text", text: raw.text });
    } else if (raw.type === "input_image" || raw.type === "image") {
      const source = raw.image_url ?? raw.url;
      const url = typeof source === "string" ? source : isRecord(source) && typeof source.url === "string" ? source.url : undefined;
      if (!url) fail("input_image 缺少 image_url");
      const dataMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
      const detail = isRecord(source) && (source.detail === "auto" || source.detail === "high" || source.detail === "low") ? source.detail : undefined;
      parts.push({
        type: "image",
        media: dataMatch
          ? { mimeType: dataMatch[1], data: dataMatch[2], ...(detail ? { detail } : {}) }
          : { url, ...(detail ? { detail } : {}) },
      });
    } else if (raw.type === "input_audio" && isRecord(raw.input_audio)) {
      parts.push({ type: "audio", media: { data: typeof raw.input_audio.data === "string" ? raw.input_audio.data : "", mimeType: `audio/${typeof raw.input_audio.format === "string" ? raw.input_audio.format : "wav"}` } });
    } else {
      fail(`${field} 包含不支持的内容块类型 ${String(raw.type)}`);
    }
  }
  return { content: parts, wasArray: true };
}

function responsesToolResultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const part of output) {
      if (isRecord(part) && (part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    return texts.join("");
  }
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}

/**
 * Responses 源 → Universal。库转换文本 / 图片 / 音频 / system 消息与基础参数；
 * 以下缺口按实测补齐：字符串 input 字段丢失（L1）、function_call 历史变空 user
 * 消息（L2）、instructions / parallel_tool_calls 不进通用体、custom / namespace
 * 声明被静默剥离（C2/C3）。
 */
function responsesSourceToUniversal(body: Json, registry: ToolRegistry): UniversalBody {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && body.previous_response_id !== "") {
    fail("桥接转换是无状态的：previous_response_id 需要完整 input 历史");
  }
  const input = body.input;
  const items: unknown[] = typeof input === "string"
    ? [{ type: "message", role: "user", content: input }]
    : asArray(input);
  if (input !== undefined && !Array.isArray(input) && typeof input !== "string") fail("input 必须是字符串或数组");

  // 仅做字符串 input 的数组化；instructions / 工具 / 历史在补齐阶段统一处理。
  const sanitizedSource: Json = { ...body, input: items };
  delete sanitizedSource.tools;
  const universal: UniversalBody = openaiResponsesToUniversal(sanitizedSource as never);
  const declarations = collectResponsesTools(body, registry);
  const declarationByKey = new Map<string, ToolDeclaration>();
  for (const declaration of declarations) {
    declarationByKey.set(JSON.stringify([declaration.namespace ?? null, registry.map.get(declaration.mapped)!.name]), declaration);
  }

  const systemTexts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions) systemTexts.push(body.instructions);
  else if (body.instructions !== undefined && typeof body.instructions !== "string") fail("instructions 必须是字符串");

  const messages: UniversalMessage[] = [];
  const callsSeen = new Set<string>();
  const resultsSeen = new Set<string>();
  const libraryMessage = (index: number): UniversalMessage | undefined =>
    universal.messages.find((message) => message.metadata.originalIndex === index);

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!isRecord(item)) fail("Responses input 包含非对象 history 项");
    const type = typeof item.type === "string" ? item.type : "message";
    if (type === "message" || type === undefined) {
      const role = item.role;
      if (role === "system" || role === "developer") {
        // system/developer 只允许文本块（图片等无法进入系统提示）；文本以 \n\n 连接。
        if (Array.isArray(item.content)) {
          const parts: string[] = [];
          for (const part of item.content) {
            if (!isRecord(part)) fail(`${role} 消息包含无效内容块`);
            if (part.type !== "input_text" && part.type !== "output_text" && part.type !== "text" && part.type !== "summary_text") {
              fail(`${role} 消息不支持非文本内容块（图片等）`);
            }
            if (typeof part.text !== "string") fail(`${role} 消息文本必须是字符串`);
            parts.push(part.text);
          }
          if (parts.length > 0) systemTexts.push(parts.join("\n\n"));
        } else if (typeof item.content === "string" && item.content) {
          systemTexts.push(item.content);
        }
        continue;
      }
      if (role !== "user" && role !== "assistant") fail(`不支持的消息 role ${String(role)}`);
      const rebuilt = buildResponsesMessageContent(item.content, `${role} 消息`);
      const previous = messages.at(-1);
      if (role === "assistant" && previous?.role === "assistant" && previous.content.some((entry) => entry.type === "tool_call")) {
        // 与 main 同一轮次语义：带调用的 assistant 轮次内追加文本。
        previous.content.push(...rebuilt.content);
        previous.metadata = { ...previous.metadata, content_was_array: previous.metadata.content_was_array || rebuilt.wasArray };
      } else {
        messages.push({
          id: `msg_${index}`,
          role,
          content: rebuilt.content,
          metadata: { provider: "openai-responses", originalIndex: index, content_was_array: rebuilt.wasArray },
        });
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const custom = type === "custom_tool_call";
      const originalName = requiredString(item.name, `${type}.name`);
      const namespace = item.namespace === undefined || item.namespace === null ? undefined : requiredString(item.namespace, `${type}.namespace`);
      const declaration = declarationByKey.get(JSON.stringify([namespace ?? null, originalName]));
      // 历史调用不要求本次请求重新声明（客户端可能已结束该工具的轮次，压缩后的
      // 声明类型也可能变化）；身份按需注册，仅按名称与命名空间关联。
      const mapped = declaration ? declaration.mapped : registry.register(originalName, namespace, custom);
      const callId = requiredString(item.call_id ?? item.id, `${type}.call_id`);
      if (callsSeen.has(callId)) fail(`history 中重复的工具调用 ID ${callId}`);
      callsSeen.add(callId);
      const rawArguments = custom ? item.input : item.arguments;
      if (custom && typeof rawArguments !== "string") fail("custom_tool_call.input 必须是字符串");
      const argumentsText = custom
        ? JSON.stringify({ input: rawArguments as string })
        : typeof rawArguments === "string"
          ? rawArguments
          : isRecord(rawArguments)
            ? JSON.stringify(rawArguments)
            : fail(`${type} 的 arguments 必须是 JSON 对象或 JSON 字符串`);
      if (!custom) safeJsonParse(argumentsText, `${type}.arguments`);
      const content: UniversalContent = {
        type: "tool_call",
        tool_call: {
          id: callId,
          name: mapped,
          arguments: custom ? safeJsonParse(argumentsText, `${type}.input`) : safeJsonParse(argumentsText, `${type}.arguments`),
          metadata: { custom, source_arguments: argumentsText },
        },
      };
      // 与 main 适配器同一轮次语义：相邻 assistant 消息（文本/调用）合并为一条，
      // 只有 user / 工具输出 / 系统内容会结束当前 assistant 轮次。
      const previous = messages.at(-1);
      if (previous && previous.role === "assistant") {
        previous.content.push(content);
      } else {
        messages.push({
          id: `msg_${index}`,
          role: "assistant",
          content: [content],
          metadata: { provider: "openai-responses", originalIndex: index },
        });
      }
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = requiredString(item.call_id, `${type}.call_id`);
      if (!callsSeen.has(callId)) fail(`${type} 未关联到同一 input 中匹配的工具调用 ${callId}`);
      if (resultsSeen.has(callId)) fail(`history 中重复的工具输出 ID ${callId}`);
      resultsSeen.add(callId);
      messages.push({
        id: `msg_${index}`,
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_result: {
              tool_call_id: callId,
              name: "",
              result: responsesToolResultText(item.output ?? item.content),
              // 结构化内容（含图片）保留在元数据中：anthropic 目标可原样表达，
              // chat 等目标按各自合同降级。
              metadata: { content: Array.isArray(item.output) ? item.output : undefined },
            },
          },
        ],
        metadata: { provider: "openai-responses", originalIndex: index, tool_call_id: callId },
      });
      continue;
    }
    if (type === "reasoning" || type.endsWith("_call") || type === "mcp_list_tools" || type === "mcp_list_resources") {
      // reasoning 信封与服务器内置工具调用是插件政策层输入；桥接默认剥离并显式记录。
      registry.note(`已剥离 ${type} history 项（插件前处理负责回放或降级）`);
      continue;
    }
    fail(`不支持的 Responses history 项类型 ${type}`);
  }

  universal.messages = messages;
  if (systemTexts.length > 0) universal.system = systemTexts.join("\n\n");
  else delete universal.system;

  // 工具声明：库只保留 type === "function" 并丢弃 custom / namespace / strict（C2）。
  const tools: UniversalTool[] = declarations.map((declaration) => ({
    name: declaration.mapped,
    description: declaration.description,
    parameters: declaration.parameters,
    metadata: { custom: declaration.custom, strict: declaration.strict },
    _original: { provider: "openai-responses", raw: declaration.raw },
  }));
  if (tools.length > 0) universal.tools = tools;
  else delete universal.tools;

  const maxTokens = positiveInteger(body.max_output_tokens, "max_output_tokens");
  if (maxTokens !== undefined) universal.max_tokens = maxTokens;

  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") fail("parallel_tool_calls 必须是布尔值");
    universal.provider_params = { ...(universal.provider_params ?? {}), parallel_tool_calls: body.parallel_tool_calls };
  }
  delete (universal as { reasoning_effort?: unknown }).reasoning_effort;
  if (isRecord(body.reasoning)) {
    const effort = body.reasoning.effort;
    if (effort !== undefined) {
      if (typeof effort !== "string") fail("reasoning.effort 必须是字符串");
      if (effort !== "none") (universal as { reasoning_effort?: string }).reasoning_effort = effort;
    }
    if (body.reasoning.summary !== undefined) {
      universal.provider_params = { ...(universal.provider_params ?? {}), reasoning_summary: body.reasoning.summary };
    }
  }
  // effort → thinking 预算是各服务合同（如 ZCode 的预算表），桥接只保留 effort 语义。
  delete universal.thinking;

  applyResponsesToolChoice(universal, body.tool_choice, declarationByKey, registry);
  return universal;
}

function applyResponsesToolChoice(
  universal: UniversalBody,
  value: unknown,
  declarationByKey: Map<string, ToolDeclaration>,
  registry: ToolRegistry,
): void {
  if (value === undefined) return;
  // 库会把任意形状的 tool_choice 原样透传进通用体；先清除再按合同回填。
  delete universal.tool_choice;
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") {
      universal.tool_choice = value;
      return;
    }
    fail(`不支持的 tool_choice ${value}`);
  }
  if (!isRecord(value)) fail("不支持的 tool_choice");
  if (value.type === "function" || value.type === "custom") {
    const name = requiredString(value.name, "tool_choice.name");
    const namespace = value.namespace === undefined || value.namespace === null ? undefined : requiredString(value.namespace, "tool_choice.namespace");
    const declaration = declarationByKey.get(JSON.stringify([namespace ?? null, name]));
    if (!declaration) fail(`工具选择引用了未声明的工具 ${name}`);
    if (declaration.custom !== (value.type === "custom")) fail("tool_choice 与工具声明类型不一致");
    universal.tool_choice = { name: declaration.mapped };
    return;
  }
  if (typeof value.type === "string" && value.type !== "") {
    // 指向服务器内置工具的选择跨协议不可表达：显式回退 auto 并记录。
    registry.note(`tool_choice ${String(value.type)} 指向内置工具，跨协议目标回退为 auto`);
    return;
  }
  fail("不支持的 tool_choice");
}

/* ========================= Chat Completions 源规范化 ========================= */

function chatSourceToUniversal(body: Json, registry: ToolRegistry): UniversalBody {
  if (!Array.isArray(body.messages)) fail("messages 必须是数组");
  const maxCompletion = positiveInteger(body.max_completion_tokens, "max_completion_tokens");
  const maxTokens = positiveInteger(body.max_tokens, "max_tokens");
  if (maxCompletion !== undefined && maxTokens !== undefined && maxCompletion !== maxTokens) {
    fail("max_tokens 与 max_completion_tokens 同时提供时必须一致");
  }
  if (body.n !== undefined && body.n !== 1) fail("跨协议转换仅支持 n = 1");

  // 库只读取第一条 system 消息、丢弃其余；这里先合并为一条（保留顺序）。
  const messages = asArray(body.messages);
  if (messages.some((entry) => isRecord(entry) && entry.role === "system")) {
    const merged: unknown[] = [];
    const systemTexts: string[] = [];
    for (const message of messages) {
      if (isRecord(message) && message.role === "system") {
        if (typeof message.content === "string") systemTexts.push(message.content);
        else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (isRecord(part) && part.type === "text" && typeof part.text === "string") systemTexts.push(part.text);
          }
        }
      } else merged.push(message);
    }
    if (systemTexts.length > 0) merged.unshift({ role: "system", content: systemTexts.join("\n\n") });
    body = { ...body, messages: merged };
  }

  const sanitized: Json = { ...body };
  delete sanitized.tools;
  const universal: UniversalBody = openaiToUniversal(sanitized as never);

  // 调用历史中的 function.name 是客户端原始名：与声明共用同一身份映射改写，
  // 保证上游看到的声明、历史、named choice 三处一致（L4 身份合同）。
  for (const message of universal.messages) {
    for (const call of message.tool_calls ?? []) {
      const mapped = registry.mappedFor(call.name) ?? registry.register(call.name, undefined, false);
      call.name = mapped;
    }
  }

  // L5：库在 tool.function.description 上直接崩溃；先校验类型，custom 以可逆
  // {input:string} 参数降级为 function 声明。
  const tools: UniversalTool[] = [];
  for (const raw of asArray(body.tools)) {
    if (!isRecord(raw)) fail("tools 包含无效声明");
    if (raw.type !== "function" && raw.type !== "custom") {
      registry.note(`已剥离工具声明 ${String(raw.type)}（目标协议不可表达）`);
      continue;
    }
    const custom = raw.type === "custom";
    const original = requiredString(custom ? raw.name : isRecord(raw.function) ? raw.function.name : undefined, "工具 name");
    const mapped = registry.register(original, undefined, custom);
    const description = custom
      ? (typeof raw.description === "string" ? raw.description : "")
      : isRecord(raw.function) && typeof raw.function.description === "string" ? raw.function.description : "";
    const strict = !custom && isRecord(raw.function) && raw.function.strict === true ? true : undefined;
    tools.push({
      name: mapped,
      description,
      parameters: custom ? CUSTOM_TOOL_PARAMETERS : isRecord(raw.function) && isRecord(raw.function.parameters) ? (raw.function.parameters as Json) : { type: "object", properties: {} },
      metadata: { custom, strict },
      _original: { provider: "openai", raw },
    });
  }
  if (tools.length > 0) universal.tools = tools;
  else delete universal.tools;

  const choice = body.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === "string") {
      if (choice === "auto" || choice === "none" || choice === "required") universal.tool_choice = choice;
      else fail(`不支持的 tool_choice ${choice}`);
    } else if (isRecord(choice) && choice.type === "function" && isRecord(choice.function)) {
      const name = requiredString(choice.function.name, "tool_choice.function.name");
      const mapped = registry.mappedFor(name);
      if (!mapped) fail(`工具选择引用了未声明的工具 ${name}`);
      universal.tool_choice = { name: mapped };
    } else if (isRecord(choice) && typeof choice.type === "string" && choice.type !== "") {
      registry.note(`tool_choice ${String(choice.type)} 跨协议不可表达，目标回退为 auto`);
    } else {
      fail("不支持的 tool_choice");
    }
  }

  if (body.stop !== undefined) {
    const stop = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (stop.some((entry) => typeof entry !== "string")) fail("stop 必须是字符串或字符串数组");
    universal.provider_params = { ...(universal.provider_params ?? {}), stop_sequences: stop as string[] };
  }
  const limit = maxCompletion ?? maxTokens;
  if (limit !== undefined) universal.max_tokens = limit;
  return universal;
}

/* ============================ Anthropic 源规范化 ============================ */

/**
 * Anthropic 源跨协议不可表达字段的显式能力记录（不伪装为文本、不静默丢失）：
 * thinking/redacted_thinking 块及其 signature、内容块与 system 上的 cache_control。
 * anthropic 目标走同协议直通，不经过本函数。
 */
function recordAnthropicLosses(body: Json, registry: ToolRegistry): void {
  let thinkingBlocks = 0;
  let signatures = 0;
  let cacheMarks = 0;
  const scanBlocks = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const raw of blocks) {
      if (!isRecord(raw)) continue;
      if (raw.type === "thinking" || raw.type === "redacted_thinking") {
        thinkingBlocks++;
        if (typeof raw.signature === "string" && raw.signature) signatures++;
      }
      if (raw.cache_control !== undefined) cacheMarks++;
    }
  };
  for (const message of asArray(body.messages)) {
    if (!isRecord(message)) continue;
    scanBlocks(message.content);
  }
  if (Array.isArray(body.system)) {
    for (const part of body.system) {
      if (isRecord(part) && part.cache_control !== undefined) cacheMarks++;
    }
  }
  if (thinkingBlocks > 0) {
    registry.note(`Anthropic thinking 块跨协议目标不可表达，已丢弃 ${thinkingBlocks} 个块${signatures > 0 ? `（含 ${signatures} 个 signature）` : ""}`);
  }
  if (cacheMarks > 0) {
    registry.note(`Anthropic cache_control 提示跨协议目标没有对应字段，已丢弃 ${cacheMarks} 处标记`);
  }
}

function anthropicSourceToUniversal(body: Json, registry: ToolRegistry): UniversalBody {
  if (!Array.isArray(body.messages)) fail("messages 必须是数组");
  recordAnthropicLosses(body, registry);
  const sanitized: Json = { ...body };
  delete sanitized.tools;
  const universal: UniversalBody = anthropicToUniversal(sanitized as never);

  // 调用历史中的 tool_use.name 与声明共用同一身份映射改写（同 chat 源的三处一致合同）。
  for (const message of universal.messages) {
    for (const content of message.content) {
      if (content.type === "tool_call" && content.tool_call) {
        const mapped = registry.mappedFor(content.tool_call.name) ?? registry.register(content.tool_call.name, undefined, false);
        content.tool_call.name = mapped;
      }
    }
  }

  // 工具声明：input_schema → 同一身份映射（custom / 内置工具在此协议不存在）。
  const tools: UniversalTool[] = [];
  for (const raw of asArray(body.tools)) {
    if (!isRecord(raw)) fail("tools 包含无效声明");
    const type = typeof raw.type === "string" ? raw.type : "custom";
    if (type !== "custom" && type !== "function") {
      registry.note(`已剥离 Anthropic 服务器工具 ${type}（跨协议不可表达）`);
      continue;
    }
    const custom = type === "custom";
    const original = requiredString(raw.name, "工具 name");
    const mapped = registry.register(original, undefined, custom);
    const schema = isRecord(raw.input_schema) ? (raw.input_schema as Json) : undefined;
    tools.push({
      name: mapped,
      description: typeof raw.description === "string" ? raw.description : "",
      parameters: custom || !schema ? CUSTOM_TOOL_PARAMETERS : schema,
      metadata: { custom },
      _original: { provider: "anthropic", raw },
    });
  }
  if (tools.length > 0) universal.tools = tools;
  else delete universal.tools;

  // tool_choice：库把 "any" 原样透传（chat 目标非法）；disable_parallel_tool_use 收敛为 parallel = false。
  const choice = body.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === "string") {
      if (choice === "auto" || choice === "none") universal.tool_choice = choice;
      else if (choice === "any") universal.tool_choice = "required";
      else fail(`不支持的 Anthropic tool_choice ${choice}`);
    } else if (isRecord(choice)) {
      const type = choice.type;
      if (type === "tool" && typeof choice.name === "string") {
        const mapped = registry.mappedFor(choice.name);
        if (!mapped) fail(`工具选择引用了未声明的工具 ${choice.name}`);
        universal.tool_choice = { name: mapped };
      } else if (type === "auto" || type === "any") {
        universal.tool_choice = type === "any" ? "required" : "auto";
      } else if (type === "none") {
        universal.tool_choice = "none";
      } else {
        fail(`不支持的 Anthropic tool_choice 类型 ${String(type)}`);
      }
      if (choice.disable_parallel_tool_use === true) {
        universal.provider_params = { ...(universal.provider_params ?? {}), parallel_tool_calls: false };
      }
    } else {
      fail("不支持的 tool_choice");
    }
  }

  // 工具结果：库把块数组原样放在 result；跨协议目标需要纯文本，图片部分记录降级。
  for (const message of universal.messages) {
    for (const content of message.content) {
      if (content.type === "tool_result" && content.tool_result && Array.isArray(content.tool_result.result)) {
        const blocks = content.tool_result.result as unknown[];
        const texts: string[] = [];
        let droppedImages = 0;
        for (const block of blocks) {
          if (isRecord(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);
          else if (isRecord(block) && block.type === "image") droppedImages++;
        }
        if (droppedImages > 0) registry.note(`工具结果 ${String(content.tool_result.tool_call_id)} 含 ${droppedImages} 个图片块，跨协议目标无法在 tool 消息中表达`);
        content.tool_result.result = texts.join("");
      }
    }
  }

  const maxTokens = positiveInteger(body.max_tokens, "max_tokens");
  if (maxTokens !== undefined) universal.max_tokens = maxTokens;
  return universal;
}

/* ================================ 目标投影 ================================ */

function stripUndefined(body: Json): Json {
  const result: Json = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

/** 递归删除 undefined 值的键（库输出常带 strict: undefined 之类的显式空键）。 */
function deepStripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepStripUndefined);
  if (isRecord(value)) {
    const result: Json = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      result[key] = deepStripUndefined(entry);
    }
    return result;
  }
  return value;
}

/** assistant 工具调用消息的 content 污染修复：有文本取文本，否则置 null。 */
function fixChatToolCallContent(body: Json): void {
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue;
    if (Array.isArray(message.content)) {
      const texts = message.content
        .filter((entry) => isRecord(entry) && entry.type === "text")
        .map((entry) => String((entry as Json).text ?? ""));
      const text = texts.join("");
      message.content = text === "" ? null : text;
    } else if (typeof message.content === "string" && message.content === "") {
      message.content = null;
    }
  }
}

function emitChatTarget(universal: UniversalBody, registry: ToolRegistry, stopSequences: string[] | undefined): Json {
  const prepared = structuredClone(universal);
  for (const message of prepared.messages) {
    // 内容中的 tool_call 条目提升到 msg.tool_calls：emitter 对顶层 tool_calls 走
    // 干净路径（content 置 null），留在内容里则会变成 JSON 字符串文本污染。
    const contentCalls = message.content.filter((entry) => entry.type === "tool_call" && entry.tool_call);
    if (contentCalls.length > 0) {
      message.tool_calls = [
        ...(message.tool_calls ?? []),
        ...contentCalls.map((entry) => entry.tool_call!),
      ];
      message.content = message.content.filter((entry) => entry.type !== "tool_call");
    }
    // anthropic 源的 tool_result 在 user 消息内；chat 目标必须是 role "tool" +
    // tool_call_id（库不重排角色，导致孤立输出）。
    if (message.role === "user") {
      const results = message.content.filter((entry) => entry.type === "tool_result" && entry.tool_result);
      if (results.length > 0 && results.length === message.content.length) {
        message.role = "tool";
        message.metadata = { ...message.metadata, tool_call_id: results[0]!.tool_result!.tool_call_id };
      }
    }
  }
  const body = universalToOpenAI(prepared as never) as unknown as Json;
  fixChatToolCallContent(body);
  // 内容形状保形：源为数组内容的消息在 chat 目标保持内容块数组。
  const chatMessages = Array.isArray(body.messages) ? body.messages : [];
  const offset = universal.system ? 1 : 0;
  prepared.messages.forEach((message, index) => {
    if (message.metadata?.content_was_array !== true) return;
    const emitted = chatMessages[offset + index];
    if (isRecord(emitted) && typeof emitted.content === "string" && message.role !== "system") {
      emitted.content = emitted.content === "" ? [] : [{ type: "text", text: emitted.content }];
    }
  });
  if (stopSequences !== undefined && stopSequences.length > 0) body.stop = stopSequences;
  if (isRecord(body.tool_choice) && typeof body.tool_choice.name === "string") {
    const mapped = body.tool_choice.name;
    const identity = registry.map.get(mapped);
    body.tool_choice = { type: "function", function: { name: mapped } };
    if (identity?.custom === true) registry.note(`named tool_choice ${identity.name} 为 custom 工具，chat 目标以 function 形状表达`);
  }
  return deepStripUndefined(stripUndefined(body)) as Json;
}

function emitAnthropicTarget(universal: UniversalBody, registry: ToolRegistry, stopSequences: string[] | undefined): Json {
  const prepared = structuredClone(universal);
  // 收集带结构化内容的 tool_result（anthropic 目标可表达文本+图片块）。
  const structuredResults: Array<unknown[] | undefined> = [];
  for (const message of prepared.messages) {
    // 通用 tool 角色在 anthropic 必须是 user 消息内的 tool_result 块。
    if (message.role === "tool") message.role = "user";
    for (const content of message.content) {
      if (content.type === "tool_result") {
        structuredResults.push(Array.isArray(content.tool_result?.metadata?.content) ? content.tool_result?.metadata?.content as unknown[] : undefined);
      }
    }
  }
  const body = universalToAnthropic(prepared as never) as unknown as Json;
  // 还原 tool_result 的结构化内容块（文本 + 图片）。
  let structuredIndex = 0;
  for (const rawMessage of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(rawMessage) || !Array.isArray(rawMessage.content)) continue;
    for (const rawBlock of rawMessage.content) {
      if (!isRecord(rawBlock) || rawBlock.type !== "tool_result") continue;
      const parts = structuredResults[structuredIndex++];
      if (!parts) continue;
      const blocks: Json[] = [];
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "input_image" || part.type === "image") {
          const source = part.image_url ?? part.url;
          const url = typeof source === "string" ? source : isRecord(source) ? source.url : undefined;
          if (typeof url !== "string" || !url) continue;
          const dataMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
          blocks.push(dataMatch
            ? { type: "image", source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] } }
            : { type: "image", source: { type: "url", url } });
        }
      }
      if (blocks.length > 0) rawBlock.content = blocks;
    }
  }
  const choice = universal.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === "string") {
      body.tool_choice = choice === "required" ? { type: "any" } : { type: choice };
    } else if (isRecord(choice) && typeof choice.name === "string") {
      body.tool_choice = { type: "tool", name: choice.name };
    }
  }
  if (universal.provider_params?.parallel_tool_calls === false) {
    const current = isRecord(body.tool_choice) ? body.tool_choice : { type: "auto" };
    if (current.type !== "none") body.tool_choice = { ...current, disable_parallel_tool_use: true };
  }
  if (stopSequences !== undefined && stopSequences.length > 0) body.stop_sequences = stopSequences;
  if (universal.max_tokens === undefined) {
    body.max_tokens = 1024;
    registry.note("源请求未指定 token 上限；anthropic 目标要求 max_tokens，已用 1024 占位，插件可覆盖服务默认值");
  }
  if (universal.structured_output) {
    registry.note("结构化输出在 anthropic 目标没有对应字段，已丢弃（json_schema/json_object）");
  }
  // thinking 预算是服务合同（插件决定）；桥接不因 effort 自动启用。
  delete body.thinking;
  return stripUndefined(body);
}

function emitGoogleTarget(universal: UniversalBody, registry: ToolRegistry, stopSequences: string[] | undefined): Json {
  const body = universalToGoogle(universal as never) as unknown as Json;
  if (stopSequences !== undefined && stopSequences.length > 0) {
    const generationConfig = isRecord(body.generationConfig) ? body.generationConfig : {};
    generationConfig.stopSequences = stopSequences;
    body.generationConfig = generationConfig;
  }
  const choice = universal.tool_choice;
  if (isRecord(choice) && typeof choice.name === "string" && isRecord(body.toolConfig) && isRecord(body.toolConfig.functionCallingConfig)) {
    body.toolConfig.functionCallingConfig.mode = "ANY";
    body.toolConfig.functionCallingConfig.allowedFunctionNames = [choice.name];
  }
  if (universal.reasoning_effort !== undefined && !universal.thinking?.enabled) {
    registry.note("reasoning effort 在 gemini 目标未映射 thinkingLevel（预算/档位由插件按服务合同设置）");
  }
  return stripUndefined(body);
}

/** Responses 目标：库输出为基座，重建 input 条目序列以补 function_call 历史（L3）。 */
function emitResponsesTarget(universal: UniversalBody, registry: ToolRegistry): Json {
  const prepared = structuredClone(universal);
  for (const message of prepared.messages) {
    if (message.role !== "assistant") continue;
    // chat 源的工具调用在 msg.tool_calls（顶层）；统一提升为内容条目后按序重建
    // function_call items（库的 responses 输出会跳过它们，L3）。
    for (const call of message.tool_calls ?? []) {
      message.content.push({
        type: "tool_call",
        tool_call: {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          metadata: { custom: false, source_arguments: JSON.stringify(call.arguments ?? {}) },
        },
      });
    }
    message.tool_calls = undefined;
  }
  const base = universalToOpenaiResponses(prepared as never) as unknown as Json;
  const input: unknown[] = [];
  if (prepared.system) {
    const systemContent = typeof prepared.system === "string" ? prepared.system : prepared.system.content;
    if (systemContent) input.push({ role: "system", content: systemContent });
  }
  for (const message of prepared.messages) {
    const toolResults = message.content.filter((entry) => entry.type === "tool_result");
    const others = message.content.filter((entry) => entry.type !== "tool_result");
    for (const result of toolResults) {
      if (!result.tool_result) continue;
      input.push({
        type: "function_call_output",
        call_id: result.tool_result.tool_call_id,
        output: typeof result.tool_result.result === "string" ? result.tool_result.result : JSON.stringify(result.tool_result.result ?? ""),
      });
    }
    const parts: Json[] = [];
    const functionCalls: Array<{ id: string; name: string; arguments: string }> = [];
    const customCalls: Array<{ id: string; name: string; input: string }> = [];
    for (const content of others) {
      if (content.type === "text" && content.text) {
        parts.push({ type: "input_text", text: content.text });
      } else if (content.type === "image") {
        if (content.media?.url) {
          parts.push({ type: "input_image", image_url: content.media.url, ...(content.media.detail ? { detail: content.media.detail } : {}) });
        } else if (content.media?.data) {
          parts.push({ type: "input_image", image_url: `data:${content.media.mimeType || "image/jpeg"};base64,${content.media.data}` });
        }
      } else if (content.type === "audio" && content.media?.data) {
        parts.push({ type: "input_audio", input_audio: { data: content.media.data, format: content.media.mimeType?.split("/")[1] || "wav" } });
      } else if (content.type === "tool_call" && content.tool_call) {
        const custom = content.tool_call.metadata?.custom === true;
        const identity = registry.map.get(content.tool_call.name);
        // 历史项与声明、named choice 一致使用映射名；上游看到的名字三处统一，
        // 客户端可见的原始名由响应侧身份表还原（L4 身份合同）。
        const argumentsText = typeof content.tool_call.metadata?.source_arguments === "string"
          ? (content.tool_call.metadata.source_arguments as string)
          : JSON.stringify(content.tool_call.arguments ?? {});
        if (custom && identity) {
          const parsed = safeJsonParse(argumentsText, "custom_tool_call.input");
          customCalls.push({ id: content.tool_call.id, name: content.tool_call.name, input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input ?? "") });
        } else {
          functionCalls.push({ id: content.tool_call.id, name: content.tool_call.name, arguments: argumentsText });
        }
      }
    }
    const toolOnlyMessage = message.role === "tool" && others.length === 0;
    if (!toolOnlyMessage && (parts.length > 0 || (functionCalls.length === 0 && customCalls.length === 0))) {
      const content = parts.length === 1 && parts[0]?.type === "input_text" ? parts[0].text : parts;
      input.push({ role: message.role === "tool" ? "user" : message.role, content });
    }
    for (const call of functionCalls) {
      input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
    }
    for (const call of customCalls) {
      input.push({ type: "custom_tool_call", call_id: call.id, name: call.name, input: call.input });
    }
  }
  base.input = input;
  if (isRecord(base.tool_choice) && typeof base.tool_choice.name === "string") {
    const mapped = base.tool_choice.name as string;
    const identity = registry.map.get(mapped);
    base.tool_choice = { type: identity?.custom === true ? "custom" : "function", name: mapped };
  } else if (typeof base.tool_choice === "string" && base.tool_choice === "required") {
    // responses 的 required 枚举与 chat 一致，保留原样。
  }
  return stripUndefined(base);
}

/* ================================ 主入口 ================================ */

function collectPassthroughIdentities(from: BridgeProtocol, body: Json, registry: ToolRegistry): void {
  if (from === "responses") {
    collectResponsesTools(body, registry);
    return;
  }
  if (from === "chat-completions") {
    for (const raw of asArray(body.tools)) {
      if (!isRecord(raw)) continue;
      if (raw.type === "custom") {
        registry.register(requiredString(raw.name, "工具 name"), undefined, true);
      } else if (raw.type === "function" && isRecord(raw.function)) {
        registry.register(requiredString(raw.function.name, "工具 name"), undefined, false);
      }
    }
    return;
  }
  for (const raw of asArray(body.tools)) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) continue;
    registry.register(raw.name, undefined, false);
  }
}

export function convertRequest(
  from: BridgeProtocol,
  to: BridgeProtocol,
  body: unknown,
  options?: ConvertRequestOptions,
): ConvertRequestResult {
  if (!isRecord(body)) fail("请求正文必须是 JSON 对象");
  const notes: string[] = [];
  const registry = new ToolRegistry(notes, options?.mapToolName);

  if (from === to) {
    // 同协议直通：保留全部可表达字段与扩展，不执行任何政策；身份表供响应侧还原。
    collectPassthroughIdentities(from, body, registry);
    const passthrough = structuredClone(body);
    if (options?.model !== undefined) passthrough.model = options.model;
    return { body: passthrough, tools: registry.map, notes };
  }

  if (from === "gemini") fail("gemini 仅作为上游目标协议，不接受客户端输入");

  let universal: UniversalBody;
  if (from === "responses") universal = responsesSourceToUniversal(body, registry);
  else if (from === "chat-completions") universal = chatSourceToUniversal(body, registry);
  else universal = anthropicSourceToUniversal(body, registry);

  if (options?.model !== undefined) universal.model = options.model;

  const stopSequences = isRecord(universal.provider_params) && Array.isArray(universal.provider_params.stop_sequences)
    ? (universal.provider_params.stop_sequences as string[])
    : undefined;

  let emitted: Json;
  if (to === "chat-completions") emitted = emitChatTarget(universal, registry, stopSequences);
  else if (to === "anthropic") emitted = emitAnthropicTarget(universal, registry, stopSequences);
  else if (to === "gemini") emitted = emitGoogleTarget(universal, registry, stopSequences);
  else {
    if (stopSequences !== undefined) notes.push("源请求的 stop 序列在 responses 目标没有对应字段，已丢弃");
    emitted = emitResponsesTarget(universal, registry);
  }

  return { body: emitted, tools: registry.map, notes };
}
