import { handleUniversalStreamRequest, translateBetweenProviders } from "llm-bridge";
import type { ProviderType } from "llm-bridge";
import type { OpencodeZenModelProtocol } from "./catalog.ts";

/**
 * OpenCode Zen 多协议转换层。
 *
 * 客户端两个入口（chat completions / responses）与模型四种端点协议
 * （chat / responses / anthropic / google）之间的请求与流式转换：
 * - responses → chat：严格手写（llm-bridge 2.0.1 实测会丢弃 instructions、
 *   parallel_tool_calls、function_call 历史与 custom 工具，工具轮因此断裂；对齐
 *   codebuddy/request.ts 的严格转换先例）；
 * - 其余跨协议方向以 chat 为规范中间层经 llm-bridge 转换（responses 先落到 chat，
 *   再转 anthropic / google）；
 * - 流式一律经 handleUniversalStreamRequest 逐事件转换（实测工具事件两方向完整）；
 * - 非流式 responses 客户端由聚合器把 responses SSE 还原为完整 response JSON。
 */

/** 网关面向客户端的协议面：chat completions 与 responses 两个入口。 */
export type OpencodeZenClientProtocol = "chat" | "responses";

/** llm-bridge 协议名映射（chat = OpenAI 家族 chat completions）。 */
const BRIDGE_PROTOCOL: Record<OpencodeZenModelProtocol, ProviderType> = {
  chat: "openai",
  responses: "openai-responses",
  anthropic: "anthropic",
  google: "google",
};

/** llm-bridge 按"任意 JSON 体"使用：入参出参都在本模块收口并有测试覆盖。 */
const translate = translateBetweenProviders as unknown as (
  from: ProviderType,
  to: ProviderType,
  body: Record<string, unknown>,
) => Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** responses 消息内容（字符串或内容块数组）→ chat content（纯文本折叠为字符串）。 */
function chatContentFromResponses(content: unknown): string | Array<Record<string, unknown>> | undefined {
  if (typeof content === "string") return content;
  const parts: Array<Record<string, unknown>> = [];
  for (const raw of asArray(content)) {
    if (!isRecord(raw)) continue;
    if (raw.type === "input_text" || raw.type === "output_text" || raw.type === "text") {
      if (typeof raw.text === "string") parts.push({ type: "text", text: raw.text });
    } else if (raw.type === "input_image") {
      const url = typeof raw.image_url === "string" ? raw.image_url : undefined;
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  if (parts.length === 0) return undefined;
  if (parts.every((part) => part.type === "text")) return parts.map((part) => String(part.text)).join("");
  return parts;
}

/** responses 工具声明 → chat 工具声明；custom 工具降级为 {input:string} 的 function。 */
function chatToolFromResponses(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return undefined;
  if (raw.type === "function") {
    return { type: "function", function: {
      name: raw.name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      parameters: isRecord(raw.parameters) ? raw.parameters : { type: "object", properties: {} },
    } };
  }
  if (raw.type === "custom") {
    return { type: "function", function: {
      name: raw.name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
    } };
  }
  return undefined;
}

/**
 * responses → chat 严格转换：instructions 并入 system 消息；function_call /
 * custom_tool_call 历史重建为 assistant.tool_calls（相邻调用合并进同一条消息），
 * 输出重建为 tool 消息；不认识的历史条目（如 reasoning）丢弃。
 */
export function responsesToChatBody(input: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
  if (instructions) messages.push({ role: "system", content: instructions });
  const appendCall = (call: Record<string, unknown>): void => {
    const last = messages.at(-1);
    if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
      (last.tool_calls as Array<Record<string, unknown>>).push(call);
      return;
    }
    messages.push({ role: "assistant", content: "", tool_calls: [call] });
  };
  const items = typeof input.input === "string"
    ? [{ type: "message", role: "user", content: input.input }]
    : asArray(input.input);
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    if (raw.type === "message") {
      const role = raw.role === "assistant" ? "assistant" : raw.role === "system" || raw.role === "developer" ? "system" : "user";
      const content = chatContentFromResponses(raw.content);
      if (content === undefined || content === "") continue;
      messages.push({ role, content });
    } else if (raw.type === "function_call") {
      appendCall({ id: String(raw.call_id ?? ""), type: "function", function: {
        name: String(raw.name ?? ""),
        arguments: typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? {}),
      } });
    } else if (raw.type === "custom_tool_call") {
      appendCall({ id: String(raw.call_id ?? ""), type: "function", function: {
        name: String(raw.name ?? ""),
        arguments: JSON.stringify({ input: typeof raw.input === "string" ? raw.input : "" }),
      } });
    } else if (raw.type === "function_call_output" || raw.type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(raw.call_id ?? ""),
        content: typeof raw.output === "string" ? raw.output : JSON.stringify(raw.output ?? ""),
      });
    }
    // reasoning 等其余条目在 chat 协议没有对应物，丢弃。
  }
  const body: Record<string, unknown> = { messages };
  if (typeof input.parallel_tool_calls === "boolean") body.parallel_tool_calls = input.parallel_tool_calls;
  // reasoning.effort 转成 chat 形状的 reasoning_effort（取值域校验与 off 语义由
  // 指纹注入层统一处理）；responses 协议模型直通时该字段保留在 input 原样发送。
  if (input.reasoning !== null && typeof input.reasoning === "object" && !Array.isArray(input.reasoning)) {
    const effort = (input.reasoning as Record<string, unknown>).effort;
    if (typeof effort === "string" && effort.trim()) body.reasoning_effort = effort.trim();
  }
  const tools = asArray(input.tools)
    .map(chatToolFromResponses)
    .filter((tool): tool is Record<string, unknown> => tool !== undefined);
  if (tools.length > 0) body.tools = tools;
  if (input.tool_choice !== undefined) body.tool_choice = input.tool_choice;
  if (typeof input.max_output_tokens === "number") body.max_tokens = input.max_output_tokens;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (typeof input.top_p === "number") body.top_p = input.top_p;
  return body;
}

