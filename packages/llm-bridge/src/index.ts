/**
 * @agent-proxy/llm-bridge：规范协议转换封装。
 *
 * 以 @ai-sdk/*（ai + 各厂商 provider）为出站拼装引擎：公开统一异步
 * convertRequest(from, to, body, options) 与四种客户端协议（Responses /
 * Chat Completions / Anthropic / Gemini）的流式、聚合 JSON、错误与取消输出。引擎
 * 请求体经离线 stub fetch 捕获，本包不执行任何网络 I/O、不执行工具、不持有
 * 任何插件生命周期。
 */

export {
  BridgeConversionError,
} from "./types.ts";
export type {
  BridgeStopReason,
  BridgeStreamEvent,
  BridgeUsage,
  ConvertRequestOptions,
  ConvertRequestResult,
  ToolIdentity,
  ToolIdentityMap,
} from "./types.ts";

export type { ClientProtocol } from "@agent-proxy/plugin-api";

export { convertRequest } from "./request.ts";
export { normalizeResponsesToolDeclarations } from "./responses-tools.ts";

export { readSseFrames, sseFrameBytes } from "./sse.ts";
export type { SseFrame } from "./sse.ts";

export { parseUpstreamEvents } from "./events.ts";

export {
  ResponsesOutputShell,
  bridgeUsageToJson,
  createAnthropicClientOutput,
  createChatCompletionsClientOutput,
  createClientResponse,
  createGeminiClientOutput,
  createResponsesClientOutput,
} from "./output.ts";
export type {
  ClientOutputOptions,
  ClientOutputResult,
  CreateClientResponseOptions,
  ResponsesShellOptions,
} from "./output.ts";

export { clientErrorResponse } from "./errors.ts";
export type { ClientErrorOptions } from "./errors.ts";
