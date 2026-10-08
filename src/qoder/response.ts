import { createCodebuddyResponse, type CodebuddyResponseOptions } from "../codebuddy/response.ts";
import { asObject, readFrames, parseQueueStatus, parseJsonObject, encoder } from "./sse.ts";
import type { Json } from "./sse.ts";

export type QoderResponseOptions = CodebuddyResponseOptions;

/** 拆开多层 {code,message} JSON 字符串，取最内层信息用于错误分类。 */
function unwrapNested(value: Json): Json {
  let current: Json = value;
  for (let depth = 0; depth < 4; depth++) {
    const message = current.message;
    if (typeof message !== "string" || !message.startsWith("{")) return current;
    try { current = parseJsonObject(message, "错误信封 message"); } catch { return current; }
  }
  return current;
}

/** 将 Qoder 明文信封转为标准 Chat SSE，复用仓库现有的 Responses 事件合成器。 */
function unwrap(upstream: ReadableStream<Uint8Array>, billing: Json): { body: ReadableStream<Uint8Array>; abort: () => void } {
  const reader = upstream.getReader();
  const calls = new Map<string, number>();
  const activeCalls = new Map<number, number>();
  let terminal = false;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      for await (const frame of readFrames(reader)) {
        // 内层 [DONE] 不是权威结束标识，必须等到独立 finish 事件。
        if (frame.event === "finish") { terminal = true; yield encoder.encode("data: [DONE]\n\n"); return; }
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
      } catch (error) { controller.error(error); }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
      await iterator.return(undefined);
    },
  }, { highWaterMark: 0 });
  return { body, abort: () => { void reader.cancel().catch(() => undefined); } };
}

function augment(response: Json, billing: Json): Json {
  if (response.usage !== null && response.usage !== undefined) {
    response.usage = { ...asObject(response.usage, "Responses usage"), ...billing };
  }
  if (response.error !== null && response.error !== undefined) {
    const error = asObject(response.error, "Responses error");
    if (typeof error.message === "string") error.message = error.message.replaceAll("CodeBuddy", "Qoder");
  }
  return response;
}

function safely(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* 观测回调不能中断协议转换。 */ }
}

export async function translateQoderResponse(upstream: Response, options: QoderResponseOptions): Promise<Response> {
  if (!upstream.body) throw new Error("Qoder 上游响应缺少 body");
  const billing: Json = {};
  let completed: Json | undefined;
  const normalized = unwrap(upstream.body, billing);
  const converted = await createCodebuddyResponse(new Response(normalized.body, {
    headers: { "content-type": "text/event-stream" },
  }), {
    ...options,
    // 直接唤醒原始流的在途读取；仅靠等待转换迭代器结束会卡住客户端取消。
    abort: () => { normalized.abort(); safely(options.abort); },
    onComplete: (response) => {
      completed = augment(response, billing);
      safely(() => options.onComplete?.(completed!));
    },
    onChunk: undefined,
    sanitizeError: (error) => {
      const value = { ...error, ...(typeof error.message === "string" ? { message: error.message.replaceAll("CodeBuddy", "Qoder") } : {}) };
      return options.sanitizeError ? options.sanitizeError(value) : value;
    },
  });
  if (!options.stream) {
    const payload = augment(parseJsonObject(JSON.stringify(await converted.json()), "响应"), billing);
    safely(() => options.onChunk?.(JSON.stringify(payload)));
    return Response.json(payload, { status: converted.status });
  }
  // 通用合成器每个读取块对应一个完整事件；仅为终态快照补充原始计费字段。
  let terminalSent = false;
  let sequence = 0;
  const transformed = converted.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      const text = new TextDecoder().decode(bytes);
      const marker = text.indexOf("\ndata: ");
      const event = parseJsonObject(text.slice(marker + 7).trimEnd(), "Responses 事件");
      if (typeof event.sequence_number === "number") sequence = event.sequence_number + 1;
      if (["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) terminalSent = true;
      // 就地增补计费字段：深拷贝会丢失与被序列化事件对象的关联。
      if (event.response !== undefined) augment(asObject(event.response, "Responses 快照"), billing);
      const rewritten = `${text.slice(0, marker)}\ndata: ${JSON.stringify(event)}\n\n`;
      safely(() => options.onChunk?.(rewritten));
      controller.enqueue(encoder.encode(rewritten));
    },
    flush(controller) {
      // 通用转换器在 AbortSignal 中止时关闭流；仍连接的调用方需要明确失败终态。
      if (!terminalSent && completed?.status === "failed") {
        const event = { type: "response.failed", sequence_number: sequence, response: completed };
        const chunk = `event: response.failed\ndata: ${JSON.stringify(event)}\n\n`;
        safely(() => options.onChunk?.(chunk));
        controller.enqueue(encoder.encode(chunk));
      }
    },
  }));
  return new Response(transformed, { status: converted.status, headers: converted.headers });
}
