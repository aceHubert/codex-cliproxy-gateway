import { BridgeConversionError, convertRequest, normalizeResponsesToolDeclarations } from "@agent-proxy/llm-bridge";
import type { ToolIdentityMap } from "@agent-proxy/llm-bridge";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import { createHash } from "node:crypto";
import { decodeZcodeThinking, isZcodeRecord } from "./wire.ts";
import type { ZcodeTranslatedRequest, ZcodeToolMap } from "./wire.ts";
import { ANALYZE_IMAGE_SYSTEM_NOTE, ANALYZE_IMAGE_TOOL_DECLARATION, ANALYZE_IMAGE_TOOL_NAME, collectZcodeImages } from "./vision.ts";

/**
 * ZCode 请求准备：标准消息/工具/参数统一经 @agent-proxy/llm-bridge 的
 * convertRequest(to, "anthropic")；z.ai 私有形状（web_search_20250305 服务端工具、
 * thinking 预算表、zcode-thinking 信封回放、analyze_image 代执行）作为插件前后处理。
 *
 * Responses 源的私有 history 项（reasoning / web_search_call / 其它服务器调用）不能
 * 进标准转换：按项把 input 切成「标准段 + 私有项」，标准段逐段调用公共入口，私有段
 * 由本模块转换，最后按 main 的同角色合并语义拼装。
 */

export class ZcodeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZcodeRequestError";
  }
}

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: Block[] };

const CUSTOM_INPUT_SCHEMA = {
  type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false,
};
const THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 10240, max: 10240, ultra: 10240,
};

