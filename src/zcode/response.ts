import { parseAnthropicStream } from "llm-bridge";
import { encodeZcodeThinking, isZcodeRecord, type ZcodeToolMap } from "./wire.ts";
import { gatewayToolCallNarration, gatewayToolResultNarration, type ZcodeGatewayCall } from "./vision.ts";

/** 网关代执行工具（analyze_image）的驱动层钩子：执行调用并按需发起上游续跑。 */
export interface ZcodeGatewayToolsHook {
  /** 执行一次被吸收的调用；返回作为 tool_result 呈给上游的文本。抛错时降级为错误说明文本。 */
  execute: (call: ZcodeGatewayCall) => Promise<string>;
  /** 追加 tool_use/tool_result 消息后发起下一次上游请求；失败应抛错（整条响应转 failed）。 */
  nextUpstream: (calls: Array<{ call: ZcodeGatewayCall; result: string }>) => Promise<Response>;
  /** 续跑上限（防止模型循环调用）。 */
  maxContinuations: number;
}

export interface ZcodeResponseOptions {
  model: string;
  tools: ZcodeToolMap;
  stream: boolean;
  signal?: AbortSignal;
  abort?: () => void;
  onComplete?: (response: Record<string, unknown>) => void;
  onChunk?: (chunk: string) => void;
  sanitizeError?: (error: Record<string, unknown>) => Record<string, unknown>;
  /** 声明了网关代执行工具时必须提供；否则吸收到相关调用会让响应失败。 */
  gatewayTools?: ZcodeGatewayToolsHook;
}

type Json = Record<string, unknown>;
interface Block {
  source: Json;
  item: Json;
  outputIndex: number;
  text: string;
  signature: string;
  arguments: string;
  hasArgumentDelta: boolean;
  stopped: boolean;
  /** 网关代执行块：吸收调用，不产出客户端事件与输出条目。 */
  gateway?: boolean;
}
/** 上游服务端搜索块折叠为单个 web_search_call 条目期间的状态。 */
interface ServerToolEntry {
  upstreamId: string;
  item: Json;
  outputIndex: number;
  jsonBuffer: string;
  blockStopped: boolean;
  resultArrived: boolean;
}
/** z.ai 的服务端搜索按 web_search_prime/search_query 形状返回 query；兼容 Anthropic 标准的 query。 */
function serverToolQueryOf(input: Json): string {
  for (const key of ["search_query", "query"]) {
    if (typeof input[key] === "string" && input[key]) return input[key] as string;
  }
  return "";
}
function serverToolResultEntries(content: unknown): Json[] {
  const entries: Json[] = [];
  if (typeof content === "string" && content) return [{ type: "web_search_result", text: content }];
  if (!Array.isArray(content)) return entries;
  for (const raw of content) {
    if (!isZcodeRecord(raw)) continue;
    if (typeof raw.text === "string" && raw.text) entries.push({ type: "web_search_result", text: raw.text });
    else if (typeof raw.url === "string" && raw.url) entries.push(raw);
  }
  return entries;
}
const encoder = new TextEncoder();
function safely(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* 日志回调不能中断响应。 */ }
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`ZCode ${label} 必须是字符串`);
  return value;
}
function record(value: unknown, label: string): Json {
  if (!isZcodeRecord(value)) throw new Error(`ZCode ${label} 必须是对象`);
  return value;
}
function blockIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("ZCode content block index 无效");
  return value;
}

