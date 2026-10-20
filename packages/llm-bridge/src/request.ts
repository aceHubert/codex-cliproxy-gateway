/**
 * 统一请求转换 convertRequest(from, to, body, options)——语义链路为
 * 上游 endpoint (from) → 调用方 route (to)：from 是桥接拼装的上游目标协议，
 * to 是调用方端点协议；请求数据流为 to → from（把客户端体转成上游体）。
 *
 * 以 @ai-sdk/*（ai 引擎层，见 engine.ts）为出站拼装底座：三来源先规范化为引擎
 * prompt（V4 消息/部件），经离线捕获得到目标协议请求体，再按目标协议补齐引擎
 * 不表达的合同字段（stream/parallel/strict/reasoning_effort/text.format 等）。
 * to === from 时结构化克隆直通，保留 Codex 工具信封的位置，不执行任何厂商政策。工具身份（custom /
 * namespace 安全名）在声明、调用历史与 named tool_choice 间共用同一映射，映射
 * 表随结果返回供响应侧还原。
 */

import { createHash } from "node:crypto";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import { buildTargetBody, type EngineFunctionTool, type EnginePrompt, type EngineToolChoice } from "./engine.ts";
import { normalizeResponsesToolDeclarations } from "./responses-tools.ts";
import {
  BridgeConversionError,
  type ConvertRequestOptions,
  type ConvertRequestResult,
  type ToolIdentity,
  type ToolIdentityMap,
} from "./types.ts";

type Json = Record<string, unknown>;

/* 引擎 prompt 的结构部件类型（与 @ai-sdk/provider 的 V4 部件结构一致，仅内部使用）。 */
type Part =
  | { type: "text"; text: string }
  | { type: "file"; data: { type: "data"; data: string } | { type: "url"; url: string }; mediaType: string; providerOptions?: Record<string, unknown> }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } | { type: "content"; value: Array<{ type: "text"; text: string } | { type: "file"; data: { type: "data"; data: string } | { type: "url"; url: string }; mediaType: string }> } };

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

/** data URL → {mimeType, base64}；非 data URL 返回 undefined。 */
function parseDataUrl(url: string): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  return match ? { mimeType: match[1]!, data: match[2]! } : undefined;
}

/* ============================== 工具身份注册表 ============================== */

class ToolRegistry {
  readonly map: ToolIdentityMap = new Map();
  readonly strippedTools: string[] = [];
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

  /**
   * 原名身份注册（同协议直通专用）：请求体不经改名，身份表 key 与 body 中
   * 实际工具名一致，不生成请求体未使用的映射名。
   */
  registerIdentity(name: string, namespace: string | undefined, custom: boolean): void {
    this.map.set(name, { name, custom, ...(namespace === undefined ? {} : { namespace }) });
  }

  note(message: string): void {
    this.notes.push(message);
  }

  /** 记录一次工具声明剥离：notes 负责可观测，strippedTools 负责程序化消费。 */
  stripTool(toolType: string, message: string): void {
    this.strippedTools.push(toolType);
    this.note(message);
  }
}

/* ============================ 源规范化公共结构 ============================ */

type StructuredOutput =
  | { kind: "json_schema"; name: string; strict?: boolean; schema: Json }
  | { kind: "json_object" };

interface PreparedRequest {
  model: string;
  prompt: EnginePrompt;
  tools: EngineFunctionTool[];
  /** 映射名 → 声明中的 strict（引擎不表达，按目标协议后合并）。 */
  strictByTool: Map<string, boolean>;
  toolChoice?: EngineToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream?: boolean;
  parallelToolCalls?: boolean;
  /** Anthropic 源 tool_choice.disable_parallel_tool_use；目标 anthropic 时后合并。 */
  disableParallelToolUse?: boolean;
  reasoningEffort?: string;
  structured?: StructuredOutput;
  /** 与 prompt 中非 system 消息一一对应；chat 目标保持内容块数组形状。 */
  contentArrayFlags: boolean[];
}

/** 逐条消息构建 prompt：user/assistant/tool 消息按序入列，system 统一合并为一条。 */
class PromptBuilder {
  private readonly prompt: EnginePrompt = [];
  /** 与最终 prompt 中非 system 消息一一对应的“源内容是数组”标志（chat 目标保形用）。 */
  private readonly arrayFlags: boolean[] = [];
  private pendingAssistant: Part[] | null = null;
  private pendingArray = false;

  constructor(private readonly systemTexts: string[]) {}

  private flush(): void {
    if (this.pendingAssistant === null) return;
    const parts = this.pendingAssistant;
    const wasArray = this.pendingArray;
    this.pendingAssistant = null;
    this.pendingArray = false;
    this.prompt.push({ role: "assistant", content: parts as never });
    this.arrayFlags.push(wasArray);
  }

  /**
   * Responses 源的相邻 assistant 合并规则与 main 适配器一致（非对称）：
   * 工具调用无条件并入相邻 assistant 轮（文本轮 + 后续调用合成一轮）；
   * 文本仅并入已含调用的轮，纯文本轮之间保持独立消息。
   */
  appendAssistantText(part: Part, wasArray: boolean): void {
    const hasToolCall = this.pendingAssistant?.some((entry) => entry.type === "tool-call") ?? false;
    if (this.pendingAssistant !== null && hasToolCall) {
      this.pendingAssistant.push(part);
      this.pendingArray = this.pendingArray || wasArray;
      return;
    }
    this.flush();
    this.pendingAssistant = [part];
    this.pendingArray = wasArray;
  }

  appendAssistantToolCall(part: Part): void {
    if (this.pendingAssistant !== null) {
      this.pendingAssistant.push(part);
      return;
    }
    this.pendingAssistant = [part];
    this.pendingArray = false;
  }

  pushUser(parts: Part[], wasArray: boolean): void {
    this.flush();
    this.prompt.push({ role: "user", content: parts as never });
    this.arrayFlags.push(wasArray);
  }

  pushToolResult(part: Part): void {
    this.flush();
    this.prompt.push({ role: "tool", content: [part] as never });
    this.arrayFlags.push(false);
  }

  /** chat/anthropic 源的 assistant 消息保持一一对应，不跨消息合并。 */
  pushAssistantMessage(parts: Part[], wasArray: boolean): void {
    this.flush();
    this.prompt.push({ role: "assistant", content: parts as never });
    this.arrayFlags.push(wasArray);
  }

  build(): EnginePrompt {
    this.flush();
    if (this.systemTexts.length > 0) {
      return [{ role: "system", content: this.systemTexts.join("\n\n") }, ...this.prompt];
    }
    return this.prompt;
  }

  contentArrayFlags(): boolean[] {
    return [...this.arrayFlags];
  }
}

