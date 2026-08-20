#!/usr/bin/env bun
// 请求日志检查工具：汇总网关按路径分组的请求日志，便于手工验收与排障。
//
// 用法：
//   bun scripts/log-check.ts                    # 概览 + 最近 15 条摘要 + 错误摘要尾行
//   bun scripts/log-check.ts --tail 50          # 最近 50 条
//   bun scripts/log-check.ts --group v1-live    # 只看某个分组
//   bun scripts/log-check.ts --errors           # 只看错误摘要全文
//   bun scripts/log-check.ts --dir <目录>       # 指定日志目录
//
// 摘要行形态：
//   08-19 19:06:18  POST /v1/responses  401  152ms  model=__probe__  hint=gpt-5.6-luna
//   08-19 19:06:20  [realtime] call-create api.openai.com/v1/live  201  923ms
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DIR = path.join(process.env.HOME ?? ".", ".codex-cliproxy-gateway", "logs");

interface Options {
  dir: string;
  tail: number;
  group?: string;
  errorsOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dir: DEFAULT_DIR, tail: 15, errorsOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = argv[++i] ?? "";
    else if (arg === "--tail") options.tail = Number(argv[++i] ?? "15") || 15;
    else if (arg === "--group") options.group = argv[++i];
    else if (arg === "--errors") options.errorsOnly = true;
    else {
      console.error(`未知参数: ${arg}\n用法见文件头注释。`);
      process.exit(2);
    }
  }
  return options;
}

type EntryKind = "exchange" | "error" | "realtime";

interface LogEntry {
  file: string;
  group: string;
  kind: EntryKind;
  time: string;
  at: number;
  summary: string;
  raw: string;
}

function groupOf(fileName: string): string {
  const match = fileName.match(/^cliproxy-(.+)-\d{8,}\.log$/);
  return match ? match[1] : fileName.replace(/\.log$/, "");
}

/** 旧格式是 UTC ISO（带 Z），新格式是本地时间；统一按本地解析用于排序。 */
function epochOf(stamp: string): number {
  const normalized = stamp.includes("T") ? stamp : stamp.replace(" ", "T");
  const at = new Date(normalized).getTime();
  return Number.isNaN(at) ? 0 : at;
}

function shortStamp(stamp: string): string {
  const rest = stamp.replace(/^\d{4}-/, "").replace("T", " ");
  return rest.slice(0, 14);
}

