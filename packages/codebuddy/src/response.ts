import { createClientResponse } from "@agent-proxy/llm-bridge";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import { encodeCodebuddyReasoning } from "./wire.ts";
import type { CodebuddyToolMap } from "./request.ts";

/**
 * OpenAI Chat Completions 上游 → 客户端协议输出。标准 SSE/JSON、事件外壳、usage、
 * 终态与取消由 @agent-proxy/llm-bridge 统一负责；本层只注入 CodeBuddy 服务合同：
 * DeepSeek 模型的 reasoning 信封回写与 reasoning_content 厂商字段（chat 客户端）。
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

export async function createCodebuddyResponse(
  to: ClientProtocol,
  upstream: Response,
  responseOptions: CodebuddyResponseOptions,
): Promise<Response> {
  const deepseek = /deepseek/i.test(responseOptions.model);
  const result = await createClientResponse(to, upstream, {
    upstreamProtocol: "chat-completions",
    model: responseOptions.model,
    stream: responseOptions.stream,
    signal: responseOptions.signal,
    abort: responseOptions.abort,
    onChunk: responseOptions.onChunk,
    onComplete: responseOptions.onComplete,
    sanitizeError: responseOptions.sanitizeError,
    toolIdentities: responseOptions.tools,
    // DeepSeek：reasoning 条目关闭/截断时写回本地回放信封；chat 客户端还原
    // reasoning_content 厂商字段。两者都是服务合同，不进入公共转换核心。
    encodeReasoning: deepseek ? (text) => encodeCodebuddyReasoning(responseOptions.model, text) : undefined,
    chatReasoningField: deepseek ? "reasoning_content" : undefined,
  });
  return result.response;
}