/** 文本 + 图片/音频内容块 → 引擎部件；data URL 转 base64 部件，URL 保持引用。 */
function contentPartsFromImages(
  entries: Array<{ kind: "text"; text: string } | { kind: "image"; url: string; detail?: string } | { kind: "audio"; data: string; format: string }>,
): Part[] {
  const parts: Part[] = [];
  for (const entry of entries) {
    if (entry.kind === "text") {
      parts.push({ type: "text", text: entry.text });
    } else if (entry.kind === "image") {
      const inline = parseDataUrl(entry.url);
      parts.push(inline
        ? { type: "file", data: { type: "data", data: inline.data }, mediaType: inline.mimeType }
        : { type: "file", data: { type: "url", url: entry.url }, mediaType: "image" });
      if (entry.detail === "auto" || entry.detail === "high" || entry.detail === "low") {
        (parts.at(-1) as { providerOptions?: Record<string, unknown> }).providerOptions = { openai: { imageDetail: entry.detail } };
      }
    } else {
      parts.push({ type: "file", data: { type: "data", data: entry.data }, mediaType: `audio/${entry.format}` });
    }
  }
  return parts;
}

function parseReasoningEffort(source: Json): string | undefined {
  if (!isRecord(source.reasoning)) return undefined;
  const effort = source.reasoning.effort;
  if (effort === undefined) return undefined;
  if (typeof effort !== "string") fail("reasoning.effort 必须是字符串");
  return effort === "none" ? undefined : effort;
}

/* ============================ Responses 源规范化 ============================ */

interface ToolDeclaration {
  mapped: string;
  custom: boolean;
  parameters: Json;
  strict?: boolean;
  description: string;
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
        registry.stripTool(String(raw.type), `已剥离内置工具声明 ${String(raw.type)}（服务器内置工具由插件前处理决定回放或降级）`);
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
        namespace,
      });
    }
  };
  visit(source.tools);
  return declarations;
}

/** Responses 输出内容块 → 统一内容描述（text / image / audio）。 */
function describeResponsesContent(content: unknown, field: string): Array<{ kind: "text"; text: string } | { kind: "image"; url: string; detail?: string } | { kind: "audio"; data: string; format: string }> {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) fail(`${field} 必须是字符串或内容数组`);
  const entries: Array<{ kind: "text"; text: string } | { kind: "image"; url: string; detail?: string } | { kind: "audio"; data: string; format: string }> = [];
  for (const raw of content) {
    if (!isRecord(raw)) fail(`${field} 包含无效内容块`);
    if (raw.type === "input_text" || raw.type === "output_text" || raw.type === "text" || raw.type === "summary_text") {
      if (typeof raw.text !== "string") fail(`${field}.text 必须是字符串`);
      entries.push({ kind: "text", text: raw.text });
    } else if (raw.type === "input_image" || raw.type === "image") {
      const source = raw.image_url ?? raw.url;
      const url = typeof source === "string" ? source : isRecord(source) && typeof source.url === "string" ? source.url : undefined;
      if (!url) fail("input_image 缺少 image_url");
      const detail = isRecord(source) && (source.detail === "auto" || source.detail === "high" || source.detail === "low") ? source.detail : undefined;
      entries.push({ kind: "image", url, ...(detail ? { detail } : {}) });
    } else if (raw.type === "input_audio" && isRecord(raw.input_audio)) {
      entries.push({ kind: "audio", data: typeof raw.input_audio.data === "string" ? raw.input_audio.data : "", format: typeof raw.input_audio.format === "string" ? raw.input_audio.format : "wav" });
    } else {
      fail(`${field} 包含不支持的内容块类型 ${String(raw.type)}`);
    }
  }
  return entries;
}

/** 工具输出内容 → 引擎 tool-result 输出；纯文本用 text，混合内容用 content。 */
function responsesToolResultOutput(output: unknown): Part extends { output: infer O } ? O : never {
  if (Array.isArray(output)) {
    const entries = describeResponsesContent(output, "function_call_output.output");
    const hasFile = entries.some((entry) => entry.kind !== "text");
    if (!hasFile) return { type: "text", value: entries.map((entry) => entry.kind === "text" ? entry.text : "").join("") } as never;
    return {
      type: "content",
      value: contentPartsFromImages(entries) as never,
    } as never;
  }
  if (typeof output === "string") return { type: "text", value: output } as never;
  if (output === undefined || output === null) return { type: "text", value: "" } as never;
  return { type: "text", value: JSON.stringify(output) } as never;
}

/**
 * Responses 源 → PreparedRequest。引擎承担目标协议拼装；以下语义按实测由封装层
 * 保留：instructions/system/developer 合并（L1/C1）、function_call 历史与输出
 * 配对（L2）、custom/namespace 声明与身份（C2/C3）、strict 与 named choice。
 */
