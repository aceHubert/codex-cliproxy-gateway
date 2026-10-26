import { createHash, randomBytes } from "node:crypto";
import fingerprintData from "./fingerprint-data.json";

/**
 * OpenCode Zen 免费层门禁指纹。
 *
 * 门禁画像（2026-10-26 换 IP 后逐项隔离实测；此前 10-15 的「read 实名闸 + 标头
 * 最小集」画像已被换代推翻，漂移轨迹见 docs/fingerprint-data.md 与
 * scripts/zen-gate-probe.ts）：
 * 1. **会话层（时间段新鲜度硬校验）**：`x-opencode-session` / `x-session-affinity` /
 *    `x-session-id` 三标头与请求体 `prompt_cache_key` 四值同配，格式 `ses_` + 12 位
 *    降序 hex 时间戳 + 14 位 Base62；时间段解码必须是当前时间附近——哈希位当时间段
 *    的派生 id 一律 429（2/2），现铸 id 连续 200；窗口未精测，≥45 分钟仍有效。
 *    多余标头（`x-opencode-session-id`）无害；UA 版本/渠道不校验（beta/旧 GA 均过）。
 * 2. **请求体层（system 包含官方当前代模板）**：system 消息内容必须**包含**官方
 *    agent 模板全文（模板在前、客户端指令追加在后的形态实测过闸；截断 500/2000 字、
 *    无模板的普通长文本均 429）；模板随官方发版换代，快照过期即整体 429。tools
 *    不再要求官方实名（仅客户端工具 + 最小 read 亦过；无 tools 未单测，网关恒带
 *    工具）；官方标题模板不在白名单（官方 CLI 自己的标题生成也 429）。
 * 3. **传输层**：仅接受 `stream: true`；非流式一律被拒，适配器对非流式客户端必须
 *    上游强制流式并在网关侧聚合 SSE 为完整 JSON。
 * 4. **端点层**：`https://opencode.ai/inference/openai/v1`（元数据 provider.api 同源）；
 *    网关缺省端点 `/inference/v1` 与旧 `/zen/v1` 均不可用。
 * 5. **配额层**：匿名 `Bearer public` 有按 IP 的滚动共享池，耗尽时一切请求 429
 *    `FreeUsageLimitError`（与形态拒绝同文案；换 IP 即恢复，UTC 午夜重置）——
 *    排查时先换出口再下结论。
 *
 * 官方模板与完整工具定义保留在 `fingerprint-data.json`（GA 2.1.4 快照）；模板换代
 * 失效时按 docs/fingerprint-data.md「更新方法」重取并以探针脚本验证。UA 的版本段
 * 不写死：运行时按 npm dist-tag 取当前版本（见 user-agent.ts），失败回退快照。
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

/** 官方 agent 模板（GA 2.1.4 快照）：门禁要求 system 消息包含其全文，注入见 mergeOpencodeZenGateSystem。 */
export const OPENCODE_ZEN_AGENT_SYSTEM_PROMPT = CLIENT.agentSystemPrompt;
/** 官方标题生成器模板（2026-10-26 实测不在门禁白名单，仅留档）。 */
export const OPENCODE_ZEN_TITLE_SYSTEM_PROMPT = CLIENT.titleSystemPrompt;
/** 官方工具定义（2026-10-26 画像：门禁不再要求在场，保留 read 合并作最小保险）。 */
export const OPENCODE_ZEN_CLIENT_TOOLS = CLIENT.tools;

/** 保险合并的官方工具名（2026-10-26 实测仅客户端工具亦可过闸；所有已验证过闸形态都含 read，保留）。 */
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
 * 客户端原始标头（含任何鉴权）一律不透传。会话三标头（`x-opencode-session` /
 * `x-session-affinity` / `x-session-id`）与 `x-opencode-session-id` 同值回填——
 * 门禁要求会话标识四值同配（2026-10-26 实测），多余的 `x-opencode-session-id`
 * 留作官方 2.0.29+ 形状兼容（实测在场无害）。
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

/** 上游 tools 数组硬上限（2026-10-26 实测：超出即 400 "maximum number of items is 128"）。 */
export const OPENCODE_ZEN_TOOLS_MAX = 128;

/**
 * 按上游上限截断 tools：超出时保留前 `max - 1` 个原序条目 + 名单闸官方定义垫底
 * （read 必须存活——它可能在截断线之后被追加）。未超限时原样返回。
 */
function capOpencodeZenGateTools(tools: unknown[], official: () => unknown): unknown[] {
  if (tools.length <= OPENCODE_ZEN_TOOLS_MAX) return tools;
  return [...tools.slice(0, OPENCODE_ZEN_TOOLS_MAX - 1), official()];
}

/**
 * 名单闸官方定义合并：确保官方 `read` 定义在场（2026-10-26 复测修正：**带 tools
 * 时 read 为硬性要求**——127 个客户端工具无 read 一律 429（3/3），垫补 read 后
 * 同负载 200；客户端已有同名定义优先、原样保留；空工具列表同样合并）。合并结果
 * 按上游上限截断（重载客户端（如带大量 MCP 的 agent IDE）tools 可达 128+，超出
 * 即上游 400）。
 */
