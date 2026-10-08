import { createHash } from "node:crypto";
import { AGY_DEFAULT_PROJECT } from "./transport.ts";

/**
 * Codex Responses → Antigravity v1internal generateContent 请求转换。
 *
 * 外层是 v1internal 包装（project/request_id/user_prompt_id/user_agent/request），
 * 内层是 Gemini/Vertex 风格的 contents + systemInstruction + tools + generationConfig。
 * 按现有适配器的严格风格手写全量转换：不支持的字段显式报 400，不支持的服务器内置
 * 工具降级为系统旁白；思考文本历史不回放（thought 属于模型私有态），但响应侧经
 * agn1: 信封下发的 thoughtSignature 会挂回下一个函数调用（上游强制要求）。
 */

export class AgyRequestError extends Error {
  constructor(message: string) { super(message); this.name = "AgyRequestError"; }
}

export interface AgyToolIdentity {
  name: string;
  custom: boolean;
  namespace?: string;
}
export type AgyToolMap = Map<string, AgyToolIdentity>;

export interface AgyTranslatedRequest {
  /** v1internal 外层包装，序列化后直接作为 streamGenerateContent 的 body。 */
  wrapper: Record<string, unknown>;
  tools: AgyToolMap;
  dropped: string[];
}

type GeminiPart = Record<string, unknown>;
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function fail(message: string): never { throw new AgyRequestError(message); }
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

function textPart(value: Record<string, unknown>, field: string): GeminiPart {
  return { text: string(value.text, `${field}.text`) };
}

function systemText(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) fail(`${field} 必须是字符串或内容数组`);
  const parts: string[] = [];
  for (const raw of value) {
    if (!record(raw)) fail(`${field} 包含无效内容块`);
    if (raw.type === "input_text" || raw.type === "output_text" || raw.type === "text") {
      parts.push(string(raw.text, `${field}.text`));
    } else {
      fail(`${field} 的 system 内容不支持图片等非文本块`);
    }
  }
  return parts.join("\n\n");
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

/** 本地 $ref 的指针形态：`#/$defs/name` 或 `#/definitions/name`。 */
const LOCAL_REF_PATTERN = /^#\/(?:\$defs|definitions)\/(.+)$/;

/** Gemini Schema 的已知合法键（protojson 严格模式：白名单外的键一律剥除）。
 *  additionalProperties/oneOf 有真实 200 实证；其余为 Gemini 公开 Schema 字段。 */
const GEMINI_SCHEMA_KEYS = new Set([
  "type", "format", "title", "description", "nullable", "default", "items", "maxItems", "minItems",
  "enum", "properties", "required", "minimum", "maximum", "minLength", "maxLength", "pattern",
  "example", "anyOf", "oneOf", "propertyOrdering", "additionalProperties",
]);

/** enum/const 的字面量统一转字符串：Gemini 的 enum 是 repeated string。 */
function literalToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * JSON Schema → 上游可接受的形态。上游是 protojson 严格模式，任何未知字段（`$ref`/
 * `const`/`deprecated`/`x-*` 扩展/`exclusiveMinimum` 等 JSON Schema 词汇）都会 400，
 * 因此按 Gemini Schema 白名单重建 schema：本地 `$ref` 内联展开（悬空/外部/循环按
 * `{}` 兜底），联合 `type` 数组拆解为单值 + nullable 或 anyOf，`const` 转 enum，
 * 元组形 `items` 数组转 anyOf，非字符串 enum 字面量转字符串，白名单外的键剥除。
 */