function responsesSourceToPrepared(body: Json, registry: ToolRegistry): PreparedRequest {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && body.previous_response_id !== "") {
    fail("桥接转换是无状态的：previous_response_id 需要完整 input 历史");
  }
  const input = body.input;
  const items: unknown[] = typeof input === "string"
    ? [{ type: "message", role: "user", content: input }]
    : asArray(input);
  if (input !== undefined && !Array.isArray(input) && typeof input !== "string") fail("input 必须是字符串或数组");

  const declarations = collectResponsesTools(body, registry);
  const declarationByKey = new Map<string, ToolDeclaration>();
  for (const declaration of declarations) {
    declarationByKey.set(JSON.stringify([declaration.namespace ?? null, registry.map.get(declaration.mapped)!.name]), declaration);
  }

  const systemTexts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions) systemTexts.push(body.instructions);
  else if (body.instructions !== undefined && typeof body.instructions !== "string") fail("instructions 必须是字符串");

  const builder = new PromptBuilder(systemTexts);
  const callNameByld = new Map<string, string>();
  const callsSeen = new Set<string>();
  const resultsSeen = new Set<string>();

  for (const item of items) {
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
      const wasArray = Array.isArray(item.content);
      const parts = contentPartsFromImages(describeResponsesContent(item.content, `${role} 消息`));
      if (role === "assistant") {
        for (const part of parts) builder.appendAssistantText(part, wasArray);
      } else {
        builder.pushUser(parts, wasArray);
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
      callNameByld.set(callId, mapped);
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
      const parsed = custom ? safeJsonParse(argumentsText, `${type}.input`) : safeJsonParse(argumentsText, `${type}.arguments`);
      builder.appendAssistantToolCall({ type: "tool-call", toolCallId: callId, toolName: mapped, input: parsed });
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = requiredString(item.call_id, `${type}.call_id`);
      if (!callsSeen.has(callId)) fail(`${type} 未关联到同一 input 中匹配的工具调用 ${callId}`);
      if (resultsSeen.has(callId)) fail(`history 中重复的工具输出 ID ${callId}`);
      resultsSeen.add(callId);
      builder.pushToolResult({
        type: "tool-result",
        toolCallId: callId,
        toolName: callNameByld.get(callId) ?? "",
        output: responsesToolResultOutput(item.output ?? item.content),
      });
      continue;
    }
    if (type === "reasoning" || type.endsWith("_call") || type === "mcp_list_tools" || type === "mcp_list_resources") {
      // reasoning 信封与服务器内置工具调用是插件政策层输入；桥接默认剥离并显式记录。
      registry.note(`已剥离 ${type} history 项（插件前处理负责回放或降级）`);
      continue;
    }
    if (type === "compaction_trigger") {
      // 工具信封已在入口提升；压缩标记没有工具声明，不进入消息历史。
      registry.note(`已剥离 ${type} history 项（工具增补/压缩标记，不进入消息历史）`);
      continue;
    }
    fail(`不支持的 Responses history 项类型 ${type}`);
  }

  const tools: EngineFunctionTool[] = declarations.map((declaration) => ({
    type: "function",
    name: declaration.mapped,
    description: declaration.description,
    inputSchema: declaration.parameters,
    ...(declaration.strict === true ? { strict: true } : {}),
  }));
  const strictByTool = new Map<string, boolean>();
  for (const declaration of declarations) {
    if (declaration.strict === true) strictByTool.set(declaration.mapped, true);
  }

  const prepared: PreparedRequest = {
    model: typeof body.model === "string" && body.model ? body.model : "",
    prompt: builder.build(),
    contentArrayFlags: builder.contentArrayFlags(),
    tools,
    strictByTool,
    maxOutputTokens: positiveInteger(body.max_output_tokens, "max_output_tokens"),
  };
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number") fail("temperature 必须是数字");
    prepared.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    if (typeof body.top_p !== "number") fail("top_p 必须是数字");
    prepared.topP = body.top_p;
  }
  if (body.stream === true) prepared.stream = true;
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") fail("parallel_tool_calls 必须是布尔值");
    prepared.parallelToolCalls = body.parallel_tool_calls;
  }
  prepared.reasoningEffort = parseReasoningEffort(body);

  if (isRecord(body.text) && isRecord(body.text.format)) {
    const format = body.text.format;
    if (format.type === "json_schema") {
      prepared.structured = {
        kind: "json_schema",
        name: requiredString(format.name, "text.format.name"),
        strict: format.strict === true ? true : undefined,
        schema: isRecord(format.schema) ? (format.schema as Json) : fail("text.format.schema 必须是 JSON 对象"),
      };
    } else if (format.type === "json_object") {
      prepared.structured = { kind: "json_object" };
    } else if (format.type !== undefined && format.type !== "text") {
      fail(`不支持的 text.format 类型 ${String(format.type)}`);
    }
  }

  const choice = body.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === "string") {
      if (choice === "auto" || choice === "none" || choice === "required") prepared.toolChoice = { type: choice };
      else fail(`不支持的 tool_choice ${choice}`);
    } else if (isRecord(choice) && (choice.type === "function" || choice.type === "custom")) {
      const name = requiredString(choice.name, "tool_choice.name");
      const namespace = choice.namespace === undefined || choice.namespace === null ? undefined : requiredString(choice.namespace, "tool_choice.namespace");
      const declaration = declarationByKey.get(JSON.stringify([namespace ?? null, name]));
      if (!declaration) fail(`工具选择引用了未声明的工具 ${name}`);
      if (declaration.custom !== (choice.type === "custom")) fail("tool_choice 与工具声明类型不一致");
      prepared.toolChoice = { type: "tool", toolName: declaration.mapped };
    } else if (isRecord(choice) && typeof choice.type === "string" && choice.type !== "") {
      // 指向服务器内置工具的选择跨协议不可表达：显式回退 auto 并记录。
      registry.note(`tool_choice ${String(choice.type)} 指向内置工具，跨协议目标回退为 auto`);
    } else {
      fail("不支持的 tool_choice");
    }
  }
  return prepared;
}

/* ========================= Chat Completions 源规范化 ========================= */

/** Chat image_url 部件源（字符串或对象）→ 统一 image 描述。 */
function describeChatImage(source: unknown): { url: string; detail?: string } {
  const url = typeof source === "string" ? source : isRecord(source) && typeof source.url === "string" ? source.url : undefined;
  if (!url) fail("image_url 部件缺少 url");
  const detail = isRecord(source) && (source.detail === "auto" || source.detail === "high" || source.detail === "low") ? source.detail : undefined;
  return { url, ...(detail ? { detail } : {}) };
}

