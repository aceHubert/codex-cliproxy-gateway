import type { AgyToolMap } from "./request.ts";

/**
 * Antigravity v1internal streamGenerateContent（SSE）→ Codex Responses 事件流。
 *
 * 上游每帧是 v1internal 包装：{"response": master.GenerateContentResponse, "traceId"}。
 * 结构对齐 zcode/codebuddy 的 response.ts：严格 SSE 解析、事件序号连续、快照聚合，
 * 客户端非流式时聚合为完整 JSON。thought=true 的 parts 映射为 reasoning 摘要；
 * 函数调用携带的 thoughtSignature 以 agn1: 信封放进 reasoning 项的 encrypted_content
 * 下发（上游要求回放调用时带回，缺失直接 400）；functionCall 部件按声明表还原
 * function_call/custom_tool_call。
 */

export interface AgyResponseOptions {
  model: string;
  tools: AgyToolMap;
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
}
type Block = MessageBlock | ReasoningBlock | ToolBlock;

const encoder = new TextEncoder();
function safely(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* 日志回调不能中断响应。 */ }
}
function record(value: unknown, label: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Antigravity ${label} 必须是对象`);
  return value as Json;
}

/** 仅消费一条上游流；严格解析 SSE（多行 data 拼接、注释行忽略）。 */
async function* readFrames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Json> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  function line(value: string): Json | undefined {
    if (value === "") {
      if (!data.length) return;
      const joined = data.join("\n");
      data = [];
      let parsed: unknown;
      try { parsed = JSON.parse(joined); }
      catch { throw new Error("Antigravity SSE 包含无效 JSON"); }
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
      if (buffer.length || data.length) throw new Error("Antigravity SSE 在事件结束前意外 EOF");
      return;
    }
  }
}

function usageFromUpstream(value: unknown): Json | null {
  if (value === undefined || value === null) return null;
  const usage = record(value, "usageMetadata");
  const count = (key: string): number => typeof usage[key] === "number" ? usage[key] as number : 0;
  const input = count("promptTokenCount");
  const output = count("candidatesTokenCount");
  const result: Json = { input_tokens: input, output_tokens: output, total_tokens: count("totalTokenCount") || input + output };
  const thoughts = count("thoughtsTokenCount");
  if (thoughts > 0) result.output_tokens_details = { reasoning_tokens: thoughts };
  const cached = usage.promptTokensDetails;
  if (cached !== undefined && cached !== null) {
    const details = record(cached, "promptTokensDetails");
    if (typeof details.cachedTokens === "number") result.input_tokens_details = { cached_tokens: details.cachedTokens };
  }
  return result;
}

const SAFETY_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "LANGUAGE"]);

function finishDisposition(finishReason: string | undefined): { status: "completed" | "incomplete" | "failed"; incompleteReason?: string; failure?: string } {
  if (finishReason === undefined || finishReason === "" || finishReason === "STOP") return { status: "completed" };
  if (finishReason === "MAX_TOKENS") return { status: "incomplete", incompleteReason: "max_output_tokens" };
  if (SAFETY_FINISH.has(finishReason)) return { status: "incomplete", incompleteReason: "content_filter" };
  if (finishReason === "MALFORMED_FUNCTION_CALL") return { status: "failed", failure: "Antigravity 上游报告函数调用格式无效，请检查工具声明后重试" };
  return { status: "failed", failure: `Antigravity 上游返回不支持的 finishReason：${finishReason}` };
}

export async function createAgyResponse(upstream: Response, options: AgyResponseOptions): Promise<Response> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // 上游忽略 alt=sse 时可能整包返回：包装成单帧 SSE 复用同一事件合成路径。
    let payload: Json;
    try { payload = record(await upstream.json(), "上游响应"); }
    catch { throw new Error("Antigravity 上游响应不是有效 JSON"); }
    if (payload.error !== undefined) {
      const error = record(payload.error, "error");
      throw new Error(typeof error.message === "string" && error.message ? error.message : "Antigravity 上游响应失败");
    }
    const frames = [payload];
    return streamResponses(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")));
        controller.close();
      },
    }), options);
  }
  if (!upstream.body) throw new Error("Antigravity 上游响应缺少 body");
  return streamResponses(upstream.body, options);
}

async function streamResponses(body: ReadableStream<Uint8Array>, options: AgyResponseOptions): Promise<Response> {
  const reader = body.getReader();
  const blocks = new Map<string, Block>();
  const closedBlocks = new Set<Block>();
  const output: Json[] = [];
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  let finalResponse: Json | undefined;
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  let upstreamUsage: Json | null = null;
  let canceled = false;
  let cleaned = false;
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
      block.item.status = "incomplete";
    }
    finalResponse = { ...snapshot(status), usage: upstreamUsage };
    if (status === "incomplete") {
      finalResponse.incomplete_details = { reason: finishReason === "MAX_TOKENS" ? "max_output_tokens" : "content_filter" };
    }
    if (error) {
      try { finalResponse.error = options.sanitizeError ? options.sanitizeError(error) : error; }
      catch { finalResponse.error = { code: "upstream_error", message: "Antigravity 上游响应失败" }; }
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
    finish("failed", { code: "response_cancelled", message: "Antigravity 响应已取消" });
  }
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  if (options.signal?.aborted) handleAbort();

  const pending: Json[] = [];
  function emit(value: Json): void { pending.push(value); }

  function ensureMessage(): MessageBlock {
    const existing = blocks.get("message");
    if (existing) return existing as MessageBlock;
    const item: Json = { id: `item_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", status: "in_progress", content: [] };
    const block: MessageBlock = { kind: "message", item, outputIndex: output.length, text: "" };
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
    if (!value) return;
    const block = ensureReasoning();
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
  function openToolCall(index: number, call: Json, signature?: string): void {
    const key = `tool:${index}`;
    if (blocks.has(key)) throw new Error(`Antigravity 重复的工具调用序号 ${index}`);
    const name = typeof call.name === "string" ? call.name : "";
    if (!name) throw new Error("Antigravity functionCall 缺少 name");
    const mapped = options.tools.get(name);
    if (!mapped) throw new Error(`Antigravity 返回了未声明的工具：${name}`);
    // 上游要求回放函数调用时携带 thoughtSignature：以 agn1: 信封放进 reasoning 项的
    // encrypted_content 随调用下发，客户端下一轮回传后由请求侧挂回 functionCall。
    if (signature) {
      const sigItem: Json = { id: `item_${crypto.randomUUID().replaceAll("-", "")}`, type: "reasoning", status: "in_progress", summary: [], encrypted_content: `agn1:${signature}` };
      const sigBlock: ReasoningBlock = { kind: "reasoning", item: sigItem, outputIndex: output.length, text: "" };
      blocks.set(`sig:${index}`, sigBlock);
      output.push(sigItem);
      emit(event("response.output_item.added", { output_index: sigBlock.outputIndex, item: structuredClone(sigItem) }));
    }
    const callId = `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const itemId = `item_${crypto.randomUUID().replaceAll("-", "")}`;
    const args = record(call.args ?? {}, "functionCall.args");
    const item: Json = mapped.custom
      ? { id: itemId, type: "custom_tool_call", call_id: callId, name: mapped.name, ...(mapped.namespace === undefined ? {} : { namespace: mapped.namespace }), status: "in_progress", input: "" }
      : { id: itemId, type: "function_call", call_id: callId, name: mapped.name, ...(mapped.namespace === undefined ? {} : { namespace: mapped.namespace }), status: "in_progress", arguments: "" };
    const block: ToolBlock = { kind: "tool", item, outputIndex: output.length };
    blocks.set(key, block);
    output.push(item);
    emit(event("response.output_item.added", { output_index: block.outputIndex, item: structuredClone(item) }));
    // Gemini 的 functionCall 一次给全量 args，不存在参数增量：直接整段下发。
    if (mapped.custom) {
      const input = typeof args.input === "string" ? args.input : JSON.stringify(args.input ?? null);
      block.item.input = input;
      emit(event("response.custom_tool_call_input.delta", { ...fields(block), delta: input }));
    } else {
      const argumentsText = JSON.stringify(args);
      block.item.arguments = argumentsText;
      emit(event("response.function_call_arguments.delta", { ...fields(block), delta: argumentsText }));
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
      } else if (block.kind === "reasoning") {
        if ((block.item.summary as Json[]).length) {
          result.push(event("response.reasoning_summary_text.done", { ...base, summary_index: 0, text: block.text }));
          result.push(event("response.reasoning_summary_part.done", { ...base, summary_index: 0, part: { type: "summary_text", text: block.text } }));
        }
      } else {
        if (block.item.type === "custom_tool_call") {
          result.push(event("response.custom_tool_call_input.done", { ...base, input: block.item.input }));
        } else {
          result.push(event("response.function_call_arguments.done", { ...base, arguments: block.item.arguments }));
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
      let toolIndex = 0;
      for await (const frame of readFrames(reader)) {
        if (canceled) return;
        if (frame.error !== undefined) {
          const original = record(frame.error, "error");
          const terminal = finish("failed", {
            code: typeof original.code === "number" || typeof original.code === "string" ? String(original.code) : "upstream_error",
            message: typeof original.message === "string" && original.message ? original.message : "Antigravity 上游响应失败",
            upstream_error: original,
          });
          if (terminal && !canceled) yield terminal;
          return;
        }
        const inner = frame.response === undefined || frame.response === null ? undefined : record(frame.response, "response");
        if (inner === undefined) continue;
        const usage = usageFromUpstream(inner.usageMetadata);
        if (usage) upstreamUsage = usage;
        const feedback = inner.promptFeedback === undefined || inner.promptFeedback === null
          ? undefined : record(inner.promptFeedback, "promptFeedback");
        if (feedback !== undefined && typeof feedback.blockReason === "string" && feedback.blockReason) {
          blockReason = feedback.blockReason;
        }
        if (!Array.isArray(inner.candidates)) continue;
        const candidate = record(inner.candidates[0] ?? {}, "candidates[0]");
        if (typeof candidate.finishReason === "string" && candidate.finishReason) finishReason = candidate.finishReason;
        const content = candidate.content === undefined || candidate.content === null
          ? {} : record(candidate.content, "candidates[0].content");
        if (!Array.isArray(content.parts)) {
          for (const value of pending.splice(0)) yield value;
          continue;
        }
        // thoughtSignature 可能独占一个 part（无 text/functionCall），也可能附着在
        // functionCall part 上：独立出现的缓存给下一个函数调用，附着的一并下发。
        let pendingSignature: string | undefined;
        for (const raw of content.parts) {
          const part = record(raw, "candidates[0].content.parts");
          const signature = typeof part.thoughtSignature === "string" && part.thoughtSignature
            ? part.thoughtSignature : undefined;
          if (part.functionCall !== undefined && part.functionCall !== null) {
            openToolCall(toolIndex++, record(part.functionCall, "functionCall"), signature ?? pendingSignature);
            pendingSignature = undefined;
            continue;
          }
          if (signature) pendingSignature = signature;
          if (typeof part.text !== "string" || !part.text) continue;
          if (part.thought === true) appendReasoning(part.text);
          else appendMessageText(part.text);
        }
        for (const value of pending.splice(0)) yield value;
      }
      if (canceled) return;
      if (blockReason !== undefined) {
        const terminal = finish("incomplete");
        if (terminal) yield terminal;
        return;
      }
      const disposition = finishDisposition(finishReason);
      if (disposition.status === "failed") {
        const terminal = finish("failed", { code: "agy_finish_error", message: disposition.failure });
        if (terminal && !canceled) yield terminal;
        return;
      }
      const result: Json[] = [];
      closeBlocks(result);
      const terminal = finish(disposition.status);
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
    const response = finalResponse ?? snapshot("failed");
    return Response.json(response, { status: finalResponse?.status === "failed" || canceled ? 502 : 200 });
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
