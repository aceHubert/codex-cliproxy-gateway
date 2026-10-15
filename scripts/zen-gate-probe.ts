#!/usr/bin/env bun
// OpenCode Zen 免费层门禁诊断探针：逐项隔离实测当前门禁画像，供指纹失效时单点重测。
//
// 背景：门禁持续漂移——2026-10-08 三层画像（标头 + 请求体模板/工具 + 流式）、
// 2026-10-14 名单制画像（read/bash 之名、空 schema 可过、模板不查）均已被推翻。
// 2026-10-15 终版画像（抓包 + 逐项隔离实测 + linux.do 2912664 同结论）：
//   ① 端点迁至 https://opencode.ai/inference/v1（旧 /zen/v1 一律 403）；
//   ② 标头最小集（最小头实验四件：Authorization + User-Agent + x-opencode-session-id +
//      x-session-affinity）；完整指纹集下单缺 affinity 亦放行（标头互备），UA 版本不校验；
//   ③ tools 仅 `read` 必须：schema 须非空（空 properties 403；官方完整定义与
//      {path:{}} 最小形均过闸），其它工具（bash/shell 及数量）无关；system 内容
//      不检查；无 tools 仅官方标题模板放行（不走）。
// 出现批量 403 `zen_free_tier_error` 时先跑本脚本定位漂移层，再按
// docs/fingerprint-data.md「更新方法」处理。
//
// 用法：
//   bun scripts/zen-gate-probe.ts                     # 默认 10 个探针，5s 间隔
//   bun scripts/zen-gate-probe.ts --model nemotron-3.5-lightning-free
//   bun scripts/zen-gate-probe.ts --base https://opencode.ai/inference/v1
//
// 输出：每个探针一行（PASS/FAIL 相对当前已知画像），末尾汇总画像漂移项。
// 退出码：0 = 画像与实现一致；1 = 有漂移（对照失败优先看 fingerprint-data.json）；
//         2 = 参数错误。探针走免费 public 通道，会消耗 IP 限额。
// 注意：同日多次全量跑可能触发 IP 限频或上游抖动，出现偶发 DRIFT 时先复跑一次再定性
// （2026-10-14 实测：同一形态首跑被拒、复跑 10/10 全过）；判定画像漂移以复跑为准。
import {
  buildOpencodeZenUpstreamHeaders,
  createOpencodeZenProjectId,
  mergeOpencodeZenGateTools,
  OPENCODE_ZEN_AGENT_SYSTEM_PROMPT,
  OPENCODE_ZEN_CLIENT_TOOLS,
  OPENCODE_ZEN_CLIENT_USER_AGENT,
} from "../packages/opencode-zen/src/fingerprint.ts";
import { createOpenCodeSessionId, deriveOpenCodeSessionId } from "../packages/opencode-zen/src/session.ts";

interface Options {
  model: string;
  base: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { model: "space-bunny-free", base: "https://opencode.ai/inference/v1" };
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

const PLAIN_SYSTEM = "You are a precise coding agent. Answer concisely.";

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

function officialTool(name: string): Record<string, unknown> | undefined {
  return (OPENCODE_ZEN_CLIENT_TOOLS as Array<Record<string, unknown>>).find(
    (tool) => (tool.function as { name?: unknown } | undefined)?.name === name,
  );
}

interface Probe {
  id: string;
  ua: string;
  system: string;
  tools: unknown[];
  expectPass: boolean;
  rule: string;
  /** 探针级 base 覆盖（默认取 options.base）。 */
  base?: string;
  /** 探针级会话 id 覆盖（默认每次铸新 id）。 */
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
    max_tokens: 16,
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

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const projectId = createOpencodeZenProjectId("zen-gate-probe");
  const read = officialTool("read");
  const shell = officialTool("shell");
  if (!read) {
    console.error("fingerprint-data.json 缺少 read 官方定义，先按 docs/fingerprint-data.md 更新数据文件。");
    return 2;
  }