function chatSourceToPrepared(body: Json, registry: ToolRegistry): PreparedRequest {
  if (!Array.isArray(body.messages)) fail("messages 必须是数组");
  const maxCompletion = positiveInteger(body.max_completion_tokens, "max_completion_tokens");
  const maxTokens = positiveInteger(body.max_tokens, "max_tokens");
  if (maxCompletion !== undefined && maxTokens !== undefined && maxCompletion !== maxTokens) {
    fail("max_tokens 与 max_completion_tokens 同时提供时必须一致");
  }
  if (body.n !== undefined && body.n !== 1) fail("跨协议转换仅支持 n = 1");

  const systemTexts: string[] = [];
  const builder = new PromptBuilder(systemTexts);
  const callNameById = new Map<string, string>();

  for (const message of body.messages) {
    if (!isRecord(message)) fail("messages 包含无效消息");
    const role = message.role;
    if (role === "system" || role === "developer") {
      if (typeof message.content === "string") systemTexts.push(message.content);
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (isRecord(part) && part.type === "text" && typeof part.text === "string") systemTexts.push(part.text);
        }
      }
      continue;
    }
    if (role === "user") {
      const entries: Array<{ kind: "text"; text: string } | { kind: "image"; url: string; detail?: string }> = [];
      if (typeof message.content === "string") entries.push({ kind: "text", text: message.content });
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!isRecord(part)) fail("user 消息包含无效内容块");
          if (part.type === "text" && typeof part.text === "string") entries.push({ kind: "text", text: part.text });
          else if (part.type === "image_url") entries.push({ kind: "image", ...describeChatImage(part.image_url) });
          else fail(`user 消息包含不支持的内容块类型 ${String(part.type)}`);
        }
      } else if (message.content !== undefined) fail("user 消息 content 必须是字符串或数组");
      builder.pushUser(contentPartsFromImages(entries), Array.isArray(message.content));
      continue;
    }
    if (role === "assistant") {
      const parts: Part[] = [];
      if (typeof message.content === "string" && message.content) parts.push({ type: "text", text: message.content });
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!isRecord(part)) fail("assistant 消息包含无效内容块");
          if (part.type === "text" && typeof part.text === "string" && part.text) parts.push({ type: "text", text: part.text });
          else if (part.type !== "text") fail(`assistant 消息包含不支持的内容块类型 ${String(part.type)}`);
        }
      }
      // 调用历史中的 function.name 是客户端原始名：与声明共用同一身份映射改写，
      // 保证上游看到的声明、历史、named choice 三处一致（L4 身份合同）。
      for (const call of asArray(message.tool_calls)) {
        if (!isRecord(call) || !isRecord(call.function)) fail("assistant.tool_calls 包含无效调用");
        const original = requiredString(call.function.name, "tool_calls.function.name");
        const mapped = registry.mappedFor(original) ?? registry.register(original, undefined, false);
        const rawArguments = call.function.arguments;
        const parsed = typeof rawArguments === "string"
          ? safeJsonParse(rawArguments, "tool_calls.function.arguments")
          : isRecord(rawArguments)
            ? rawArguments
            : fail("tool_calls.function.arguments 必须是 JSON 对象或 JSON 字符串");
        const callId = requiredString(call.id, "tool_calls.id");
        if (callNameById.has(callId)) fail(`history 中重复的工具调用 ID ${callId}`);
        callNameById.set(callId, mapped);
        parts.push({ type: "tool-call", toolCallId: callId, toolName: mapped, input: parsed });
      }
      builder.pushAssistantMessage(parts, Array.isArray(message.content));
      continue;
    }
    if (role === "tool") {
      const callId = requiredString(message.tool_call_id, "tool 消息 tool_call_id");
      const toolName = callNameById.get(callId);
      if (!toolName) fail(`tool 消息 ${callId} 未关联到前述 assistant 工具调用`);
      const text = typeof message.content === "string" ? message.content : isRecord(message.content) || Array.isArray(message.content) ? JSON.stringify(message.content) : "";
      builder.pushToolResult({ type: "tool-result", toolCallId: callId, toolName, output: { type: "text", value: text } });
      continue;
    }
    fail(`不支持的消息 role ${String(role)}`);
  }

  // 工具声明：custom 以可逆 {input:string} 参数降级为 function（L5），内置类型剥离。
  const tools: EngineFunctionTool[] = [];
  const strictByTool = new Map<string, boolean>();
  for (const raw of asArray(body.tools)) {
    if (!isRecord(raw)) fail("tools 包含无效声明");
    if (raw.type !== "function" && raw.type !== "custom") {
      registry.stripTool(String(raw.type), `已剥离工具声明 ${String(raw.type)}（目标协议不可表达）`);
      continue;
    }
    const custom = raw.type === "custom";
    const original = requiredString(custom ? raw.name : isRecord(raw.function) ? raw.function.name : undefined, "工具 name");
    const mapped = registry.register(original, undefined, custom);
    const description = custom
      ? (typeof raw.description === "string" ? raw.description : "")
      : isRecord(raw.function) && typeof raw.function.description === "string" ? raw.function.description : "";
    tools.push({
      type: "function",
      name: mapped,
      description,
      inputSchema: custom ? CUSTOM_TOOL_PARAMETERS : isRecord(raw.function) && isRecord(raw.function.parameters) ? (raw.function.parameters as Json) : { type: "object", properties: {} },
    });
    if (!custom && isRecord(raw.function) && raw.function.strict === true) strictByTool.set(mapped, true);
  }

  const prepared: PreparedRequest = {
    model: typeof body.model === "string" && body.model ? body.model : "",
    prompt: builder.build(),
    contentArrayFlags: builder.contentArrayFlags(),
    tools,
    strictByTool,
    maxOutputTokens: maxCompletion ?? maxTokens,
  };
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number") fail("temperature 必须是数字");
    prepared.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    if (typeof body.top_p !== "number") fail("top_p 必须是数字");
    prepared.topP = body.top_p;
  }
  if (body.stream === true) prepared.stream = true;
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") fail("parallel_tool_calls 必须是布尔值");
    prepared.parallelToolCalls = body.parallel_tool_calls;
  }
  prepared.reasoningEffort = parseReasoningEffort(body);

  if (isRecord(body.response_format)) {
    const format = body.response_format;
    if (format.type === "json_schema" && isRecord(format.json_schema)) {
      const schema = format.json_schema;
      prepared.structured = {
        kind: "json_schema",
        name: requiredString(schema.name, "response_format.json_schema.name"),
        strict: schema.strict === true ? true : undefined,
        schema: isRecord(schema.schema) ? (schema.schema as Json) : fail("response_format.json_schema.schema 必须是 JSON 对象"),
      };
    } else if (format.type === "json_object") {
      prepared.structured = { kind: "json_object" };
    } else if (format.type !== undefined && format.type !== "text") {
      fail(`不支持的 response_format 类型 ${String(format.type)}`);
    }
  }

  if (body.stop !== undefined) {
    const stop = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (stop.some((entry) => typeof entry !== "string")) fail("stop 必须是字符串或字符串数组");
    prepared.stopSequences = stop as string[];
  }

  const choice = body.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === "string") {
      if (choice === "auto" || choice === "none" || choice === "required") prepared.toolChoice = { type: choice };
      else fail(`不支持的 tool_choice ${choice}`);
    } else if (isRecord(choice) && choice.type === "function" && isRecord(choice.function)) {
      const name = requiredString(choice.function.name, "tool_choice.function.name");
      const mapped = registry.mappedFor(name);
      if (!mapped) fail(`工具选择引用了未声明的工具 ${name}`);
      prepared.toolChoice = { type: "tool", toolName: mapped };
    } else if (isRecord(choice) && typeof choice.type === "string" && choice.type !== "") {
      registry.note(`tool_choice ${String(choice.type)} 跨协议不可表达，目标回退为 auto`);
    } else {
      fail("不支持的 tool_choice");
    }
  }
  return prepared;
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

