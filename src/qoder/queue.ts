import type { QoderCredentials } from "./credentials.ts";
import type { QoderInferPayload, QoderFetch } from "./transport.ts";
import { parseQueueStatus, type Frame, type QoderQueueStatus } from "./sse.ts";

/** 排队终态错误：服务持续繁忙，等待与恢复都没有换来推理机会。 */
export class QoderQueueError extends Error {
  constructor(message: string, readonly kind: "queued_limited" | "queue_timeout", readonly queue?: QoderQueueStatus) {
    super(message);
  }
}

export type QoderInferFn = (
  credential: QoderCredentials,
  payload: QoderInferPayload,
  signal?: AbortSignal,
) => Promise<Response>;

export interface QueueRecoveryOptions {
  /** 排队恢复的总时间预算；超过后给出明确失败。 */
  totalBudgetMs?: number;
  /** 重试间隔上限；实际取上游 retryAfterSeconds。 */
  retryDelayCapMs?: number;
  /** 上游未给出 retryAfterSeconds 时的重试间隔。 */
  minRetryDelayMs?: number;
  fetch?: QoderFetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface QueueRecoveryHooks {
  /** 每收到上游帧（含排队状态帧）时回调，用于重置外层空闲计时。 */
  keepAlive?: () => void;
}

const encoder = new TextEncoder();

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { signal.throwIfAborted(); }
  const timer = setTimeout(() => resolve(), ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException("请求已取消", "AbortError"));
  }, { once: true });
});

function frameBytes(frame: Frame): Uint8Array {
  const text = `${frame.event ? `event: ${frame.event}\n` : ""}data: ${frame.data}\n\n`;
  return encoder.encode(text);
}

interface ContentHandoff {
  kind: "content";
  /** 观察期间出现的内容帧（排队帧已剥离），按标准形态重建。 */
  replay: Uint8Array[];
  /** 帧解析器内部尚未消费的原始余量，必须原样交还下游。 */
  remainder: Uint8Array;
}

interface QueueOutcome {
  kind: "queued" | "ready" | "eof";
  queue?: QoderQueueStatus;
}

type PeekResult = ContentHandoff | QueueOutcome;

/**
 * 只窥探到首个有意义的帧即返回。与通用帧解析不同，这里必须自持缓冲：
 * 一次 reader.read() 可能携带多帧（测试单块、TCP 粘包），在首个内容帧
 * 处退出时把未解析余量与 reader 一起交还，否则会静默丢帧。
 * 实测排队流不会被服务端提升为推理流（约 120 秒后直接关闭），因此
 * 见到排队信封应立即放弃该流，按官方 CLI 语义改期重发，而不是持有等待。
 */
async function peekQueueFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  hooks: QueueRecoveryHooks | undefined,
): Promise<PeekResult> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer: Uint8Array = new Uint8Array(0);
  let event = "";
  let data: string[] = [];
  let lastQueue: QoderQueueStatus | undefined;
  const replay: Uint8Array[] = [];

  const takeFrame = (): Frame | undefined => {
    if (!data.length && !event) return undefined;
    const frame: Frame = { event, data: data.join("\n") };
    data = [];
    event = "";
    return frame;
  };

  while (true) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const index = buffer.findIndex((byte) => byte === 13 || byte === 10);
      if (index < 0) break;
      // 末尾孤立 \r 需等待下一个字节判断是否 \r\n。
      if (buffer[index] === 13 && index === buffer.length - 1) break;
      const width = buffer[index] === 13 && buffer[index + 1] === 10 ? 2 : 1;
      // 换行字节不会出现在有效 UTF-8 字符内部；只解码完整行，让未解析余量保持原始字节。
      const line = decoder.decode(buffer.subarray(0, index + width), { stream: true }).slice(0, -width);
      buffer = buffer.subarray(index + width);
      progressed = true;
      if (!line) {
        // 任何完整帧边界（含心跳注释帧）都是上游活性，重置外层空闲计时。
        hooks?.keepAlive?.();
        const frame = takeFrame();
        if (!frame) continue;
        if (frame.data.startsWith("{")) {
          let envelope: Record<string, unknown> | undefined;
          try { envelope = JSON.parse(frame.data) as Record<string, unknown>; }
          catch { envelope = undefined; }
          const status = envelope ? parseQueueStatus(envelope) : undefined;
          if (status) {
            if (status.isQueued === false && status.serviceAvailable !== false) {
              return { kind: "ready", queue: status };
            }
            // 排队帧先记录；同块内若紧跟内容帧则按服务端提升处理，继续解析。
            lastQueue = status;
            continue;
          }
        }
        replay.push(frameBytes(frame));
        return { kind: "content", replay, remainder: buffer };
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let content = colon < 0 ? "" : line.slice(colon + 1);
      if (content.startsWith(" ")) content = content.slice(1);
      if (field === "data") data.push(content);
      if (field === "event") event = content;
    }
    // 已见排队帧且缓冲内没有更多完整帧：实测排队流不会被提升，
    // 立即放弃并按官方 CLI 语义改期重发，而不是持有等待约 120 秒后被服务端关闭。
    if (lastQueue) return { kind: "queued", queue: lastQueue };
    const { value, done } = await reader.read();
    if (done) return { kind: "eof" };
    if (!buffer.length) buffer = value;
    else {
      const combined = new Uint8Array(buffer.length + value.length);
      combined.set(buffer);
      combined.set(value, buffer.length);
      buffer = combined;
    }
  }
}