/** 仅消费一条上游流；严格解析 SSE，保留库解析器忽略的字段和错误。 */
async function* readFrames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Json> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let event = "";
  let data: string[] = [];
  function line(value: string): Json | undefined {
    if (value === "") {
      if (!data.length) { event = ""; return; }
      let parsed: unknown;
      try { parsed = JSON.parse(data.join("\n")); }
      catch { throw new Error("ZCode SSE 包含无效 JSON"); }
      const frame = record(parsed, "SSE data");
      if (event && frame.type !== undefined && event !== frame.type) throw new Error("ZCode SSE event 与 type 不一致");
      const type = event || requiredString(frame.type, "SSE type");
      data = [];
      event = "";
      return { ...frame, type };
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "event") event = content;
    if (field === "data") data.push(content);
  }
  while (true) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    while (true) {
      const position = buffer.search(/[\r\n]/);
      if (position < 0) break;
      if (buffer[position] === "\r" && position + 1 === buffer.length && !done) break;
      const width = buffer[position] === "\r" && buffer[position + 1] === "\n" ? 2 : 1;
      const next = line(buffer.slice(0, position));
      buffer = buffer.slice(position + width);
      if (next) yield next;
    }
    if (done) {
      if (buffer.length || data.length) throw new Error("ZCode SSE 在事件结束前意外 EOF");
      return;
    }
  }
}

/** 库只保存一个工具上下文；按帧补入对应块，使交错的块仍通过库正确归一化。 */
async function normalize(frame: Json, block?: Block): Promise<Json[]> {
  const frames: Json[] = [];
  if (block?.source.type === "tool_use" && (frame.type === "content_block_delta" || frame.type === "content_block_stop")) {
    frames.push({ type: "content_block_start", index: frame.index, content_block: block.source });
  }
  frames.push(frame);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join("")));
      controller.close();
    },
  });
  const result: Json[] = [];
  let skipContext = frames.length > 1;
  for await (const value of parseAnthropicStream(stream)) {
    if (skipContext) { skipContext = false; continue; }
    result.push(value as unknown as Json);
  }
  return result;
}

