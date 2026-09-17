import fs from "node:fs";
import path from "node:path";

import type { ProcessLogTarget } from "./types.ts";

export interface RequestLogSink {
  dir: string;
  /** 整个日志目录保留的最新请求日志文件数；0 表示不限制。 */
  maxLogs: number;
  /**
   * 进程日志目标。未配置时（如单测直接构造 handler）只写请求日志，不写进程日志；
   * 请求摘要与错误摘要只在配置了它之后才记录，见 process-log.ts。
   */
  processLog?: ProcessLogTarget;
}

const LOG_PREFIX = "cliproxy";
export type LogNamespace = "cliproxy" | "zai" | "bigmodel";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "chatgpt-account-id",
  "cookie",
  "set-cookie",
  // Codex Realtime 会带上数 KB 的 attestation，属于凭据，不得明文落盘。
  "x-oai-attestation",
]);

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** 文件名时间戳，本地时区：20260819173535；进程日志备份名也用它。 */
export function fileStamp(at = new Date()): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/** 日志正文时间戳，本地时区：2026-08-19 17:35:35.494 */
export function localTime(at = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

/**
 * 取请求路径前两段作为日志分组：/v1/live/rtc_x -> v1-live。
 * 不按上游命名，因为缺模型信息时会回落到 official，用它做文件名会误导排查。
 * 段内只保留安全字符，避免 `..` 之类拼出目录外的路径。
 */
export function logGroupFromPath(pathname: string): string {
  const segments = pathname.split("/")
    .filter(Boolean)
    .slice(0, 2)
    .map((segment) => segment.replace(/[^A-Za-z0-9_-]/g, "_"))
    .filter(Boolean);
  return segments.length > 0 ? segments.join("-") : "root";
}

/** 一个日志目标：name 是写入日志目录的文件名。 */
export interface LogFileRef {
  name: string;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** HTTP 请求：按秒滚动，与此前行为一致。 */
export function httpLogFile(group: string, at = fileStamp(), namespace: LogNamespace = LOG_PREFIX): LogFileRef {
  return { name: `${namespace}-${group}-http-${at}.log` };
}

/**
 * WebSocket 连接：整条会话写同一个文件。
 * 用 session-id 而非 thread-id——多条连接（含 subagent 派生的 thread）共享同一 session，
 * 合并后文件数量大幅下降；缺失时回落到建连时刻。
 */
export function websocketLogFile(group: string, sessionId?: string): LogFileRef {
  const id = sanitizeSegment(sessionId ?? "").slice(0, 64) || fileStamp();
  return { name: `${LOG_PREFIX}-${group}-ws-${id}.log` };
}

/**
 * 本模块历史上写出的请求日志名：`<namespace>-error-<时间戳>.log`
 * 或 `<namespace>-<group>-<http|ws>-<id>.log`。
 *
 * 只用来判断"这个文件是不是请求日志"——保留策略按时间全局生效，不再需要分组。
 * 同时挡住 gateway.log 这类进程日志：logDir 被指到网关根目录时，它由 launchd 持有句柄，
 * 绝不能被请求日志的保留计数删掉。
 * `error-` 形仍被识别，是为了让旧的错误摘要文件按同一保留策略自然老化，而不是永远留下。
 */
const REQUEST_LOG_NAME = /^(?:cliproxy|zai|bigmodel)-(?:error-\d{14}|.+-(?:http|ws)-[^/]+)\.log$/;

export function isRequestLogName(name: string): boolean {
  return REQUEST_LOG_NAME.test(name);
}

/**
 * 进程内正在被写入的日志文件（绝对路径）→ 仍持有它的写入方计数。
 * WebSocket 会话是长生命周期的持续写入：文件在会话结束前一直被追加，
 * 若在会话中途被删，进程握着的 inode 还在写，日志却从目录里消失——静默丢一段会话。
 * 多个连接可能共享同一 session-id（即同一日志文件），因此按引用计数登记：
 * 任意一个连接关闭只递减计数，最后一个连接释放后才允许裁剪删除。
 */
const activeLogCounts = new Map<string, number>();

/**
 * 日志文件名只允许是日志目录内的普通文件名。
 * 会话 id 之类的外部输入已经过 sanitizeSegment，这里再兜一层边界校验：
 * 先要求是纯 basename（挡住 `..` 与路径分隔符），再把解析后的绝对路径与日志目录比对，
 * 确认目标仍落在目录内，绝不拼出目录外的路径。
 */
export function safeLogPath(dir: string, name: string): string | undefined {
  if (!name || name === "." || name === ".." || name !== path.basename(name)) return undefined;
  const root = path.resolve(dir);
  const target = path.resolve(root, name);
  if (target === root || !target.startsWith(root + path.sep)) return undefined;
  return target;
}

/** 登记一个持续写入的日志文件，返回幂等的释放函数；会话结束时必须调用。 */
export function retainLogFile(dir: string, file: LogFileRef): () => void {
  const target = safeLogPath(dir, file.name);
  if (!target) return () => {};
  activeLogCounts.set(target, (activeLogCounts.get(target) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeLogCounts.get(target) ?? 1) - 1;
    if (remaining > 0) activeLogCounts.set(target, remaining);
    else activeLogCounts.delete(target);
  };
}


/**
 * 按修改时间全局裁剪：整个日志目录只保留最新的 maxLogs 个请求日志，不分组。
 *
 * 跳过两类文件：本进程正在写入的（未结束的 WebSocket 会话），以及不是请求日志的
 * （gateway.log 等进程日志、历史 config 审计文件）。
 */
export function pruneLogDir(dir: string, maxLogs: number): void {
  if (maxLogs <= 0) return;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!isRequestLogName(name)) continue;
    const target = safeLogPath(dir, name);
    if (!target || (activeLogCounts.get(target) ?? 0) > 0) continue;
    try {
      candidates.push({ path: target, mtimeMs: fs.statSync(target).mtimeMs });
    } catch {
      // 文件在扫描期间被移走，跳过。
    }
  }
  if (candidates.length <= maxLogs) return;
  // 最新在前；mtime 相同（同一毫秒内落盘）时用文件名兜底，保证结果稳定。
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1));
  for (const { path: target } of candidates.slice(maxLogs)) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // 单个文件删不掉不影响其余裁剪。
    }
  }
}

