/**
 * 引擎适配层：本包唯一直接接触 @ai-sdk/* 的模块。
 *
 * 通过注入离线 stub fetch 调用厂商 provider 的 doGenerate，从结果的
 * request.body 捕获引擎拼装的目标协议请求体；stub 只返回各协议的最小合成
 * 响应供内部解析结束调用，全程不执行任何网络 I/O。真实传输（URL 改写、
 * 认证头、签名、发送）由插件完成，与本层无关。
 *
 * AI SDK 规格版本差异（LanguageModelV2/V3/V4）收口在此模块；依赖按 `~` 范围
 * 跟进同大版本的补丁/小版本更新（重大变更被 major 锁挡住），升级后重跑
 * convert 矩阵 fixtures。
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
  LanguageModelV4ToolChoice,
} from "@ai-sdk/provider";
import type { ClientProtocol } from "@agent-proxy/plugin-api";
import { BridgeConversionError } from "./types.ts";

export type EnginePrompt = LanguageModelV4Prompt;
export type EngineFunctionTool = LanguageModelV4FunctionTool;
export type EngineToolChoice = LanguageModelV4ToolChoice;

export interface EngineBuildOptions {
  model: string;
  prompt: EnginePrompt;
  tools?: EngineFunctionTool[];
  toolChoice?: EngineToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

interface OfflineModel {
  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<{ request?: { body?: unknown } }>;
}

/* 离线合成响应：仅供引擎完成内部响应解析，内容不进入任何输出路径。 */
const SYNTHETIC_RESPONSES = {
  "chat-completions": {
    id: "bridge-capture",
    object: "chat.completion",
    created: 1,
    model: "bridge",
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  responses: {
    id: "bridge-capture",
    object: "response",
    created_at: 1,
    model: "bridge",
    status: "completed",
    output: [{ type: "message", id: "bridge-msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "", annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
  anthropic: {
    id: "bridge-capture",
    type: "message",
    role: "assistant",
    model: "bridge",
    content: [{ type: "text", text: "" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  gemini: {
    candidates: [{ content: { parts: [{ text: "" }], role: "model" }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  },
} as const;

function offlineFetch(body: unknown): typeof globalThis.fetch {
  return (async (): Promise<Response> =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
}

const OFFLINE_KEY = "agent-proxy-offline";

/**
 * 盐化 modelId：@ai-sdk/openai 按模型名正则（gpt-5*、o* 等）自动启用 OpenAI
 * 专属策略（system→developer、剥离 temperature、max_tokens→max_completion_tokens）。
 * 本包的目标体面向任意兼容上游，内部模型名不得触发这些策略；固定前缀使全部
 * 探测正则失效，真实模型名由 request.ts 在引擎输出后回填 body.model。
 */
const ENGINE_MODEL_PREFIX = "__agent_proxy__";

function createModel(target: ClientProtocol, modelId: string): OfflineModel {
  const engineModelId = ENGINE_MODEL_PREFIX + modelId;
  if (target === "chat-completions") {
    const openai = createOpenAI({ apiKey: OFFLINE_KEY, fetch: offlineFetch(SYNTHETIC_RESPONSES["chat-completions"]) });
    return openai.chat(engineModelId) as unknown as OfflineModel;
  }
  if (target === "responses") {
    const openai = createOpenAI({ apiKey: OFFLINE_KEY, fetch: offlineFetch(SYNTHETIC_RESPONSES.responses) });
    return openai.responses(engineModelId) as unknown as OfflineModel;
  }
  if (target === "anthropic") {
    const anthropic = createAnthropic({ apiKey: OFFLINE_KEY, fetch: offlineFetch(SYNTHETIC_RESPONSES.anthropic) });
    return anthropic(modelId) as unknown as OfflineModel;
  }
  // 注意：@ai-sdk/google 的 provider 设置不接受 supportedUrls，URL 文件会被尝试
  // 下载；gemini 目标的 URL 图片由 request.ts 在入口显式拒绝，保持离线边界。
  const google = createGoogleGenerativeAI({
    apiKey: OFFLINE_KEY,
    fetch: offlineFetch(SYNTHETIC_RESPONSES.gemini),
  });
  return google(modelId) as unknown as OfflineModel;
}

/** 调用引擎拼装目标协议请求体并离线捕获；不产生任何网络请求。 */
export async function buildTargetBody(target: ClientProtocol, options: EngineBuildOptions): Promise<Record<string, unknown>> {
  const callOptions: LanguageModelV4CallOptions = {
    prompt: options.prompt,
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { topP: options.topP } : {}),
    ...(options.stopSequences && options.stopSequences.length > 0 ? { stopSequences: options.stopSequences } : {}),
  };
  const result = await createModel(target, options.model).doGenerate(callOptions);
  const body = result.request?.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BridgeConversionError(`引擎未能捕获 ${target} 目标请求体；请检查锁定的 @ai-sdk/* 版本`);
  }
  return body as Record<string, unknown>;
}