function sanitizeToolSchema(input: Record<string, unknown>): Record<string, unknown> {
  const root = structuredClone(input);
  const defs = new Map<string, unknown>();
  for (const key of ["$defs", "definitions"] as const) {
    const section = root[key];
    if (record(section)) {
      for (const [name, schema] of Object.entries(section)) defs.set(name, schema);
      delete root[key];
    }
  }
  const walk = (value: unknown, stack: Set<string>): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, stack));
    if (!record(value)) return value;
    if (typeof value.$ref === "string") {
      const match = LOCAL_REF_PATTERN.exec(value.$ref);
      const name = match?.[1];
      if (!name || !defs.has(name) || stack.has(name)) return {};
      stack.add(name);
      const inlined = walk(structuredClone(defs.get(name)), stack);
      stack.delete(name);
      if (!record(inlined)) return {};
      const merged = { ...value };
      delete merged.$ref;
      return { ...inlined, ...walk(merged, stack) as Record<string, unknown> };
    }
    const out: Record<string, unknown> = {};
    // JSON Schema 联合类型数组（如 ["string","null"]）：拆成单值 type + nullable，
    // 多个非空类型转 anyOf——protojson 的 type 是单值枚举，数组直接 400。
    const typeList = Array.isArray(value.type) ? value.type as unknown[] : undefined;
    if (typeList) {
      const nonNull = typeList.filter((item): item is string => typeof item === "string" && item !== "null" && item !== "");
      if (nonNull.length === 1) out.type = nonNull[0];
      else if (nonNull.length > 1 && value.anyOf === undefined) {
        out.anyOf = nonNull.map((type) => ({ type }));
      }
      if (typeList.includes("null")) out.nullable = true;
    }
    // const 单字面量约束转 enum（白名单里没有 const）。
    if (value.const !== undefined && value.enum === undefined) out.enum = [literalToString(value.const)];
    // 元组形 items 数组（draft-07 位置校验）无法表达，退化为 anyOf 并集。
    const itemsList = Array.isArray(value.items) ? value.items as unknown[] : undefined;
    if (itemsList) out.items = { anyOf: itemsList.map((item) => walk(item, stack)) };
    for (const [key, entry] of Object.entries(value)) {
      if (key === "type" && typeList !== undefined) continue;
      if (key === "items" && itemsList !== undefined) continue;
      if (key === "const") continue;
      if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
      // properties 是 map<string, Schema>：属性名是 map 键不是 schema 键，值按普通 schema 走。
      if (key === "properties") {
        out.properties = record(entry)
          ? Object.fromEntries(Object.entries(entry).map(([name, schema]) => [name, walk(schema, stack)]))
          : {};
        continue;
      }
      // enum 是 repeated string：布尔/数字等非字符串字面量统一转字符串（true -> "true"）。
      if (key === "enum" && Array.isArray(entry)) {
        out.enum = entry.map(literalToString);
        continue;
      }
      out[key] = walk(entry, stack);
    }
    return out;
  };
  return walk(root, new Set()) as Record<string, unknown>;
}

/** Gemini 的 functionResponse.response 必须是对象：对象原样，标量包成 { output }。 */
function functionResponsePayload(value: unknown): Record<string, unknown> {
  if (record(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (record(parsed)) return parsed;
    } catch { /* 非 JSON 文本按原文包装。 */ }
    return value ? { output: value } : {};
  }
  return { output: JSON.stringify(value ?? null) };
}

function toolResultParts(value: unknown, field: string): { text: string; hasContent: boolean } {
  if (typeof value === "string") return { text: value, hasContent: value.length > 0 };
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const part of value) {
      if (!record(part)) fail(`${field} 包含无效内容块`);
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        const text = string(part.text, `${field} 文本`);
        if (text) texts.push(text);
      } else {
        // Gemini 的 functionResponse 放不了多模态：图片等结果块降级为占位说明。
        texts.push(`[工具输出包含不支持的内容块 ${String(part.type)}，已省略]`);
      }
    }
    return { text: texts.join(""), hasContent: texts.length > 0 };
  }
  return { text: "", hasContent: false };
}

function serverCallSummary(item: Record<string, unknown>): string {
  const action = record(item.action) ? item.action : {};
  const query = [action.query, action.url].find((field): field is string => typeof field === "string" && field.length > 0);
  const detail = query ? `（查询：${query}）` : "";
  return `[已省略服务器内置工具调用 ${String(item.type)}${detail}；本通道不支持该工具]`;
}

