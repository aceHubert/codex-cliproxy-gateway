import type { CodebuddyToolMap } from "./request.ts";
import { encodeCodebuddyReasoning } from "./wire.ts";

/**
 * OpenAI Chat Completions（SSE 或整包 JSON）→ Codex Responses 事件流。
 *
 * 结构对齐 zcode/response.ts：严格 SSE 解析、事件序号连续、快照聚合，客户端
 * 非流式时聚合为完整 JSON。reasoning_content 映射为 reasoning 摘要条目，
 * tool_calls 按声明表还原 function_call/custom_tool_call，refusal 走专用事件。
 */

export interface CodebuddyResponseOptions {
  model: string;
  tools: CodebuddyToolMap;
  stream: boolean;
  signal?: AbortSignal;
  abort?: () => void;
  onComplete?: (response: Record<string, unknown>) => void;
  onChunk?: (chunk: string) => void;
  sanitizeError?: (error: Record<string, unknown>) => Record<string, unknown>;
}

type Json = Record<string, unknown>;

interface MessageBlock {
  kind: "message";
  item: Json;
  outputIndex: number;
  text: string;
  refusal: string;
}
interface ReasoningBlock {
  kind: "reasoning";
  item: Json;
  outputIndex: number;
  text: string;
}
interface ToolBlock {
  kind: "tool";
  item: Json;
  outputIndex: number;
  arguments: string;
  custom: boolean;
}
type Block = MessageBlock | ReasoningBlock | ToolBlock;

const encoder = new TextEncoder();
function safely(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* 日志回调不能中断响应。 */ }
}
function record(value: unknown, label: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`CodeBuddy ${label} 必须是对象`);
  return value as Json;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`CodeBuddy ${label} 必须是字符串`);
  return value;
}

/** 仅消费一条上游流；严格解析 SSE，[DONE] 哨兵结束。 */
async function* readFrames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Json | "[DONE]"> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  function line(value: string): Json | "[DONE]" | undefined {
    if (value === "") {
      if (!data.length) return;
      const joined = data.join("\n");
      data = [];
      if (joined === "[DONE]") return "[DONE]";
      let parsed: unknown;
      try { parsed = JSON.parse(joined); }
      catch { throw new Error("CodeBuddy SSE 包含无效 JSON"); }
      return record(parsed, "SSE data");
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
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
      if (buffer.length || data.length) throw new Error("CodeBuddy SSE 在事件结束前意外 EOF");
      return;
    }
  }
}

function usageFromUpstream(value: unknown): Json | null {
  if (value === undefined || value === null) return null;
  const usage = record(value, "usage");
  const count = (key: string): number => typeof usage[key] === "number" ? usage[key] as number : 0;
  const input = count("prompt_tokens");
  const output = count("completion_tokens");
  const result: Json = { input_tokens: input, output_tokens: output, total_tokens: count("total_tokens") || input + output };
  const details = (key: string): Json | undefined => {
    if (usage[key] === undefined || usage[key] === null) return undefined;
    return record(usage[key], key);
  };
  const cachedTokens = details("prompt_tokens_details")?.cached_tokens;
  if (typeof cachedTokens === "number") {
    result.input_tokens_details = { cached_tokens: cachedTokens };
  }
  const reasoningTokens = details("completion_tokens_details")?.reasoning_tokens;
  if (typeof reasoningTokens === "number") {
    result.output_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return result;
}

/** 把整包 chat completion 重放为 SSE chunk 序列，复用同一事件合成路径。 */
function replayCompletionAsSSE(payload: Json, model: string): ReadableStream<Uint8Array> {
  const choice = Array.isArray(payload.choices) ? record(payload.choices[0], "choices[0]") : undefined;
  const message = record(choice?.message, "choices[0].message");
  const frames: Json[] = [];
  const emit = (delta: Json): void => {
    frames.push({
      id: typeof payload.id === "string" ? payload.id : "chatcmpl_fixture",
      object: "chat.completion.chunk",
      created: typeof payload.created === "number" ? payload.created : 0,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    });
  };
  if (typeof message.reasoning_content === "string") emit({ reasoning_content: message.reasoning_content });
  if (typeof message.content === "string" && message.content) emit({ content: message.content });
  if (typeof message.refusal === "string" && message.refusal) emit({ refusal: message.refusal });
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((raw, index) => {
      const call = record(raw, "tool_calls");
      emit({ tool_calls: [{ ...call, index: typeof call.index === "number" ? call.index : index }] });
    });
  }
  frames.push({
    id: typeof payload.id === "string" ? payload.id : "chatcmpl_fixture",
    object: "chat.completion.chunk",
    created: typeof payload.created === "number" ? payload.created : 0,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? "stop" }],
    usage: payload.usage ?? {},
  });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")));
      controller.close();
    },
  });
}

