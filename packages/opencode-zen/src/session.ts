import { createHash, randomBytes } from "node:crypto";

/**
 * OpenCode Zen 会话标识引擎。
 *
 * Zen 免费层服务端强校验 `x-opencode-session` / `x-opencode-session-id`（2026-10-15 起
 * 硬性）：必须是 `ses_` + 12 位降序十六进制时间戳段 + 14 位 Base62 随机串（共 30 字符，
 * 见调研文档 §3.2 的 Identifier.descending 逆向）。**时间戳段会被解码校验**：摘要哈希
 * 直接当前缀的 id 一律 403（dsh 同类插件同结论），counter 位（低 12 位）必须为官方
 * 形状（counter=1 → hex 以 `ffe` 结尾）。本模块负责三件事：
 * 1. `createOpenCodeSessionId`：铸无外部会话时的单次合规 session id；
 * 2. `deriveOpenCodeSessionId`：从外部会话 id（agent/IDE 的 conversation id）**确定性
 *    派生**合规 session id——同一会话跨请求、跨进程重启永远得到同一个 id（Zen 按会话
 *    计量免费额度并按它路由 prompt cache，会话稳定即缓存亲和稳定）；
 * 3. `resolveOpenCodeSession`：标头判定优先级——入站已带合法 `x-opencode-session`
 *    则原样透传；否则取外部会话标头（`x-session-id` / `session-id` / `thread-id`，
 *    Codex 实发 `session-id`）确定性派生；都没有时生成单次临时 session。
 */

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK_48 = 0xffffffffffffn;
/** 后 14 位随机串的长度；与 OpenCode Identifier.descending 的结构一致。 */
const RANDOM_SUFFIX_LENGTH = 14;

/** OpenCode 会话 id 的完整格式（服务端按此校验，不合规直接 403 FreeTierError）。 */
export const OPENCODE_SESSION_PATTERN = /^ses_[0-9A-Za-z]{26}$/;

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

/**
 * 从外部会话 id（agent/IDE 的 conversation id）确定性派生合规 session id：
 * 时间段取 SHA-256(外部 id) 的高 36 位，counter 位固定 1（官方形状，hex 以 `ffe`
 * 结尾——服务端解码校验时间段结构，2026-10-15 实测 counter 位随机的哈希前缀一律
 * 403、固定官方形状的派生 id 3/3 过闸）；后缀由同一摘要派生。同一外部会话跨请求、
 * 跨进程重启永远得到同一 id——Zen 按会话计量免费额度并按它路由 prompt cache，
 * 确定性派生使会话粘性不依赖任何进程内状态或磁盘持久化。
 */
export function deriveOpenCodeSessionId(external: string): string {
  const digest = createHash("sha256").update(`codex-cliproxy-gateway:session:${external}`).digest();
  const msBits = (BigInt(`0x${digest.subarray(0, 6).toString("hex")}`) >> 12n) & ((1n << 36n) - 1n);
  const hexPart = (MASK_48 - ((msBits << 12n) | 1n)).toString(16).padStart(12, "0");
  return `ses_${hexPart}${base62FromBytes(digest.subarray(6, 6 + RANDOM_SUFFIX_LENGTH))}`;
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
   * 标头判定优先级：合法 `x-opencode-session` 原样透传（不转换）→ 外部会话标头
   * （`x-session-id` / `session-id` / `thread-id`，Codex 实发 `session-id`）确定性
   * 派生 → 都没有时生成单次临时合规 session。
   */
  resolve(headers: HeaderSource): string;
}

/**
 * 外部会话标头取值（按优先级）：`x-session-id`（既有契约）→ `session-id`（Codex
 * 实发）→ `thread-id`（Codex 同值附带；fork 线程下仅此头在场时仍可稳定派生）。
 */
function externalSessionId(headers: HeaderSource): string | undefined {
  return headerValue(headers, "x-session-id")
    ?? headerValue(headers, "session-id")
    ?? headerValue(headers, "thread-id");
}

export function createOpenCodeSessionResolver(
  options: { now?: () => number } = {},
): OpenCodeSessionResolver {
  const now = options.now ?? Date.now;
  return {
    resolve(headers: HeaderSource): string {
      const inbound = headerValue(headers, "x-opencode-session");
      if (inbound && OPENCODE_SESSION_PATTERN.test(inbound)) return inbound;
      const external = externalSessionId(headers);
      if (external) return deriveOpenCodeSessionId(external);
      return createOpenCodeSessionId(now());
    },
  };
}