function anthropicSourceToPrepared(body: Json, registry: ToolRegistry): PreparedRequest {
  if (!Array.isArray(body.messages)) fail("messages 必须是数组");
  recordAnthropicLosses(body, registry);

  const systemTexts: string[] = [];
  if (typeof body.system === "string" && body.system) systemTexts.push(body.system);
  else if (Array.isArray(body.system)) {
    for (const part of body.system) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text) systemTexts.push(part.text);
    }
  }

  const builder = new PromptBuilder(systemTexts);
  const callNameById = new Map<string, string>();

  for (const message of asArray(body.messages)) {
    if (!isRecord(message)) fail("messages 包含无效消息");
    const role = message.role;
    if (role !== "user" && role !== "assistant") fail(`不支持的消息 role ${String(role)}`);
    const userParts: Part[] = [];
    const assistantParts: Part[] = [];
    const toolResults: Part[] = [];
    for (const block of asArray(message.content)) {
      if (!isRecord(block)) fail("消息包含无效内容块");
      if (block.type === "text") {
        if (typeof block.text !== "string") fail("text 块缺少字符串 text");
        (role === "user" ? userParts : assistantParts).push({ type: "text", text: block.text });
      } else if (block.type === "image" && isRecord(block.source)) {
        const source = block.source;
        if (source.type === "base64") {
          const mediaType = requiredString(source.media_type, "image.source.media_type");
          const data = requiredString(source.data, "image.source.data");
          (role === "user" ? userParts : assistantParts).push({ type: "file", data: { type: "data", data }, mediaType });
        } else if (source.type === "url") {
          const url = requiredString(source.url, "image.source.url");
          (role === "user" ? userParts : assistantParts).push({ type: "file", data: { type: "url", url }, mediaType: "image" });
        } else {
          fail(`不支持的 image source 类型 ${String(source.type)}`);
        }
      } else if (block.type === "tool_use") {
        const id = requiredString(block.id, "tool_use.id");
        const original = requiredString(block.name, "tool_use.name");
        // 与声明共用同一身份映射改写（三处一致合同）。
        const mapped = registry.mappedFor(original) ?? registry.register(original, undefined, false);
        if (callNameById.has(id)) fail(`history 中重复的工具调用 ID ${id}`);
        callNameById.set(id, mapped);
        assistantParts.push({
          type: "tool-call",
          toolCallId: id,
          toolName: mapped,
          input: isRecord(block.input) ? block.input : fail("tool_use.input 必须是 JSON 对象"),
        });
      } else if (block.type === "tool_result") {
        const id = requiredString(block.tool_use_id, "tool_result.tool_use_id");
        const toolName = callNameById.get(id);
        if (!toolName) fail(`tool_result ${id} 未关联到前述 tool_use 调用`);
        // 块数组中图片跨协议目标无法在 tool 消息中表达：保留文本并显式记录。
        if (Array.isArray(block.content)) {
          const texts: string[] = [];
          let droppedImages = 0;
          for (const part of block.content) {
            if (isRecord(part) && part.type === "text" && typeof part.text === "string") texts.push(part.text);
            else if (isRecord(part) && part.type === "image") droppedImages++;
          }
          if (droppedImages > 0) registry.note(`工具结果 ${id} 含 ${droppedImages} 个图片块，跨协议目标无法在 tool 消息中表达`);
          toolResults.push({ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value: texts.join("") } });
        } else {
          const text = typeof block.content === "string" ? block.content : "";
          toolResults.push({ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value: text } });
        }
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        continue; // 已由 recordAnthropicLosses 记录丢弃。
      } else {
        fail(`不支持的内容块类型 ${String(block.type)}`);
      }
    }
    if (role === "user") {
      // V4 要求 tool-result 位于 role:"tool" 消息；先出结果再出剩余 user 内容。
      for (const result of toolResults) builder.pushToolResult(result);
      if (userParts.length > 0) builder.pushUser(userParts, true);
    } else {
      builder.pushAssistantMessage(assistantParts, true);
    }
  }

  // 工具声明：input_schema → 同一身份映射（服务器内置工具在此协议不存在）。
  // Anthropic 常规工具声明没有 type 字段（ZCode/Claude Code/MCP 客户端皆然），缺省
  // 必须是 function：2026-10-15 实测缺省 custom 会把真实 input_schema 换成占位、
  // 历史回放发射成 custom_tool_call 而输出仍是 function_call_output，上游按类型
  // 配对直接 400。真正的 custom 工具（自由文本输入）显式声明 type:"custom"。
  const tools: EngineFunctionTool[] = [];
  for (const raw of asArray(body.tools)) {
    if (!isRecord(raw)) fail("tools 包含无效声明");
    const type = typeof raw.type === "string" ? raw.type : "function";
    if (type !== "custom" && type !== "function") {
      registry.stripTool(type, `已剥离 Anthropic 服务器工具 ${type}（跨协议不可表达）`);
      continue;
    }
    const original = requiredString(raw.name, "工具 name");
    const mapped = registry.register(original, undefined, type === "custom");
    const schema = isRecord(raw.input_schema) ? (raw.input_schema as Json) : undefined;
    tools.push({
      type: "function",
      name: mapped,
      description: typeof raw.description === "string" ? raw.description : "",
      inputSchema: type === "custom" || !schema ? CUSTOM_TOOL_PARAMETERS : schema,
    });
  }

  const prepared: PreparedRequest = {
    model: typeof body.model === "string" && body.model ? body.model : "",
    prompt: builder.build(),
    contentArrayFlags: builder.contentArrayFlags(),
    tools,
    strictByTool: new Map(),
    maxOutputTokens: positiveInteger(body.max_tokens, "max_tokens"),
  };
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number") fail("temperature 必须是数字");
    prepared.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    if (typeof body.top_p !== "number") fail("top_p 必须是数字");
    prepared.topP = body.top_p;
  }
  if (body.stop_sequences !== undefined) {
    if (!Array.isArray(body.stop_sequences) || body.stop_sequences.some((entry) => typeof entry !== "string")) fail("stop_sequences 必须是字符串数组");
    prepared.stopSequences = body.stop_sequences as string[];
  }

  const choice = body.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === "string") {
      if (choice === "auto" || choice === "none") prepared.toolChoice = { type: choice };
      else if (choice === "any") prepared.toolChoice = { type: "required" };
      else fail(`不支持的 Anthropic tool_choice ${choice}`);
    } else if (isRecord(choice)) {
      const type = choice.type;
      if (type === "tool" && typeof choice.name === "string") {
        const mapped = registry.mappedFor(choice.name);
        if (!mapped) fail(`工具选择引用了未声明的工具 ${choice.name}`);
        prepared.toolChoice = { type: "tool", toolName: mapped };
      } else if (type === "auto" || type === "any") {
        prepared.toolChoice = type === "any" ? { type: "required" } : { type: "auto" };
      } else if (type === "none") {
        prepared.toolChoice = { type: "none" };
      } else {
        fail(`不支持的 Anthropic tool_choice 类型 ${String(type)}`);
      }
      if (choice.disable_parallel_tool_use === true) prepared.disableParallelToolUse = true;
    } else {
      fail("不支持的 tool_choice");
    }
  }
  return prepared;
}

/* ============================== Gemini 源规范化 ============================== */

/**
 * Gemini generateContent 源 → PreparedRequest。model 不在请求体（由 URL 路径
 * 携带），由 options.model 提供；thought 思考 parts 跨协议不可表达，与 Anthropic
 * thinking 块同合同：显式剥离并记录，不伪装为文本。
 */