/** reasoning.effort → Gemini thinkingLevel；unknown 档位映射到最近的低/高档。
 *  档位名同时是多档位家族的上游变体后缀，catalog.ts 复用该映射做 effort → 变体解析。 */
export const THINKING_LEVELS: Record<string, string> = {
  minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
};

function translateTools(value: unknown): { tools: Array<Record<string, unknown>>; map: AgyToolMap; dropped: Set<string> } {
  const tools: Array<Record<string, unknown>> = [];
  const map: AgyToolMap = new Map();
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
      if (raw.type !== "function" && raw.type !== "custom") {
        dropped.add(typeof raw.type === "string" ? raw.type : "unknown");
        continue;
      }
      // namespace 既可能是 type=namespace 的包裹项，也可能是声明上的扁平字段
      // （与 history 调用项的 namespace 字段对应）；两者取其一，避免映射名不一致。
      const flat = namespace === undefined && typeof raw.namespace === "string" && raw.namespace
        ? raw.namespace : undefined;
      const identity = toolIdentity(raw.name, namespace ?? flat);
      if (map.has(identity.name)) fail(`工具名映射冲突：${identity.original}`);
      const custom = raw.type === "custom";
      const schema = record(raw.parameters) ? raw.parameters : undefined;
      if (!custom && schema === undefined) fail(`function 工具 ${identity.original} 缺少对象 parameters`);
      const details = [description, typeof raw.description === "string" ? raw.description : undefined]
        .filter((item): item is string => item !== undefined);
      tools.push({
        name: identity.name,
        ...(details.length ? { description: details.join("\n\n") } : {}),
        // parameters 原样透传会带 $ref/$defs 等 JSON Schema 元字段，上游 protojson 直接 400。
        parameters: custom ? CUSTOM_TOOL_PARAMETERS : sanitizeToolSchema(schema!),
      });
      map.set(identity.name, { name: identity.original, custom, ...((namespace ?? flat) === undefined ? {} : { namespace: (namespace ?? flat) as string }) });
    }
  }
  if (value !== undefined) visit(value);
  return { tools, map, dropped };
}

