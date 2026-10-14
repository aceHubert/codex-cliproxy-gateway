import {
  convertRequest,
  createAnthropicClientOutput,
  createChatCompletionsClientOutput,
  createResponsesClientOutput,
  parseUpstreamEvents,
} from "@agent-proxy/llm-bridge";
import type { BridgeProtocol, ToolIdentityMap } from "@agent-proxy/llm-bridge";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import type { OpencodeZenModelProtocol } from "./catalog.ts";

/**
 * OpenCode Zen 多协议转换层。
 *
 * 标准转换统一走 @agent-proxy/llm-bridge 的 convertRequest：客户端三种来源
 * （chat-completions / responses / anthropic）直接单跳到模型端点协议（chat /
 * responses / anthropic / google），不再经 Chat Completions 中间层；流式回转经
 * parseUpstreamEvents + 桥接客户端渲染器逐事件转换；非流式客户端由渲染器聚合为
 * 完整 JSON。同协议原样浅拷贝/透传。
 */

/** llm-bridge 协议名映射（chat = OpenAI 家族 chat completions；google = Gemini）。 */
const CLIENT_BRIDGE_PROTOCOL: Record<ClientProtocol, BridgeProtocol> = {
  "chat-completions": "chat-completions",
  responses: "responses",
  anthropic: "anthropic",
};
const BRIDGE_PROTOCOL: Record<OpencodeZenModelProtocol, BridgeProtocol> = {
  chat: "chat-completions",
  responses: "responses",
  anthropic: "anthropic",
  google: "gemini",
};

export interface OpencodeZenPreparedRequest {
  body: Record<string, unknown>;
  /** 转换产生的工具身份表；响应侧还原 custom/namespace 语义时使用。 */
  tools: ToolIdentityMap;
}

/** 请求体转换：客户端协议 → 模型端点协议。同协议原样浅拷贝；跨协议单跳。 */
export function convertOpencodeZenRequest(
  from: ClientProtocol,
  to: OpencodeZenModelProtocol,
  input: Record<string, unknown>,
): OpencodeZenPreparedRequest {
  if (CLIENT_BRIDGE_PROTOCOL[from] === BRIDGE_PROTOCOL[to]) return { body: { ...input }, tools: new Map() };
  const converted = convertRequest(from, BRIDGE_PROTOCOL[to], input);
  return { body: converted.body, tools: converted.tools };
}

export interface OpencodeZenClientRenderOptions {
  model: string;
  stream: boolean;
  tools?: ToolIdentityMap;
}

/**
 * 上游响应 → 客户端协议输出。跨协议方向经桥接事件解析与渲染；同协议透传由调用方
 * 处理（保留上游原始字节）。非流式时聚合为完整客户端 JSON。
 */
export async function renderOpencodeZenClientOutput(
  from: OpencodeZenModelProtocol,
  to: ClientProtocol,
  upstream: Response,
  options: OpencodeZenClientRenderOptions,
): Promise<Response> {
  const events = parseUpstreamEvents(BRIDGE_PROTOCOL[from], upstream, options.model);
  const shared = {
    model: options.model,
    stream: options.stream,
    toolIdentities: options.tools,
  };
  if (to === "chat-completions") {
    const result = await createChatCompletionsClientOutput(events, shared);
    return result.response;
  }
  if (to === "anthropic") {
    const result = await createAnthropicClientOutput(events, shared);
    return result.response;
  }
  const result = await createResponsesClientOutput(events, shared);
  return result.response;
}