export async function createZcodeResponse(upstream: Response, options: ZcodeResponseOptions): Promise<Response> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = upstream.body?.getReader();
  const blocks = new Map<number, Block>();
  const serverTools: ServerToolEntry[] = [];
  const serverToolByIndex = new Map<number, ServerToolEntry>();
  const serverToolByUpstreamId = new Map<string, ServerToolEntry>();
  const serverResults = new Map<number, { entry: ServerToolEntry; entries: Json[]; text: string }>();
  const ignoredBlocks = new Set<number>();
  const output: Json[] = [];
  const usage: Json = {};
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  let started = false;
  let stopped = false;
  let stopReason: string | undefined;
  let finalResponse: Json | undefined;
  let canceled = false;
  let upstreamCanceled = false;
  let cleaned = false;
  /** 本腿被吸收的网关工具调用（message_stop 时整批执行并续跑）。 */
  let pendingGateway: ZcodeGatewayCall[] = [];
  /** 已流出 Input 旁白卡片的吸收调用；未续跑时需补 Output 卡片，避免 "Executing on server..." 悬挂。 */
  let narratedGateway: ZcodeGatewayCall[] = [];
  let continuations = 0;
  const snapshot = (status: string): Json => ({
    id, object: "response", created_at: createdAt, model: options.model, status,
    output: structuredClone(output), error: null, incomplete_details: null, usage: null,
  });
  const event = (type: string, fields: Json = {}): Json => ({ type, sequence_number: sequence++, ...fields });
  function finalUsage(): Json | null {
    if (!Object.keys(usage).length) return null;
    const count = (key: string): number => typeof usage[key] === "number" ? usage[key] as number : 0;
    const input = count("input_tokens") + count("cache_read_input_tokens") + count("cache_creation_input_tokens");
    const result: Json = { input_tokens: input, output_tokens: count("output_tokens"), total_tokens: input + count("output_tokens") };
    const details: Json = {};
    if ("cache_read_input_tokens" in usage) details.cached_tokens = count("cache_read_input_tokens");
    if ("cache_creation_input_tokens" in usage) details.cache_creation_tokens = count("cache_creation_input_tokens");
    if (Object.keys(details).length) result.input_tokens_details = details;
    if (typeof usage.reasoning_tokens === "number") result.output_tokens_details = { reasoning_tokens: usage.reasoning_tokens };
    return result;
  }
  function finish(status: "completed" | "incomplete" | "failed", error?: Json): Json | undefined {
    if (finalResponse) return;
    for (const block of blocks.values()) {
      if (!block.stopped) {
        block.item.status = "incomplete";
        if (block.source.type === "thinking") {
          block.item.encrypted_content = encodeZcodeThinking(options.model, [{ type: "thinking", thinking: block.text, signature: block.signature }]);
        }
      }
    }
    // 异常终止时未等到结果块的服务端搜索条目不补事件，仅随快照标记状态（与普通块截断语义一致）。
    for (const entry of serverTools) {
      if (!entry.resultArrived) entry.item.status = status === "completed" ? "completed" : "incomplete";
    }
    finalResponse = { ...snapshot(status), usage: finalUsage() };
    if (status === "incomplete") finalResponse.incomplete_details = { reason: "max_output_tokens" };
    if (error) {
      try { finalResponse.error = options.sanitizeError ? options.sanitizeError(error) : error; }
      catch { finalResponse.error = { code: "upstream_error", message: "ZCode 上游响应失败" }; }
    }
    cleanup();
    safely(() => options.onComplete?.(structuredClone(finalResponse!)));
    return event(`response.${status}`, { response: finalResponse });
  }
  function cancelUpstream(): void {
    if (upstreamCanceled) return;
    upstreamCanceled = true;
    safely(options.abort);
    void reader?.cancel().catch(() => undefined).finally(() => {
      try { reader?.releaseLock(); } catch { /* 取消期间可能仍有待收尾读取。 */ }
    });
  }
  /** 切换到续跑的下一腿上游流；事件序号与输出条目跨腿连续。 */
  function startLeg(response: Response): void {
    const next = response.body?.getReader();
    if (!next) throw new Error("ZCode 续跑上游响应缺少 body");
    reader = next;
    started = false;
    stopped = false;
    stopReason = undefined;
    blocks.clear();
    serverTools.length = 0;
    serverToolByIndex.clear();
    serverToolByUpstreamId.clear();
    serverResults.clear();
    ignoredBlocks.clear();
    upstreamCanceled = false;
  }
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    options.signal?.removeEventListener("abort", handleAbort);
    cancelUpstream();
  }
  function handleAbort(): void {
    if (finalResponse) return;
    canceled = true;
    finish("failed", { code: "response_cancelled", message: "ZCode 响应已取消" });
  }
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  if (options.signal?.aborted) handleAbort();
  function mergeUsage(value: unknown): void {
    if (!isZcodeRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number" && Number.isFinite(item) && item >= 0) usage[key] = item;
    }
  }
  const fields = (block: Block): Json => ({ item_id: block.item.id, output_index: block.outputIndex });
  function completeServerTool(entry: ServerToolEntry, entries: Json[], status: "completed" | "incomplete", result: Json[]): void {
    if (entry.resultArrived) return;
    entry.resultArrived = true;
    if (entries.length) entry.item.results = entries;
    entry.item.status = status;
    result.push(event("response.output_item.done", { output_index: entry.outputIndex, item: structuredClone(entry.item) }));
  }
  function appendText(block: Block, value: string, result: Json[]): void {
    if (!value) return;
    block.text += value;
    if (block.source.type === "text") {
      (block.item.content as Json[])[0]!.text = block.text;
      result.push(event("response.output_text.delta", { ...fields(block), content_index: 0, delta: value, logprobs: [] }));
    } else {
      (block.item.summary as Json[])[0]!.text = block.text;
      result.push(event("response.reasoning_summary_text.delta", { ...fields(block), summary_index: 0, delta: value }));
    }
  }
  function closeBlock(block: Block, result: Json[]): void {
    if (block.stopped) throw new Error("ZCode content block 重复结束");
    const base = fields(block);
    if (block.source.type === "text") {
      const part = (block.item.content as Json[])[0]!;
      result.push(event("response.output_text.done", { ...base, content_index: 0, text: block.text, logprobs: [] }));
      result.push(event("response.content_part.done", { ...base, content_index: 0, part: structuredClone(part) }));
    } else if (block.source.type === "thinking" || block.source.type === "redacted_thinking") {
      const preserved = block.source.type === "thinking"
        ? { type: "thinking", thinking: block.text, signature: block.signature }
        : { type: "redacted_thinking", data: requiredString(block.source.data, "redacted thinking data") };
      block.item.encrypted_content = encodeZcodeThinking(options.model, [preserved]);
      if (block.source.type === "thinking") {
        result.push(event("response.reasoning_summary_text.done", { ...base, summary_index: 0, text: block.text }));
        result.push(event("response.reasoning_summary_part.done", { ...base, summary_index: 0, part: { type: "summary_text", text: block.text } }));
      }
    } else {
      const argumentsText = block.hasArgumentDelta ? block.arguments : JSON.stringify(block.source.input ?? {});
      let parsed: unknown;
      try { parsed = JSON.parse(argumentsText); } catch { throw new Error("ZCode tool arguments 包含无效或未结束的 JSON"); }
      if (!isZcodeRecord(parsed)) throw new Error("ZCode tool arguments 必须是 JSON 对象");
      if (block.item.type === "custom_tool_call") {
        const input = requiredString(parsed.input, "custom tool input");
        block.item.input = input;
        if (input) result.push(event("response.custom_tool_call_input.delta", { ...base, delta: input }));
        result.push(event("response.custom_tool_call_input.done", { ...base, input }));
      } else {
        if (!block.hasArgumentDelta && argumentsText) result.push(event("response.function_call_arguments.delta", { ...base, delta: argumentsText }));
        block.item.arguments = argumentsText;
        result.push(event("response.function_call_arguments.done", { ...base, arguments: argumentsText }));
      }
    }
    block.stopped = true;
    block.item.status = "completed";
    result.push(event("response.output_item.done", { output_index: block.outputIndex, item: structuredClone(block.item) }));
  }
  /** 一次性合成完整生命周期的助手文本条目：网关代执行工具的旁白卡片（事件序与真实文本块一致）。 */
  function synthesizeMessage(value: string, result: Json[]): void {
    const item: Json = { id: `item_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", status: "in_progress", content: [] };
    const outputIndex = output.length;
    output.push(item);
    result.push(event("response.output_item.added", { output_index: outputIndex, item: structuredClone(item) }));
    const empty: Json = { type: "output_text", text: "", annotations: [], logprobs: [] };
    result.push(event("response.content_part.added", { output_index: outputIndex, item_id: item.id, content_index: 0, part: empty }));
    result.push(event("response.output_text.delta", { output_index: outputIndex, item_id: item.id, content_index: 0, delta: value, logprobs: [] }));
    result.push(event("response.output_text.done", { output_index: outputIndex, item_id: item.id, content_index: 0, text: value, logprobs: [] }));
    result.push(event("response.content_part.done", { output_index: outputIndex, item_id: item.id, content_index: 0, part: { ...empty, text: value } }));
    item.status = "completed";
    (item.content as Json[]).push({ ...empty, text: value });
    result.push(event("response.output_item.done", { output_index: outputIndex, item: structuredClone(item) }));
  }
  async function process(frame: Json): Promise<Json[]> {
    const result: Json[] = [];
    const index = frame.type === "content_block_start" || frame.type === "content_block_delta" || frame.type === "content_block_stop" ? blockIndex(frame.index) : undefined;
    const block = index === undefined ? undefined : blocks.get(index);
    const normalized = await normalize(frame, block);
    if (frame.type === "ping") return result;
    if (frame.type === "error") {
      const original = record(frame.error, "error");
      const errorEvent = normalized.find((value) => value.type === "error");
      const error = record(errorEvent?.error, "normalized error");
      const terminal = finish("failed", { ...original, code: error.code ?? "upstream_error", message: error.message, upstream_error: original });
      if (terminal) result.push(terminal);
      return result;
    }
    if (frame.type === "message_start") {
      if (started) throw new Error("ZCode message_start 重复");
      started = true;
      const message = record(frame.message, "message");
      if (!normalized.some((value) => value.type === "message_start")) throw new Error("ZCode message_start 无法归一化");
      mergeUsage(message.usage);
      return result;
    }
    if (!started) throw new Error("ZCode 缺少 message_start");
    if (frame.type === "content_block_start") {
      if (block || serverToolByIndex.has(index!) || serverResults.has(index!) || ignoredBlocks.has(index!)) throw new Error("ZCode content block index 重复");
      const source = record(frame.content_block, "content_block");
      // 分配事件序号前验证起始字段，错误帧不能留下序号空洞。
      if (source.type === "text") requiredString(source.text ?? "", "initial text");
      if (source.type === "thinking") {
        requiredString(source.thinking ?? "", "initial thinking");
        if (source.signature !== undefined) requiredString(source.signature, "initial signature");
      }
      if (source.type === "redacted_thinking") requiredString(source.data, "redacted thinking data");
      if (source.type === "server_tool_use") {
        // z.ai 把 web_search_20250305 映射为 web_search_prime；两种名称都折叠回 web_search_call。
        if (source.name !== "web_search_prime" && source.name !== "web_search") {
          ignoredBlocks.add(index!);
          return result;
        }
        const rawId = typeof source.id === "string" ? source.id.replace(/[^A-Za-z0-9_]/g, "") : "";
        const upstreamId = rawId || `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
        const input = isZcodeRecord(source.input) ? source.input : {};
        const item: Json = {
          id: `ws_${upstreamId}`, type: "web_search_call", status: "in_progress",
          action: { type: "search", query: serverToolQueryOf(input) },
        };
        const entry: ServerToolEntry = { upstreamId, item, outputIndex: output.length, jsonBuffer: "", blockStopped: false, resultArrived: false };
        serverTools.push(entry);
        serverToolByIndex.set(index!, entry);
        serverToolByUpstreamId.set(upstreamId, entry);
        output.push(item);
        result.push(event("response.output_item.added", { output_index: entry.outputIndex, item: structuredClone(item) }));
        return result;
      }
      if (source.type === "tool_result" || source.type === "web_search_tool_result") {
        // 服务端搜索结果块：按 tool_use_id 配对折叠进对应 web_search_call；未配对的按未知块忽略。
        const toolUseId = typeof source.tool_use_id === "string" ? source.tool_use_id : "";
        const entry = toolUseId ? serverToolByUpstreamId.get(toolUseId) : undefined;
        if (!entry || entry.resultArrived) {
          ignoredBlocks.add(index!);
          return result;
        }
        serverResults.set(index!, { entry, entries: serverToolResultEntries(source.content), text: "" });
        return result;
      }
      const itemId = `item_${crypto.randomUUID().replaceAll("-", "")}`;
      let item: Json;
      if (source.type === "text") item = { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] };
      else if (source.type === "thinking" || source.type === "redacted_thinking") item = { id: itemId, type: "reasoning", status: "in_progress", summary: [] };
      else if (source.type === "tool_use") {
        const tool = normalized.find((value) => value.type === "tool_call_start");
        const call = record(tool?.tool_call, "tool call");
        const name = requiredString(call.name, "tool name");
        const mapped = options.tools.get(name);
        if (!mapped) throw new Error(`ZCode 返回了未声明的工具：${name}`);
        if (mapped.gateway) {
          if (!options.gatewayTools) throw new Error(`ZCode 网关工具 ${name} 缺少执行钩子`);
          // 网关代执行：只跟踪参数，不产出客户端事件，也不进入输出条目。
          blocks.set(index!, {
            source, item: { type: "function_call" }, outputIndex: -1, text: "", signature: "",
            arguments: "", hasArgumentDelta: false, stopped: false, gateway: true,
          });
          return result;
        }
        item = { id: itemId, type: mapped.custom ? "custom_tool_call" : "function_call", call_id: requiredString(call.id, "tool call id"), name: mapped.name, ...(mapped.namespace === undefined ? {} : { namespace: mapped.namespace }), status: "in_progress", ...(mapped.custom ? { input: "" } : { arguments: "" }) };
      } else {
        // 未知块类型不再中断整条流：忽略其后续 delta/stop，由快照保证事件序号连续。
        ignoredBlocks.add(index!);
        return result;
      }
      const added: Block = { source, item, outputIndex: output.length, text: "", signature: typeof source.signature === "string" ? source.signature : "", arguments: "", hasArgumentDelta: false, stopped: false };
      blocks.set(index!, added);
      output.push(item);
      result.push(event("response.output_item.added", { output_index: added.outputIndex, item: structuredClone(item) }));
      if (source.type === "text") {
        const part = { type: "output_text", text: "", annotations: [], logprobs: [] };
        (item.content as Json[]).push(part);
        result.push(event("response.content_part.added", { ...fields(added), content_index: 0, part: structuredClone(part) }));
        appendText(added, requiredString(source.text ?? "", "initial text"), result);
      } else if (source.type === "thinking") {
        const part = { type: "summary_text", text: "" };
        (item.summary as Json[]).push(part);
        result.push(event("response.reasoning_summary_part.added", { ...fields(added), summary_index: 0, part: structuredClone(part) }));
        appendText(added, requiredString(source.thinking ?? "", "initial thinking"), result);
      }
      return result;
    }
    if (frame.type === "content_block_delta") {
      if (ignoredBlocks.has(index!)) return result;
      const serverTool = serverToolByIndex.get(index!);
      if (serverTool) {
        const delta = record(frame.delta, "delta");
        // Anthropic 标准形状的 query 走 input_json_delta 增量；z.ai 在 start 帧已给全量。
        if (delta.type === "input_json_delta") serverTool.jsonBuffer += requiredString(delta.partial_json, "server tool arguments delta");
        return result;
      }
      const serverResult = serverResults.get(index!);
      if (serverResult) {
        const delta = record(frame.delta, "delta");
        if (delta.type === "text_delta" && typeof delta.text === "string") serverResult.text += delta.text;
        return result;
      }
      if (!block || block.stopped) throw new Error("ZCode delta 引用了不存在或已结束的 block");
      const delta = record(frame.delta, "delta");
      const content = normalized.find((value) => value.type === "content_delta");
      if (delta.type === "text_delta" || delta.type === "thinking_delta") {
        const expected = delta.type === "text_delta" ? "text" : "thinking";
        if (block.source.type !== expected) throw new Error("ZCode delta 与 block 类型不匹配");
        const normalizedDelta = record(content?.delta, "normalized delta");
        appendText(block, requiredString(normalizedDelta[expected], "delta text"), result);
      } else if (delta.type === "signature_delta") {
        if (block.source.type !== "thinking") throw new Error("ZCode signature 引用了非 thinking block");
        block.signature += requiredString(delta.signature, "signature");
      } else if (delta.type === "input_json_delta") {
        if (block.source.type !== "tool_use") throw new Error("ZCode tool delta 引用了非 tool block");
        const call = record(normalized.find((value) => value.type === "tool_call_delta")?.tool_call, "normalized tool delta");
        const value = requiredString(call.arguments_delta, "tool arguments delta");
        block.hasArgumentDelta = true;
        block.arguments += value;
        if (block.item.type === "function_call" && !block.gateway) {
          block.item.arguments = block.arguments;
          if (value) result.push(event("response.function_call_arguments.delta", { ...fields(block), delta: value }));
        }
      } else throw new Error(`ZCode 不支持的 delta：${String(delta.type)}`);
      return result;
    }
    if (frame.type === "content_block_stop") {
      if (ignoredBlocks.has(index!)) return result;
      const serverTool = serverToolByIndex.get(index!);
      if (serverTool) {
        if (serverTool.blockStopped) throw new Error("ZCode content block 重复结束");
        serverTool.blockStopped = true;
        if (serverTool.jsonBuffer) {
          let parsed: unknown;
          try { parsed = JSON.parse(serverTool.jsonBuffer); } catch { throw new Error("ZCode server tool arguments 包含无效或未结束的 JSON"); }
          if (isZcodeRecord(parsed)) serverTool.item.action = { type: "search", query: serverToolQueryOf(parsed) };
        }
        // 此刻不结束条目：等配对的结果块到达后折叠，未到达由 message_stop 兜底。
        return result;
      }
      const serverResult = serverResults.get(index!);
      if (serverResult) {
        if (!serverResult.entries.length && serverResult.text) serverResult.entries = [{ type: "web_search_result", text: serverResult.text }];
        completeServerTool(serverResult.entry, serverResult.entries, "completed", result);
        return result;
      }
      if (block?.gateway) {
        if (block.stopped) throw new Error("ZCode content block 重复结束");
        const argumentsText = block.hasArgumentDelta ? block.arguments : JSON.stringify(block.source.input ?? {});
        let parsed: unknown;
        try { parsed = JSON.parse(argumentsText || "{}"); } catch { throw new Error("ZCode 网关工具 arguments 包含无效或未结束的 JSON"); }
        if (!isZcodeRecord(parsed)) throw new Error("ZCode 网关工具 arguments 必须是 JSON 对象");
        block.stopped = true;
        const call: ZcodeGatewayCall = {
          id: requiredString(block.source.id, "gateway tool id"),
          name: requiredString(block.source.name, "gateway tool name"),
          input: parsed,
        };
        pendingGateway.push(call);
        // Input 旁白卡片在本帧同步流出：执行等待期间客户端就能看到 "Executing on server..."。
        // 达到续跑上限的调用不会执行，也就不旁白，保持静默丢弃的原语义。
        if (options.gatewayTools && continuations < options.gatewayTools.maxContinuations) {
          synthesizeMessage(gatewayToolCallNarration(call), result);
          narratedGateway.push(call);
        }
        return result;
      }
      if (!block) throw new Error("ZCode stop 引用了不存在的 block");
      closeBlock(block, result);
      return result;
    }
    if (frame.type === "message_delta") {
      const delta = record(frame.delta, "message delta");
      if (delta.stop_reason !== undefined && delta.stop_reason !== null) stopReason = requiredString(delta.stop_reason, "stop_reason");
      mergeUsage(frame.usage);
      return result;
    }
    if (frame.type === "message_stop") {
      if ([...blocks.values()].some((value) => !value.stopped) || serverTools.some((value) => !value.blockStopped)) throw new Error("ZCode message_stop 到达时仍存在未结束的 block");
      if (!stopReason) throw new Error("ZCode message_stop 缺少 stop_reason");
      if (!["end_turn", "tool_use", "stop_sequence", "max_tokens"].includes(stopReason)) throw new Error(`ZCode 不支持的 stop_reason：${stopReason}`);
      stopped = true;
      // 未等到结果块的服务端搜索调用仍要闭合条目，否则 Codex 侧留下永久 in_progress 的输出项。
      const pendingStatus = stopReason === "max_tokens" ? "incomplete" : "completed";
      for (const entry of serverTools) completeServerTool(entry, [], pendingStatus, result);
      if (stopReason === "tool_use" && pendingGateway.length > 0 && options.gatewayTools && continuations < options.gatewayTools.maxContinuations) {
        // 网关代执行：批量执行被吸收的调用，以 tool_result 续跑上游；事件序号与输出条目跨腿连续。
        const completed: Array<{ call: ZcodeGatewayCall; result: string }> = [];
        for (const call of pendingGateway) {
          let callResult: string;
          try {
            callResult = await options.gatewayTools.execute(call);
          } catch (error) {
            if (options.signal?.aborted) throw error;
            // 执行失败降级为错误说明，让模型改用其他方式而不是整条响应失败。
            callResult = `analyze_image 执行失败：${error instanceof Error ? error.message : String(error)}。请改用其他方式完成，或向用户说明无法识别该图片。`;
          }
          synthesizeMessage(gatewayToolResultNarration(call.name, callResult), result);
          completed.push({ call, result: callResult });
        }
        pendingGateway = [];
        narratedGateway = [];
        continuations++;
        const next = await options.gatewayTools.nextUpstream(completed);
        if (!next.ok || !next.body) throw new Error(`ZCode 续跑上游返回 HTTP ${next.status}`);
        // 旧腿已无后续帧，取消以释放其读取与连接。
        void reader?.cancel().catch(() => undefined);
        startLeg(next);
        return result;
      }
      // 未续跑（无待执行调用或达到上限）：丢弃残余的吸收调用，按本腿结果正常收尾。
      for (const call of narratedGateway) {
        synthesizeMessage(gatewayToolResultNarration(call.name, `${call.name} 调用未执行：本次响应未发起网关续跑。`), result);
      }
      narratedGateway = [];
      pendingGateway = [];
      const terminal = finish(stopReason === "max_tokens" ? "incomplete" : "completed");
      if (terminal) result.push(terminal);
      return result;
    }
    throw new Error(`ZCode 不支持的 SSE 事件：${String(frame.type)}`);
  }
  async function* events(): AsyncGenerator<Json> {
    try {
      if (canceled) return;
      yield event("response.created", { response: snapshot("in_progress") });
      yield event("response.in_progress", { response: snapshot("in_progress") });
      if (!reader) throw new Error("ZCode 上游响应缺少 body");
      while (!canceled && !finalResponse) {
        const legReader: ReadableStreamDefaultReader<Uint8Array> | undefined = reader;
        for await (const frame of readFrames(legReader)) {
          if (canceled) return;
          const before: ReadableStreamDefaultReader<Uint8Array> | undefined = reader;
          for (const value of await process(frame)) yield value;
          if (finalResponse) break;
          // message_stop 里触发续跑时 reader 已切到新腿，不再等待旧腿连接收尾。
          if (reader !== before) break;
        }
        if (canceled || finalResponse) break;
        // 上一腿自然读完；message_stop 里触发续跑时 reader 已切到新腿。
        if (reader !== legReader) continue;
        if (!stopped) throw new Error("ZCode 上游在 message_stop 前意外 EOF");
        break;
      }
    } catch (error) {
      const terminal = finish("failed", { code: "upstream_protocol_error", message: error instanceof Error ? error.message : String(error) });
      if (terminal && !canceled) yield terminal;
    } finally {
      cleanup();
      try { reader?.releaseLock(); } catch { /* 正在取消的读取由 cancel 收尾。 */ }
    }
  }
  const iterator = events();
  if (!options.stream) {
    for await (const value of iterator) safely(() => options.onChunk?.(JSON.stringify(value)));
    return Response.json(finalResponse ?? snapshot("failed"), { status: finalResponse?.status === "failed" || canceled ? 502 : 200 });
  }
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (canceled || next.done) { controller.close(); return; }
        const chunk = `event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`;
        safely(() => options.onChunk?.(chunk));
        controller.enqueue(encoder.encode(chunk));
      } catch (error) { if (!canceled) controller.error(error); }
    },
    async cancel() {
      handleAbort();
      cleanup();
      await iterator.return(undefined);
      try { reader?.releaseLock(); } catch { /* reader 可能已经由生成器释放。 */ }
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