function geminiSourceToPrepared(body: Json, registry: ToolRegistry): PreparedRequest {
  if (!Array.isArray(body.contents)) fail("contents 必须是数组");

  const systemTexts: string[] = [];
  const instruction = body.systemInstruction;
  if (typeof instruction === "string" && instruction) systemTexts.push(instruction);
  else if (isRecord(instruction) && Array.isArray(instruction.parts)) {
    for (const part of instruction.parts) {
      if (isRecord(part) && typeof part.text === "string" && part.text) systemTexts.push(part.text);
    }
  } else if (instruction !== undefined) {
    fail("systemInstruction 必须是字符串或 {parts} 对象");
  }

  const builder = new PromptBuilder(systemTexts);
  const callIdByIndex: string[] = [];
  const openCallsByName = new Map<string, string[]>();
  const respondedCalls = new Set<string>();

  let contentIndex = 0;
  for (const message of body.contents) {
    if (!isRecord(message)) fail("contents 包含无效条目");
    const role = message.role;
    if (role !== "user" && role !== "model") fail(`不支持的内容 role ${String(role)}`);
    const userParts: Part[] = [];
    const modelParts: Part[] = [];
    const toolResults: Part[] = [];
    for (const part of asArray(message.parts)) {
      if (!isRecord(part)) fail("parts 包含无效块");
      if (typeof part.text === "string" && part.text) {
        if (part.thought === true) {
          registry.note("Gemini thought 思考块跨协议目标不可表达，已丢弃（与 Anthropic thinking 块同合同）");
          continue;
        }
        (role === "model" ? modelParts : userParts).push({ type: "text", text: part.text });
      } else if (isRecord(part.inlineData) && typeof part.inlineData.data === "string") {
        (role === "model" ? modelParts : userParts).push({
          type: "file",
          data: { type: "data", data: part.inlineData.data },
          mediaType: typeof part.inlineData.mimeType === "string" ? part.inlineData.mimeType : "image",
        });
      } else if (isRecord(part.fileData) && typeof part.fileData.fileUri === "string") {
        (role === "model" ? modelParts : userParts).push({
          type: "file",
          data: { type: "url", url: part.fileData.fileUri },
          mediaType: typeof part.fileData.mimeType === "string" ? part.fileData.mimeType : "image",
        });
      } else if (isRecord(part.functionCall)) {
        const name = requiredString(part.functionCall.name, "functionCall.name");
        const mapped = registry.mappedFor(name) ?? registry.register(name, undefined, false);
        const declaredId = typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : undefined;
        const callId = declaredId ?? `gemini_call_${contentIndex}_${callIdByIndex.length}`;
        callIdByIndex.push(callId);
        if (!declaredId) {
          const queue = openCallsByName.get(name) ?? [];
          queue.push(callId);
          openCallsByName.set(name, queue);
        }
        modelParts.push({
          type: "tool-call",
          toolCallId: callId,
          toolName: mapped,
          input: isRecord(part.functionCall.args) ? part.functionCall.args : {},
        });
      } else if (isRecord(part.functionResponse)) {
        const name = typeof part.functionResponse.name === "string" ? part.functionResponse.name : "";
        let callId = typeof part.functionResponse.id === "string" && part.functionResponse.id ? part.functionResponse.id : undefined;
        if (!callId && name) {
          // 无 id 响应按「最近一次同名未应答调用」配对；配不上则显式报错。
          const queue = openCallsByName.get(name);
          while (queue && queue.length > 0) {
            const candidate = queue.shift()!;
            if (!respondedCalls.has(candidate)) {
              callId = candidate;
              break;
            }
          }
        }
        if (!callId) fail(`functionResponse 缺少 id 且无法按名称 ${name || "(空)"} 配对到未应答调用`);
        respondedCalls.add(callId);
        const mapped = registry.mappedFor(name) ?? (name ? registry.register(name, undefined, false) : "");
        toolResults.push({
          type: "tool-result",
          toolCallId: callId,
          toolName: mapped,
          output: { type: "text", value: JSON.stringify(isRecord(part.functionResponse.response) ? part.functionResponse.response : part.functionResponse.response ?? "") },
        });
      } else if (typeof part.thoughtSignature === "string") {
        registry.note("Gemini thoughtSignature 跨协议目标不可表达，已丢弃");
      } else {
        fail("parts 包含不支持的块（无 text/inlineData/fileData/functionCall/functionResponse）");
      }
    }
    if (role === "model") {
      for (const part of modelParts) {
        if (part.type === "tool-call") builder.appendAssistantToolCall(part);
        else builder.appendAssistantText(part, true);
      }
    } else {
      for (const result of toolResults) builder.pushToolResult(result);
      if (userParts.length > 0) builder.pushUser(userParts, true);
    }
    contentIndex++;
  }

  // 工具声明：functionDeclarations 展平（parametersJsonSchema 优先，兼容旧 parameters）。
  const tools: EngineFunctionTool[] = [];
  for (const raw of asArray(body.tools)) {
    if (!isRecord(raw)) fail("tools 包含无效声明");
    if (!Array.isArray(raw.functionDeclarations)) continue;
    for (const declaration of raw.functionDeclarations) {
      if (!isRecord(declaration)) fail("functionDeclarations 包含无效声明");
      const original = requiredString(declaration.name, "functionDeclarations.name");
      const mapped = registry.register(original, undefined, false);
      const schema = isRecord(declaration.parametersJsonSchema)
        ? (declaration.parametersJsonSchema as Json)
        : isRecord(declaration.parameters)
          ? (declaration.parameters as Json)
          : { type: "object", properties: {} };
      tools.push({
        type: "function",
        name: mapped,
        description: typeof declaration.description === "string" ? declaration.description : "",
        inputSchema: schema,
      });
    }
  }

  const prepared: PreparedRequest = {
    model: typeof body.model === "string" && body.model ? body.model : "",
    prompt: builder.build(),
    contentArrayFlags: builder.contentArrayFlags(),
    tools,
    strictByTool: new Map(),
  };
  const generation = isRecord(body.generationConfig) ? body.generationConfig : {};
  const maxTokens = positiveInteger(generation.maxOutputTokens, "generationConfig.maxOutputTokens");
  if (maxTokens !== undefined) prepared.maxOutputTokens = maxTokens;
  if (generation.temperature !== undefined) {
    if (typeof generation.temperature !== "number") fail("generationConfig.temperature 必须是数字");
    prepared.temperature = generation.temperature;
  }
  if (generation.topP !== undefined) {
    if (typeof generation.topP !== "number") fail("generationConfig.topP 必须是数字");
    prepared.topP = generation.topP;
  }
  if (generation.stopSequences !== undefined) {
    if (!Array.isArray(generation.stopSequences) || generation.stopSequences.some((entry) => typeof entry !== "string")) fail("generationConfig.stopSequences 必须是字符串数组");
    prepared.stopSequences = generation.stopSequences as string[];
  }
  if (generation.responseMimeType === "application/json" || isRecord(generation.responseJsonSchema) || isRecord(generation.responseSchema)) {
    const schema = isRecord(generation.responseJsonSchema) ? generation.responseJsonSchema : isRecord(generation.responseSchema) ? generation.responseSchema : undefined;
    prepared.structured = schema
      ? { kind: "json_schema", name: "output", schema: schema as Json }
      : { kind: "json_object" };
  } else if (generation.responseMimeType !== undefined && generation.responseMimeType !== "text/plain") {
    fail(`不支持的 generationConfig.responseMimeType ${String(generation.responseMimeType)}`);
  }

  const config = isRecord(body.toolConfig) && isRecord(body.toolConfig.functionCallingConfig) ? body.toolConfig.functionCallingConfig : undefined;
  if (config !== undefined) {
    const mode = typeof config.mode === "string" ? config.mode : "AUTO";
    if (mode === "AUTO" || mode === "NONE") prepared.toolChoice = { type: mode === "AUTO" ? "auto" : "none" };
    else if (mode === "ANY") {
      const allowed = Array.isArray(config.allowedFunctionNames) ? config.allowedFunctionNames : [];
      if (allowed.length === 1 && typeof allowed[0] === "string") {
        const mapped = registry.mappedFor(allowed[0]);
        if (!mapped) fail(`functionCallingConfig 引用了未声明的工具 ${allowed[0]}`);
        prepared.toolChoice = { type: "tool", toolName: mapped };
      } else {
        prepared.toolChoice = { type: "required" };
      }
    } else {
      fail(`不支持的 functionCallingConfig.mode ${mode}`);
    }
  }
  return prepared;
}

