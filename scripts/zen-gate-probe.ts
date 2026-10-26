#!/usr/bin/env bun
// OpenCode Zen 免费层门禁诊断探针：逐项隔离实测当前门禁画像，供指纹失效时单点重测。
//
// 背景画像漂移史——2026-10-08 三层画像（标头 + 请求体模板/工具 + 流式）、2026-10-14
// 名单制画像（read/bash 之名、空 schema 可过、模板不查）、2026-10-15「read 实名 +
// 标头最小集」画像均已被换代推翻。2026-10-26 终版画像（GA 2.1.4 抓包 + 换 IP 后
// 逐项隔离实测）：
//   ① 端点 https://opencode.ai/inference/openai/v1（/models 列表仍在 /inference/v1）；
//   ② 会话四值同配且时间段须为当前时间附近（哈希/随机 hex 当时间段一律 429；
//      UA 版本渠道不校验；多余 x-opencode-session-id 无害）；
//   ③ system 消息必须**包含**官方当前代 agent 模板全文（截断/无模板 429；
//      模板 + 客户端指令追加过闸；模板随官方发版换代，快照过期即整体 429）；
//   ④ tools 已非必要条件（仅客户端工具 + read 亦过；网关保留 read 合并作保险）；
//   ⑤ 匿名 Bearer public 有按 IP 的滚动共享池，耗尽时与形态拒绝同文案
//      （429 FreeUsageLimitError）——批量 429 时先换出口 IP 复测再定性漂移。
// 出现批量 429 时先跑本脚本定位漂移层，再按 docs/fingerprint-data.md「更新方法」处理。
//
// 用法：
//   bun scripts/zen-gate-probe.ts                     # 默认 8 个探针，3s 间隔
//   bun scripts/zen-gate-probe.ts --model nemotron-3.5-lightning-free
//   bun scripts/zen-gate-probe.ts --base https://opencode.ai/inference/openai/v1
//
// 输出：每个探针一行（PASS/FAIL 相对当前已知画像），末尾汇总画像漂移项。
// 退出码：0 = 画像与实现一致；1 = 有漂移（对照失败优先看 fingerprint-data.json）；
//         2 = 参数错误。探针走免费 public 通道，会消耗当前出口 IP 的共享池额度。
// 注意：同日多次全量跑可能触发共享池耗尽，出现批量 429 时先换出口 IP 复跑一次再定性。
import {
  buildOpencodeZenUpstreamHeaders,
  createOpencodeZenProjectId,
  injectOpencodeZenFingerprintBody,
  mergeOpencodeZenGateTools,
  OPENCODE_ZEN_AGENT_SYSTEM_PROMPT,
  OPENCODE_ZEN_CLIENT_TOOLS,
  OPENCODE_ZEN_CLIENT_USER_AGENT,
} from "../packages/opencode-zen/src/fingerprint.ts";
import { createOpenCodeSessionId } from "../packages/opencode-zen/src/session.ts";

interface Options {
  model: string;
  base: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { model: "nemotron-3.5-lightning-free", base: "https://opencode.ai/inference/openai/v1" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") options.model = argv[++i] ?? "";
    else if (arg === "--base") options.base = argv[++i] ?? "";
    else {
      console.error(`未知参数: ${arg}\n用法见文件头注释。`);
      process.exit(2);
    }
  }
  if (!options.model || !options.base) {
    console.error("--model 与 --base 不能为空");
    process.exit(2);
  }
  return options;
}

const CLIENT_SYSTEM = "You are a precise coding agent. Answer concisely.";

/** Codex 工具按 convert.ts 的降级形状（exec_command 原生 + apply_patch 包一层 input）。 */
const CODEX_TOOLS: Array<Record<string, unknown>> = [
  { type: "function", function: {
    name: "exec_command",
    description: "Run a shell command in the workspace and return its output.",
    parameters: { type: "object", properties: { cmd: { type: "string" }, timeout: { type: "number" } }, required: ["cmd"], additionalProperties: false },
  } },
  { type: "function", function: {
    name: "apply_patch",
    description: "Use the apply_patch tool to create, update, or delete files. Input is a patch in the V4A diff format.",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
  } },
];

interface Probe {
  id: string;
  ua: string;
  system: string;
  tools: unknown[];
  expectPass: boolean;
  rule: string;
  /** 探针级 base 覆盖（默认取 options.base）。 */
  base?: string;
  /** 探针级会话 id 覆盖（默认每次铸官方形状新 id）。 */
  session?: string;
  /** 追加/剔除标头（相对 buildOpencodeZenUpstreamHeaders 的产物）。 */
  mutateHeaders?: (headers: Record<string, string>) => void;
}

interface ProbeResult {
  probe: Probe;
  passed: boolean;
  detail: string;
}

