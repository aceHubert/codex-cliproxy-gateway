import { createHash, randomBytes } from "node:crypto";

/**
 * OpenCode Zen 会话标识引擎。
 *
 * Zen 免费层服务端强校验 `x-opencode-session`：必须是 `ses_` + 12 位降序十六进制
 * 时间戳 + 14 位 Base62 随机串（共 30 字符，见调研文档 §3.2 的 Identifier.descending
 * 逆向）。本模块负责三件事：
 * 1. `createOpenCodeSessionId`：生成合规的 session id（支持 seed 确定性生成）；
 * 2. `SessionBindingCache`：外部 `X-Session-Id` → Zen session 的 LRU 绑定表，
 *    TTL 24 小时滑动续期，避免每请求新建会话被服务端限流；
 * 3. `resolveOpenCodeSession`：标头判定优先级——入站已带合法 `x-opencode-session`
 *    则原样透传；否则有 `X-Session-Id` 时经绑定表转换；都没有时生成单次临时 session。
 */

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK_48 = 0xffffffffffffn;
/** 后 14 位随机串的长度；与 OpenCode Identifier.descending 的结构一致。 */
const RANDOM_SUFFIX_LENGTH = 14;

/** OpenCode 会话 id 的完整格式（服务端按此校验，不合规直接 403 FreeTierError）。 */
export const OPENCODE_SESSION_PATTERN = /^ses_[0-9A-Za-z]{26}$/;

/** 绑定表默认 TTL：24 小时滑动续期（活跃请求每次续满）。 */
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** 绑定表默认容量：超出按最久未使用淘汰，防内存无界增长。 */
const DEFAULT_MAX_BOUND_SESSIONS = 512;

function base62FromBytes(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += BASE62_CHARS[byte % BASE62_CHARS.length];
  return value;
}

/**
 * 生成合规的 OpenCode session id：`ses_` + 12 位降序 Hex + 14 位 Base62。
 * 时间段与官方客户端（`Identifier.descending`，自 opencode2 二进制逆向核验）逐位一致：
 * `r = timestampMs * 0x1000 + counter`（counter 为同毫秒自增序号，从 1 起），
 * 降序 Hex 取 `~r` 的高 48 位，即 `0xffffffffffff - (r & 0xffffffffffff)`。
 * 传入 seed 时后缀由 SHA-256(seed) 派生（确定性），否则用密码学随机源。
 */
export function createOpenCodeSessionId(timestampMs = Date.now(), seed?: string): string {
  const r = (BigInt(Math.trunc(timestampMs)) * 0x1000n + 1n) & MASK_48;
  const hexPart = (MASK_48 - r).toString(16).padStart(12, "0");
  const suffix = seed !== undefined
    ? base62FromBytes(createHash("sha256").update(seed).digest().subarray(0, RANDOM_SUFFIX_LENGTH))
    : base62FromBytes(randomBytes(RANDOM_SUFFIX_LENGTH));
  return `ses_${hexPart}${suffix}`;
}

/**
 * 反解 session id 的生成时间（毫秒）。官方算法把时间戳左移 12 位再截 48 位，
 * 因此对 2026 年量级的时间戳只能还原出 `timestampMs mod 2^36`（与官方客户端一致
 * 的回绕语义）；格式非法或 counter 位为 0（官方从 1 自增）返回 undefined。
 */
export function decodeOpenCodeSessionTimestamp(sessionId: string): number | undefined {
  if (!OPENCODE_SESSION_PATTERN.test(sessionId)) return undefined;
  const hexPart = sessionId.slice(4, 16);
  if (!/^[0-9a-fA-F]{12}$/.test(hexPart)) return undefined;
  const inverted = BigInt(`0x${hexPart}`);
  if (inverted <= 0n || inverted > MASK_48) return undefined;
  const r = MASK_48 - inverted;
  if ((r & 0xfffn) === 0n) return undefined;
  return Number(r >> 12n);
}

export interface SessionBindingCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface SessionBindingCache {
  /** 取外部会话对应的 Zen session；未绑定时生成并写入绑定。 */
  resolve(externalSessionId: string): string;
  /** 当前有效绑定数（测试用）。 */
  size(): number;
  clear(): void;
}

interface BoundSession {
  openCodeSession: string;
  expireAt: number;
}

/**
 * 外部 `X-Session-Id` → Zen session 的 LRU 绑定表：Map 插入序即 LRU 序，命中时
 * 删除重插完成 touch 并滑动续期 TTL；写入前清理过期项并在超容量时淘汰最旧项。
 */
export function createSessionBindingCache(options: SessionBindingCacheOptions = {}): SessionBindingCache {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_SESSION_TTL_MS);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_BOUND_SESSIONS);
  const entries = new Map<string, BoundSession>();

  const sweepExpired = (): void => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expireAt <= current) entries.delete(key);
    }
  };

  return {
    resolve(externalSessionId: string): string {
      const current = now();
      const cached = entries.get(externalSessionId);
      if (cached && cached.expireAt > current) {
        // 活跃请求滑动续期；delete+set 把条目移回 Map 尾部（最近使用）。
        entries.delete(externalSessionId);
        cached.expireAt = current + ttlMs;
        entries.set(externalSessionId, cached);
        return cached.openCodeSession;
      }
      if (cached) entries.delete(externalSessionId);
      sweepExpired();
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      const openCodeSession = createOpenCodeSessionId(current, externalSessionId);
      entries.set(externalSessionId, { openCodeSession, expireAt: current + ttlMs });
      return openCodeSession;
    },
    size(): number {
      sweepExpired();
      return entries.size;
    },
    clear(): void {
      entries.clear();
    },
  };
}

/** 入站标头的两种来源：fetch Headers 或已小写化的 plain object。 */
export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function headerValue(source: HeaderSource, name: string): string | undefined {
  if (source instanceof Headers) return source.get(name) ?? undefined;
  // plain object 的键大小写不定（网关外测试注入与真实抓包都有混合大小写）：按名全扫。
  const target = name.toLowerCase();
  let raw: string | string[] | undefined;
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === target) {
      raw = value;
      break;
    }
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface OpenCodeSessionResolver {
  /**
   * 标头判定优先级：合法 `x-opencode-session` 原样透传（不转换、不进绑定表）→
   * `X-Session-Id` 经绑定表稳定转换 → 都没有时生成单次临时合规 session。
   */
  resolve(headers: HeaderSource): string;
}

export function createOpenCodeSessionResolver(
  cache: SessionBindingCache = createSessionBindingCache(),
  options: { now?: () => number } = {},
): OpenCodeSessionResolver {
  const now = options.now ?? Date.now;
  return {
    resolve(headers: HeaderSource): string {
      const inbound = headerValue(headers, "x-opencode-session");
      if (inbound && OPENCODE_SESSION_PATTERN.test(inbound)) return inbound;
      const external = headerValue(headers, "x-session-id");
      if (external) return cache.resolve(external);
      return createOpenCodeSessionId(now());
    },
  };
}
