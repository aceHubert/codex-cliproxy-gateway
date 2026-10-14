import { createHash, randomBytes } from "node:crypto";
import fingerprintData from "./fingerprint-data.json";

/**
 * OpenCode Zen 免费层门禁指纹。
 *
 * 门禁画像（2026-10-14 探针复测，`scripts/zen-gate-probe.ts` 8 项隔离实证；10-08 的
 * 「模板逐字符匹配」画像已失效，漂移轨迹见调研报告修正段与 docs/fingerprint-data.md）：
 * 1. **标头层**：官方 UA（四段式快照；两段式 `opencode/<semver>` 亦放行）、合规
 *    `x-opencode-session`（见 session.ts）与同值回填、稳定 `x-opencode-project`；
 *    追踪头保留（零成本，免疫收紧）。
 * 2. **请求体层（名单制）**：tools 必须同时含 `read` 与 `bash`/`shell` 之一的**名字**，
 *    schema 不做任何检查（空对象占位可过）；system 消息内容不检查（官方模板无需在场）。
 *    名单闸不分有无工具——无 tools 的请求同样 403，必须垫补占位。
 * 3. **传输层**：仅接受 `stream: true`；非流式一律 403 FreeTierError，适配器对非流式
 *    客户端必须上游强制流式并在网关侧聚合 SSE 为完整 JSON。
 *
 * 官方模板与工具定义保留在 `fingerprint-data.json` 作回退材料（门禁再收紧时按
 * docs/fingerprint-data.md「更新方法」重取并以探针脚本验证），生产路径不再注入。
 * UA 的版本段不写死：运行时按 npm dist-tag 取当前版本（见 user-agent.ts），失败回退快照。
 */

const CLIENT = fingerprintData as {
  clientVersion: string;
  channel: string;
  clientName: string;
  agentSystemPrompt: string;
  titleSystemPrompt: string;
  tools: Array<Record<string, unknown>>;
};

/** 官方客户端 UA 快照：`opencode/<channel>/<version>/<clientName>`（门禁按此格式解析版本）。 */
export const OPENCODE_ZEN_CLIENT_USER_AGENT = `opencode/${CLIENT.channel}/${CLIENT.clientVersion}/${CLIENT.clientName}`;
/** 渠道段（官方 beta 渠道）。 */
export const OPENCODE_ZEN_CLIENT_CHANNEL = CLIENT.channel;
/** 快照版本号：动态获取（见 user-agent.ts）失败时的回退值。 */
export const OPENCODE_ZEN_CLIENT_VERSION = CLIENT.clientVersion;
/** 客户端名段（`opencode2` 上报的 `cli`）。 */
export const OPENCODE_ZEN_CLIENT_NAME = CLIENT.clientName;

/** 官方 agent 模板（回退材料：当前门禁不检查 system 内容，生产路径不注入）。 */
export const OPENCODE_ZEN_AGENT_SYSTEM_PROMPT = CLIENT.agentSystemPrompt;
/** 官方标题生成器模板（回退材料，同上）。 */
export const OPENCODE_ZEN_TITLE_SYSTEM_PROMPT = CLIENT.titleSystemPrompt;
/** 官方工具定义（回退材料：当前门禁只查名单，生产路径只垫占位不并入官方定义）。 */
export const OPENCODE_ZEN_CLIENT_TOOLS = CLIENT.tools;

/** 稳定的 40-hex 项目标识：官方客户端对项目目录做哈希，服务端不校验注册，任意稳定值即可。 */
export function createOpencodeZenProjectId(seed: string): string {
  return createHash("sha1").update(`codex-cliproxy-gateway:${seed}`).digest("hex");
}

function traceHeaders(): { b3: string; traceparent: string } {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return { b3: `${traceId}-${spanId}-1`, traceparent: `00-${traceId}-${spanId}-01` };
}

/**
 * 构造发往 Zen 的完整标头集。除 content-type/accept 外全部替换为官方指纹，
 * 客户端原始标头（含任何鉴权）一律不透传。
 */
export function buildOpencodeZenUpstreamHeaders(
  session: string,
  apiKey: string,
  projectId: string,
  userAgent: string = OPENCODE_ZEN_CLIENT_USER_AGENT,
): Record<string, string> {
  const trace = traceHeaders();
  return {
    "accept": "text/event-stream",
    "authorization": `Bearer ${apiKey}`,
    "b3": trace.b3,
    "content-type": "application/json",
    "traceparent": trace.traceparent,
    "user-agent": userAgent,
    "x-opencode-client": CLIENT.clientName,
    "x-opencode-project": projectId,
    "x-opencode-session": session,
    "x-session-affinity": session,
    "x-session-id": session,
  };
}