export function translateAgyRequest(body: Record<string, unknown>, upstreamModel: string): AgyTranslatedRequest {
  if (typeof upstreamModel !== "string" || !upstreamModel) fail("上游模型不能为空");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && body.previous_response_id !== "") {
    fail("Antigravity 不支持 previous_response_id；请提供完整 input 历史");
  }
  if (body.conversation !== undefined && body.conversation !== null && body.conversation !== "") {
    fail("Antigravity 不支持 conversation；请提供完整 input 历史");
  }
  if (body.background === true) fail("Antigravity 不支持 background 请求");
  for (const format of [body.response_format, record(body.text) ? body.text.format : undefined]) {
    if (format !== undefined && (!record(format) || format.type !== "text")) fail("Antigravity 不支持 Responses 的结构化输出格式");
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") fail("instructions 必须是字符串");
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") fail("parallel_tool_calls 必须是布尔值");

  const maxTokens = body.max_output_tokens === undefined ? 16384 : positiveInteger(body.max_output_tokens, "max_output_tokens");
  const convertedTools = translateTools(body.tools);
  const contents: GeminiContent[] = [];
  const system: string[] = [];
  const callNames = new Map<string, { mapped: string; custom: boolean }>();
  const results = new Set<string>();
  // 回放历史时待挂回的 thought 签名（来自响应侧 agn1: 信封的 reasoning 项）。
  let pendingSignature: string | undefined;
  let pendingAssistant: GeminiContent | undefined;
  const assistantContent = (): GeminiContent => {
    if (pendingAssistant && contents.at(-1) === pendingAssistant) return pendingAssistant;
    pendingAssistant = { role: "model", parts: [] };
    contents.push(pendingAssistant);
    return pendingAssistant;
  };
  const userContent = (): GeminiContent => {
    pendingAssistant = undefined;
    const content: GeminiContent = { role: "user", parts: [] };
    contents.push(content);
    return content;
  };

  const input = body.input;
  if (typeof input === "string") {
    userContent().parts.push({ text: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!record(item)) fail("input 包含非对象 history 项");
      if (item.type === "reasoning") {
        // thought signature 无法跨请求回放；但响应侧经 agn1: 信封下发的 thoughtSignature
        // 必须挂回下一个函数调用（上游强制要求，缺失直接 400）。官方模型的加密内容不带
        // 该前缀，忽略。
        const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
        if (encrypted !== undefined && encrypted.startsWith("agn1:")) pendingSignature = encrypted.slice(5);
        pendingAssistant = undefined;
        continue;
      }
      if (item.type === "message" || item.type === undefined) {
        if (item.role === "system" || item.role === "developer") {
          pendingAssistant = undefined;
          system.push(systemText(item.content, `${item.role} 消息`));
          continue;
        }
        if (item.role !== "user" && item.role !== "assistant") fail(`不支持的消息 role ${String(item.role)}`);
        const parts: GeminiPart[] = [];
        const content = item.content;
        if (typeof content === "string") parts.push({ text: content });
        else if (Array.isArray(content)) {
          for (const raw of content) {
            if (!record(raw)) fail(`${item.role} 消息包含无效内容块`);
            if (raw.type === "input_text" || raw.type === "output_text" || raw.type === "text") parts.push(textPart(raw, "消息"));
            else if (raw.type === "input_image" || raw.type === "image") {
              const source = raw.image_url ?? raw.url;
              const url = typeof source === "string" ? source : record(source) ? source.url : undefined;
              if (typeof url !== "string" || !url) fail("input_image 缺少 image_url");
              // data: URI 走 inlineData（base64 内联），其余 URL 走 fileData.fileUri；
              // master.Part 没有 uri 字段，protojson 会拒绝未知字段。
              if (url.startsWith("data:")) {
                const match = /^data:([^;,]*)(?:;charset=[^;,]*)?;base64,(.*)$/s.exec(url);
                if (!match) fail("input_image 的 data URI 必须是 base64 编码");
                parts.push({ inlineData: { mimeType: match[1] || "image/png", data: match[2] } });
              } else {
                parts.push({ fileData: { fileUri: url } });
              }
            } else fail(`${item.role} 消息包含不支持的内容块类型 ${String(raw.type)}`);
          }
        } else fail(`${item.role} 消息的 content 必须是字符串或数组`);
        (item.role === "assistant" ? assistantContent() : userContent()).parts.push(...parts);
        continue;
      }
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const identity = toolIdentity(item.name, item.namespace);
        const custom = item.type === "custom_tool_call";
        const callId = string(item.call_id ?? item.id, `${item.type}.call_id`);
        if (callNames.has(callId)) fail(`history 中重复的工具调用 ID ${callId}`);
        callNames.set(callId, { mapped: identity.name, custom });
        const rawArguments = custom ? item.input : item.arguments;
        let args: Record<string, unknown>;
        if (custom) args = { input: string(rawArguments, "custom_tool_call.input") };
        else if (record(rawArguments)) args = rawArguments;
        else if (typeof rawArguments === "string") {
          try {
            const parsed: unknown = JSON.parse(rawArguments);
            if (!record(parsed)) fail("function_call 的 arguments 必须解码为 JSON 对象");
            args = parsed;
          } catch (cause) {
            if (cause instanceof AgyRequestError) throw cause;
            fail("function_call 的 arguments 不是有效 JSON 对象");
          }
        } else fail("function_call 的 arguments 必须是 JSON 对象或 JSON 字符串");
        assistantContent().parts.push({
          functionCall: { name: identity.name, args },
          // thoughtSignature 是 Part 级字段（与 functionCall 平级），上游按此校验回放。
          ...(pendingSignature !== undefined ? { thoughtSignature: pendingSignature } : {}),
        });
        pendingSignature = undefined;
        continue;
      }
      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        const callId = string(item.call_id, `${item.type}.call_id`);
        const call = callNames.get(callId);
        if (!call || (item.type === "function_call_output") === call.custom) {
          fail(`${item.type} 未关联到同一 input 中匹配的工具调用 ${callId}`);
        }
        if (results.has(callId)) fail(`history 中重复的工具输出 ID ${callId}`);
        results.add(callId);
        const raw = item.output ?? item.content;
        // Gemini 的 functionResponse.response 必须是对象：对象原样、数组取文本部分、
        // 字符串尝试按 JSON 对象解码，其余形态统一包成 { output }。
        const response = record(raw) ? raw
          : Array.isArray(raw) ? { output: toolResultParts(raw, `${item.type}`).text }
          : functionResponsePayload(raw);
        userContent().parts.push({ functionResponse: { name: call.mapped, response } });
        continue;
      }
      if (typeof item.type === "string" && (item.type.endsWith("_call") || item.type === "mcp_list_tools" || item.type === "mcp_list_resources")) {
        // 其余服务器执行的历史调用无法在上游执行，降级为文本摘要。
        assistantContent().parts.push({ text: serverCallSummary(item) });
        pendingAssistant = undefined;
        continue;
      }
      fail(`不支持的 Responses history 项类型 ${typeof item.type === "string" ? item.type : "unknown"}`);
    }
  } else {
    fail("input 必须是字符串或数组");
  }

  if (convertedTools.dropped.size) {
    system.push(`本通道无法执行以下服务器内置工具，已从本请求移除：${[...convertedTools.dropped].join("、")}。请勿声称已使用这些工具。`);
  }

  // thinkingConfig 按 CLI 真实形态发送：includeThoughts 使 thought 部件随流返回，
  // thinkingBudget=-1 交由服务端按模型档位决定；档位用 thinkingLevel 表达。
  const thinkingConfig: Record<string, unknown> = { includeThoughts: true, thinkingBudget: -1 };
  const reasoning = record(body.reasoning) ? body.reasoning : undefined;
  const effort = reasoning?.effort;
  if (typeof effort === "string" && THINKING_LEVELS[effort]) {
    thinkingConfig.thinkingLevel = THINKING_LEVELS[effort];
  }
  const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens, thinkingConfig };
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) fail("temperature 必须是数值");
    generationConfig.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    if (typeof body.top_p !== "number" || !Number.isFinite(body.top_p)) fail("top_p 必须是数值");
    generationConfig.topP = body.top_p;
  }

  const inner: Record<string, unknown> = {
    contents,
    ...(system.length || body.instructions !== undefined ? {
      systemInstruction: { role: "user", parts: [...(body.instructions !== undefined ? [{ text: body.instructions }] : []), ...system.map((text) => ({ text }))] },
    } : {}),
    ...(convertedTools.tools.length ? { tools: [{ functionDeclarations: convertedTools.tools }] } : {}),
    generationConfig,
  };
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (choice === "auto") inner.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    else if (choice === "none") inner.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (choice === "required") inner.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (record(choice) && (choice.type === "function" || choice.type === "custom")) {
      const identity = toolIdentity(choice.name, choice.namespace);
      if (!convertedTools.map.has(identity.name)) fail(`工具选择引用了未声明的工具 ${identity.original}`);
      inner.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [identity.name] } };
    } else if (record(choice) && typeof choice.type === "string" && choice.type !== "") {
      // 指向服务器内置工具的选择无法跨格式表达，省略让上游回到默认 auto。
    } else fail("不支持的 tool_choice");
  }

  return {
    wrapper: {
      // 外层字段名与归属按 MITM 抓包的真实形状：model 在外层、protojson camelCase、
      // sessionId 为随机 int64 字符串；userAgent 固定 "antigravity"。
      project: AGY_DEFAULT_PROJECT,
      requestId: `checkpoint/${crypto.randomUUID()}`,
      model: upstreamModel,
      userAgent: "antigravity",
      requestType: "checkpoint",
      request: { ...inner, sessionId: `${-Math.floor(Math.random() * 9e18)}` },
    },
    tools: convertedTools.map,
    dropped: [...convertedTools.dropped],
  };
}
