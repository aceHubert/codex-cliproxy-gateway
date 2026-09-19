import { createHash, randomUUID } from "node:crypto";
import type { CodebuddyCredential, CodebuddyProfile } from "./credentials.ts";
import { profileProduct, profileRegion } from "./credentials.ts";

/**
 * CLI 与 WorkBuddy 身份头：两套产品使用各自的 UA/IDE 头，鉴权字段共享。
 * 语义对齐 codebuddy2api 的 client_profiles.py；版本号集中在此，单一来源。
 */

/** 伪装的 CLI 版本；与本机 `@tencent-ai/codebuddy-code` 保持一致，目录缓存键也会带上。 */
export const CODEBUDDY_CLI_VERSION = "2.151.0";
export const CODEBUDDY_WORKBUDDY_VERSION = "5.5.2";
export const CODEBUDDY_WORKBUDDY_CLI_VERSION = "2.137.1";

/** OpenAI JS SDK 随请求发送的 x-stainless 系列与通用代理意图头（对齐真实 CLI 流量）。 */
const SDK_HEADERS: Record<string, string> = {
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Linux",
  "x-stainless-package-version": "6.25.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.21.0",
  "X-Agent-Intent": "craft",
  "X-Agent-Purpose": "conversation",
  "X-Agent-Type": "main",
  "X-Private-Data": "false",
  "X-CodeBuddy-Request": "1",
};

function identityHeaders(profile: CodebuddyProfile): Record<string, string> {
  if (profileProduct(profile) === "cli") {
    return {
      "User-Agent": `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": CODEBUDDY_CLI_VERSION,
    };
  }
  const name = profileRegion(profile) === "intl" ? "WorkBuddy AI" : "WorkBuddy";
  return {
    "User-Agent": `WorkBuddy/${CODEBUDDY_WORKBUDDY_VERSION} ${name}/${CODEBUDDY_WORKBUDDY_VERSION} CLI/${CODEBUDDY_WORKBUDDY_CLI_VERSION}`,
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": CODEBUDDY_WORKBUDDY_VERSION,
  };
}

function authHeaders(credential: CodebuddyCredential): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${credential.accessToken}`,
    "X-User-Id": credential.accountUid,
    "X-Enterprise-Id": credential.enterpriseId,
    "X-Tenant-Id": credential.enterpriseId,
    "X-Domain": credential.domain,
    "X-Product": "SaaS",
    "X-Requested-With": "XMLHttpRequest",
    ...identityHeaders(credential.profile),
  };
}

/** 模型请求头：SDK 头 + 鉴权/身份头 + 会话追踪头（不携带 x-client-platform）。 */
export function buildCodebuddyChatHeaders(
  credential: CodebuddyCredential,
  context: CodebuddyRequestContext,
): Headers {
  const headers = new Headers({ ...SDK_HEADERS, ...authHeaders(credential) });
  headers.set("x-conversation-id", context.conversationId);
  headers.set("x-request-id", context.requestId);
  headers.set("x-conversation-message-id", context.requestId);
  headers.set("x-conversation-request-id", context.traceId);
  headers.set("x-root-request-id", context.traceId);
  headers.set("x-trace-id", context.traceId);
  headers.set("traceparent", `00-${context.traceId.replace(/-/g, "")}-${context.spanId}-01`);
  headers.set("b3", `${context.traceId.replace(/-/g, "")}-${context.spanId}-1-${context.parentSpanId}`);
  headers.set("x-b3-traceid", context.traceId.replace(/-/g, ""));
  headers.set("x-b3-spanid", context.spanId);
  headers.set("x-b3-parentspanid", context.parentSpanId);
  headers.set("x-b3-sampled", "1");
  return headers;
}

/**
 * 目录请求头：与模型请求同源，但 CLI profile 必须额外携带 x-client-platform: cli
 * （WorkBuddy profile 严禁携带，否则会选到错误产品的目录）。
 */
export function buildCodebuddyCatalogHeaders(credential: CodebuddyCredential): Headers {
  const headers = new Headers(authHeaders(credential));
  if (profileProduct(credential.profile) === "cli") headers.set("x-client-platform", "cli");
  return headers;
}

export interface CodebuddyRequestContext {
  /** 会话稳定 ID：同一 thread 复用同一 conversation id（上游侧会话归因）。 */
  conversationId: string;
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const DEFAULT_TTL_MS = 900_000;
const DEFAULT_MAX_ENTRIES = 1024;

function headerSessionKey(request: Request): string | undefined {
  for (const name of ["thread-id", "session-id"]) {
    const value = request.headers.get(name);
    if (value) {
      const normalized = value.trim();
      if (normalized.length <= 128 && PRINTABLE_ASCII.test(normalized)) return `${name}:${normalized}`;
    }
  }
  return undefined;
}

/** thread-id → 稳定 conversation id 的会话表（语义对齐 ZCode 的 createZcodeContexts）。 */
export function createCodebuddyContexts(options: {
  now?: () => number;
  uuid?: () => string;
  maxEntries?: number;
  ttlMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? randomUUID;
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
  const scopes = new WeakMap<CodebuddyCredential, string>();
  const sessions = new Map<string, { conversationId: string; expiresAt: number }>();
  let closed = false;

  function scope(credential: CodebuddyCredential): string {
    const cached = scopes.get(credential);
    if (cached) return cached;
    // 摘要只作为内存 Map 的作用域键，不进入请求头或日志。
    const value = createHash("sha256").update(`${credential.profile}\n${credential.accountUid}\n${credential.accessToken}`).digest("hex");
    scopes.set(credential, value);
    return value;
  }
  function purge(time: number): void {
    for (const [key, value] of sessions) if (value.expiresAt <= time) sessions.delete(key);
    while (sessions.size > maxEntries) sessions.delete(sessions.keys().next().value!);
  }

  return {
    resolve(request: Request, credential: CodebuddyCredential): CodebuddyRequestContext {
      if (closed) throw new Error("CodeBuddy 请求上下文已关闭");
      const time = now();
      purge(time);
      const incoming = headerSessionKey(request);
      let conversationId = uuid();
      if (incoming) {
        const key = `${scope(credential)}\n${incoming}`;
        const existing = sessions.get(key);
        if (existing && existing.expiresAt > time) {
          conversationId = existing.conversationId;
          existing.expiresAt = time + ttlMs;
          sessions.delete(key);
          sessions.set(key, existing);
        } else {
          sessions.set(key, { conversationId, expiresAt: time + ttlMs });
          purge(time);
        }
      }
      return {
        conversationId,
        requestId: uuid(),
        traceId: uuid(),
        spanId: uuid().replaceAll("-", "").slice(0, 16),
        parentSpanId: uuid().replaceAll("-", "").slice(0, 16),
      };
    },
    close(): void { closed = true; sessions.clear(); },
  };
}

/** 目录缓存键的版本修订部分：cli 与 work 各自的包版本组合。 */
export function catalogRevision(profile: CodebuddyProfile): string {
  return profileProduct(profile) === "cli"
    ? CODEBUDDY_CLI_VERSION
    : `${CODEBUDDY_WORKBUDDY_VERSION}:${CODEBUDDY_WORKBUDDY_CLI_VERSION}`;
}
