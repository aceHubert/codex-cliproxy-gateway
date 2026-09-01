import fs from "node:fs";
import path from "node:path";

export interface RequestLogSink {
  dir: string;
  /** 每个日志分组保留的最大文件数；0 表示不限制。 */
  maxLogs: number;
}

const LOG_PREFIX = "cliproxy";
const ERROR_GROUP = "error";

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

/** 文件名时间戳，本地时区：20260819173535 */
function fileStamp(at = new Date()): string {
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

/** 一个日志目标：name 是文件名，prefix 用于 maxRequestLogs 按组裁剪。 */
export interface LogFileRef {
  name: string;
  prefix: string;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** HTTP 请求：按秒滚动，与此前行为一致。 */
export function httpLogFile(group: string, at = fileStamp()): LogFileRef {
  const prefix = `${LOG_PREFIX}-${group}-http-`;
  return { name: `${prefix}${at}.log`, prefix };
}

/**
 * WebSocket 连接：整条会话写同一个文件。
 * 用 session-id 而非 thread-id——多条连接（含 subagent 派生的 thread）共享同一 session，
 * 合并后文件数量大幅下降；缺失时回落到建连时刻。
 */
export function websocketLogFile(group: string, sessionId?: string): LogFileRef {
  const prefix = `${LOG_PREFIX}-${group}-ws-`;
  const id = sanitizeSegment(sessionId ?? "").slice(0, 64) || fileStamp();
  return { name: `${prefix}${id}.log`, prefix };
}

function errorLogFile(at = fileStamp()): LogFileRef {
  const prefix = `${LOG_PREFIX}-${ERROR_GROUP}-`;
  return { name: `${prefix}${at}.log`, prefix };
}

/** 同一分组内按文件名升序裁剪，只保留最新的 maxLogs 个。 */
function pruneGroup(dir: string, prefix: string, maxLogs: number): void {
  if (maxLogs <= 0) return;
  const files = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".log"))
    .sort();
  for (const name of files.slice(0, Math.max(0, files.length - maxLogs))) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

function append(sink: RequestLogSink, file: LogFileRef, text: string): void {
  try {
    fs.mkdirSync(sink.dir, { recursive: true });
    fs.appendFileSync(path.join(sink.dir, file.name), text);
    pruneGroup(sink.dir, file.prefix, sink.maxLogs);
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
  durationMs?: number;
}

export function logExchange(sink: RequestLogSink | undefined, group: string, entry: ExchangeEntry): void {
  if (!sink) return;
  const lines = [
    `--${entry.requestTime}--`,
    `=== ${entry.method} ${entry.url} ===`,
    ...(entry.upstreamUrl ? [`--- upstream: ${entry.upstreamUrl} ---`] : []),
    ``,
    `--- request headers ---`,
    ...headerLines(entry.reqHeaders),
    ``,
    `--- request payload ---`,
    `  ${typeof entry.reqBody === "string" ? entry.reqBody : JSON.stringify(entry.reqBody ?? null)}`,
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
  append(sink, httpLogFile(group), `${lines.join("\n")}\n`);
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

/** 错误双写：既留在所属分组日志保留上下文，也汇总到 cliproxy-error-*.log 便于快速扫描。 */
export function logGatewayError(sink: RequestLogSink | undefined, group: string, entry: ErrorEntry): void {
  if (!sink) return;
  const text = `${errorLines(entry).join("\n")}\n`;
  append(sink, httpLogFile(group), text);
  append(sink, errorLogFile(), text);
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

/** 网关日志备份保留个数：最旧先删；stdout/stderr 两个文件共用 maxBytes，磁盘占用上限约为 2 × (GATEWAY_LOG_BACKUPS + 1) × maxBytes。 */
const GATEWAY_LOG_BACKUPS = 5;

/**
 * 网关进程日志的大小上限：当前文件加上即将写入的字节数超过 maxBytes 时，先把现有内容
 * 复制为 gateway-<毫秒级时间戳>.log 备份，再原地清空原文件。必须用 copy-truncate 而非
 * rename：launchd 只在 spawn 时打开 stdout/stderr，之后不会重开——rename 会让运行中
 * 进程的后续写入全部落进备份（stderr 错误 handler 常驻、运行期持续写），甚至写进已被
 * 裁剪删除的 inode；原地清空保持 inode 不变，O_APPEND 追加不会产生空洞。滚动是每进程
 * 至多一次的低频操作，复制整文件的开销可忽略。
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
    // Rotation must never break the config flow.
  }
}

/**
 * 备份时间戳带毫秒：秒级精度在连续两次滚动时会命中同名备份，rename 静默覆盖丢内容。
 * 滚动都是每进程至多一次的低频操作（进程启动远慢于 1ms），毫秒足以消除碰撞。
 */
function gatewayBackupStamp(at = new Date()): string {
  return `${fileStamp(at)}${pad(at.getMilliseconds(), 3)}`;
}

/** 备份名按目标文件派生（gateway- / gateway.error-）；前缀写死会让非默认文件的裁剪静默失效。 */
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
 * 配置审计：CLI 每次真实改动配置都追加到网关进程日志（gateway.log）；超过 maxBytes 时
 * 先复制备份并原地清空，再写入。条目以日志时间分隔符开头，与网关启动横幅同格式；与请求
 * 日志目录完全解耦——不依赖 requestLogging，也不参与 maxRequestLogs 的分组统计与裁剪。
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
  const text = `${lines.join("\n")}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    capGatewayLog(logFile, maxBytes, Buffer.byteLength(text));
    fs.appendFileSync(logFile, text);
  } catch {
    // Logging must never break the config flow.
  }
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
