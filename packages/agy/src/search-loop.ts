import { readAgyFrames } from "./response.ts";

type Json = Record<string, unknown>;

export interface AgyNativeSearchCallbacks {
  infer(body: Json, signal?: AbortSignal): Promise<Response>;
  search(query: string, domain?: string, signal?: AbortSignal): Promise<{ output: string; results: unknown[] }>;
  signal: AbortSignal;
  maxSearches?: number;
}

function record(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 逐帧转发主模型输出；只有内部搜索调用被消费并在服务器续轮。
 * 原始 model 部件与签名完整回放，客户端函数调用始终只交给客户端执行。
 */
export function createAgyNativeSearchStream(upstream: Response, wrapper: Json, toolName: string, callbacks: AgyNativeSearchCallbacks): Response {
  const encoder = new TextEncoder();
  const localAbort = new AbortController();
  const signal = AbortSignal.any([callbacks.signal, localAbort.signal]);
  const maxSearches = callbacks.maxSearches ?? 4;
  if (!Number.isSafeInteger(maxSearches) || maxSearches < 1 || maxSearches > 4) throw new Error("AGY 原生搜索次数限制必须是 1 到 4 的整数");
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => { void currentReader?.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancelReader);
  const request = structuredClone(wrapper);
  if (!record(request.request) || !Array.isArray(request.request.contents)) throw new Error("AGY 原生搜索续轮缺少 contents");
  const inner = request.request;
  const contents = inner.contents as unknown[];
  const usageTotal: Json = {};
  let count = 0;

  function addUsage(value: Json | undefined): void {
    if (!value) return;
    for (const key of ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount"]) {
      if (typeof value[key] === "number") usageTotal[key] = Number(usageTotal[key] ?? 0) + Number(value[key]);
    }
  }

  async function* frames(): AsyncGenerator<Json> {
    let response = upstream;
    try {
      while (true) {
        signal.throwIfAborted();
        if (!response.ok || !response.body) throw new Error("AGY 搜索续轮未返回有效上游流");
        currentReader = response.body.getReader();
        const modelParts: Json[] = [];
        const clientParts: Json[] = [];
        const searches: { part: Json; query: string; domain?: string; id: string }[] = [];
        let hasClientCall = false;
        let finishReason: unknown;
        let lastUsage: Json | undefined;
        let blocked = false;
        let pendingSignature: string | undefined;
        try {
          for await (const frame of readAgyFrames(currentReader)) {
            signal.throwIfAborted();
            if (frame.error !== undefined) { yield frame; return; }
            const raw = record(frame.response) ? frame.response : undefined;
            if (!raw) { yield frame; continue; }
            if (record(raw.usageMetadata)) lastUsage = raw.usageMetadata;
            if (record(raw.promptFeedback) && raw.promptFeedback.blockReason) blocked = true;
            const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
            const candidate = record(candidates[0]) ? candidates[0] : undefined;
            const content = candidate && record(candidate.content) ? candidate.content : undefined;
            const parts = content && Array.isArray(content.parts) ? content.parts : [];
            const forwarded: unknown[] = [];
            for (const value of parts) {
              if (!record(value)) throw new Error("AGY 搜索续轮收到无效模型部件");
              const call = record(value.functionCall) ? value.functionCall : undefined;
              const replay = structuredClone(value);
              const signature = typeof value.thoughtSignature === "string" && value.thoughtSignature ? value.thoughtSignature : undefined;
              if (call) {
                // 签名可能独立于 functionCall 到达，回放时必须挂到调用部件本身。
                if (!signature && pendingSignature) replay.thoughtSignature = pendingSignature;
                pendingSignature = undefined;
              } else if (signature) pendingSignature = signature;
              if (Object.keys(value).some((key) => key !== "thoughtSignature")) modelParts.push(replay);
              if (!call || call.name !== toolName) {
                if (call) {
                  hasClientCall = true;
                  clientParts.push(replay);
                } else forwarded.push(value);
                continue;
              }
              const args = record(call.args) ? call.args : undefined;
              if (!args || typeof args.query !== "string" || !args.query.trim() || args.query.length > 4096) throw new Error("AGY 原生搜索 query 必须是非空字符串");
              if (args.domain !== undefined && (typeof args.domain !== "string" || !args.domain.trim())) throw new Error("AGY 原生搜索 domain 必须是有效域名字符串");
              searches.push({ part: replay, query: args.query.trim(), ...(typeof args.domain === "string" ? { domain: args.domain.trim() } : {}), id: `ws_${crypto.randomUUID().replaceAll("-", "")}` });
            }
            if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason;
            // 每轮末尾的 finishReason/usage 由本执行器统一下发，避免中途完成或覆盖计数。
            const next: Json = { ...raw };
            delete next.usageMetadata;
            if (candidate) {
              const selected: Json = { ...candidate };
              delete selected.finishReason;
              if (content) selected.content = { ...content, parts: forwarded };
              next.candidates = [selected, ...candidates.slice(1)];
            }
            yield { ...frame, response: next };
          }
        } finally {
          try { currentReader.releaseLock(); } catch { /* 取消读取时由 reader.cancel 收尾。 */ }
          currentReader = undefined;
        }
        addUsage(lastUsage);
        signal.throwIfAborted();
        if (!searches.length) {
          // 只有确定本轮不含服务器搜索后才把客户端调用交出去，避免半路失败留下悬空工具。
          if (clientParts.length) yield { response: { candidates: [{ content: { role: "model", parts: clientParts } }] } };
          yield { response: { candidates: [{ finishReason }], ...(Object.keys(usageTotal).length ? { usageMetadata: usageTotal } : {}) } };
          return;
        }
        if (blocked || finishReason !== "STOP") throw new Error("AGY 原生搜索调用未正常结束，不能继续执行");
        if (hasClientCall) throw new Error("AGY 同轮混合了原生搜索和客户端工具，请分步调用，避免未配对的工具结果");
        if (count + searches.length > maxSearches) throw new Error(`AGY 原生搜索超过单次请求最多 ${maxSearches} 次的限制，请缩小查询范围`);
        count += searches.length;
        const responses: Json[] = [];
        for (const search of searches) {
          signal.throwIfAborted();
          yield { agyWebSearch: { id: search.id, query: search.query, status: "in_progress" } };
          const result = await callbacks.search(search.query, search.domain, signal);
          signal.throwIfAborted();
          const call = search.part.functionCall as Json;
          responses.push({ functionResponse: { name: toolName, ...(typeof call.id === "string" ? { id: call.id } : {}), response: { output: result.output, results: result.results } } });
          yield { agyWebSearch: { id: search.id, query: search.query, status: "completed", results: result.results } };
        }
        contents.push({ role: "model", parts: modelParts }, { role: "user", parts: responses });
        // 显式要求调用工具在首轮已经满足，续轮允许模型生成最终答案。
        if (record(inner.toolConfig) && record(inner.toolConfig.functionCallingConfig)
          && inner.toolConfig.functionCallingConfig.mode === "ANY") {
          inner.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
        }
        if (typeof request.requestId === "string") request.requestId = request.requestId.replace(/[^/]*$/, crypto.randomUUID());
        response = await callbacks.infer(request, signal);
      }
    } catch (error) {
      if (!signal.aborted) yield { error: { code: "agy_native_search_error", message: error instanceof Error ? error.message : "AGY 原生搜索执行失败" } };
    } finally {
      signal.removeEventListener("abort", cancelReader);
      cancelReader();
    }
  }

  const iterator = frames();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (signal.aborted || next.done) { controller.close(); return; }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      } catch (error) { controller.error(error); }
    },
    cancel() {
      localAbort.abort();
      cancelReader();
      void iterator.return(undefined).catch(() => undefined);
    },
  }, { highWaterMark: 0 }), { status: upstream.status, headers: { "content-type": "text/event-stream" } });
}