/* ================================ 目标后合并 ================================ */

function stripUndefined(body: Json): Json {
  const result: Json = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

/** 递归删除 undefined 值的键（引擎体在序列化前可能带显式空键）。 */
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

/** 工具声明 strict 合同：引擎只写自己的默认（false），声明为 true 时才保留。 */
function applyToolStrict(target: "chat-completions" | "responses", body: Json, prepared: PreparedRequest): void {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const raw of tools) {
    if (!isRecord(raw)) continue;
    if (target === "chat-completions" && isRecord(raw.function)) {
      if (raw.function.strict === true || prepared.strictByTool.get(String(raw.function.name)) === true) raw.function.strict = true;
      else delete raw.function.strict;
    } else if (target === "responses") {
      if (prepared.strictByTool.get(String(raw.name)) === true) raw.strict = true;
      else delete raw.strict;
    }
  }
}

function structuredToJsonSchemaFormat(structured: StructuredOutput): Json {
  if (structured.kind === "json_object") return { type: "json_object" };
  return { type: "json_schema", name: structured.name, ...(structured.strict === true ? { strict: true } : {}), schema: structured.schema };
}

/** 引擎在未携带 tools 时可能省略 tool_choice；按合同形状补齐/覆盖。 */
function applyChatToolChoice(body: Json, prepared: PreparedRequest): void {
  const choice = prepared.toolChoice;
  if (choice === undefined) return;
  if (choice.type === "tool") body.tool_choice = { type: "function", function: { name: choice.toolName } };
  else body.tool_choice = choice.type;
}

/**
 * chat 目标 system 语义防御：本包三个源都把 system/developer/instructions
 * 归并为 system 语义；盐化 modelId 已避免引擎的 developer 映射，此处兜底
 * 把可能出现的 developer 首消息还原为 role: "system"。
 */
function applyChatSystemRole(body: Json): void {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  if (isRecord(first) && first.role === "developer") first.role = "system";
}

/** 内容形状保形：源为数组内容的消息在 chat 目标保持内容块数组。 */
function applyChatContentShape(body: Json, prepared: PreparedRequest): void {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = isRecord(messages[0]) ? messages[0].role : undefined;
  const offset = first === "system" || first === "developer" ? 1 : 0;
  prepared.contentArrayFlags.forEach((wasArray, index) => {
    if (wasArray !== true) return;
    const emitted = messages[offset + index];
    if (!isRecord(emitted) || typeof emitted.content !== "string" || emitted.role === "system" || emitted.role === "developer") return;
    emitted.content = emitted.content === "" ? [] : [{ type: "text", text: emitted.content }];
  });
}

function applyChatExtras(body: Json, prepared: PreparedRequest): void {
  applyChatSystemRole(body);
  applyChatContentShape(body, prepared);
  if (prepared.stream === true) body.stream = true;
  if (prepared.parallelToolCalls !== undefined) body.parallel_tool_calls = prepared.parallelToolCalls;
  if (prepared.reasoningEffort !== undefined) body.reasoning_effort = prepared.reasoningEffort;
  applyChatToolChoice(body, prepared);
  if (prepared.structured !== undefined) {
    body.response_format = structuredToJsonSchemaFormatForChat(prepared.structured);
  }
}

function structuredToJsonSchemaFormatForChat(structured: StructuredOutput): Json {
  if (structured.kind === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: { name: structured.name, ...(structured.strict === true ? { strict: true } : {}), schema: structured.schema },
  };
}

function applyResponsesExtras(body: Json, prepared: PreparedRequest, registry: ToolRegistry): void {
  if (prepared.stream === true) body.stream = true;
  if (prepared.parallelToolCalls !== undefined) body.parallel_tool_calls = prepared.parallelToolCalls;
  // 引擎把空文本 assistant 轮写成 {role:"assistant",content:""}； Responses 输入
  // 中该空消息无语义，删除以保持与既有合同一致。
  if (Array.isArray(body.input)) {
    body.input = body.input.filter((item) => !(isRecord(item) && item.role === "assistant" && (item.content === "" || (Array.isArray(item.content) && item.content.length === 0))));
  }
  // custom 工具历史：引擎统一写 function_call/function_call_output，按身份表还原
  // custom_tool_call，其配对输出同步还原为 custom_tool_call_output——上游按类型
  // 配对调用与输出，交叉配对会被拒（2026-10-15 muse-spark 实测 400
  // "No function call found for function call output"）。
  if (Array.isArray(body.input)) {
    const items = body.input as unknown[];
    const customCallIds = new Set<string>();
    const calls = items.map((item) => {
      if (!isRecord(item) || item.type !== "function_call" || typeof item.name !== "string") return item;
      const identity = registry.map.get(item.name);
      if (!identity?.custom || typeof item.arguments !== "string") return item;
      const parsed = safeJsonParse(item.arguments, "custom_tool_call.arguments");
      if (typeof item.call_id === "string") customCallIds.add(item.call_id);
      return { type: "custom_tool_call", call_id: item.call_id, name: item.name, input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input ?? "") };
    });
    body.input = customCallIds.size > 0
      ? calls.map((item) => {
        if (!isRecord(item) || item.type !== "function_call_output" || typeof item.call_id !== "string" || !customCallIds.has(item.call_id)) return item;
        return { type: "custom_tool_call_output", call_id: item.call_id, output: item.output };
      })
      : calls;
  }
  if (prepared.structured !== undefined) {
    body.text = { ...(isRecord(body.text) ? body.text : {}), format: structuredToJsonSchemaFormat(prepared.structured) };
  }
  const choice = prepared.toolChoice;
  if (choice !== undefined) {
    if (choice.type === "tool") body.tool_choice = { type: "function", name: choice.toolName };
    else body.tool_choice = choice.type;
  }
}

