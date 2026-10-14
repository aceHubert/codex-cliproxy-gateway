#!/usr/bin/env bun
// OpenCode Zen 免费层门禁诊断探针：逐项隔离实测当前门禁画像，供指纹失效时单点重测。
//
// 背景：2026-10-08 mitm 实证的三层门禁（标头 + 请求体模板/工具 + 流式）在 2026-10-14
// 复测已部分失效——system 模板不再被检查、两段式 UA 放行，工具名单成为唯一实锤的
// 请求体闸（必须同时含 `read` 与 `bash`/`shell` 之名，schema 不查）。门禁会漂移，
// 出现批量 403 `zen_free_tier_error` 时先跑本脚本定位漂移层，再按
// docs/fingerprint-data.md「更新方法」处理。
//
// 用法：
//   bun scripts/zen-gate-probe.ts                     # 默认 10 个探针，5s 间隔
//   bun scripts/zen-gate-probe.ts --model nemotron-3.5-lightning-free
//   bun scripts/zen-gate-probe.ts --base https://opencode.ai/zen/v1
//
// 输出：每个探针一行（PASS/FAIL 相对当前已知画像），末尾汇总画像漂移项。
// 退出码：0 = 画像与实现一致；1 = 有漂移（对照失败优先看 fingerprint-data.json）；
//         2 = 参数错误。探针走免费 public 通道，会消耗 IP 限额。
// 注意：同日多次全量跑可能触发 IP 限频或上游抖动，出现偶发 DRIFT 时先复跑一次再定性
// （2026-10-14 实测：同一形态首跑被拒、复跑 10/10 全过）；判定画像漂移以复跑为准。
import {
  buildOpencodeZenUpstreamHeaders,
  createOpencodeZenProjectId,
  OPENCODE_ZEN_AGENT_SYSTEM_PROMPT,
  OPENCODE_ZEN_CLIENT_TOOLS,
  OPENCODE_ZEN_CLIENT_USER_AGENT,
  padOpencodeZenGateTools,
} from "../packages/opencode-zen/src/fingerprint.ts";
import { createOpenCodeSessionId } from "../packages/opencode-zen/src/session.ts";

interface Options {
  model: string;
  base: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { model: "space-bunny-free", base: "https://opencode.ai/zen/v1" };
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
const LEGACY_UA_FALLBACK = "1.19.0";

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

/** dsh 式无参占位工具：名字命中门禁、schema 为空、描述声明不可执行。 */
function placeholderTool(name: string): Record<string, unknown> {
  return { type: "function", function: {
    name,
    description: "Requirement placeholder: this harness cannot execute it. Use the harness tools instead.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  } };
}

interface Probe {
  id: string;
  ua: string;
  system: string;
  tools: unknown[];
  expectPass: boolean;
  rule: string;
}

async function resolveLegacyUserAgent(): Promise<string> {
  try {
    const response = await fetch("https://unpkg.com/opencode-ai@latest/package.json", { signal: AbortSignal.timeout(10_000) });
    const payload = await response.json() as { version?: string };
    return typeof payload.version === "string" && payload.version ? `opencode/${payload.version}` : `opencode/${LEGACY_UA_FALLBACK}`;
  } catch {
    return `opencode/${LEGACY_UA_FALLBACK}`;
  }
}

interface ProbeResult {
  probe: Probe;
  passed: boolean;
  detail: string;
}

async function runProbe(options: Options, projectId: string, probe: Probe): Promise<ProbeResult> {
  const session = createOpenCodeSessionId();
  const headers = buildOpencodeZenUpstreamHeaders(session, "public", projectId, probe.ua);
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
    const response = await fetch(`${options.base}/chat/completions`, {
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
  const legacyUserAgent = await resolveLegacyUserAgent();
  const officialTools = OPENCODE_ZEN_CLIENT_TOOLS as Array<Record<string, unknown>>;

  // expectPass = 当前已知画像下的预期；实测翻转即画像漂移。
  const probes: Probe[] = [
    { id: "control-gateway", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: padOpencodeZenGateTools(CODEX_TOOLS), expectPass: true, rule: "对照：网关现行注入形态（垫补 read+bash 占位）应放行" },
    { id: "fallback-official", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: OPENCODE_ZEN_AGENT_SYSTEM_PROMPT, tools: OPENCODE_ZEN_CLIENT_TOOLS, expectPass: true, rule: "回退形态（官方模板+官方工具全量）应放行：回退材料有效" },
    { id: "codex-tools-only", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: CODEX_TOOLS, expectPass: false, rule: "仅 Codex 工具（无 read/bash 名）应被拒：工具名单闸在场" },
    { id: "pad-read-bash", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [...CODEX_TOOLS, placeholderTool("read"), placeholderTool("bash")], expectPass: true, rule: "read+bash 空 schema 占位应放行：最小垫补可行" },
    { id: "pad-shell-read", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [...CODEX_TOOLS, placeholderTool("shell"), placeholderTool("read")], expectPass: true, rule: "shell 可替代 bash（官方 GA 工具名同样有效）" },
    { id: "pad-read-only", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [...CODEX_TOOLS, placeholderTool("read")], expectPass: false, rule: "仅 read（无 bash/shell）应被拒：两名都要" },
    { id: "pad-bash-only", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [...CODEX_TOOLS, placeholderTool("bash")], expectPass: false, rule: "仅 bash（无 read）应被拒：read 硬性" },
    { id: "no-template-official-tools", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: officialTools, expectPass: true, rule: "无官方模板 + 官方工具全量应放行：system 模板不检查" },
    { id: "legacy-ua-pad", ua: legacyUserAgent, system: PLAIN_SYSTEM, tools: [...CODEX_TOOLS, placeholderTool("read"), placeholderTool("bash")], expectPass: true, rule: "两段式 UA + 最小垫补应放行：UA 格式已放宽" },
    { id: "no-tools-plain", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: [], expectPass: false, rule: "无工具裸发应被拒：名单闸不分有无工具" },
    { id: "no-tools-pad", ua: OPENCODE_ZEN_CLIENT_USER_AGENT, system: PLAIN_SYSTEM, tools: padOpencodeZenGateTools([]), expectPass: true, rule: "无工具 + 垫补占位应放行：标题生成等场景的保活路径" },
  ];

  console.log(`model=${options.model}  base=${options.base}  snapshotUA=${OPENCODE_ZEN_CLIENT_USER_AGENT}  legacyUA=${legacyUserAgent}\n`);
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
    console.log("结论：门禁画像与 2026-10-14 复测一致（read+bash/shell 名单闸，不分有无工具；模板与 UA 格式不检查）。");
  } else {
    console.log(`结论：画像漂移 ${drift.length} 项——${drift.map((result) => result.probe.id).join("、")}；按 docs/fingerprint-data.md 与 docs/exec-plans/active/ 计划重新评估注入面。`);
  }
  return drift.length === 0 ? 0 : 1;
}

process.exit(await main());