export async function createCodebuddyResponse(upstream: Response, responseOptions: CodebuddyResponseOptions): Promise<Response> {
  const contentType = upstream.headers.get("content-type") ?? "";
  // 上游忽略 stream 参数时返回整包 JSON：解析单条 completion，复用同一事件合成路径。
  if (!contentType.includes("text/event-stream")) {
    let payload: Json;
    try { payload = record(await upstream.json(), "上游响应"); }
    catch { throw new Error("CodeBuddy 上游响应不是有效 JSON"); }
    if (payload.error !== undefined) {
      const error = record(payload.error, "error");
      throw new Error(requiredString(error.message ?? "CodeBuddy 上游响应失败", "error.message"));
    }
    return streamResponses(replayCompletionAsSSE(payload, responseOptions.model), responseOptions);
  }
  if (!upstream.body) throw new Error("CodeBuddy 上游响应缺少 body");
  return streamResponses(upstream.body, responseOptions);
}

async function streamResponses(body: ReadableStream<Uint8Array>, options: CodebuddyResponseOptions): Promise<Response> {
  const reader = body.getReader();
  const blocks = new Map<string, Block>();
  /** 已正常闭合的块（closeBlocks 置位）；finish 只把未闭合块标记为 incomplete。 */
  const closedBlocks = new Set<Block>();
  const output: Json[] = [];
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  let finalResponse: Json | undefined;
  let finishReason: string | undefined;
  let upstreamUsage: Json | null = null;
  let canceled = false;
  let cleaned = false;
  const preserveReasoning = /deepseek/i.test(options.model);
  const snapshot = (status: string): Json => ({
    id, object: "response", created_at: createdAt, model: options.model, status,
    output: structuredClone(output), error: null, incomplete_details: null, usage: null,
  });
  const event = (type: string, fields: Json = {}): Json => ({ type, sequence_number: sequence++, ...fields });
  const fields = (block: Block): Json => ({ item_id: block.item.id, output_index: block.outputIndex });

  function finish(status: "completed" | "incomplete" | "failed", error?: Json): Json | undefined {
    if (finalResponse) return;
    for (const block of blocks.values()) {
      if (closedBlocks.has(block)) continue;
      if (block.kind === "reasoning" && preserveReasoning) {
        block.item.encrypted_content = encodeCodebuddyReasoning(options.model, block.text);
      }
      block.item.status = "incomplete";
    }
    finalResponse = { ...snapshot(status), usage: upstreamUsage };
    if (status === "incomplete") {
      finalResponse.incomplete_details = { reason: finishReason === "content_filter" ? "content_filter" : "max_output_tokens" };
    }
    if (error) {
      try { finalResponse.error = options.sanitizeError ? options.sanitizeError(error) : error; }
      catch { finalResponse.error = { code: "upstream_error", message: "CodeBuddy 上游响应失败" }; }
    }
    cleanup();
    safely(() => options.onComplete?.(structuredClone(finalResponse!)));
    return event(`response.${status}`, { response: structuredClone(finalResponse) });
  }
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    options.signal?.removeEventListener("abort", handleAbort);
    safely(options.abort);
  }
  function handleAbort(): void {
    if (finalResponse) return;
    canceled = true;
    finish("failed", { code: "response_cancelled", message: "CodeBuddy 响应已取消" });
  }
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  if (options.signal?.aborted) handleAbort();

  const pending: Json[] = [];
  function emit(value: Json): void { pending.push(value); }

  function ensureMessage(): MessageBlock {
    const existing = blocks.get("message");
    if (existing) return existing as MessageBlock;
    const item: Json = { id: `item_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", status: "in_progress", content: [] };
    const block: MessageBlock = { kind: "message", item, outputIndex: output.length, text: "", refusal: "" };
    blocks.set("message", block);
    output.push(item);
    emit(event("response.output_item.added", { output_index: block.outputIndex, item: structuredClone(item) }));
    return block;
  }
  function appendMessageText(value: string): void {
    if (!value) return;
    const block = ensureMessage();
    const existing = block.item.content as Json[];
    let index = existing.findIndex((part) => part.type === "output_text");
    if (index < 0) {
      const part = { type: "output_text", text: "", annotations: [], logprobs: [] };
      existing.push(part);
      index = existing.length - 1;
      emit(event("response.content_part.added", { ...fields(block), content_index: index, part: structuredClone(part) }));
    }
    block.text += value;
    existing[index]!.text = block.text;
    emit(event("response.output_text.delta", { ...fields(block), content_index: index, delta: value, logprobs: [] }));
  }
  function appendRefusal(value: string): void {
    if (!value) return;
    const block = ensureMessage();
    const existing = block.item.content as Json[];
    let index = existing.findIndex((part) => part.type === "refusal");
    if (index < 0) {
      existing.push({ type: "refusal", refusal: "" });
      index = existing.length - 1;
      emit(event("response.content_part.added", { ...fields(block), content_index: index, part: { type: "refusal", refusal: "" } }));
    }
    block.refusal += value;
    existing[index]!.refusal = block.refusal;
    emit(event("response.refusal.delta", { ...fields(block), content_index: index, delta: value }));
  }
  function ensureReasoning(): ReasoningBlock {
    const existing = blocks.get("reasoning");
    if (existing) return existing as ReasoningBlock;
    const item: Json = { id: `item_${crypto.randomUUID().replaceAll("-", "")}`, type: "reasoning", status: "in_progress", summary: [] };
    const block: ReasoningBlock = { kind: "reasoning", item, outputIndex: output.length, text: "" };
    blocks.set("reasoning", block);
    output.push(item);
    emit(event("response.output_item.added", { output_index: block.outputIndex, item: structuredClone(item) }));
    return block;
  }
  function appendReasoning(value: string): void {
    if (!value && !preserveReasoning) return;
    const block = ensureReasoning();
    if (!value) return;
    const summary = block.item.summary as Json[];
    if (!summary.length) {
      const part = { type: "summary_text", text: "" };
      summary.push(part);
      emit(event("response.reasoning_summary_part.added", { ...fields(block), summary_index: 0, part: structuredClone(part) }));
    }
    block.text += value;
    summary[0]!.text = block.text;
    emit(event("response.reasoning_summary_text.delta", { ...fields(block), summary_index: 0, delta: value }));
  }
  function openToolCall(index: number, call: Json): void {
    const key = `tool:${index}`;
    if (blocks.has(key)) return;
    const function_ = record(call.function ?? {}, "tool_calls.function");
    const name = typeof function_.name === "string" ? function_.name : "";
    if (!name) throw new Error("CodeBuddy tool_call 首个 delta 缺少 function.name");
    const mapped = options.tools.get(name);
    if (!mapped) throw new Error(`CodeBuddy 返回了未声明的工具：${name}`);
    const callId = typeof call.id === "string" && call.id ? call.id : `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const itemId = `item_${crypto.randomUUID().replaceAll("-", "")}`;
    const item: Json = mapped.custom
      ? { id: itemId, type: "custom_tool_call", call_id: callId, name: mapped.name, ...(mapped.namespace === undefined ? {} : { namespace: mapped.namespace }), status: "in_progress", input: "" }
      : { id: itemId, type: "function_call", call_id: callId, name: mapped.name, ...(mapped.namespace === undefined ? {} : { namespace: mapped.namespace }), status: "in_progress", arguments: "" };
    const block: ToolBlock = { kind: "tool", item, outputIndex: output.length, arguments: "", custom: mapped.custom };
    blocks.set(key, block);
    output.push(item);
    emit(event("response.output_item.added", { output_index: block.outputIndex, item: structuredClone(item) }));
  }
  function appendToolArguments(index: number, value: string): void {
    if (!value) return;
    const block = blocks.get(`tool:${index}`);
    if (!block || block.kind !== "tool") throw new Error("CodeBuddy tool delta 引用了未声明的工具调用");
    block.arguments += value;
    if (block.custom) {
      emit(event("response.custom_tool_call_input.delta", { ...fields(block), delta: value }));
    } else {
      (block.item as { arguments: string }).arguments = block.arguments;
      emit(event("response.function_call_arguments.delta", { ...fields(block), delta: value }));
    }
  }
  function closeBlocks(result: Json[]): void {
    for (const block of blocks.values()) {
      if (closedBlocks.has(block)) continue;
      closedBlocks.add(block);
      const base = fields(block);
      if (block.kind === "message") {
        const textIndex = (block.item.content as Json[]).findIndex((entry) => entry.type === "output_text");
        if (textIndex >= 0 && block.text) {
          const part = (block.item.content as Json[])[textIndex]!;
          result.push(event("response.output_text.done", { ...base, content_index: textIndex, text: block.text, logprobs: [] }));
          result.push(event("response.content_part.done", { ...base, content_index: textIndex, part: structuredClone(part) }));
        }
        const refusalIndex = (block.item.content as Json[]).findIndex((entry) => entry.type === "refusal");
        if (refusalIndex >= 0 && block.refusal) {
          result.push(event("response.refusal.done", { ...base, content_index: refusalIndex, refusal: block.refusal }));
          result.push(event("response.content_part.done", { ...base, content_index: refusalIndex, part: structuredClone((block.item.content as Json[])[refusalIndex]!) }));
        }
      } else if (block.kind === "reasoning") {
        if (preserveReasoning) block.item.encrypted_content = encodeCodebuddyReasoning(options.model, block.text);
        if ((block.item.summary as Json[]).length) {
          result.push(event("response.reasoning_summary_text.done", { ...base, summary_index: 0, text: block.text }));
          result.push(event("response.reasoning_summary_part.done", { ...base, summary_index: 0, part: { type: "summary_text", text: block.text } }));
        }
      } else {
        const parsedArguments = block.arguments || "{}";
        let parsed: unknown;
        try { parsed = JSON.parse(parsedArguments); }
        catch { throw new Error("CodeBuddy tool arguments 包含无效或未结束的 JSON"); }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("CodeBuddy tool arguments 必须是 JSON 对象");
        }
        if (block.custom) {
          const input = requiredString((parsed as Json).input, "custom tool input");
          block.item.input = input;
          result.push(event("response.custom_tool_call_input.done", { ...base, input }));
        } else {
          result.push(event("response.function_call_arguments.done", { ...base, arguments: parsedArguments }));
        }
      }
      block.item.status = "completed";
      result.push(event("response.output_item.done", { output_index: block.outputIndex, item: structuredClone(block.item) }));
    }
  }

  async function* events(): AsyncGenerator<Json> {
    try {
      if (canceled) return;
      yield event("response.created", { response: snapshot("in_progress") });
      yield event("response.in_progress", { response: snapshot("in_progress") });
      for (const value of pending.splice(0)) yield value;
      for await (const frame of readFrames(reader)) {
        if (canceled) return;
        if (frame === "[DONE]") break;
        if (frame.error !== undefined) {
          const original = record(frame.error, "error");
          const terminal = finish("failed", {
            code: typeof original.code === "string" ? original.code : "upstream_error",
            message: typeof original.message === "string" ? original.message : "CodeBuddy 上游响应失败",
            upstream_error: original,
          });
          if (terminal && !canceled) yield terminal;
          return;
        }
        const usage = usageFromUpstream(frame.usage);
        if (usage) upstreamUsage = usage;
        if (!Array.isArray(frame.choices)) continue;
        for (const raw of frame.choices) {
          const choice = record(raw, "choices");
          if (choice.index !== undefined && choice.index !== 0) continue;
          // 上游未结束时 finish_reason 为 ""（空串）或 null，均视为未结束。
          if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
            finishReason = choice.finish_reason;
          }
          const delta = record(choice.delta ?? {}, "choices.delta");
          if (typeof delta.content === "string") appendMessageText(delta.content);
          if (typeof delta.reasoning_content === "string") appendReasoning(delta.reasoning_content);
          if (typeof delta.refusal === "string") appendRefusal(delta.refusal);
          if (Array.isArray(delta.tool_calls)) {
            for (const rawCall of delta.tool_calls) {
              const call = record(rawCall, "tool_calls");
              const index = typeof call.index === "number" && Number.isInteger(call.index) && call.index >= 0 ? call.index : 0;
              openToolCall(index, call);
              const function_ = record(call.function ?? {}, "tool_calls.function");
              if (typeof function_.arguments === "string") appendToolArguments(index, function_.arguments);
            }
          }
          for (const value of pending.splice(0)) yield value;
        }
      }
      if (canceled) return;
      if (finishReason !== undefined && !["stop", "tool_calls", "length", "content_filter"].includes(finishReason)) {
        throw new Error(`CodeBuddy 不支持的 finish_reason：${finishReason}`);
      }
      const result: Json[] = [];
      closeBlocks(result);
      const status = finishReason === "length" || finishReason === "content_filter" ? "incomplete" : "completed";
      const terminal = finish(status);
      for (const value of result) yield value;
      if (terminal) yield terminal;
    } catch (error) {
      const terminal = finish("failed", { code: "upstream_protocol_error", message: error instanceof Error ? error.message : String(error) });
      if (terminal && !canceled) yield terminal;
    } finally {
      cleanup();
      try { reader.releaseLock(); } catch { /* 正在取消的读取由 cancel 收尾。 */ }
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
      reader.cancel().catch(() => undefined);
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
