/**
 * 上游流式解析：chat-completions / responses / anthropic / gemini 的 SSE 或整包
 * JSON → 统一 BridgeStreamEvent。npm 库的 parseOpenAIStream 等会静默丢帧、忽略
 * reasoning_content / refusal / usage 明细（实测），这里以严格 SSE 读取器为基础
 * 自行归一化，正常终态必须有上游协议结束信号，不能由物理 EOF 推断。
 */

import { readSseFrames } from "./sse.ts";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import type { BridgeStopReason, BridgeStreamEvent, BridgeUsage } from "./types.ts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toBridgeStopReason(raw: string): BridgeStopReason {
  switch (raw) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
    case "refusal_stop":
    case "STOP":
      return "stop";
    case "tool_calls":
    case "tool_use":
      return "tool_calls";
    case "length":
    case "max_tokens":
    case "MAX_TOKENS":
      return "length";
    case "content_filter":
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    default:
      return "other";
  }
}

function chatUsageToBridge(value: unknown): BridgeUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: BridgeUsage = {
    inputTokens: typeof value.prompt_tokens === "number" ? value.prompt_tokens : undefined,
    outputTokens: typeof value.completion_tokens === "number" ? value.completion_tokens : undefined,
    totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : undefined,
  };
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
  const completionDetails = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : undefined;
  if (promptDetails && typeof promptDetails.cached_tokens === "number") usage.cachedInputTokens = promptDetails.cached_tokens;
  if (completionDetails && typeof completionDetails.reasoning_tokens === "number") usage.reasoningTokens = completionDetails.reasoning_tokens;
  return usage;
}