function applyAnthropicExtras(body: Json, prepared: PreparedRequest, registry: ToolRegistry): void {
  // 引擎把 system 写为内容块数组；合同保留字符串形状（多段以 \n\n 连接）。
  if (Array.isArray(body.system)) {
    const texts = body.system
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .filter((text) => text !== "");
    if (texts.length > 0) body.system = texts.join("\n\n");
    else delete body.system;
  }
  const choice = prepared.toolChoice;
  if (choice !== undefined) {
    if (choice.type === "tool") body.tool_choice = { type: "tool", name: choice.toolName };
    else body.tool_choice = { type: choice.type === "required" ? "any" : choice.type };
  }
  if (prepared.disableParallelToolUse === true) {
    const current = isRecord(body.tool_choice) ? body.tool_choice : { type: "auto" };
    if (current.type !== "none") body.tool_choice = { ...current, disable_parallel_tool_use: true };
  }
  if (prepared.structured !== undefined) {
    registry.note("结构化输出在 anthropic 目标没有对应字段，已丢弃（json_schema/json_object）");
  }
}

/* ================================ 主入口 ================================ */

function collectPassthroughIdentityNames(to: ClientProtocol, body: Json, registry: ToolRegistry): void {
  if (to === "responses") {
    // 只注册身份，不需要声明表：按 responses 声明结构展平收集原名。
    const visit = (entries: unknown, namespace?: string): void => {
      for (const raw of asArray(entries)) {
        if (!isRecord(raw)) continue;
        if (raw.type === "namespace") {
          visit(raw.tools, typeof raw.name === "string" ? raw.name : namespace);
          continue;
        }
        if (raw.type === "function" || raw.type === "custom") {
          if (typeof raw.name === "string" && raw.name) registry.registerIdentity(raw.name, namespace, raw.type === "custom");
        }
      }
    };
    visit(body.tools);
    return;
  }
  if (to === "chat-completions") {
    for (const raw of asArray(body.tools)) {
      if (!isRecord(raw)) continue;
      if (raw.type === "custom") {
        registry.registerIdentity(requiredString(raw.name, "工具 name"), undefined, true);
      } else if (raw.type === "function" && isRecord(raw.function)) {
        registry.registerIdentity(requiredString(raw.function.name, "工具 name"), undefined, false);
      }
    }
    return;
  }
  if (to === "gemini") {
    for (const raw of asArray(body.tools)) {
      if (!isRecord(raw) || !Array.isArray(raw.functionDeclarations)) continue;
      for (const declaration of raw.functionDeclarations) {
        if (isRecord(declaration) && typeof declaration.name === "string" && declaration.name) {
          registry.registerIdentity(declaration.name, undefined, false);
        }
      }
    }
    return;
  }
  for (const raw of asArray(body.tools)) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) continue;
    registry.registerIdentity(raw.name, undefined, false);
  }
}

export async function convertRequest(
  /** 上游 endpoint 协议（from）：桥接拼装的目标、响应的源头。 */
  from: ClientProtocol,
  /** 调用方 route 协议（to）：请求的源协议、响应的终点。 */
  to: ClientProtocol,
  inputBody: unknown,
  options?: ConvertRequestOptions,
): Promise<ConvertRequestResult> {
  if (!isRecord(inputBody)) fail("请求正文必须是 JSON 对象");
  const notes: string[] = [];
  const body = to === "responses" ? normalizeResponsesToolDeclarations(inputBody) : inputBody;
  const registry = new ToolRegistry(notes, options?.mapToolName);

  if (to === from) {
    // 原生 Responses 保留声明在历史中的位置与缓存前缀；只用合并视图收集身份。
    // （body 未改名，映射名与实际工具一致），供响应侧还原，且不进入 AI SDK 引擎。
    collectPassthroughIdentityNames(to, body, registry);
    const passthrough = structuredClone(inputBody);
    if (options?.model !== undefined) passthrough.model = options.model;
    return { body: passthrough, tools: registry.map, notes, strippedTools: registry.strippedTools };
  }

  if (body !== inputBody) notes.push("已合并 additional_tools 工具声明并移除历史信封");

  const prepared = to === "responses"
    ? responsesSourceToPrepared(body, registry)
    : to === "chat-completions"
      ? chatSourceToPrepared(body, registry)
      : to === "gemini"
        ? geminiSourceToPrepared(body, registry)
        : anthropicSourceToPrepared(body, registry);
  if (options?.model !== undefined) prepared.model = options.model;

  // 目标特定前置调整：anthropic 必须有 max_tokens；responses 无 stop 字段。
  if (from === "anthropic" && prepared.maxOutputTokens === undefined) {
    prepared.maxOutputTokens = 1024;
    registry.note("源请求未指定 token 上限；anthropic 目标要求 max_tokens，已用 1024 占位，插件可覆盖服务默认值");
  }
  if (from === "responses" && prepared.stopSequences !== undefined) {
    registry.note("源请求的 stop 序列在 responses 目标没有对应字段，已丢弃");
    prepared.stopSequences = undefined;
  }
  if (from === "gemini") {
    // 引擎的 gemini provider 会下载 URL 文件，违反离线边界：显式能力错误。
    for (const message of prepared.prompt) {
      const parts = message.content as unknown[] | string;
      if (typeof parts !== "string" && parts.some((part) => isRecord(part) && part.type === "file" && isRecord(part.data) && part.data.type === "url")) {
        fail("gemini 目标不能保留图片 URL（引擎需下载才能内联）；请插件层预先转 base64 或改传其他目标协议");
      }
    }
    if (prepared.reasoningEffort !== undefined) {
      registry.note("reasoning effort 在 gemini 目标未映射 thinkingLevel（预算/档位由插件按服务合同设置）");
    }
  }

  const emitted = await buildTargetBody(from, prepared);
  // 引擎使用盐化 modelId（见 engine.ts）；真实模型名可缺省（插件后处理负责写入）。
  if (prepared.model) emitted.model = prepared.model;
  else delete emitted.model;
  if (from === "chat-completions") {
    applyToolStrict("chat-completions", emitted, prepared);
    applyChatExtras(emitted, prepared);
  } else if (from === "responses") {
    applyToolStrict("responses", emitted, prepared);
    applyResponsesExtras(emitted, prepared, registry);
  } else if (from === "anthropic") {
    applyAnthropicExtras(emitted, prepared, registry);
  }

  return { body: deepStripUndefined(stripUndefined(emitted)) as Json, tools: registry.map, notes, strippedTools: registry.strippedTools };
}
