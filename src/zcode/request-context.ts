import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import type { ZcodeProviderSnapshot } from "./config.ts";

export type ZcodePlan = "coding-plan" | "start-plan" | "api-key";

export interface ZcodeIdentity {
  appVersion: string;
  language: string;
  timezone: string;
  platform: string;
  arch: string;
  osVersion: string;
}

export interface ZcodeRequestContext {
  requestId: string;
  traceId: string;
  queryId: string;
  sessionId: string;
  sessionType: "main" | "subagent" | "other";
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const DEFAULT_TTL_MS = 900_000;
const DEFAULT_MAX_ENTRIES = 1024;

function printable(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized && PRINTABLE_ASCII.test(normalized) ? normalized : fallback;
}

function readIdentity(): ZcodeIdentity {
  let appVersion = "unknown";
  if (process.platform === "darwin") {
    try {
      appVersion = printable(execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "/Applications/ZCode.app/Contents/Info.plist"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000,
      }));
    } catch { /* 未安装或不可读取时保持无凭据的 unknown。 */ }
  }
  let language = "unknown";
  let timezone = "unknown";
  try { language = printable(Intl.DateTimeFormat().resolvedOptions().locale); } catch { /* 保持 unknown。 */ }
  try { timezone = printable(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { /* 保持 unknown。 */ }
  return Object.freeze({
    appVersion,
    language,
    timezone,
    platform: printable(process.platform),
    arch: printable(os.arch()),
    osVersion: printable(os.release()),
  });
}

// 首次启用时读取公开版本；关闭 ZCode 的命令不执行额外系统查询。
let identityCache: ZcodeIdentity | undefined;

export function readZcodeIdentity(): ZcodeIdentity {
  return { ...(identityCache ??= readIdentity()) };
}

export function zcodePlan(snapshot: ZcodeProviderSnapshot): ZcodePlan {
  if (snapshot.plan === "start-plan") return "start-plan";
  if (snapshot.plan === "api-key") return "api-key";
  return "coding-plan";
}

function osCategory(platform: string): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform === "unknown" ? "unknown" : "linux";
}

/** 构建完全由网关控制的来源头；不接受入站请求覆盖。 */
export function buildZcodeSourceHeaders(identity: ZcodeIdentity): Headers {
  const appVersion = printable(identity.appVersion);
  const platform = printable(identity.platform);
  const headers = new Headers({
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": `ZCode/${appVersion} ai-sdk/anthropic/3.0.81`,
    "X-Title": "Z Code@cli",
    "X-Release-Channel": "production",
    "X-Client-Language": printable(identity.language),
    "X-Client-Timezone": printable(identity.timezone),
    "X-Platform": `${platform}-${printable(identity.arch)}`,
    "X-Os-Category": osCategory(platform),
    "X-Os-Version": printable(identity.osVersion),
  });
  if (appVersion !== "unknown") headers.set("X-ZCode-App-Version", appVersion);
  headers.set("X-ZCode-Agent", "glm");
  return headers;
}

/** 模型请求所需的协议、归因和套餐鉴权头。 */
export function buildZcodeModelHeaders(
  identity: ZcodeIdentity,
  context: ZcodeRequestContext,
  plan: ZcodePlan,
  apiKey: string,
): Headers {
  const headers = buildZcodeSourceHeaders(identity);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  headers.set("anthropic-version", "2023-06-01");
  headers.set("x-request-id", context.requestId);
  headers.set("x-zcode-session-type", context.sessionType);
  headers.set("x-zcode-trace-id", context.traceId);
  headers.set("x-query-id", context.queryId);
  headers.set("x-session-id", context.sessionId);
  headers.set("authorization", `Bearer ${apiKey}`);
  if (plan !== "start-plan") headers.set("x-api-key", apiKey);
  return headers;
}

function headerSessionKey(request: Request): string | undefined {
  for (const name of ["thread-id", "session-id"]) {
    const value = request.headers.get(name);
    if (value) {
      const normalized = value.trim();
      if (normalized.length <= 128 && PRINTABLE_ASCII.test(normalized)) return `${name}:${normalized}`;
    }
  }
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 只处理已转换的 Anthropic body：移除非 system 的旧标记，并在最后一个可
 * 缓存内容块写入临时标记。thinking/redacted_thinking 永远不作为标记目标。
 */
export function decorateZcodeBody(body: Record<string, unknown>, context: ZcodeRequestContext): Record<string, unknown> {
  const result = clone(body) as Record<string, unknown>;
  const messages = result.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!record(message) || message.role === "system" || !Array.isArray(message.content)) continue;
      for (const block of message.content) if (record(block)) delete block.cache_control;
    }
    outer: for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!record(message) || message.role === "system" || !Array.isArray(message.content)) continue;
      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = message.content[blockIndex];
        if (!record(block) || block.type === "thinking" || block.type === "redacted_thinking") continue;
        block.cache_control = { type: "ephemeral" };
        break outer;
      }
    }
  }
  result.metadata = {
    ...(record(result.metadata) ? result.metadata : {}),
    user_id: JSON.stringify({ account_uuid: "", session_id: context.sessionId }),
  };
  return result;
}

export function createZcodeContexts(options: {
  now?: () => number;
  uuid?: () => string;
  maxEntries?: number;
  ttlMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? randomUUID;
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
  const scopes = new WeakMap<ZcodeProviderSnapshot, string>();
  const sessions = new Map<string, { sessionId: string; expiresAt: number }>();
  let closed = false;

  function scope(snapshot: ZcodeProviderSnapshot): string {
    const cached = scopes.get(snapshot);
    if (cached) return cached;
    // 摘要只作为内存 Map 的不可逆作用域，不进入返回值、请求头或日志。
    const value = createHash("sha256").update(`${snapshot.family}\n${snapshot.providerID}\n${snapshot.apiKey}`).digest("hex");
    scopes.set(snapshot, value);
    return value;
  }
  function purge(time: number): void {
    for (const [key, value] of sessions) if (value.expiresAt <= time) sessions.delete(key);
    while (sessions.size > maxEntries) sessions.delete(sessions.keys().next().value!);
  }

  return {
    resolve(request: Request, snapshot: ZcodeProviderSnapshot): ZcodeRequestContext {
      if (closed) throw new Error("ZCode 请求上下文已关闭");
      const time = now();
      purge(time);
      const incoming = headerSessionKey(request);
      let sessionId: string;
      if (incoming) {
        const key = `${scope(snapshot)}\n${incoming}`;
        const existing = sessions.get(key);
        if (existing && existing.expiresAt > time) {
          sessionId = existing.sessionId;
          existing.expiresAt = time + ttlMs;
          sessions.delete(key);
          sessions.set(key, existing);
        } else {
          sessionId = uuid();
          sessions.set(key, { sessionId, expiresAt: time + ttlMs });
          purge(time);
        }
      } else sessionId = uuid();
      const parent = request.headers.get("x-codex-parent-thread-id")?.trim();
      const subagent = Boolean(parent && parent.length <= 128 && PRINTABLE_ASCII.test(parent));
      return {
        requestId: uuid(), traceId: uuid(), queryId: uuid(), sessionId,
        sessionType: subagent ? "subagent" : incoming ? "main" : "other",
      };
    },
    close(): void { closed = true; sessions.clear(); },
  };
}