/** Chat Completions 单条 completion（非流式）重放为事件序列，复用同一合成路径。 */
function* chatCompletionToEvents(payload: Json, model: string): Generator<BridgeStreamEvent> {
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const message = isRecord(choice?.message) ? choice!.message : {};
  if (typeof payload.id === "string" || model) {
    yield { type: "message_start", id: typeof payload.id === "string" ? payload.id : "", model: typeof payload.model === "string" ? payload.model : model };
  }
  if (typeof message.reasoning_content === "string") {
    yield { type: "content_delta", delta: { thinking: message.reasoning_content } };
  }
  if (typeof message.content === "string" && message.content) {
    yield { type: "content_delta", delta: { text: message.content } };
  }
  if (typeof message.refusal === "string" && message.refusal) {
    yield { type: "content_delta", delta: { refusal: message.refusal } };
  }
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isRecord(raw)) continue;
      const function_ = isRecord(raw.function) ? raw.function : {};
      const id = typeof raw.id === "string" && raw.id ? raw.id : `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
      yield { type: "tool_call_start", tool_call: { id, name: typeof function_.name === "string" ? function_.name : "" } };
      if (typeof function_.arguments === "string" && function_.arguments) {
        yield { type: "tool_call_delta", tool_call: { id, arguments_delta: function_.arguments } };
      }
      yield { type: "tool_call_end", tool_call: { id } };
    }
  }
  const rawStop = typeof choice?.finish_reason === "string" && choice!.finish_reason !== "" ? choice!.finish_reason : "stop";
  yield {
    type: "message_end",
    stop_reason: toBridgeStopReason(rawStop),
    raw_stop_reason: rawStop,
    usage: chatUsageToBridge(payload.usage),
  };
}

async function* parseChatStream(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<BridgeStreamEvent> {
  let started = false;
  let lastStopReason: string | undefined;
  let usage: BridgeUsage | undefined;
  let ended = false;
  const openCalls = new Map<number, { id: string; name: string; started: boolean; pendingArguments: string[] }>();
  const emitEnd = function* (): Generator<BridgeStreamEvent> {
    if (ended) return;
    ended = true;
    for (const call of openCalls.values()) {
      // 直到流结束仍缺 name 的待定调用不能静默丢弃：以空名开始并结束，交由
      // 输出侧的严格身份校验拒绝（与基线显式报错语义一致）。
      if (call.started) {
        yield { type: "tool_call_end", tool_call: { id: call.id } };
        continue;
      }
      yield { type: "tool_call_start", tool_call: { id: call.id, name: call.name } };
      for (const buffered of call.pendingArguments) {
        yield { type: "tool_call_delta", tool_call: { id: call.id, arguments_delta: buffered } };
      }
      yield { type: "tool_call_end", tool_call: { id: call.id } };
    }
    openCalls.clear();
    yield {
      type: "message_end",
      stop_reason: toBridgeStopReason(lastStopReason ?? "stop"),
      ...(lastStopReason !== undefined ? { raw_stop_reason: lastStopReason } : {}),
      usage,
    };
  };
  for await (const frame of readSseFrames(body)) {
    if (frame === "[DONE]") {
      if (!started) throw new Error("Chat 上游流在消息开始前结束");
      yield* emitEnd();
      return;
    }
    const chunk = JSON.parse(frame.data) as Json;
    if (!started) {
      yield { type: "message_start", id: typeof chunk.id === "string" ? chunk.id : "", model: typeof chunk.model === "string" ? chunk.model : model };
      started = true;
    }
    if (chunk.error !== undefined) {
      const error = isRecord(chunk.error) ? chunk.error : {};
      yield {
        type: "error",
        error: {
          message: typeof error.message === "string" ? error.message : "上游返回错误",
          code: typeof error.code === "string" || typeof error.code === "number" ? String(error.code) : undefined,
          type: typeof error.type === "string" ? error.type : undefined,
          // 原始错误字段（status 等）随事件透传，供插件安全分类与审计。
          ...error,
        },
      };
      return;
    }
    const chunkUsage = chatUsageToBridge(chunk.usage);
    if (chunkUsage) usage = chunkUsage;
    if (!Array.isArray(chunk.choices)) continue;
    for (const raw of chunk.choices) {
      if (!isRecord(raw)) continue;
      if (raw.index !== undefined && raw.index !== 0) continue;
      const finishReason = raw.finish_reason;
      if (typeof finishReason === "string" && finishReason !== "") lastStopReason = finishReason;
      const delta = isRecord(raw.delta) ? raw.delta : {};
      if (typeof delta.content === "string" && delta.content) yield { type: "content_delta", delta: { text: delta.content } };
      if (typeof delta.reasoning_content === "string") {
        // 空字符串也产出事件：需要回放的服务（如 DeepSeek 信封）据此保留条目存在性。
        yield { type: "content_delta", delta: { thinking: delta.reasoning_content } };
      } else if (typeof delta.reasoning === "string" && delta.reasoning) {
        yield { type: "content_delta", delta: { thinking: delta.reasoning } };
      }
      if (typeof delta.refusal === "string" && delta.refusal) yield { type: "content_delta", delta: { refusal: delta.refusal } };
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          if (!isRecord(rawCall)) continue;
          const index = typeof rawCall.index === "number" && Number.isInteger(rawCall.index) && rawCall.index >= 0 ? rawCall.index : 0;
          const function_ = isRecord(rawCall.function) ? rawCall.function : {};
          const existing = openCalls.get(index);
          if (typeof rawCall.id === "string" && rawCall.id && !existing) {
            // id 与 name 可能被上游拆进不同帧：先登记待定调用，name 到达（同帧或后续
            // 帧）时才产出 tool_call_start；先到的 arguments 缓存，start 后按序补发。
            openCalls.set(index, { id: rawCall.id, name: typeof function_.name === "string" ? function_.name : "", started: false, pendingArguments: [] });
          } else if (existing && !existing.started && typeof function_.name === "string" && function_.name && !existing.name) {
            existing.name = function_.name;
          }
          const call = openCalls.get(index);
          if (!call) continue;
          if (!call.started && call.name) {
            call.started = true;
            yield { type: "tool_call_start", tool_call: { id: call.id, name: call.name } };
            for (const buffered of call.pendingArguments) {
              yield { type: "tool_call_delta", tool_call: { id: call.id, arguments_delta: buffered } };
            }
            call.pendingArguments = [];
          }
          if (typeof function_.arguments === "string" && function_.arguments) {
            if (call.started) {
              yield { type: "tool_call_delta", tool_call: { id: call.id, arguments_delta: function_.arguments } };
            } else {
              call.pendingArguments.push(function_.arguments);
            }
          }
        }
      }
    }
  }
  // finish_reason 已确认完成；随后可能还有独立 usage 帧，因此等 EOF 才收尾。
  if (started && lastStopReason !== undefined) yield* emitEnd();
  else throw new Error("Chat 上游流在结束信号前意外 EOF");
}

async function* parseAnthropicStream(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<BridgeStreamEvent> {
  let started = false;
  let ended = false;
  let stopReason: string | undefined;
  let usage: BridgeUsage = {};
  const blocks = new Map<number, { type: string; toolId?: string }>();
  const emitEnd = function* (): Generator<BridgeStreamEvent> {
    if (ended) return;
    ended = true;
    yield {
      type: "message_end",
      stop_reason: toBridgeStopReason(stopReason ?? "end_turn"),
      ...(stopReason !== undefined ? { raw_stop_reason: stopReason } : {}),
      usage: Object.keys(usage).length > 0 ? usage : undefined,
    };
  };
  for await (const frame of readSseFrames(body)) {
    if (frame === "[DONE]") {
      if (!started || !stopReason || blocks.size > 0) throw new Error("Anthropic 上游流在消息完成前收到 [DONE]");
      yield* emitEnd();
      return;
    }
    const data = JSON.parse(frame.data) as Json;
    const type = frame.event ?? (typeof data.type === "string" ? data.type : "");
    switch (type) {
      case "message_start": {
        const message = isRecord(data.message) ? data.message : data;
        if (isRecord(message.usage)) {
          if (typeof message.usage.input_tokens === "number") usage.inputTokens = message.usage.input_tokens;
          if (typeof message.usage.cache_read_input_tokens === "number") usage.cachedInputTokens = message.usage.cache_read_input_tokens;
          if (typeof message.usage.cache_creation_input_tokens === "number") usage.cacheCreationInputTokens = message.usage.cache_creation_input_tokens;
        }
        if (!started) {
          yield { type: "message_start", id: typeof message.id === "string" ? message.id : "", model: typeof message.model === "string" ? message.model : model };
          started = true;
        }
        break;
      }
      case "content_block_start": {
        const index = typeof data.index === "number" ? data.index : -1;
        const block = isRecord(data.content_block) ? data.content_block : {};
        const blockType = typeof block.type === "string" ? block.type : "";
        blocks.set(index, { type: blockType, toolId: blockType === "tool_use" && typeof block.id === "string" ? block.id : undefined });
        if (blockType === "tool_use") {
          yield { type: "tool_call_start", tool_call: { id: typeof block.id === "string" ? block.id : "", name: typeof block.name === "string" ? block.name : "" } };
        }
        break;
      }
      case "content_block_delta": {
        const delta = isRecord(data.delta) ? data.delta : {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "content_delta", delta: { text: delta.text } };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          yield { type: "content_delta", delta: { thinking: delta.thinking } };
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          yield { type: "thinking_signature", signature: delta.signature };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const block = blocks.get(typeof data.index === "number" ? data.index : -1);
          if (block?.toolId && delta.partial_json) {
            yield { type: "tool_call_delta", tool_call: { id: block.toolId, arguments_delta: delta.partial_json } };
          }
        }
        break;
      }
      case "content_block_stop": {
        const index = typeof data.index === "number" ? data.index : -1;
        const block = blocks.get(index);
        if (block?.toolId) yield { type: "tool_call_end", tool_call: { id: block.toolId } };
        blocks.delete(index);
        break;
      }
      case "message_delta": {
        const delta = isRecord(data.delta) ? data.delta : {};
        if (typeof delta.stop_reason === "string" && delta.stop_reason) stopReason = delta.stop_reason;
        if (isRecord(data.usage)) {
          if (typeof data.usage.output_tokens === "number") usage.outputTokens = data.usage.output_tokens;
          if (typeof data.usage.input_tokens === "number") usage.inputTokens = data.usage.input_tokens;
        }
        break;
      }
      case "message_stop": {
        if (!started || !stopReason || blocks.size > 0) throw new Error("Anthropic 上游 message_stop 缺少完整消息结束信息");
        yield* emitEnd();
        return;
      }
      case "error": {
        const error = isRecord(data.error) ? data.error : {};
        yield {
          type: "error",
          error: {
            message: typeof error.message === "string" ? error.message : "上游返回错误",
            type: typeof error.type === "string" ? error.type : undefined,
          },
        };
        return;
      }
      default:
        break;
    }
  }
  throw new Error("Anthropic 上游流在 message_stop 前意外 EOF");
}

function geminiUsageToBridge(value: unknown): BridgeUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: BridgeUsage = {};
  if (typeof value.promptTokenCount === "number") usage.inputTokens = value.promptTokenCount;
  if (typeof value.candidatesTokenCount === "number") usage.outputTokens = value.candidatesTokenCount;
  if (typeof value.totalTokenCount === "number") usage.totalTokens = value.totalTokenCount;
  if (Array.isArray(value.promptTokensDetails)) {
    for (const detail of value.promptTokensDetails) {
      if (isRecord(detail) && detail.modality === "PROMPT_CACHE" && typeof detail.tokenCount === "number") {
        usage.cachedInputTokens = detail.tokenCount;
      }
    }
  }
  if (typeof value.thoughtsTokenCount === "number") {
    usage.reasoningTokens = value.thoughtsTokenCount;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

async function* parseGeminiStream(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<BridgeStreamEvent> {
  // 库解析器会在 EOF 合成 end_turn；直接读帧才能验证 finishReason 与末尾 usage。
  let started = false;
  let finishReason: string | undefined;
  let usage: BridgeUsage | undefined;
  let toolCallCounter = 0;
  for await (const frame of readSseFrames(body)) {
    if (frame === "[DONE]") break;
    const chunk = JSON.parse(frame.data) as Json;
    if (isRecord(chunk.error)) {
      yield { type: "error", error: {
        message: typeof chunk.error.message === "string" ? chunk.error.message : "上游返回错误",
        code: typeof chunk.error.code === "number" || typeof chunk.error.code === "string" ? String(chunk.error.code) : undefined,
      } };
      return;
    }
    if (!started) {
      started = true;
      yield { type: "message_start", id: `gemini-${Date.now()}`, model: typeof chunk.modelVersion === "string" ? chunk.modelVersion : model };
    }
    const chunkUsage = geminiUsageToBridge(chunk.usageMetadata);
    if (chunkUsage) usage = { ...usage, ...chunkUsage };
    const candidate = Array.isArray(chunk.candidates) && isRecord(chunk.candidates[0]) ? chunk.candidates[0] : {};
    const content = isRecord(candidate.content) ? candidate.content : {};
    if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (!isRecord(part)) continue;
        if (isRecord(part.functionCall)) {
          const id = `call_${toolCallCounter++}`;
          yield { type: "tool_call_start", tool_call: { id, name: typeof part.functionCall.name === "string" ? part.functionCall.name : "" } };
          yield { type: "tool_call_delta", tool_call: { id, arguments_delta: JSON.stringify(part.functionCall.args ?? {}) } };
          yield { type: "tool_call_end", tool_call: { id } };
        } else if (typeof part.text === "string" && part.text) {
          yield { type: "content_delta", delta: part.thought === true ? { thinking: part.text } : { text: part.text } };
        }
      }
    }
    if (typeof candidate.finishReason === "string" && candidate.finishReason) finishReason = candidate.finishReason;
    if (isRecord(chunk.promptFeedback) && typeof chunk.promptFeedback.blockReason === "string" && chunk.promptFeedback.blockReason) {
      yield { type: "message_end", stop_reason: "content_filter", raw_stop_reason: chunk.promptFeedback.blockReason, usage };
      return;
    }
  }
  if (!started || !finishReason) throw new Error("Gemini 上游流在 finishReason 前意外 EOF");
  yield { type: "message_end", stop_reason: toBridgeStopReason(finishReason), raw_stop_reason: finishReason, usage };
}

function responsesUsageToBridge(value: unknown): BridgeUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: BridgeUsage = {};
  if (typeof value.input_tokens === "number") usage.inputTokens = value.input_tokens;
  if (typeof value.output_tokens === "number") usage.outputTokens = value.output_tokens;
  if (typeof value.total_tokens === "number") usage.totalTokens = value.total_tokens;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : undefined;
  if (inputDetails && typeof inputDetails.cached_tokens === "number") usage.cachedInputTokens = inputDetails.cached_tokens;
  if (outputDetails && typeof outputDetails.reasoning_tokens === "number") usage.reasoningTokens = outputDetails.reasoning_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function responsesStopReason(status: string, reason: string | undefined): BridgeStopReason {
  // incomplete 的原因缺失或未知时仍保留未完成，不能降为正常 stop。
  if (status === "incomplete") return reason === "content_filter" ? "content_filter" : "length";
  return "stop";
}

async function* parseResponsesStream(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<BridgeStreamEvent> {
  let started = false;
  let ended = false;
  let sawToolCall = false;
  type ResponseCall = { id: string; custom: boolean; input: string; ended: boolean };
  const calls = new Map<string, ResponseCall>();
  const itemIds = new Map<string, string>();
  const outputIndices = new Map<number, string>();
  const openCalls = new Map<string, ResponseCall>();
  const findCall = (data: Json, item?: Json): ResponseCall | undefined => {
    const itemId = typeof data.item_id === "string" ? data.item_id : typeof item?.id === "string" ? item.id : undefined;
    const id = itemId !== undefined ? itemIds.get(itemId) : undefined;
    return calls.get(id ?? (typeof data.output_index === "number" ? outputIndices.get(data.output_index) : undefined)
      ?? (typeof item?.call_id === "string" ? item.call_id : ""));
  };
  const closeCall = function* (call: ResponseCall, input?: unknown, inputProvided = false): Generator<BridgeStreamEvent> {
    if (call.custom && inputProvided && typeof input !== "string") throw new Error("Responses custom 完成输入必须是字符串");
    if (call.ended) return;
    if (call.custom) {
      if (typeof input === "string") call.input = input;
      // 原生 Responses 的 custom 增量是自由文本，Bridge 参数则必须是可逆 JSON。
      yield { type: "tool_call_delta", tool_call: { id: call.id, arguments_delta: JSON.stringify({ input: call.input }) } };
    }
    call.ended = true;
    openCalls.delete(call.id);
    yield { type: "tool_call_end", tool_call: { id: call.id } };
  };
  const emitEnd = (stop: BridgeStopReason, raw: string | undefined, usage: BridgeUsage | undefined): BridgeStreamEvent => ({
    type: "message_end",
    stop_reason: sawToolCall && stop === "stop" ? "tool_calls" : stop,
    ...(raw !== undefined ? { raw_stop_reason: raw } : {}),
    usage,
  });
  for await (const frame of readSseFrames(body)) {
    if (frame === "[DONE]") {
      if (!ended) throw new Error("Responses 上游流在终态前收到 [DONE]");
      return;
    }
    if (ended) throw new Error("Responses 上游流在终态后返回额外数据帧");
    const data = JSON.parse(frame.data) as Json;
    const type = frame.event ?? (typeof data.type === "string" ? data.type : "");
    switch (type) {
      case "response.created":
      case "response.in_progress": {
        const response = isRecord(data.response) ? data.response : {};
        if (!started) {
          started = true;
          yield { type: "message_start", id: typeof response.id === "string" ? response.id : "", model: typeof response.model === "string" ? response.model : model };
        }
        break;
      }
      case "response.output_text.delta": {
        if (typeof data.delta === "string" && data.delta) yield { type: "content_delta", delta: { text: data.delta } };
        break;
      }
      case "response.refusal.delta": {
        if (typeof data.delta === "string" && data.delta) yield { type: "content_delta", delta: { refusal: data.delta } };
        break;
      }
      case "response.reasoning_summary_text.delta": {
        if (typeof data.delta === "string" && data.delta) yield { type: "content_delta", delta: { thinking: data.delta } };
        break;
      }
      case "response.output_item.added": {
        const item = isRecord(data.item) ? data.item : {};
        if (item.type === "function_call" || item.type === "custom_tool_call") {
          if (!started) {
            started = true;
            yield { type: "message_start", id: "", model };
          }
          sawToolCall = true;
          const id = typeof item.call_id === "string" && item.call_id ? item.call_id : String(item.id ?? "");
          const call: ResponseCall = { id, custom: item.type === "custom_tool_call", input: typeof item.input === "string" ? item.input : "", ended: false };
          calls.set(id, call);
          openCalls.set(id, call);
          itemIds.set(String(item.id ?? id), id);
          if (typeof data.output_index === "number") outputIndices.set(data.output_index, id);
          yield { type: "tool_call_start", tool_call: { id, name: typeof item.name === "string" ? item.name : "" } };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        if (typeof data.delta === "string" && data.delta) {
          const call = findCall(data);
          if (!call || call.custom || call.ended) throw new Error("Responses 工具参数增量引用了无效调用");
          yield { type: "tool_call_delta", tool_call: { id: call.id, arguments_delta: data.delta } };
        }
        break;
      }
      case "response.custom_tool_call_input.delta": {
        const call = findCall(data);
        if (!call || !call.custom || call.ended) throw new Error("Responses custom input 增量引用了无效调用");
        if (typeof data.delta !== "string") throw new Error("Responses custom input 增量必须是字符串");
        call.input += data.delta;
        break;
      }
      case "response.custom_tool_call_input.done": {
        const call = findCall(data);
        if (!call || !call.custom) throw new Error("Responses custom input 完成事件引用了无效调用");
        yield* closeCall(call, data.input, "input" in data);
        break;
      }
      case "response.output_item.done": {
        const item = isRecord(data.item) ? data.item : {};
        if (item.type === "function_call" || item.type === "custom_tool_call") {
          const call = findCall(data, item);
          if (!call) throw new Error("Responses 工具条目完成事件引用了无效调用");
          yield* closeCall(call, item.input, "input" in item);
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        if (!ended) {
          ended = true;
          const response = isRecord(data.response) ? data.response : {};
          const status = typeof response.status === "string" ? response.status : type.replace("response.", "");
          if (status !== type.replace("response.", "")) throw new Error("Responses 上游终态事件与响应状态不一致");
          if (status === "failed") {
            const error = isRecord(response.error) ? response.error : {};
            yield {
              type: "error",
              error: {
                message: typeof error.message === "string" ? error.message : "上游响应失败",
                code: typeof error.code === "string" ? error.code : undefined,
                ...error,
              },
            };
            return;
          }
          if (status === "completed" ? !started || openCalls.size > 0 : [...openCalls.values()].some((call) => !call.custom)) {
            throw new Error("Responses 上游终态缺少完整消息结束信息");
          }
          if (!started) {
            started = true;
            yield { type: "message_start", id: typeof response.id === "string" ? response.id : "", model };
          }
          const reason = isRecord(response.incomplete_details) && typeof response.incomplete_details.reason === "string"
            ? response.incomplete_details.reason
            : undefined;
          const stop = responsesStopReason(status, reason);
          if (started) yield emitEnd(stop, status, responsesUsageToBridge(response.usage));
        }
        break;
      }
      case "error": {
        const error = isRecord(data.error) ? data.error : {};
        yield {
          type: "error",
          error: {
            message: typeof error.message === "string" ? error.message : "上游返回错误",
            code: typeof error.code === "string" ? error.code : undefined,
          },
        };
        return;
      }
      default:
        break;
    }
  }
  if (!ended) throw new Error("Responses 上游流在终态前意外 EOF");
}

/** 上游响应 → 桥接事件流：SSE 严格解析；整包 JSON 先重放为事件序列。 */
export async function* parseUpstreamEvents(protocol: ClientProtocol, upstream: Response, model: string): AsyncGenerator<BridgeStreamEvent> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.body) throw new Error("上游响应缺少 body");
  if (!contentType.includes("text/event-stream")) {
    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      throw new Error("上游响应不是有效 JSON");
    }
    if (!isRecord(payload)) throw new Error("上游响应必须是 JSON 对象");
    if (protocol === "chat-completions") {
      if (payload.error !== undefined) {
        const error = isRecord(payload.error) ? payload.error : {};
        yield {
          type: "error",
          error: { message: typeof error.message === "string" ? error.message : "上游响应失败" },
        };
        return;
      }
      yield* chatCompletionToEvents(payload, model);
      return;
    }
    if (protocol === "anthropic") {
      const message = payload;
      yield { type: "message_start", id: typeof message.id === "string" ? message.id : "", model: typeof message.model === "string" ? message.model : model };
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            yield { type: "content_delta", delta: { text: block.text } };
          } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            yield { type: "content_delta", delta: { thinking: block.thinking } };
            if (typeof block.signature === "string") yield { type: "thinking_signature", signature: block.signature };
          } else if (block.type === "tool_use") {
            const id = typeof block.id === "string" ? block.id : "";
            yield { type: "tool_call_start", tool_call: { id, name: typeof block.name === "string" ? block.name : "" } };
            yield { type: "tool_call_delta", tool_call: { id, arguments_delta: JSON.stringify(block.input ?? {}) } };
            yield { type: "tool_call_end", tool_call: { id } };
          }
        }
      }
      const stop = typeof message.stop_reason === "string" ? message.stop_reason : "end_turn";
      const usage = isRecord(message.usage) ? message.usage : undefined;
      yield {
        type: "message_end",
        stop_reason: toBridgeStopReason(stop),
        raw_stop_reason: stop,
        usage: usage
          ? {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            cachedInputTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
            cacheCreationInputTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined,
          }
          : undefined,
      };
      return;
    }
    if (protocol === "responses") {
      const status = typeof payload.status === "string" ? payload.status : "completed";
      if (status === "failed") {
        const error = isRecord(payload.error) ? payload.error : {};
        yield { type: "error", error: {
          message: typeof error.message === "string" ? error.message : "上游响应失败",
          code: typeof error.code === "string" || typeof error.code === "number" ? String(error.code) : undefined,
          type: typeof error.type === "string" ? error.type : undefined,
        } };
        return;
      }
      if (status !== "completed" && status !== "incomplete") throw new Error("Responses 上游 JSON 缺少有效终态");
      if (Array.isArray(payload.output)) {
        for (const item of payload.output) {
          if (!isRecord(item)) continue;
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (isRecord(part) && part.type === "output_text" && typeof part.text === "string" && part.text) {
                yield { type: "content_delta", delta: { text: part.text } };
              }
            }
          } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
            for (const part of item.summary) {
              if (isRecord(part) && typeof part.text === "string" && part.text) {
                yield { type: "content_delta", delta: { thinking: part.text } };
              }
            }
          } else if (item.type === "function_call" || item.type === "custom_tool_call") {
            if (item.type === "custom_tool_call" && status === "completed" && typeof item.input !== "string") {
              throw new Error("Responses completed custom 输入必须是字符串");
            }
            const id = typeof item.call_id === "string" && item.call_id ? item.call_id : String(item.id ?? "");
            yield { type: "tool_call_start", tool_call: { id, name: typeof item.name === "string" ? item.name : "" } };
            const argumentsText = item.type === "custom_tool_call"
              ? JSON.stringify({ input: typeof item.input === "string" ? item.input : "" })
              : typeof item.arguments === "string" ? item.arguments : "{}";
            yield { type: "tool_call_delta", tool_call: { id, arguments_delta: argumentsText } };
            yield { type: "tool_call_end", tool_call: { id } };
          }
        }
      }
      const reason = isRecord(payload.incomplete_details) && typeof payload.incomplete_details.reason === "string" ? payload.incomplete_details.reason : undefined;
      const stop = responsesStopReason(status, reason);
      yield { type: "message_start", id: typeof payload.id === "string" ? payload.id : "", model: typeof payload.model === "string" ? payload.model : model };
      yield { type: "message_end", stop_reason: stop, raw_stop_reason: status, usage: responsesUsageToBridge(isRecord(payload.usage) ? payload.usage : undefined) };
      return;
    }
    // gemini 整包 JSON
    yield* geminiJsonToEvents(payload, model);
    return;
  }
  if (protocol === "chat-completions") {
    yield* parseChatStream(upstream.body, model);
    return;
  }
  if (protocol === "anthropic") {
    yield* parseAnthropicStream(upstream.body, model);
    return;
  }
  if (protocol === "responses") {
    yield* parseResponsesStream(upstream.body, model);
    return;
  }
  yield* parseGeminiStream(upstream.body, model);
}

function* geminiJsonToEvents(payload: Json, model: string): Generator<BridgeStreamEvent> {
  if (Array.isArray(payload.candidates) && payload.candidates.length > 0) {
    const candidate = isRecord(payload.candidates[0]) ? payload.candidates[0] : {};
    const content = isRecord(candidate.content) ? candidate.content : {};
    yield { type: "message_start", id: `gemini-${Date.now()}`, model: typeof payload.modelVersion === "string" ? payload.modelVersion : model };
    if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (!isRecord(part)) continue;
        if (isRecord(part.functionCall)) {
          const id = `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
          yield { type: "tool_call_start", tool_call: { id, name: typeof part.functionCall.name === "string" ? part.functionCall.name : "" } };
          yield { type: "tool_call_delta", tool_call: { id, arguments_delta: JSON.stringify(part.functionCall.args ?? {}) } };
          yield { type: "tool_call_end", tool_call: { id } };
        } else if (part.thought === true && typeof part.text === "string") {
          yield { type: "content_delta", delta: { thinking: part.text } };
        } else if (typeof part.text === "string") {
          yield { type: "content_delta", delta: { text: part.text } };
        }
      }
    }
    const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : undefined;
    yield {
      type: "message_end",
      stop_reason: toBridgeStopReason(finish ?? "STOP"),
      raw_stop_reason: finish,
      usage: geminiUsageToBridge(isRecord(payload.usageMetadata) ? payload.usageMetadata : undefined),
    };
    return;
  }
  if (isRecord(payload.error)) {
    yield { type: "error", error: { message: typeof payload.error.message === "string" ? payload.error.message : "上游返回错误" } };
    return;
  }
  if (isRecord(payload.promptFeedback) && typeof payload.promptFeedback.blockReason === "string") {
    yield { type: "message_start", id: `gemini-${Date.now()}`, model };
    yield { type: "message_end", stop_reason: "content_filter", raw_stop_reason: payload.promptFeedback.blockReason };
    return;
  }
  throw new Error("gemini 上游响应缺少 candidates");
}
