import { createClientResponse } from "@agent-proxy/llm-bridge";
import type { ClientOutputResult, ToolIdentityMap } from "@agent-proxy/llm-bridge";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import { asObject, readFrames, parseQueueStatus, parseJsonObject, encoder } from "./sse.ts";
import type { Json } from "./sse.ts";

/**
 * Qoder 私有 infer 信封 → 标准 Chat Completions 流 → 客户端协议输出。
 * 解信封、排队识别、计费提取与私有 tool index 修复留在本模块；标准事件合成、
 * SSE/JSON、usage 与终态由 @agent-proxy/llm-bridge 完成。
 */

export interface QoderResponseOptions {
  model: string;
  tools: ToolIdentityMap;
  stream: boolean;
  signal?: AbortSignal;
  abort?: () => void;
  onComplete?: (response: Record<string, unknown>) => void;
  onChunk?: (chunk: string) => void;
  sanitizeError?: (error: Record<string, unknown>) => Record<string, unknown>;
}

/** 拆开多层 {code,message} JSON 字符串，取最内层信息用于错误分类。 */
function unwrapNested(value: Json): Json {
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    const message = current.message;
    if (typeof message !== "string" || !message.startsWith("{")) return current;
    try {
      current = parseJsonObject(message, "错误信封 message");
    } catch {
      return current;
    }
  }
  return current;
}

/** 将 Qoder 明文信封转为标准 Chat SSE；计费字段随 billing 增补进标准 usage。 */
function unwrap(upstream: ReadableStream<Uint8Array>, billing: Json): { body: ReadableStream<Uint8Array>; abort: () => void } {
  const reader = upstream.getReader();
  const calls = new Map<string, number>();
  const activeCalls = new Map<number, number>();
  let terminal = false;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      for await (const frame of readFrames(reader)) {
        // 内层 [DONE] 不是权威结束标识，必须等到独立 finish 事件。
        if (frame.event === "finish") {
          terminal = true;
          yield encoder.encode("data: [DONE]\n\n");
          return;
        }
        if (!frame.data) continue;
        const envelope = parseJsonObject(frame.data, "SSE 信封");
        // 排队信封（statusCodeValue=403 + 10605）不是错误：转换层继续等真实推理帧。
        if (parseQueueStatus(envelope)) continue;
        if (envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 0 && envelope.statusCodeValue !== 200) {
          const raw = typeof envelope.body === "string" ? envelope.body : undefined;
          const details = raw !== undefined && raw.startsWith("{") ? parseJsonObject(raw, "错误信封 body") : {};
          const inner = unwrapNested(details);
          const error = {
            code: typeof details.code === "string" || typeof details.code === "number" ? String(details.code)
              : typeof inner.code === "string" || typeof inner.code === "number" ? String(inner.code) : "upstream_error",
            message: typeof details.message === "string" && !details.message.startsWith("{") ? details.message
              : typeof details.msg === "string" ? details.msg
                : typeof inner.message === "string" ? inner.message
                  : typeof inner.msg === "string" ? inner.msg
                    : `Qoder 上游状态 ${String(envelope.statusCodeValue)}`,
            status: envelope.statusCodeValue,
          };
          terminal = true;
          yield encoder.encode(`data: ${JSON.stringify({ error })}\n\n`);
          return;
        }
        // start/heartbeat 等元数据事件可以没有 body；推理数据必须走信封。
        if (envelope.body === undefined || envelope.body === "") continue;
        if (envelope.body === "[DONE]") continue;
        // 部分中流帧的 body 是已解包对象，直接作为 chunk 使用，不再视为协议错误。
        const chunk = typeof envelope.body === "string" ? parseJsonObject(envelope.body, "SSE body") : asObject(envelope.body, "SSE body");
        if (chunk.usage !== undefined && chunk.usage !== null) {
          const usage = asObject(chunk.usage, "usage");
          for (const field of ["credits", "original_credits"]) {
            if (typeof usage[field] === "number" && Number.isFinite(usage[field] as number)) billing[field] = usage[field];
          }
          if (typeof usage.billable === "boolean") billing.billable = usage.billable;
        }
        if (Array.isArray(chunk.choices)) {
          for (const raw of chunk.choices) {
            const choice = asObject(raw, "choices");
            if (choice.index !== undefined && choice.index !== 0) continue;
            if (choice.delta === undefined || choice.delta === null) continue;
            const delta = asObject(choice.delta, "choices.delta");
            if (!Array.isArray(delta.tool_calls)) continue;
            for (const rawCall of delta.tool_calls) {
              const call = asObject(rawCall, "tool_calls");
              const sourceIndex = typeof call.index === "number" ? call.index : 0;
              if (typeof call.id === "string" && call.id) {
                if (!calls.has(call.id)) calls.set(call.id, calls.size);
                activeCalls.set(sourceIndex, calls.get(call.id)!);
              }
              // 上游多个并行调用可能复用 index=0，新的 id 才是独立调用边界。
              call.index = activeCalls.get(sourceIndex) ?? sourceIndex;
            }
          }
        }
        terminal = chunk.error !== undefined;
        yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.error !== undefined) return;
      }
      throw new Error("Qoder SSE 缺少 finish 结束事件");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const iterator = chunks();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else {
          if (terminal) await iterator.return(undefined);
          controller.enqueue(next.value);
          if (terminal) controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
      await iterator.return(undefined);
    },
  }, { highWaterMark: 0 });
  return { body, abort: () => { void reader.cancel().catch(() => undefined); } };
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safely(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    /* 观测回调不能中断协议转换。 */
  }
}

/** 把计费字段并入 message_end 事件的 usage（各客户端协议的标准 usage 保持原样）。 */
function augmentUsageWithBilling(events: AsyncGenerator<import("@agent-proxy/llm-bridge").BridgeStreamEvent>, billing: Json) {
  return (async function* () {
    for await (const event of events) {
      if (event.type === "message_end" && Object.keys(billing).length > 0) {
        yield { ...event, usage: { ...(event.usage ?? {}), billing: { ...billing } } };
        continue;
      }
      yield event;
    }
  })();
}

export async function translateQoderResponse(
  from: ClientProtocol,
  upstream: Response,
  options: QoderResponseOptions,
): Promise<ClientOutputResult["response"]> {
  if (!upstream.body) throw new Error("Qoder 上游响应缺少 body");
  const billing: Json = {};
  const normalized = unwrap(upstream.body, billing);
  const chatUpstream = new Response(normalized.body, { headers: { "content-type": "text/event-stream" } });
  const result = await createClientResponse(from, chatUpstream, {
    upstreamProtocol: "chat-completions",
    model: options.model,
    stream: options.stream,
    signal: options.signal,
    // 直接唤醒原始流的在途读取；仅靠等待转换迭代器结束会卡住客户端取消。
    abort: () => {
      normalized.abort();
      safely(options.abort);
    },
    onChunk: options.onChunk,
    onComplete: (response) => {
      // 非流式聚合结果同步增补计费字段。
      if (isRecord(response.usage) && Object.keys(billing).length > 0) {
        Object.assign(response.usage, billing);
      }
      safely(() => options.onComplete?.(response));
    },
    sanitizeError: (error) => {
      const value = { ...error, ...(typeof error.message === "string" ? { message: error.message.replaceAll("CodeBuddy", "Qoder") } : {}) };
      return options.sanitizeError ? options.sanitizeError(value) : value;
    },
    toolIdentities: options.tools,
    transform: (events) => augmentUsageWithBilling(events as AsyncGenerator<import("@agent-proxy/llm-bridge").BridgeStreamEvent>, billing),
  });
  return result.response;
}
