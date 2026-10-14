/**
 * @agent-proxy/llm-bridge：规范协议转换封装。
 *
 * 以 npm llm-bridge 2.0.1 为底座，公开统一 convertRequest(from, to, body, options)
 * 与三种客户端协议（Responses / Chat Completions / Anthropic）的流式、聚合 JSON、
 * 错误与取消输出。外部 ProviderType 与库原语不对外泄漏；本包不发上游请求、不执行
 * 工具、不持有任何插件生命周期。
 */

export {
  BridgeConversionError,
} from "./types.ts";
export type {
  BridgeProtocol,
  BridgeStopReason,
  BridgeStreamEvent,
  BridgeUsage,
  ClientBridgeProtocol,
  ConvertRequestOptions,
  ConvertRequestResult,
  ToolIdentity,
  ToolIdentityMap,
} from "./types.ts";

export { convertRequest } from "./request.ts";

export { readSseFrames, sseFrameBytes } from "./sse.ts";
export type { SseFrame } from "./sse.ts";

export { parseUpstreamEvents } from "./events.ts";

export {
  ResponsesOutputShell,
  bridgeUsageToJson,
  createAnthropicClientOutput,
  createChatCompletionsClientOutput,
  createClientResponse,
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