async function runProbe(options: Options, projectId: string, probe: Probe): Promise<ProbeResult> {
  const session = probe.session ?? createOpenCodeSessionId();
  const headers = buildOpencodeZenUpstreamHeaders(session, "public", projectId, probe.ua);
  probe.mutateHeaders?.(headers);
  const body = {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 16,
    prompt_cache_key: session,
    messages: [
      { role: "system", content: probe.system },
      { role: "user", content: "Reply with the single word: ok" },
    ],
    tools: probe.tools,
  };
  try {
    const response = await fetch(`${probe.base ?? options.base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (response.status !== 200 || !response.body) {
      const text = (await response.text()).slice(0, 160).replaceAll("\n", " ");
      return { probe, passed: false, detail: `HTTP ${response.status} ${text}` };
    }
    // 累积读取直到首个完整 SSE 帧（帧边界 \n\n）：单次 read 可能停在帧中间，
    // 不足以判定 chunk 形状。
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    if (buffer.includes("chat.completion.chunk")) return { probe, passed: true, detail: "SSE chunk" };
    return { probe, passed: false, detail: `HTTP 200 非 chunk: ${buffer.slice(0, 120).replaceAll("\n", " ")}` };
  } catch (error) {
    return { probe, passed: false, detail: `ERROR ${String(error).slice(0, 120)}` };
  }
}

/** 非官方形状会话：12 位随机 hex 当时间段（2026-10-26 实测被新鲜度校验拒绝）。 */
function randomHexSession(): string {
  const hex = Array.from({ length: 12 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const B62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const suffix = Array.from({ length: 14 }, () => B62[Math.floor(Math.random() * B62.length)]).join("");
  return `ses_${hex}${suffix}`;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const projectId = createOpencodeZenProjectId("zen-gate-probe");
  const officialRead = OPENCODE_ZEN_CLIENT_TOOLS.find(
    (tool) => (tool.function as { name?: unknown } | undefined)?.name === "read",
  );
  if (!officialRead) {
    console.error("fingerprint-data.json 缺少 read 官方定义，先按 docs/fingerprint-data.md 更新数据文件。");
    return 2;
  }

  // expectPass = 当前已知画像下的预期；实测翻转即画像漂移。
  const probes: Probe[] = [
    { id: "control-gateway", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT + "\n\n# Client Instructions\n" + CLIENT_SYSTEM, tools: mergeOpencodeZenGateTools(CODEX_TOOLS), expectPass: true, rule: "对照：网关现行注入形态（模板包裹 system + read 合并 + 官方形状会话）应放行" },
    { id: "fallback-official", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, tools: OPENCODE_ZEN_CLIENT_TOOLS, expectPass: true, rule: "官方 GA 抓包形态（纯模板 + 官方工具全量）应放行：快照模板仍是当前代" },
    { id: "template-plus-client", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT + "\n\n# Client Instructions\n" + CLIENT_SYSTEM, tools: [officialRead], expectPass: true, rule: "模板在前、客户端指令追加在后应放行：包含关系校验（非逐字相等）" },
    { id: "plain-system", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: CLIENT_SYSTEM, tools: [officialRead], expectPass: false, rule: "无模板的普通 system 应被拒：system 包含校验在场" },
    { id: "template-truncated", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.slice(0, 2000), tools: [officialRead], expectPass: false, rule: "模板截断前 2000 字应被拒：须包含全文" },
    { id: "random-hex-session", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, tools: [officialRead], expectPass: false, rule: "随机 hex 当时间段应被拒：会话时间段新鲜度校验在场", session: randomHexSession() },
    { id: "tools-without-read", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, tools: CODEX_TOOLS, expectPass: false, rule: "带 tools 而 read 缺席应被拒：read 硬性在场要求（2026-10-26 复测 3/3）" },
    { id: "stale-ua-version", ua: "opencode/latest/2.0.29/cli", system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, tools: [officialRead], expectPass: true, rule: "旧版本号 UA 应放行：UA 版本不校验" },
    { id: "extra-session-header", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, tools: [officialRead], expectPass: true, rule: "多余 x-opencode-session-id 标头应放行：网关发全集不受影响" },
  ];

  console.log(`model=${options.model}  base=${options.base}  snapshotUA=${OPENCODE_ZEN_CLIENT_USER_AGENT}\n`);
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const result = await runProbe(options, projectId, probe);
    results.push(result);
    const verdict = result.passed === probe.expectPass ? "OK  " : "DRIFT";
    const outcome = result.passed ? "200" : "rejected";
    console.log(`${verdict}  ${probe.id.padEnd(26)} ${outcome.padEnd(8)} ${result.detail.slice(0, 90)}`);
    console.log(`      ${probe.rule}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const drift = results.filter((result) => result.passed !== result.probe.expectPass);
  const controlFailed = drift.some((result) => result.probe.id === "control-gateway" && !result.passed);
  console.log("");
  if (controlFailed) {
    console.log("结论：对照探针被拒——若 fallback-official 同被拒，先换出口 IP 复跑排除匿名共享池耗尽（与形态拒绝同文案 429）；仍拒则现行注入形态失效，按 docs/fingerprint-data.md「更新方法」重估注入面。");
  } else if (drift.length === 0) {
    console.log("结论：门禁画像与 2026-10-26 终版一致（/inference/openai/v1 端点、会话四值同配 + 时间段新鲜度、system 须包含官方当前代模板全文、tools 非必要、UA 版本不校验）。");
  } else {
    console.log(`结论：画像漂移 ${drift.length} 项——${drift.map((result) => result.probe.id).join("、")}；按 docs/fingerprint-data.md 与 docs/exec-plans/active/ 计划重新评估注入面。`);
  }
  return drift.length === 0 ? 0 : 1;
}

process.exit(await main());
