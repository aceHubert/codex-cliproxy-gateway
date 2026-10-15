import { createHash, randomBytes } from "node:crypto";
import fingerprintData from "./fingerprint-data.json";

/**
 * OpenCode Zen 免费层门禁指纹。
 *
 * 门禁画像（2026-10-15 抓包+逐项隔离实测；10-14 的「空 schema 名单占位」画像已被
 * 收紧否决，漂移轨迹见 docs/fingerprint-data.md 与 scripts/zen-gate-probe.ts）：
 * 1. **标头层**（最小集四件：Authorization + User-Agent + `x-opencode-session-id` +
 *    `x-session-affinity`，缺一即 403）：UA 版本不校验（快照/动态值均可）、合规
 *    `x-opencode-session`（见 session.ts）与同值回填、稳定 `x-opencode-project`；
 *    b3/traceparent 追踪头保留（非必需）。
 * 2. **请求体层（实名制，read 唯一必须）**：tools 必须含 `read` 且 schema 非空
 *    （空 properties 403；官方完整定义与 `{path:{}}` 最小形均过闸）；其它工具
 *    （bash/shell 及数量）无关，客户端工具可并存、同名定义优先。system 消息内容
 *    不检查（官方模板无需在场）；无 tools 的请求只有携带官方标题生成器模板才
 *    放行，网关一律保证 tools 在场，不走该例外。
 * 3. **传输层**：仅接受 `stream: true`；非流式一律 403 FreeTierError，适配器对非流式
 *    客户端必须上游强制流式并在网关侧聚合 SSE 为完整 JSON。
 * 4. **端点层**：上游 base 已从 `https://opencode.ai/zen/v1` 迁至
 *    `https://opencode.ai/inference/v1`（旧端点一律 403），缺省值与元数据
 *    provider.api 同步（见 index.ts 的 OPENCODE_ZEN_DEFAULT_ENDPOINT）。
 *
 * 官方模板与完整工具定义保留在 `fingerprint-data.json`（模板作回退材料，门禁再收紧
 * 时按 docs/fingerprint-data.md「更新方法」重取并以探针脚本验证）。
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
/** 官方工具定义（2026-10-15 终版画像：仅 read 的真实定义在场合闸，最小非空 schema 亦可）。 */
export const OPENCODE_ZEN_CLIENT_TOOLS = CLIENT.tools;

/** 门禁要求在场的官方工具名（2026-10-15 实测 + linux.do 2912664 同结论：仅 read 必须）。 */
const GATE_REQUIRED_TOOL_NAMES = new Set(["read"]);

/** 顺序化名单（合并顺序稳定）。 */
const GATE_REQUIRED_TOOL_ORDER = ["read"] as const;

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
 * 客户端原始标头（含任何鉴权）一律不透传。`x-opencode-session-id` 与
 * `x-opencode-session` 同值（官方 2.0.29 起上行，缺失实测 403）。
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
    "x-opencode-session-id": session,
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
 * 名单闸官方定义合并：确保 `read` 的**官方真实定义**（含 schema）在场——客户端已有
 * 同名定义优先、原样保留；缺失时并入官方定义（fingerprint-data.json）。空工具列表
 * 同样合并（无 tools 的请求只有官方标题生成器模板才放行，不走该例外）。
 * 2026-10-15 终版画像（探针 + linux.do 2912664 同结论）：read 是唯一必须的工具名，
 * 其 schema 须非空（空 properties 403；官方完整定义与 `{path:{}}` 最小形均过闸），
 * 其它工具（bash/shell 及数量）无关。
 */
export function mergeOpencodeZenGateTools(clientTools: unknown): unknown[] {
  const tools = Array.isArray(clientTools) ? clientTools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    const name = isPlainObject(tool) ? toolName(tool) : undefined;
    if (name) names.add(name);
  }
  const merged = [...tools];
  for (const tool of OPENCODE_ZEN_CLIENT_TOOLS) {
    const name = toolName(tool);
    if (name !== undefined && GATE_REQUIRED_TOOL_NAMES.has(name) && !names.has(name)) merged.push(tool);
  }
  return merged;
}

/** Responses 协议工具的扁平名（{type:"function", name, …}，无 function 包裹）。 */
function flatToolName(tool: Record<string, unknown>): string | undefined {
  return typeof tool.name === "string" ? tool.name : undefined;
}

/**
 * Responses 端点的名单闸合并（与 mergeOpencodeZenGateTools 同规则、扁平形状）：
 * `/responses` 端点执行同一门禁（2026-10-15 实测：缺 read 403、在场 200），官方
 * 定义转为 Responses 扁平形状（type/name/description/parameters/strict）。
 */
export function mergeOpencodeZenGateToolsResponses(clientTools: unknown): unknown[] {
  const tools = Array.isArray(clientTools) ? clientTools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    const name = flatToolName(tool) ?? toolName(tool);
    if (name) names.add(name);
  }
  const merged = [...tools];
  for (const gateName of GATE_REQUIRED_TOOL_ORDER) {
    if (names.has(gateName)) continue;
    const official = (OPENCODE_ZEN_CLIENT_TOOLS as Array<Record<string, unknown>>)
      .map((tool) => isPlainObject(tool.function) ? tool.function as Record<string, unknown> : undefined)
      .find((fn) => fn !== undefined && fn.name === gateName);
    if (official && typeof official.description === "string" && isPlainObject(official.parameters)) {
      merged.push({ type: "function", name: gateName, description: official.description, parameters: official.parameters, strict: false });
    }
  }
  return merged;
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
 * - tools 经 `mergeOpencodeZenGateTools` 保证官方 `read`/`shell` 真实定义在场
 *   （2026-10-15 实测：空 schema 占位失效）；system 消息与工具定义原样透传
 *   （门禁不检查 system 内容）；
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
      tools: mergeOpencodeZenGateTools(input.tools),
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
