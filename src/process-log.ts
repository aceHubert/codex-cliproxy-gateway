import fs from "node:fs";
import path from "node:path";

import { fileStamp, localTime } from "./request-log.ts";
import type { ProcessLogTarget } from "./types.ts";

export type { ProcessLogTarget };

/**
 * 网关进程日志 gateway.log 的全部写入。
 *
 * 这个文件同时承载 launchd 抓到的 stdout/stderr、网关启动横幅、配置审计、以及每个请求的
 * 一行摘要（错误为多行摘要），统一受 maxGatewayLogBytes 约束。请求的完整正文不在这里，
 * 只留在按 maxRequestLogs 保留的请求日志目录里。
 */

/** 备份保留个数：最旧先删；磁盘占用上限约为 (GATEWAY_LOG_BACKUPS + 1) × maxBytes。 */
const GATEWAY_LOG_BACKUPS = 5;

/**
 * 进程日志的大小上限：当前文件加上即将写入的字节数超过 maxBytes 时，先把现有内容
 * 复制为 gateway-<毫秒级时间戳>.log 备份，再原地清空原文件。必须用 copy-truncate 而非
 * rename：launchd 只在 spawn 时打开 stdout/stderr，之后不会重开——rename 会让运行中
 * 进程的后续写入全部落进备份（stderr 错误 handler 常驻、运行期持续写），甚至写进已被
 * 裁剪删除的 inode；原地清空保持 inode 不变，O_APPEND 追加不会产生空洞。滚动是低概率的
 * 低频操作，复制整文件的开销可忽略。
 */
export function capGatewayLog(logFile: string, maxBytes: number, incomingBytes = 0): void {
  if (maxBytes <= 0) return;
  let currentSize: number;
  try {
    currentSize = fs.statSync(logFile).size;
  } catch {
    return;
  }
  if (currentSize + incomingBytes <= maxBytes) return;
  const dir = path.dirname(logFile);
  const base = path.basename(logFile, ".log");
  const backup = path.join(dir, `${base}-${gatewayBackupStamp()}.log`);
  try {
    fs.copyFileSync(logFile, backup);
    fs.truncateSync(logFile, 0);
    pruneGatewayLogBackups(dir, base);
  } catch {
    // Rotation must never break the request flow.
  }
}

/**
 * 备份时间戳带毫秒：秒级精度在连续两次滚动时会命中同名备份，rename 静默覆盖丢内容。
 * 滚动是低频操作（进程启动与超限写入时），毫秒足以消除碰撞。
 */
function gatewayBackupStamp(at = new Date()): string {
  return `${fileStamp(at)}${String(at.getMilliseconds()).padStart(3, "0")}`;
}

/** 备份名按目标文件派生；前缀写死会让非默认文件的裁剪静默失效。 */
function pruneGatewayLogBackups(dir: string, base: string): void {
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{17}\\.log$`);
  const backups = fs.readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - GATEWAY_LOG_BACKUPS))) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * 追加一段文本到进程日志。
 *
 * 目标文件来自 serve 注入的 paths.stdoutLog（本机固定路径，不来自请求），这里不做任何
 * 文件名拼接。必须先按 maxBytes 判断滚动、再追加：反过来的话刚写入的这一条会被自己的
 * 滚动搬进备份，活跃文件反而空掉。copy-truncate 保持 inode 不变，launchd 持有的
 * stdout/stderr 句柄继续有效，因此运行期也受同一上限约束，不必等下一次启动。
 */
export function appendProcessLog(target: ProcessLogTarget | undefined, text: string): void {
  if (!target?.file) return;
  try {
    const entry = `${text}\n`;
    capGatewayLog(target.file, target.maxBytes, Buffer.byteLength(entry));
    fs.appendFileSync(target.file, entry);
  } catch {
    // Logging must never break the request flow.
  }
}

export interface ConfigChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ConfigChangeEntry {
  command: string;
  changes: ConfigChange[];
}

/**
 * 配置审计：CLI 每次真实改动配置都追加到网关进程日志；超过 maxBytes 时先复制备份并原地
 * 清空，再写入。条目以日志时间分隔符开头，与网关启动横幅和请求摘要同格式。
 */
export function logConfigChange(
  logFile: string | undefined,
  entry: ConfigChangeEntry,
  maxBytes = 0,
): void {
  if (!logFile || entry.changes.length === 0) return;
  const lines = [
    `--${localTime()}--`,
    `=== config changed by \`${entry.command}\` ===`,
    ...entry.changes.map((change) =>
      `  ${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`),
    ``,
  ];
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    return;
  }
  appendProcessLog({ file: logFile, maxBytes }, lines.join("\n"));
}

export interface ErrorEntry {
  requestTime: string;
  method: string;
  url: string;
  status: number;
  message: string;
  errorName?: string;
  upstreamUrl?: string;
  durationMs?: number;
  stack?: string;
}

function errorLines(entry: ErrorEntry): string[] {
  return [
    `--${entry.requestTime}--`,
    `!!! ${entry.method} ${entry.url} -> ${entry.status} !!!`,
    `  message: ${entry.message}`,
    ...(entry.errorName ? [`  error: ${entry.errorName}`] : []),
    ...(entry.upstreamUrl ? [`  upstream: ${entry.upstreamUrl}`] : []),
    ...(entry.durationMs === undefined ? [] : [`  duration: ${entry.durationMs}ms`]),
    ...(entry.stack ? [`  stack:`, ...entry.stack.split("\n").map((line) => `    ${line.trim()}`)] : []),
    ``,
  ];
}

/**
 * 请求错误摘要：单条写入进程日志，不再另开 `*-error-*.log`。
 *
 * 摘要曾另有一份副本写进所属请求日志，但那里完整 exchange 已经含有响应正文与状态，
 * 摘要只是重复同样的信息；合并进进程日志后，"哪里出错"是一处可见的线性流水，
 * 且与 stdout/stderr、配置审计共用 maxGatewayLogBytes 这一个上限。
 */
export function logGatewayError(target: ProcessLogTarget | undefined, entry: ErrorEntry): void {
  appendProcessLog(target, errorLines(entry).join("\n"));
}

export interface RequestSummary {
  requestTime: string;
  method: string;
  url: string;
  status: number;
  durationMs?: number;
  /** 本次请求实际打到哪个上游；未记录时不输出该字段。 */
  upstreamUrl?: string;
}

/**
 * 请求摘要：一行写明方法、路径、状态、耗时与上游，**不记录响应正文**——
 * 正文只留在按 maxRequestLogs 保留的请求日志里，进程日志保持可扫描。
 * 每条请求恰好一行：非错误状态（协议协商 426 也算）走这里，真正的错误走 logGatewayError。
 * WebSocket 成功桥接在会话关闭时以 status 101 写一行摘要（见 realtime.ts close）。
 */
export function logRequestSummary(target: ProcessLogTarget | undefined, entry: RequestSummary): void {
  const duration = entry.durationMs === undefined ? "" : ` (${entry.durationMs}ms)`;
  const upstream = entry.upstreamUrl ? ` upstream: ${entry.upstreamUrl}` : "";
  appendProcessLog(target, `--${entry.requestTime}-- ${entry.method} ${entry.url} -> ${entry.status}${duration}${upstream}`);
}