/**
 * 大上限时把写入路径上的补偿扫描摊薄：每写这么多文件补扫一次目录。
 *
 * 不能每次 append 都扫：realtime 逐帧写日志，扫描成本会被放大到帧路径上
 * （历史上每次写入 readdirSync 八千个文件让 300 帧从 41ms 涨到 3461ms，见
 * docs/histories/2026-09/20260901-0956）。上限本身小于这个值时目录很小，
 * 每次写入顺带裁剪更省事，也避免上限小的时候目录明显超出保留数。
 */
const SWEEP_INTERVAL = 32;
const writesSinceSweep = new Map<string, number>();

function sweepAfterWrite(dir: string, maxLogs: number): void {
  if (maxLogs <= 0) return;
  if (maxLogs >= SWEEP_INTERVAL) {
    const pending = (writesSinceSweep.get(dir) ?? 0) + 1;
    if (pending < SWEEP_INTERVAL) {
      writesSinceSweep.set(dir, pending);
      return;
    }
    writesSinceSweep.set(dir, 0);
  }
  pruneLogDir(dir, maxLogs);
}

function append(sink: RequestLogSink, file: LogFileRef, text: string): void {
  try {
    fs.mkdirSync(sink.dir, { recursive: true });
    fs.appendFileSync(path.join(sink.dir, file.name), text);
    sweepAfterWrite(sink.dir, sink.maxLogs);
  } catch {
    // Logging must never break the request flow.
  }
}

function headerLines(headers: Headers): string[] {
  const lines: string[] = [];
  headers.forEach((value, key) => lines.push(`  ${key}: ${SENSITIVE_HEADERS.has(key.toLowerCase()) ? "***" : value}`));
  return lines;
}

/** 给 WebSocket 握手头用：它不经过 logging wrapper，只能在事件里留痕，同样需要遮蔽凭据。 */
export function maskedHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "***" : value;
  }
  return masked;
}


export interface ExchangeEntry {
  requestTime: string;
  method: string;
  url: string;
  reqHeaders: Headers;
  reqBody: unknown;
  status: number;
  resHeaders: Headers;
  resBody: string;
  upstreamUrl?: string;
  upstreamRequestHeaders?: Headers;
  /** 转换后真正发给上游的请求正文；仅在实际转发过且需要落盘时记录。 */
  upstreamRequestBody?: unknown;
  durationMs?: number;
}

export function logExchange(sink: RequestLogSink | undefined, group: string, entry: ExchangeEntry, namespace: LogNamespace = LOG_PREFIX): void {
  if (!sink) return;
  const lines = [
    `--${entry.requestTime}--`,
    `=== ${entry.method} ${entry.url} ===`,
    ``,
    // 入站请求在前、实际发往上游的内容在后，一次读下来就是「收到什么 → 发出什么」。
    `--- request headers ---`,
    ...headerLines(entry.reqHeaders),
    ``,
    `--- request payload ---`,
    `  ${typeof entry.reqBody === "string" ? entry.reqBody : JSON.stringify(entry.reqBody ?? null)}`,
    ...(entry.upstreamUrl ? [``, `--- upstream: ${entry.upstreamUrl} ---`] : []),
    ...(entry.upstreamRequestHeaders ? [
      ``, `--- upstream request headers ---`, ...headerLines(entry.upstreamRequestHeaders),
    ] : []),
    ...(entry.upstreamRequestBody === undefined ? [] : [
      ``, `--- upstream request payload ---`,
      `  ${typeof entry.upstreamRequestBody === "string" ? entry.upstreamRequestBody : JSON.stringify(entry.upstreamRequestBody ?? null)}`,
    ]),
    ``,
    ``,
    `--- response status: ${entry.status}${entry.durationMs === undefined ? "" : ` (${entry.durationMs}ms)`} ---`,
    `--- response headers ---`,
    ...headerLines(entry.resHeaders),
    ``,
    `--- response body ---`,
    `  ${entry.resBody}`,
    ``,
    ``,
  ];
  append(sink, httpLogFile(group, undefined, namespace), `${lines.join("\n")}\n`);
}

export interface RealtimeEntry {
  event: string;
  url: string;
  detail?: Record<string, unknown>;
  /** 文本帧传内容（完整，不截断），二进制帧传字节数。 */
  frame?: string | number;
}

/** Realtime 的 call-create 与 WebSocket 生命周期事件。 */
export function logRealtimeEvent(
  sink: RequestLogSink | undefined,
  file: LogFileRef,
  entry: RealtimeEntry,
): void {
  if (!sink) return;
  const detail = entry.detail && Object.keys(entry.detail).length > 0
    ? ` ${JSON.stringify(entry.detail)}`
    : "";
  const frame = entry.frame === undefined
    ? ""
    : typeof entry.frame === "number"
      ? ` <binary ${entry.frame}B>`
      : ` ${entry.frame}`;
  append(sink, file, `--${localTime()}-- [realtime] ${entry.event} ${entry.url}${detail}${frame}\n`);
}