/** 把内容帧、未解析余量与剩余原始流拼回一个响应体，下游无需感知排队帧被剥离。 */
function compositeBody(handoff: ContentHandoff, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of handoff.replay) controller.enqueue(chunk);
      if (handoff.remainder.length) controller.enqueue(handoff.remainder);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel() { void reader.cancel().catch(() => undefined); },
  }, { highWaterMark: 0 });
}

/**
 * 排队恢复包装：Qoder 在并发或额度受限时先返回 403+10605 排队信封（流只承载状态，
 * 不会被提升为推理流）。按官方 CLI 语义：立即放弃排队流，等待 retryAfterSeconds
 * （实测 30 秒）后重新推理；在总预算内反复重试，预算耗尽给出明确的排队失败分类。
 */
export function createQueueAwareInfer(infer: QoderInferFn, options: QueueRecoveryOptions = {}) {
  const totalBudgetMs = Math.max(1_000, options.totalBudgetMs ?? 120_000);
  const retryDelayCapMs = Math.max(0, options.retryDelayCapMs ?? 30_000);
  const minRetryDelayMs = Math.max(0, options.minRetryDelayMs ?? 1_000);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  return {
    async infer(credential: QoderCredentials, payload: QoderInferPayload, signal?: AbortSignal, hooks?: QueueRecoveryHooks): Promise<Response> {
      const deadline = now() + totalBudgetMs;
      let lastQueue: QoderQueueStatus | undefined;
      let sawUpstream = false;
      while (true) {
        signal?.throwIfAborted();
        const response = await infer(credential, payload, signal);
        if (!response.body) return response;
        const reader = response.body.getReader();
        let peeked: PeekResult;
        try {
          peeked = await peekQueueFrames(reader, hooks);
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        }
        if (peeked.kind === "content") {
          return new Response(compositeBody(peeked, reader), { status: response.status, headers: response.headers });
        }
        await reader.cancel().catch(() => undefined);
        sawUpstream = true;
        if (peeked.queue) lastQueue = peeked.queue;
        signal?.throwIfAborted();
        const hint = peeked.queue?.retryAfterSeconds;
        const desired = typeof hint === "number" && hint > 0 ? hint * 1000 : minRetryDelayMs;
        const delayMs = Math.min(retryDelayCapMs, desired, Math.max(0, deadline - now()));
        if (delayMs <= 0 || now() + delayMs > deadline) {
          throw new QoderQueueError(
            sawUpstream
              ? `Qoder 服务繁忙，排队重试 ${Math.round(totalBudgetMs / 1000)} 秒内未获得推理机会；请稍后重试或改用其他模型（如 Qoder-CN）。`
              : "Qoder 上游持续无响应；请稍后重试或检查网络。",
            sawUpstream ? "queued_limited" : "queue_timeout", lastQueue);
        }
        await sleep(delayMs, signal);
      }
    },
  };
}