function fail(message: string): never {
  throw new ZcodeRequestError(message);
}
function record(value: unknown): value is Record<string, unknown> {
  return isZcodeRecord(value);
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
  if (/^[A-Za-z0-9_-]{1,128}$/.test(name)) return name;
  const base = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "tool_") || "tool";
  return `${base.slice(0, 112)}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}
/** 与声明/历史/choice 共用的 zcode 服务安全名策略（作为 mapToolName 传入桥接）。 */
const zcodeToolMapper = (identity: { name: string; namespace?: string }): string =>
  safeToolName(identity.namespace === undefined ? identity.name : JSON.stringify([identity.namespace, identity.name]));
function addMessage(messages: Message[], role: "user" | "assistant", blocks: Block[]): void {
  if (!blocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

/** z.ai 对 web_search_20250305 的实测回放形状：工具名映射为 web_search_prime，query 走 search_query。 */
function serverToolQuery(input: Record<string, unknown>): string {
  for (const key of ["search_query", "query"]) {
    if (typeof input[key] === "string" && (input[key] as string)) return input[key] as string;
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

interface ToolPlan {
  declarations: Block[];
  serverTools: Block[];
  dropped: string[];
}

/** Responses 工具声明规划（web_search 服务端工具、custom/namespace 安全名身份表）。 */
function planResponsesTools(value: unknown, map: ZcodeToolMap): ToolPlan {
  const declarations: Block[] = [];
  const serverTools: Block[] = [];
  const dropped: string[] = [];
  function visit(entries: unknown, namespace?: string, description?: string): void {
    if (!Array.isArray(entries)) fail("tools 必须是数组");
    for (const raw of entries) {
      if (!record(raw)) fail("tools 包含无效声明");
      if (raw.type === "namespace") {
        if (namespace !== undefined) fail("namespace 内仅支持 function 或 custom 工具");
        const segment = string(raw.name, "namespace.name");
        if (!segment) fail("namespace.name 不能为空");
        visit(raw.tools, segment, typeof raw.description === "string" ? raw.description : description);
        continue;
      }
      if (raw.type === "web_search") {
        // 服务器内置工具按上游原生等价物映射；客户端显式禁用外部访问或嵌在 namespace 内时降级剥离。
        if (raw.external_web_access === false || namespace !== undefined) dropped.push("web_search");
        else serverTools.push(webSearchServerTool(raw));
        continue;
      }
      if (raw.type !== "function" && raw.type !== "custom") {
        dropped.push(typeof raw.type === "string" ? raw.type : "unknown");
        continue;
      }
      const custom = raw.type === "custom";
      const original = string(raw.name, "工具 name");
      if (!original) fail("工具 name 不能为空");
      const ns = namespace === undefined || namespace === null ? undefined : string(namespace, "工具 namespace");
      const mapped = zcodeToolMapper({ name: original, namespace: ns });
      if (map.has(mapped)) fail(`工具名映射冲突：${original}`);
      if (!custom && !record(raw.parameters)) fail(`function 工具 ${original} 缺少对象 parameters`);
      const tool: Block = { name: mapped, input_schema: custom ? CUSTOM_INPUT_SCHEMA : raw.parameters };
      const details = [description, typeof raw.description === "string" ? raw.description : undefined].filter((item): item is string => item !== undefined);
      if (details.length) tool.description = details.join("\n\n");
      declarations.push(tool);
      map.set(mapped, { name: original, custom, ...(ns === undefined ? {} : { namespace: ns }) });
    }
  }
  if (value !== undefined) visit(value);
  return { declarations, serverTools, dropped };
}

function webSearchCallQuery(item: Block): string {
  const action = record(item.action) ? item.action : {};
  for (const key of ["query", "url"]) {
    if (typeof action[key] === "string" && (action[key] as string)) return action[key] as string;
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

/** 公共转换结果 → Message[]（anthropic 消息形状校验与收口）。 */
function anthropicMessagesOf(converted: { body: Record<string, unknown> }): Message[] {
  const raw = converted.body.messages;
  if (!Array.isArray(raw)) fail("convertRequest 未返回有效 Anthropic 消息");
  return raw.map((entry) => {
    if (!record(entry) || (entry.role !== "user" && entry.role !== "assistant") || !Array.isArray(entry.content)) {
      fail("convertRequest 返回了无效消息");
    }
    return { role: entry.role as "user" | "assistant", content: entry.content.filter(record) };
  });
}

/** zcode 请求前处理产出的一条执行腿。 */
interface ZcodeRequestLeg {
  /** 标准段：交给桥接统一转换的请求体（responses 源为切段体，其余来源为整个 body）。 */
  body?: Record<string, unknown>;
  /** 私有段：zcode 私有形状（thinking 信封 / web_search 回放 / 服务器调用摘要）就地转换的内容块。 */
  private?: Block[];
}

/**
 * R4 统一请求前处理：responses 源按私有项切段——thinking 信封、web_search 回放
 * 等私有段在本模块就地转换，标准段交给桥接；其余来源没有 zcode 私有项，整段返回。
 * 主路径对所有来源统一执行一次 convertRequest(to, "anthropic", …)；to 表示路由
 * 端点协议（响应方向 anthropic → to 的视角命名，请求方向即桥接的源协议位）。
 */
function segmentZcodeRequestLegs(to: ClientProtocol, body: Record<string, unknown>, options: { nativeWebSearch: boolean; clientModel: string }): ZcodeRequestLeg[] {
  if (to !== "responses") return [{ body }];
  const input = body.input;
  if (typeof input !== "string" && !Array.isArray(input)) fail("input 必须是字符串或数组");
  const items: unknown[] = typeof input === "string" ? [{ type: "message", role: "user", content: input }] : input;
  const legs: ZcodeRequestLeg[] = [];
  let run: unknown[] = [];
  const flush = (): void => {
    if (!run.length) return;
    // 标准段沿用源体的其余字段；instructions 由本层统一管理，不重复下发。
    legs.push({ body: { ...body, input: run, instructions: undefined } });
    run = [];
  };
  for (const item of items) {
    if (!record(item)) fail("Responses input 包含非对象 history 项");
    const type = typeof item.type === "string" ? item.type : "message";
    const privateKind = type === "reasoning" || type === "web_search_call"
      || (type.endsWith("_call") && type !== "function_call" && type !== "custom_tool_call")
      || type === "mcp_list_tools" || type === "mcp_list_resources";
    if (!privateKind) {
      run.push(item);
      continue;
    }
    flush();
    if (type === "reasoning") {
      const blocks = decodeZcodeThinking(item.encrypted_content, options.clientModel);
      // 外部或不同模型的私有载荷不能转发；自身匹配的载荷按原块还原。
      if (blocks) legs.push({ private: blocks });
      continue;
    }
    if (type === "web_search_call") {
      const query = webSearchCallQuery(item);
      if (options.nativeWebSearch) {
        // 还原为 z.ai 实测回放形状：server_tool_use（web_search_prime/search_query）+ 同轮 tool_result 文本块。
        const id = webSearchUpstreamID(item);
        legs.push({ private: [
          { type: "server_tool_use", id, name: "web_search_prime", input: query ? { search_query: query } : {} },
          { type: "tool_result", tool_use_id: id, content: webSearchResultContent(item) },
        ] });
      } else {
        legs.push({ private: [serverCallSummary(item)] });
      }
      continue;
    }
    // 其余服务器执行的历史调用（file_search_call、image_generation_call、托管 MCP 等）无法在上游执行，降级为文本摘要。
    legs.push({ private: [serverCallSummary(item)] });
  }
  flush();
  return legs;
}

/** to 为路由端点（客户端入口）协议：请求方向 to → anthropic，响应方向 anthropic → to。 */
export async function translateZcodeRequest(body: Record<string, unknown>, upstreamModel: string, to: ClientProtocol = "responses"): Promise<ZcodeTranslatedRequest> {
  if (typeof upstreamModel !== "string" || !upstreamModel) fail("上游模型不能为空");
  try {
    // 工具规划与历史切段都要使用提升后的声明，确保增补的搜索与 namespace 工具可见。
    if (to === "responses") body = normalizeResponsesToolDeclarations(body);
  } catch (error) {
    if (error instanceof BridgeConversionError) throw new ZcodeRequestError(error.message);
    throw error;
  }
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

  // 上游 token 上限按来源取参：responses 用 max_output_tokens，chat-completions /
  // anthropic 用 max_tokens，gemini 用 generationConfig.maxOutputTokens；缺省走服务默认 16384。
  const sourceLimit = to === "responses"
    ? body.max_output_tokens
    : to === "gemini"
      ? (record(body.generationConfig) ? body.generationConfig.maxOutputTokens : undefined)
      : body.max_tokens;
  const maxTokens = sourceLimit === undefined ? 16384 : positiveInteger(sourceLimit, "token 上限");
  const toolMap: ZcodeToolMap = new Map();
  const plan: ToolPlan = to === "responses" ? planResponsesTools(body.tools, toolMap) : { declarations: [], serverTools: [], dropped: [] };
  const nativeWebSearch = plan.serverTools.length > 0;
  const clientModel = body.model === undefined ? upstreamModel : string(body.model, "model");
  const identities: ToolIdentityMap = new Map();

  const messages: Message[] = [];
  const system: string[] = [];
  if (typeof body.instructions === "string" && body.instructions) system.push(body.instructions);
  let passthroughChoice: unknown;
  let passthroughStopSequences: unknown;
  let passthroughTools: Block[] | undefined;

  try {
    // R4 统一形态：前处理切段（私有段就地转换），主路径对所有来源统一执行一次
    // convertRequest(from, to)——from 是网关识别的真实客户端协议，目标恒为 anthropic。
    for (const leg of segmentZcodeRequestLegs(to, body, { nativeWebSearch, clientModel })) {
      if (leg.private !== undefined) {
        addMessage(messages, "assistant", leg.private);
        continue;
      }
      // 桥接统一形态 convertRequest(from, to, body)：from 为上游 endpoint（anthropic），to 为调用方 route 协议。
      const converted = await convertRequest("anthropic", to, leg.body!, { model: upstreamModel, mapToolName: zcodeToolMapper });
      for (const [mapped, identity] of converted.tools) identities.set(mapped, identity);
      for (const message of anthropicMessagesOf(converted)) addMessage(messages, message.role, message.content);
      if (typeof converted.body.system === "string" && converted.body.system) system.push(converted.body.system);
      passthroughTools = Array.isArray(converted.body.tools) ? converted.body.tools.filter(record) : undefined;
      passthroughChoice = converted.body.tool_choice;
      if (Array.isArray(converted.body.stop_sequences) && converted.body.stop_sequences.every((entry) => typeof entry === "string")) {
        passthroughStopSequences = converted.body.stop_sequences;
      }
    }
    } catch (error) {
    if (error instanceof BridgeConversionError) throw new ZcodeRequestError(error.message);
    throw error;
  }

  // chat/gemini/anthropic 源的工具声明来自公共转换（anthropic 为同协议直通的
  // 原名身份表），身份表同步进 zcode 工具表；responses 源的 toolMap 只含声明工具
  // （压缩历史中未声明的调用按需注册，不进入响应校验表）。
  if (to === "chat-completions" || to === "gemini" || to === "anthropic") {
    for (const [mapped, identity] of identities) {
      if (!toolMap.has(mapped)) toolMap.set(mapped, { ...identity });
    }
  }

  const declarations = to === "responses" ? plan.declarations : passthroughTools ?? [];
  const serverTools = plan.serverTools;
  if (plan.dropped.length) {
    // 剥离后必须告知模型，否则模型会声称拥有已被移除的能力。
    system.push(`本通道无法执行以下服务器内置工具，已从本请求移除：${plan.dropped.join("、")}。请勿声称已使用这些工具。`);
  }
  // 请求含图片时声明网关代执行的 analyze_image（GLM 文本模型经此识别图片）；
  // 客户端自己声明了同名工具则让位，不注入适配说明避免行为冲突。
  const images = collectZcodeImages(messages);
  const vision = images.length > 0 && !toolMap.has(ANALYZE_IMAGE_TOOL_NAME);
  if (vision) {
    declarations.push(ANALYZE_IMAGE_TOOL_DECLARATION);
    toolMap.set(ANALYZE_IMAGE_TOOL_NAME, { name: ANALYZE_IMAGE_TOOL_NAME, custom: false, gateway: "analyze_image" });
    system.push(ANALYZE_IMAGE_SYSTEM_NOTE);
  }

  const translated: Record<string, unknown> = { model: upstreamModel, stream: true, max_tokens: maxTokens, messages };
  if (system.length) translated.system = system.join("\n\n");
  if (declarations.length || serverTools.length) translated.tools = [...declarations, ...serverTools];
  if (body.temperature !== undefined) translated.temperature = body.temperature;
  else if (to === "gemini" && record(body.generationConfig) && typeof body.generationConfig.temperature === "number") {
    // gemini 源的采样参数在 generationConfig；不修改调用方原始请求。
    translated.temperature = body.generationConfig.temperature;
  }
  if (body.top_p !== undefined) translated.top_p = body.top_p;
  else if (to === "gemini" && record(body.generationConfig) && typeof body.generationConfig.topP === "number") {
    translated.top_p = body.generationConfig.topP;
  }
  if (to === "responses") {
    const choice = translateChoice(body.tool_choice, toolMap, body.parallel_tool_calls);
    if (choice) translated.tool_choice = choice;
  } else {
    // chat/anthropic 源的 named choice 已由公共转换映射到同一身份表；服务端搜索与
    // disable_parallel 语义按 anthropic 原生形状透传。
    if (record(passthroughChoice) || typeof passthroughChoice === "string") translated.tool_choice = passthroughChoice;
    if (passthroughStopSequences !== undefined) translated.stop_sequences = passthroughStopSequences;
  }
  if (to === "responses" || to === "chat-completions") {
    const effort = to === "responses"
      ? (record(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined)
      : (typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined);
    if (to === "responses" && record(body.reasoning) && body.reasoning.effort === "none") {
      translated.thinking = { type: "disabled" };
    } else if (effort !== undefined) {
      if (THINKING_BUDGETS[effort] === undefined) fail("不支持的 reasoning 档位");
      const budget = Math.min(THINKING_BUDGETS[effort]!, maxTokens - 1);
      if (budget < 1024) fail("启用 reasoning 至少需要 max_output_tokens 为 1025");
      translated.thinking = { type: "enabled", budget_tokens: budget };
    }
  }
  if (to === "anthropic" && body.thinking !== undefined && record(body.thinking)) {
    // 原生 Anthropic thinking 输入按同一服务能力验证，不静默覆盖。
    if (body.thinking.type === "enabled") {
      const budget = positiveInteger(body.thinking.budget_tokens, "thinking.budget_tokens");
      if (budget >= maxTokens) fail("thinking.budget_tokens 必须小于 max_tokens");
      translated.thinking = { type: "enabled", budget_tokens: budget };
    } else if (body.thinking.type === "disabled") {
      translated.thinking = { type: "disabled" };
    }
  }
  return { body: translated, tools: toolMap, dropped: [...plan.dropped], vision, images };
}

function translateChoice(value: unknown, tools: ZcodeToolMap, parallel: unknown): Block | undefined {
  if (parallel !== undefined && typeof parallel !== "boolean") fail("parallel_tool_calls 必须是布尔值");
  const noParallel = parallel === false;
  if (value === undefined) return noParallel ? { type: "auto", disable_parallel_tool_use: true } : undefined;
  let choice: Block;
  if (value === "auto") choice = { type: "auto" };
  else if (value === "none") choice = { type: "none" };
  else if (value === "required") choice = { type: "any" };
  else if (record(value) && (value.type === "function" || value.type === "custom")) {
    const name = string(value.name, "tool_choice.name");
    const namespace = value.namespace === undefined || value.namespace === null ? undefined : string(value.namespace, "tool_choice.namespace");
    const mapped = zcodeToolMapper({ name, namespace });
    const tool = tools.get(mapped);
    if (!tool || tool.name !== name || tool.namespace !== namespace) fail(`工具选择引用了未声明的工具 ${name}`);
    if (tool.custom !== (value.type === "custom")) fail("tool_choice 与工具声明类型不一致");
    choice = { type: "tool", name: mapped };
  } else if (record(value) && typeof value.type === "string" && value.type !== "") {
    // 指向服务器内置工具（含被剥离工具）的选择无法跨格式表达，省略让上游回到默认 auto。
    return noParallel ? { type: "auto", disable_parallel_tool_use: true } : undefined;
  } else fail("不支持的 tool_choice");
  if (noParallel && choice.type !== "none") choice.disable_parallel_tool_use = true;
  return choice;
}