/**
 * 请求体转换：客户端协议 → 模型端点协议。同协议原样浅拷贝；responses 先经严格
 * 转换落到 chat 中间层，再按需经 llm-bridge 转 anthropic / google。
 */
export function convertOpencodeZenRequest(
  from: OpencodeZenClientProtocol,
  to: OpencodeZenModelProtocol,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (from === to) return { ...input };
  const chatBody = from === "responses" ? responsesToChatBody(input) : { ...input };
  if (to === "chat") return chatBody;
  const converted = translate(BRIDGE_PROTOCOL.chat, BRIDGE_PROTOCOL[to], chatBody);
  if (to === "anthropic") {
    const maxTokens = input.max_tokens ?? input.max_completion_tokens ?? input.max_output_tokens;
    if (typeof maxTokens === "number" && maxTokens > 0) converted.max_tokens = maxTokens;
  }
  return converted;
}

/** 上游流 → 客户端协议的 SSE 转换；同协议原样返回。 */
export function translateOpencodeZenStream(
  stream: ReadableStream<Uint8Array>,
  from: OpencodeZenModelProtocol,
  to: OpencodeZenClientProtocol,
): ReadableStream<Uint8Array> {
  if (from === to) return stream;
  return handleUniversalStreamRequest(stream, BRIDGE_PROTOCOL[from], BRIDGE_PROTOCOL[to]);
}

interface AggregatedItem {
  id?: string;
  type: string;
  text?: string;
  callId?: string;
  name?: string;
  args?: string;
  order: number;
}

/**
 * responses SSE → 完整 response JSON（非流式 responses 客户端）。
 * 文本与函数调用增量按条目聚合；条目同时按 item_id 与 output_index 建索引，兼容
 * 真实上游（增量带 item_id）与 llm-bridge 重发射（增量只带 output_index）两种形状；
 * usage 与最终状态取自 response.created/completed。
 */
export async function aggregateOpencodeZenResponsesStream(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const byId = new Map<string, AggregatedItem>();
  const byIndex = new Map<number, AggregatedItem>();
  let response: Record<string, unknown> | undefined;
  let order = 0;
  const register = (event: Record<string, unknown>, entry: AggregatedItem): AggregatedItem => {
    if (typeof event.item_id === "string" && event.item_id) {
      byId.set(event.item_id, entry);
      entry.id ??= event.item_id;
    }
    if (typeof event.output_index === "number") byIndex.set(event.output_index, entry);
    return entry;
  };
  const lookup = (event: Record<string, unknown>): AggregatedItem | undefined => {
    if (typeof event.item_id === "string" && byId.has(event.item_id)) return byId.get(event.item_id);
    if (typeof event.output_index === "number" && byIndex.has(event.output_index)) return byIndex.get(event.output_index);
    return undefined;
  };
  const handleEvent = (payload: string): void => {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!isRecord(parsed)) return;
      event = parsed;
    } catch {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if ((type === "response.created" || type === "response.completed") && isRecord(event.response)) {
      response = { ...event.response };
    }
    if (type === "response.output_item.added" && isRecord(event.item)) {
      const entry: AggregatedItem = {
        ...(typeof event.item.id === "string" && event.item.id ? { id: event.item.id } : {}),
        type: typeof event.item.type === "string" ? event.item.type : "message",
        callId: typeof event.item.call_id === "string" ? event.item.call_id : undefined,
        name: typeof event.item.name === "string" ? event.item.name : undefined,
        order: order++,
      };
      if (entry.id) byId.set(entry.id, entry);
      register(event, entry);
    }
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      const entry = lookup(event) ?? register(event, { type: "message", order: order++ });
      entry.text = (entry.text ?? "") + event.delta;
    }
    if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const entry = lookup(event) ?? register(event, { type: "function_call", order: order++ });
      entry.args = (entry.args ?? "") + event.delta;
    }
  };
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  const entries = [...new Set([...byId.values(), ...byIndex.values()])].sort((a, b) => a.order - b.order);
  const output = entries.map((entry) => entry.type === "function_call"
    ? { type: "function_call", id: entry.id ?? "", call_id: entry.callId ?? "", name: entry.name ?? "", arguments: entry.args ?? "", status: "completed" }
    : { type: "message", id: entry.id ?? "", role: "assistant", status: "completed", content: [{ type: "output_text", text: entry.text ?? "" }] });
  const result: Record<string, unknown> = {
    id: typeof response?.id === "string" && response.id ? response.id : `zen-resp-${Date.now()}`,
    object: "response",
    created_at: typeof response?.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
    status: "completed",
    model: typeof response?.model === "string" && response.model ? response.model : "opencode-zen",
    output,
  };
  if (isRecord(response?.usage)) result.usage = response.usage;
  return result;
}