export function mergeOpencodeZenGateTools(clientTools: unknown): unknown[] {
  const tools = Array.isArray(clientTools) ? clientTools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    const name = isPlainObject(tool) ? toolName(tool) : undefined;
    if (name) names.add(name);
  }
  const merged = [...tools];
  let appended: unknown;
  for (const tool of OPENCODE_ZEN_CLIENT_TOOLS) {
    const name = toolName(tool);
    if (name !== undefined && GATE_REQUIRED_TOOL_NAMES.has(name) && !names.has(name)) {
      merged.push(tool);
      appended = tool;
    }
  }
  if (appended === undefined || names.has("read")) {
    // read 已由客户端提供或无需垫补：截断不破坏闸材料（read 在客户端前段或本就未超限）。
    return merged.length > OPENCODE_ZEN_TOOLS_MAX ? merged.slice(0, OPENCODE_ZEN_TOOLS_MAX) : merged;
  }
  return capOpencodeZenGateTools(merged, () => appended as unknown);
}

/** Responses 协议工具的扁平名（{type:"function", name, …}，无 function 包裹）。 */
function flatToolName(tool: Record<string, unknown>): string | undefined {
  return typeof tool.name === "string" ? tool.name : undefined;
}

/**
 * Responses 端点的名单闸合并（与 mergeOpencodeZenGateTools 同规则、扁平形状）。
 * `/responses` 端点与 chat 同源门禁（2026-10-26 画像：tools 非必要、read 保留作保险），
 * 官方定义转为 Responses 扁平形状（type/name/description/parameters/strict）；
 * 合并结果同样按上游 128 上限截断（垫补的 read 保证存活）。
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
  let appended: unknown;
  for (const gateName of GATE_REQUIRED_TOOL_ORDER) {
    if (names.has(gateName)) continue;
    const official = (OPENCODE_ZEN_CLIENT_TOOLS as Array<Record<string, unknown>>)
      .map((tool) => isPlainObject(tool.function) ? tool.function as Record<string, unknown> : undefined)
      .find((fn) => fn !== undefined && fn.name === gateName);
    if (official && typeof official.description === "string" && isPlainObject(official.parameters)) {
      appended = { type: "function", name: gateName, description: official.description, parameters: official.parameters, strict: false };
      merged.push(appended);
    }
  }
  if (appended === undefined || names.has("read")) {
    return merged.length > OPENCODE_ZEN_TOOLS_MAX ? merged.slice(0, OPENCODE_ZEN_TOOLS_MAX) : merged;
  }
  return capOpencodeZenGateTools(merged, () => appended);
}

export interface OpencodeZenBodyInjection {
  /** 注入后的上游请求体（新对象，不改写调用方输入）。 */
  body: Record<string, unknown>;
  /** 客户端原始请求是否为非流式：true 时适配器必须聚合 SSE 再回 JSON。 */
  aggregateForClient: boolean;
}

/** 官方模板在前、客户端指令在后的分隔标记（2026-10-26 实测该包裹形态过闸）。 */
const GATE_CLIENT_INSTRUCTIONS_HEADER = "\n\n# Client Instructions\n";

/**
 * 门禁 system 包裹：确保 system 消息**包含官方当前代 agent 模板全文**（2026-10-26
 * 画像：包含关系校验——模板在前、客户端内容追加在后过闸；截断模板、无模板的普通
 * 长文本一律 429）。客户端已有 system（字符串内容）时替换为「官方模板 + 分隔标记 +
 * 原内容」；无 system 或内容为非字符串（多部件数组等）时在消息首插入纯模板 system，
 * 原消息原样保留在后。messages 非数组时原样返回。
 */
export function mergeOpencodeZenGateSystem(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  const index = messages.findIndex((message) =>
    isPlainObject(message) && message.role === "system" && typeof message.content === "string");
  if (index === -1) {
    return [{ role: "system", content: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT }, ...messages];
  }
  const original = messages[index] as { role: string; content: string };
  const wrapped: unknown = {
    ...original,
    content: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT + GATE_CLIENT_INSTRUCTIONS_HEADER + original.content,
  };
  return messages.map((message, i) => (i === index ? wrapped : message));
}

/**
 * 请求体门禁注入：
 * - system 经 `mergeOpencodeZenGateSystem` 包裹官方模板（门禁包含关系校验）；
 * - 强制 `stream: true` + `stream_options.include_usage`（非流式上游必拒）；
 * - `prompt_cache_key` 固定为会话 id（门禁要求与会话标头四值同配，对齐官方行为）；
 * - tools 经 `mergeOpencodeZenGateTools` 保留官方 `read` 定义在场（保险项）；
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
  const { reasoning: _reasoning, reasoning_effort: _rawEffort, tools: _tools, messages: _messages, ...rest } = input;
  const effort = normalizeOpencodeZenEffort(effortLevels, input.reasoning_effort, input.reasoning);
  return {
    body: {
      ...rest,
      messages: mergeOpencodeZenGateSystem(input.messages),
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