  // expectPass = 当前已知画像下的预期；实测翻转即画像漂移。
  const probes: Probe[] = [
    { id: "control-gateway", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: mergeOpencodeZenGateTools(CODEX_TOOLS), expectPass: true, rule: "对照：网关现行注入形态（合并官方 read 定义）应放行" },
    { id: "fallback-official", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, tools: OPENCODE_ZEN_CLIENT_TOOLS, expectPass: true, rule: "回退形态（官方模板+官方工具全量）应放行：回退材料有效" },
    { id: "codex-tools-only", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: CODEX_TOOLS, expectPass: false, rule: "仅 Codex 工具（无 read）应被拒：read 实名闸在场" },
    { id: "minimal-read", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [read], expectPass: true, rule: "仅官方 read 定义即放行：read 唯一必须（linux.do 2912664 同结论）" },
    { id: "minimal-read-schema", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: {} } } } }], expectPass: true, rule: "read 的最小非空 schema（{path:{}}）应放行：不要求官方完整定义" },
    { id: "read-empty-schema", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {}, required: [] } } }], expectPass: false, rule: "read 空 properties 应被拒：schema 非空被检查" },
    { id: "shell-without-read", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [shell].filter(Boolean), expectPass: false, rule: "仅 shell（无 read）应被拒：其它官方名不替代 read" },
    { id: "client-plus-official", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [...CODEX_TOOLS, read], expectPass: true, rule: "客户端工具与官方 read 并存应放行：同名客户端定义优先" },
    { id: "no-session-id-header", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [read], expectPass: false, rule: "缺 x-opencode-session-id 应被拒：标头最小集在场", mutateHeaders: (h) => { delete h["x-opencode-session-id"]; } },
    { id: "no-affinity-header", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [read], expectPass: true, rule: "完整指纹集下单缺 x-session-affinity 放行（最小集实验中必需——标头存在互备，网关发全集不受影响）", mutateHeaders: (h) => { delete h["x-session-affinity"]; } },
    { id: "derived-session-id", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [read], expectPass: true, rule: "外部会话确定性派生的 id 应放行：counter 位为官方形状（哈希前缀被拒，服务端解码时间段）", session: deriveOpenCodeSessionId("zen-gate-probe-conversation") },
    { id: "stale-ua-version", ua: "opencode/latest/2.0.26/cli", system: PLAIN_SYSTEM, tools: [read], expectPass: true, rule: "旧版本号 UA 应放行：UA 版本不校验" },
    { id: "no-tools-plain", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [], expectPass: false, rule: "无工具裸发应被拒：官方标题模板例外网关不走" },
    { id: "legacy-zen-endpoint", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [read], expectPass: false, rule: "旧 /zen/v1 端点应被拒：上游已迁 /inference/v1", base: "https://opencode.ai/zen/v1" },
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
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  const drift = results.filter((result) => result.passed !== result.probe.expectPass);
  const controlFailed = drift.some((result) => result.probe.id === "control-gateway" && !result.passed);
  console.log("");
  if (controlFailed) {
    console.log("结论：对照探针被拒——现行注入形态失效，先用 fallback-official 探针判别回退形态是否仍有效，再按 docs/fingerprint-data.md「更新方法」重估注入面。");
  } else if (drift.length === 0) {
    console.log("结论：门禁画像与 2026-10-15 终版一致（/inference/v1 端点、x-opencode-session-id 硬性、read 唯一必须且 schema 非空、UA 版本不校验、/zen/v1 死透）。");
  } else {
    console.log(`结论：画像漂移 ${drift.length} 项——${drift.map((result) => result.probe.id).join("、")}；按 docs/fingerprint-data.md 与 docs/exec-plans/active/ 计划重新评估注入面。`);
  }
  return drift.length === 0 ? 0 : 1;
}

process.exit(await main());