function hintModel(lines: string[]): string {
  const header = lines.find((line) => line.trim().startsWith("x-codex-routing-hint:"));
  return header?.match(/model=([^;\s"']+)/)?.[1] ?? "-";
}

function payloadModel(lines: string[]): string {
  const index = lines.findIndex((line) => line.trim() === "--- request payload ---");
  const payload = index >= 0 ? lines[index + 1]?.trim() : undefined;
  if (!payload) return "-";
  try {
    const value: unknown = JSON.parse(payload);
    if (value && typeof value === "object" && typeof (value as { model?: unknown }).model === "string") {
      return (value as { model: string }).model;
    }
  } catch {
    // payload 可能被截断或不是 JSON，显示占位即可。
  }
  return "-";
}

function parseEntry(file: string, group: string, stamp: string, lines: string[]): LogEntry | undefined {
  const base = { file, group, time: stamp, at: epochOf(stamp), raw: `${stamp}\n${lines.join("\n")}` };
  const realtime = lines.join("\n").match(/\[realtime\] (\S+) (\S+)(.*)/);
  if (realtime) {
    const detail = realtime[3].match(/\{.*\}/)?.[0];
    let status = "-";
    let duration = "-";
    try {
      const parsed: unknown = detail ? JSON.parse(detail) : undefined;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        status = String(record.status ?? "-");
        duration = record.durationMs === undefined ? "-" : `${record.durationMs}ms`;
      }
    } catch {
      // detail 可能被截断，保留占位。
    }
    const target = new URL(realtime[2]);
    return {
      ...base,
      kind: "realtime",
      summary: `[realtime] ${realtime[1]} ${target.host}${target.pathname}  ${status}  ${duration}`,
    };
  }
  const head = lines[0] ?? "";
  const exchange = head.match(/^=== (\S+) (\S+) ===$/);
  if (exchange) {
    const status = lines.join("\n").match(/--- response status: (\d+)(?: \((\d+)ms\))? ---/);
    const model = payloadModel(lines);
    const hint = hintModel(lines);
    return {
      ...base,
      kind: "exchange",
      summary: `${exchange[1].padEnd(5)} ${exchange[2]}  ${status?.[1] ?? "-"}  ${status?.[2] ?? "-"}ms  model=${model}  hint=${hint}`,
    };
  }
  const error = head.match(/^!!! (\S+) (\S+) -> (\d+) !!!$/);
  if (error) {
    const message = lines.find((line) => line.trim().startsWith("message:"))?.trim().slice(9, 109) ?? "-";
    return { ...base, kind: "error", summary: `${error[1].padEnd(5)} ${error[2]} -> ${error[3]}  ${message}` };
  }
  return undefined;
}

/** 单条记录以 `--时间戳--` 行开头；realtime 记录的时间戳与内容同行。 */
function parseFile(dir: string, file: string): LogEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, file), "utf8");
  } catch {
    return [];
  }
  const entries: LogEntry[] = [];
  const group = groupOf(file);
  let stamp = "";
  let lines: string[] = [];
  const flush = () => {
    if (stamp && lines.length > 0) {
      const entry = parseEntry(file, group, stamp, lines);
      if (entry) entries.push(entry);
    }
    stamp = "";
    lines = [];
  };
  for (const line of text.split("\n")) {
    const separator = line.match(/^--(\d{4}-[0-9:.TZ -]+)--(.*)$/);
    if (separator) {
      flush();
      stamp = separator[1];
      const rest = separator[2].trim();
      if (rest) lines.push(rest);
    } else if (stamp) {
      lines.push(line);
    }
  }
  flush();
  return entries;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.dir)) {
    console.error(`日志目录不存在: ${options.dir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(options.dir).filter((name) => name.endsWith(".log")).sort();
  const groups = new Map<string, { files: number; entries: number; latest: LogEntry | undefined }>();
  const all: LogEntry[] = [];
  for (const file of files) {
    for (const entry of parseFile(options.dir, file)) {
      if (options.group && entry.group !== options.group) continue;
      const bucket = groups.get(entry.group) ?? { files: 0, entries: 0, latest: undefined };
      bucket.entries += 1;
      bucket.latest = !bucket.latest || entry.at >= bucket.latest.at ? entry : bucket.latest;
      groups.set(entry.group, bucket);
      all.push(entry);
    }
    if (!options.group || groupOf(file) === options.group) {
      const bucket = groups.get(groupOf(file)) ?? { files: 0, entries: 0, latest: undefined };
      bucket.files += 1;
      groups.set(groupOf(file), bucket);
    }
  }
  all.sort((a, b) => a.at - b.at);

  const errorEntries = all.filter((entry) => entry.group === "error");

  if (options.errorsOnly) {
    for (const entry of errorEntries.slice(-options.tail)) {
      console.log(entry.raw);
      console.log("");
    }
    return;
  }

  console.log(`日志目录: ${options.dir}`);
  console.log("");
  console.log("分组概况");
  for (const [group, bucket] of [...groups.entries()].sort((a, b) => (b[1].latest?.at ?? 0) - (a[1].latest?.at ?? 0))) {
    const latest = bucket.latest ? shortStamp(bucket.latest.time) : "-";
    console.log(`  ${group.padEnd(20)} ${String(bucket.files).padStart(3)} 文件  ${String(bucket.entries).padStart(4)} 条  最近 ${latest}`);
  }
  console.log("");
  // 错误在分组日志里是双写副本，主列表只展示交换与 realtime，摘要统一在底部。
  const shown = all.filter((entry) => entry.kind !== "error").slice(-options.tail);
  console.log(`最近 ${shown.length} 条（不含错误摘要，--errors 查看）`);
  for (const entry of shown) {
    console.log(`  ${shortStamp(entry.time)}  ${entry.summary}`);
  }
  console.log("");
  console.log(`错误摘要（${errorEntries.length} 条）`);
  for (const entry of errorEntries.slice(-options.tail)) {
    console.log(`  ${shortStamp(entry.time)}  ${entry.summary}`);
  }
}

main();
