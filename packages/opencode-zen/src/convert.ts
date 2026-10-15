import {
  convertRequest,
  createAnthropicClientOutput,
  createChatCompletionsClientOutput,
  createGeminiClientOutput,
  createResponsesClientOutput,
  parseUpstreamEvents,
} from "@agent-proxy/llm-bridge";
import type { ToolIdentityMap } from "@agent-proxy/llm-bridge";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import type { OpencodeZenModelProtocol } from "./catalog.ts";
import { mergeOpencodeZenGateTools, mergeOpencodeZenGateToolsResponses } from "./fingerprint.ts";

/**
 * OpenCode Zen 多协议转换层。
 *
 * 标准转换统一走 @agent-proxy/llm-bridge 的 convertRequest：客户端三种来源
 * （chat-completions / responses / anthropic）直接单跳到模型端点协议（chat /
 * responses / anthropic / google），不再经 Chat Completions 中间层；流式回转经
 * parseUpstreamEvents + 桥接客户端渲染器逐事件转换；非流式客户端由渲染器聚合为
 * 完整 JSON。同协议原样浅拷贝/透传。
 */

export interface OpencodeZenPreparedRequest {
  body: Record<string, unknown>;
  /** 转换产生的工具身份表；响应侧还原 custom/namespace 语义时使用。 */
  tools: ToolIdentityMap;
}

/**
 * 请求体转换：模型端点协议 → 客户端端点协议方向参数化，统一经桥接
 * convertRequest(from, to, body) 单入口（from 为上游 endpoint 协议，to 为调用方
 * route 协议）；同协议直通（字段保真 + 原名工具身份表 + model 回填）由桥接层
 * 内部处理，插件不自行判断同协议。
 */
export async function convertOpencodeZenRequest(
  from: OpencodeZenModelProtocol,
  to: ClientProtocol,
  input: Record<string, unknown>,
  options?: { model?: string },
): Promise<OpencodeZenPreparedRequest> {
  const converted = await convertRequest(from, to, input, options);
  return { body: converted.body, tools: converted.tools };
}

export interface OpencodeZenClientRenderOptions {
  model: string;
  stream: boolean;
  tools?: ToolIdentityMap;
  signal?: AbortSignal;
  abort?: () => void;
}

/** 仅补齐实际合并的门禁官方工具身份，客户端已有的 custom/namespace 映射优先。 */
export function mergeOpencodeZenToolIdentities(identities: ToolIdentityMap, upstreamTools: unknown): ToolIdentityMap {
  const toolName = (tool: unknown): string | undefined => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return undefined;
    const record = tool as Record<string, unknown>;
    // Responses 端点的合并定义是扁平形状（name 在顶层）；chat 端点在 function.name。
    if (typeof record.name === "string") return record.name;
    const fn = record.function;
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) return undefined;
    const name = (fn as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  };
  const gateNames = new Set([...mergeOpencodeZenGateTools([]), ...mergeOpencodeZenGateToolsResponses([])].map(toolName));
  const result = new Map(identities);
  for (const tool of Array.isArray(upstreamTools) ? upstreamTools : []) {
    const name = toolName(tool);
    if (name && gateNames.has(name) && !result.has(name)) result.set(name, { name, custom: false });
  }
  return result;
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
  const events = parseUpstreamEvents(from, upstream, options.model);
  const shared = {
    model: options.model,
    stream: options.stream,
    toolIdentities: options.tools,
    signal: options.signal,
    abort: options.abort,
  };
  if (to === "chat-completions") {
    const result = await createChatCompletionsClientOutput(events, shared);
    return result.response;
  }
  if (to === "anthropic") {
    const result = await createAnthropicClientOutput(events, shared);
    return result.response;
  }
  if (to === "gemini") {
    const result = await createGeminiClientOutput(events, shared);
    return result.response;
  }
  const result = await createResponsesClientOutput(events, shared);
  return result.response;
}
