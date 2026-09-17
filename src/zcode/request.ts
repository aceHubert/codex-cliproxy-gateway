import { translateBetweenProviders } from "llm-bridge";
import { createHash } from "node:crypto";
import { decodeZcodeThinking, isZcodeRecord } from "./wire.ts";
import type { ZcodeTranslatedRequest, ZcodeToolMap } from "./wire.ts";
import { ANALYZE_IMAGE_SYSTEM_NOTE, ANALYZE_IMAGE_TOOL_DECLARATION, ANALYZE_IMAGE_TOOL_NAME, collectZcodeImages } from "./vision.ts";

export class ZcodeRequestError extends Error {
  constructor(message: string) { super(message); this.name = "ZcodeRequestError"; }
}

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: Block[] };

const CUSTOM_INPUT_SCHEMA = {
  type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false,
};
const THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 10240, max: 10240, ultra: 10240,
};

function fail(message: string): never { throw new ZcodeRequestError(message); }
function record(value: unknown): value is Record<string, unknown> { return isZcodeRecord(value); }
function string(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} 必须是字符串`);
  return value;
}
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${field} 必须是正整数`);
  return value;
}
function safeToolName(name: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(name)) return name;
  const base = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "tool_") || "tool";
  return `${base.slice(0, 112)}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}
function addMessage(messages: Message[], role: "user" | "assistant", blocks: Block[]): void {
  if (!blocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function image(part: Record<string, unknown>): Block {
  const source = part.image_url ?? part.url;
  const url = typeof source === "string" ? source : record(source) ? source.url : undefined;
  if (typeof url !== "string" || !url) fail("input_image 缺少 image_url");
  const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
  return data
    ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
    : { type: "image", source: { type: "url", url } };
}
function content(value: unknown, field: string): Block[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) fail(`${field} 必须是字符串或内容数组`);
  return value.map((raw) => {
    if (!record(raw)) fail(`${field} 包含无效内容块`);
    if (raw.type === "input_text" || raw.type === "output_text" || raw.type === "text") {
      return { type: "text", text: string(raw.text, `${field}.text`) };
    }
    if (raw.type === "input_image" || raw.type === "image") return image(raw);
    fail(`${field} 包含不支持的内容块类型 ${String(raw.type)}`);
  });
}
function callInput(value: unknown, custom: boolean): Record<string, unknown> {
  if (custom) return { input: string(value, "custom_tool_call.input") };
  if (record(value)) return value;
  if (typeof value !== "string") fail("function_call 的 arguments 必须是 JSON 对象或 JSON 字符串");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!record(parsed)) fail("function_call 的 arguments 必须解码为 JSON 对象");
    return parsed;
  } catch (cause) {
    if (cause instanceof ZcodeRequestError) throw cause;
    fail("function_call 的 arguments 不是有效 JSON 对象");
  }
}
function toolResult(value: unknown): string | Block[] {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (record(part) && part.type === "input_image") return image(part);
      if (!record(part) || (part.type !== "input_text" && part.type !== "output_text" && part.type !== "text")) {
        fail("function_call_output 包含不支持的内容块");
      }
      return { type: "text", text: string(part.text, "tool 输出文本") };
    });
  }
  return JSON.stringify(value ?? null);
}

function bridgeText(input: string, model: string, maxTokens: number): Message[] {
  // llm-bridge 是普通 Responses 文本的基础转换器；其遗漏的工具与 custom 语义由下方严格补齐。
  const converted = translateBetweenProviders("openai-responses", "anthropic", {
    model, input, max_output_tokens: maxTokens,
  }) as unknown;
  if (!record(converted) || !Array.isArray(converted.messages)) fail("llm-bridge 未返回有效 Anthropic 请求");
  return converted.messages.map((raw) => {
    if (!record(raw) || (raw.role !== "user" && raw.role !== "assistant") || !Array.isArray(raw.content)) {
      fail("llm-bridge 返回了无效消息");
    }
    return { role: raw.role, content: raw.content.filter(record) };
  });
}

function toolIdentity(rawName: unknown, rawNamespace?: unknown): { name: string; original: string; namespace?: string } {
  const original = string(rawName, "工具 name");
  if (!original) fail("工具 name 不能为空");
  const namespace = rawNamespace === undefined || rawNamespace === null ? undefined : string(rawNamespace, "工具 namespace");
  if (namespace === "") fail("工具 namespace 不能为空");
  // 数组编码区分 namespace/name 和带点的普通工具名，声明与历史共享稳定映射。
  const name = safeToolName(namespace === undefined ? original : JSON.stringify([namespace, original]));
  return { name, original, ...(namespace === undefined ? {} : { namespace }) };
}
/** z.ai 对 web_search_20250305 的实测回放形状：工具名映射为 web_search_prime，query 走 search_query。 */
function serverToolQuery(input: Record<string, unknown>): string {
  for (const key of ["search_query", "query"]) {
    if (typeof input[key] === "string" && input[key]) return input[key] as string;
  }
  return "";
}
function webSearchServerTool(raw: Block): Block {
  const tool: Block = { type: "web_search_20250305", name: typeof raw.name === "string" && raw.name ? raw.name : "web_search" };
  if (typeof raw.max_uses === "number") tool.max_uses = raw.max_uses;
  const filters = record(raw.filters) ? raw.filters : undefined;
  if (filters && Array.isArray(filters.allowed_domains)) tool.allowed_domains = filters.allowed_domains;
  if (record(raw.user_location)) tool.user_location = raw.user_location;
  return tool;
}
function translateTools(value: unknown): { tools: Block[]; map: ZcodeToolMap; serverTools: Block[]; dropped: Set<string> } {
  const tools: Block[] = [];
  const serverTools: Block[] = [];
  const map: ZcodeToolMap = new Map();
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
        // 服务器内置工具按上游原生等价物映射；客户端显式禁用外部访问或嵌在 namespace 内时降级剥离。
        if (raw.external_web_access === false || namespace !== undefined) dropped.add("web_search");
        else serverTools.push(webSearchServerTool(raw));
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
      const tool: Block = { name: identity.name, input_schema: custom ? CUSTOM_INPUT_SCHEMA : raw.parameters };
      const details = [description, typeof raw.description === "string" ? raw.description : undefined].filter((item) => item !== undefined);
      if (details.length) tool.description = details.join("\n\n");
      tools.push(tool);
      map.set(identity.name, { name: identity.original, custom, ...(namespace === undefined ? {} : { namespace }) });
    }
  }
  if (value !== undefined) visit(value);
  return { tools, map, serverTools, dropped };
}
function callTool(raw: Block, tools: ZcodeToolMap): { name: string; custom: boolean } {
  const identity = toolIdentity(raw.name, raw.namespace);
  const tool = tools.get(identity.name);
  if (!tool || tool.name !== identity.original || tool.namespace !== identity.namespace) fail(`工具选择引用了未声明的工具 ${identity.original}`);
  if (tool.custom !== (raw.type === "custom")) fail("tool_choice 与工具声明类型不一致");
  return { name: identity.name, custom: tool.custom };
}

function webSearchCallQuery(item: Block): string {
  const action = record(item.action) ? item.action : {};
  for (const key of ["query", "url"]) {
    if (typeof action[key] === "string" && action[key]) return action[key] as string;
  }
  if (Array.isArray(action.queries)) {
    const first = action.queries.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
    if (first) return first;
  }
  return "";
}
/** Responses 的 web_search_call id（ws_ 前缀）还原为上游服务端工具 id；空缺时生成同形 id。 */
function webSearchUpstreamID(item: Block): string {
  const raw = typeof item.id === "string" ? item.id.replace(/^ws_/, "").replace(/[^A-Za-z0-9_]/g, "") : "";
  return raw || `call_ws${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 24)}`;
}
function webSearchResultContent(item: Block): Array<{ type: "text"; text: string }> {
  if (!Array.isArray(item.results)) return [];
  const parts: string[] = [];
  for (const entry of item.results) {
    if (!record(entry)) continue;
    const line = [entry.title, entry.url, entry.text].filter((field): field is string => typeof field === "string" && field.length > 0);
    if (line.length) parts.push(line.join("\n"));
  }
  return parts.map((text) => ({ type: "text" as const, text }));
}
function serverCallSummary(item: Block): Block {
  const query = item.type === "web_search_call" ? webSearchCallQuery(item) : "";
  const detail = query ? `（查询：${query}）` : "";
  return { type: "text", text: `[已省略服务器内置工具调用 ${String(item.type)}${detail}；本通道不支持该工具]` };
}
function translateInput(input: unknown, model: string, maxTokens: number, nativeWebSearch: boolean): { messages: Message[]; system: string[] } {
  if (typeof input === "string") return { messages: bridgeText(input, model, maxTokens), system: [] };
  if (!Array.isArray(input)) fail("input 必须是字符串或数组");
  const messages: Message[] = [];
  const system: string[] = [];
  const calls = new Map<string, "function_call" | "custom_tool_call">();
  const results = new Set<string>();
  for (const item of input) {
    if (!record(item)) fail("input 包含非对象 history 项");
    if (item.type === "reasoning") {
      const blocks = decodeZcodeThinking(item.encrypted_content, model);
      // 外部或不同模型的私有载荷不能转发；自身匹配的载荷按原块还原。
      if (blocks) addMessage(messages, "assistant", blocks);
      continue;
    }
    if (item.type === "message" || item.type === undefined) {
      if (item.role === "system" || item.role === "developer") {
        for (const block of content(item.content, `${item.role} 消息`)) {
          if (block.type !== "text") fail(`${item.role} 消息不支持图片`);
          system.push(string(block.text, `${item.role} 消息文本`));
        }
        continue;
      }
      if (item.role !== "user" && item.role !== "assistant") fail(`不支持的消息 role ${String(item.role)}`);
      addMessage(messages, item.role, content(item.content, `${item.role} 消息`));
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const tool = toolIdentity(item.name, item.namespace);
      const custom = item.type === "custom_tool_call";
      const callId = string(item.call_id ?? item.id, `${item.type}.call_id`);
      if (calls.has(callId)) fail(`history 中重复的工具调用 ID ${callId}`);
      calls.set(callId, item.type);
      addMessage(messages, "assistant", [{
        type: "tool_use", id: callId, name: tool.name,
        input: callInput(custom ? item.input : item.arguments, custom),
      }]);
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
      addMessage(messages, "user", [{
        type: "tool_result", tool_use_id: callId, content: toolResult(item.output ?? item.content),
      }]);
      continue;
    }
    if (item.type === "web_search_call") {
      const query = webSearchCallQuery(item);
      if (nativeWebSearch) {
        // 还原为 z.ai 实测回放形状：server_tool_use（web_search_prime/search_query）+ 同轮 tool_result 文本块。
        const id = webSearchUpstreamID(item);
        const content = webSearchResultContent(item);
        addMessage(messages, "assistant", [
          { type: "server_tool_use", id, name: "web_search_prime", input: query ? { search_query: query } : {} },
          { type: "tool_result", tool_use_id: id, content },
        ]);
      } else {
        addMessage(messages, "assistant", [serverCallSummary(item)]);
      }
      continue;
    }
    if (typeof item.type === "string" && (item.type.endsWith("_call") || item.type === "mcp_list_tools" || item.type === "mcp_list_resources")) {
      // 其余服务器执行的历史调用（file_search_call、image_generation_call、托管 MCP 等）无法在上游执行，降级为文本摘要。
      addMessage(messages, "assistant", [serverCallSummary(item)]);
      continue;
    }
    fail(`不支持的 Responses history 项类型 ${typeof item.type === "string" ? item.type : "unknown"}`);
  }
  return { messages, system };
}
function translateChoice(value: unknown, tools: ZcodeToolMap, parallel: unknown): Block | undefined {
  if (parallel !== undefined && typeof parallel !== "boolean") fail("parallel_tool_calls 必须是布尔值");
  const noParallel = parallel === false;
  if (value === undefined) return noParallel ? { type: "auto", disable_parallel_tool_use: true } : undefined;
  let choice: Block;
  if (value === "auto") choice = { type: "auto" };
  else if (value === "none") choice = { type: "none" };
  else if (value === "required") choice = { type: "any" };
  else if (record(value) && (value.type === "function" || value.type === "custom")) choice = { type: "tool", name: callTool(value, tools).name };
  else if (record(value) && typeof value.type === "string" && value.type !== "") {
    // 指向服务器内置工具（含被剥离工具）的选择无法跨格式表达，省略让上游回到默认 auto。
    return noParallel ? { type: "auto", disable_parallel_tool_use: true } : undefined;
  } else fail("不支持的 tool_choice");
  if (noParallel && choice.type !== "none") choice.disable_parallel_tool_use = true;
  return choice;
}

export function translateZcodeRequest(body: Record<string, unknown>, upstreamModel: string): ZcodeTranslatedRequest {
  if (typeof upstreamModel !== "string" || !upstreamModel) fail("上游模型不能为空");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && body.previous_response_id !== "") {
    fail("ZCode 不支持 previous_response_id；请提供完整 input 历史");
  }
  if (body.conversation !== undefined && body.conversation !== null && body.conversation !== "") {
    fail("ZCode 不支持 conversation；请提供完整 input 历史");
  }
  if (body.background === true) fail("ZCode 不支持 background 请求");
  for (const format of [body.response_format, record(body.text) ? body.text.format : undefined]) {
    if (format !== undefined && (!record(format) || format.type !== "text")) fail("ZCode 不支持 Responses 的结构化输出格式");
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") fail("instructions 必须是字符串");

  const maxTokens = body.max_output_tokens === undefined ? 16384 : positiveInteger(body.max_output_tokens, "max_output_tokens");
  const convertedTools = translateTools(body.tools);
  const nativeWebSearch = convertedTools.serverTools.length > 0;
  const clientModel = body.model === undefined ? upstreamModel : string(body.model, "model");
  const convertedInput = translateInput(body.input, clientModel, maxTokens, nativeWebSearch);
  const system = [...(body.instructions ? [body.instructions] : []), ...convertedInput.system];
  if (convertedTools.dropped.size) {
    // 剥离后必须告知模型，否则模型会声称拥有已被移除的能力。
    system.push(`本通道无法执行以下服务器内置工具，已从本请求移除：${[...convertedTools.dropped].join("、")}。请勿声称已使用这些工具。`);
  }
  // 请求含图片时声明网关代执行的 analyze_image（GLM 文本模型经此识别图片）；
  // 客户端自己声明了同名工具则让位，不注入适配说明避免行为冲突。
  const images = collectZcodeImages(convertedInput.messages);
  const vision = images.length > 0 && !convertedTools.map.has(ANALYZE_IMAGE_TOOL_NAME);
  if (vision) {
    convertedTools.tools.push(ANALYZE_IMAGE_TOOL_DECLARATION);
    convertedTools.map.set(ANALYZE_IMAGE_TOOL_NAME, { name: ANALYZE_IMAGE_TOOL_NAME, custom: false, gateway: "analyze_image" });
    system.push(ANALYZE_IMAGE_SYSTEM_NOTE);
  }
  const translated: Record<string, unknown> = { model: upstreamModel, stream: true, max_tokens: maxTokens, messages: convertedInput.messages };
  if (system.length) translated.system = system.join("\n\n");
  if (convertedTools.tools.length || convertedTools.serverTools.length) translated.tools = [...convertedTools.tools, ...convertedTools.serverTools];
  if (body.temperature !== undefined) translated.temperature = body.temperature;
  if (body.top_p !== undefined) translated.top_p = body.top_p;
  const choice = translateChoice(body.tool_choice, convertedTools.map, body.parallel_tool_calls);
  if (choice) translated.tool_choice = choice;
  if (body.reasoning !== undefined) {
    if (!record(body.reasoning)) fail("reasoning 必须是对象");
    if (body.reasoning.effort === "none") translated.thinking = { type: "disabled" };
    else if (body.reasoning.effort !== undefined) {
      const effort = body.reasoning.effort;
      if (typeof effort !== "string" || THINKING_BUDGETS[effort] === undefined) fail("不支持的 reasoning.effort");
      const budget = Math.min(THINKING_BUDGETS[effort], maxTokens - 1);
      if (budget < 1024) fail("启用 reasoning 至少需要 max_output_tokens 为 1025");
      translated.thinking = { type: "enabled", budget_tokens: budget };
    }
  }
  return { body: translated, tools: convertedTools.map, dropped: [...convertedTools.dropped], vision, images };
}