interface ToolLike {
  type?: unknown;
  function?: { name?: unknown } | unknown;
  [key: string]: unknown;
}

function toolName(tool: ToolLike): string | undefined {
  const fn = tool.function;
  if (fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string") {
    return (fn as { name: string }).name;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 名单闸占位工具：只占门禁要求的名字，schema 为空对象（模型带不出任何参数，调用
 * 必然落空），描述明写不可执行并指回 harness 工具。模型误调时由客户端以
 * `unsupported call` 兜底，真机实测一轮自纠。
 */
function gatePlaceholderTool(name: "read" | "bash"): Record<string, unknown> {
  return { type: "function", function: {
    name,
    description: "Requirement placeholder for the upstream gate: this harness cannot execute it. Use the harness tools instead.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  } };
}

/**
 * 按名单闸垫补工具名：缺 `read` 垫 read，缺 `bash` 与 `shell` 才垫 bash（官方 GA 用
 * `shell` 之名，客户端自带任一即满足）。客户端同名定义优先、原样保留；空工具列表
 * 同样垫补（名单闸不分有无工具，实测无 tools 直接 403）。
 */
export function padOpencodeZenGateTools(clientTools: unknown): unknown[] {
  const tools = Array.isArray(clientTools) ? clientTools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    const name = isPlainObject(tool) ? toolName(tool) : undefined;
    if (name) names.add(name);
  }
  const padded = [...tools];
  if (!names.has("read")) padded.push(gatePlaceholderTool("read"));
  if (!names.has("bash") && !names.has("shell")) padded.push(gatePlaceholderTool("bash"));
  return padded;
}

export interface OpencodeZenBodyInjection {
  /** 注入后的上游请求体（新对象，不改写调用方输入）。 */
  body: Record<string, unknown>;
  /** 客户端原始请求是否为非流式：true 时适配器必须聚合 SSE 再回 JSON。 */
  aggregateForClient: boolean;
}

/**
 * 请求体门禁注入：
 * - 强制 `stream: true` + `stream_options.include_usage`（非流式上游必拒）；
 * - `prompt_cache_key` 固定为会话 id（对齐官方行为，最大化上游 KV 缓存亲和）；
 * - tools 垫补名单闸要求的 `read`/`bash` 之名（见 padOpencodeZenGateTools）；
 *   system 消息与工具定义原样透传（2026-10-14 实测门禁不检查 system 内容与 schema）；
 * - reasoning effort 归一化为上游 `reasoning_effort`（见 normalizeOpencodeZenEffort），
 *   `effortLevels` 为调用方从实时元数据取的该模型档位值域（空数组=不校验）。
 */
export function injectOpencodeZenFingerprintBody(
  input: Record<string, unknown>,
  session: string,
  effortLevels: readonly string[] = [],
): OpencodeZenBodyInjection {
  const aggregateForClient = input.stream !== true;
  const streamOptions = isPlainObject(input.stream_options)
    ? { ...input.stream_options, include_usage: true }
    : { include_usage: true };
  // reasoning（Responses 形状）与原始 reasoning_effort 都不进 chat 请求体：
  // 前者 chat 端点不识别，后者可能带越界值（上游对陌生 effort 直接 400），
  // 统一由 normalizeOpencodeZenEffort 裁决后按需写回。
  const { reasoning: _reasoning, reasoning_effort: _rawEffort, tools: _tools, ...rest } = input;
  const effort = normalizeOpencodeZenEffort(effortLevels, input.reasoning_effort, input.reasoning);
  return {
    body: {
      ...rest,
      tools: padOpencodeZenGateTools(input.tools),
      ...(effort ? { reasoning_effort: effort } : {}),
      stream: true,
      stream_options: streamOptions,
      prompt_cache_key: session,
    },
    aggregateForClient,
  };
}

/**
 * effort 归一化：`off`/空值 → 省略字段（上游用默认值）；传入了该模型的档位值域时
 * 只放行值域内取值（其余省略，避免上游对陌生 effort 直接 400——实测非法值必拒）；
 * 值域为空（元数据缺失或模型无 effort 型 reasoning_options）时原样放行，由上游判定。
 * 大小写归一为小写后按值域精确匹配。
 */
export function normalizeOpencodeZenEffort(effortLevels: readonly string[], rawEffort: unknown, reasoning?: unknown): string | undefined {
  const source = rawEffort ?? (isPlainObject(reasoning) ? reasoning.effort : undefined);
  if (typeof source !== "string") return undefined;
  const effort = source.trim().toLowerCase();
  if (!effort || effort === "off") return undefined;
  if (effortLevels.length > 0 && !effortLevels.includes(effort)) return undefined;
  return effort;
}
