/**
 * ZCode Client Request Signing（coding plan 官方客户端签名）。
 *
 * 官方客户端对 coding plan 且官方域名的模型请求会附加一组逐请求签名头
 * （X-App-Id/X-Client-Ts/X-Client-Version/X-Client-Sig/X-Client-Nonce/X-Client-Pow），
 * 服务端据此把流量归因为官方 ZCode 客户端。签名身份通过握手建立：客户端用
 * `{id}.{secret}` 形态的业务 key 派生 HKDF 密钥，向上游换取一份用该密钥加密的
 * Ed25519 私钥，再对每个请求的时间戳/随机数做 Ed25519 签名与轻量 PoW。
 *
 * 本模块逐字节复刻该协议，全部输入来自网关已持有的业务 key；任何一步失败都
 * fail-open：不加签名头，请求按未签名继续发送（与官方客户端 VERIFY_* 重试耗尽
 * 后的 bypass 行为一致），绝不阻塞或断流。
 */
import { createHash } from "node:crypto";

const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const HANDSHAKE_ACTION = "get_sign_key";
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const HMAC_INFO = "getSignKey_hmac";
const PRIVATE_KEY_INFO = "ed25519_priv";
const APP_ID = "zcode";
const POW_BITS = 8;
const NONCE_BYTES = 16;
const POW_SALT_BYTES = 12;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_KEY_ENTRIES = 32;
const VERIFY_SIGNATURE_INVALID = "VERIFY_SIGNATURE_INVALID";
const VERIFY_APIKEY_EXPIRED = "VERIFY_APIKEY_EXPIRED";

/** 业务 key 必须是恰好一个点分隔的 `{id}.{secret}`；账号 JWT（两个点）不适用。 */
export function parseClientSigningCredential(apiKey: string): { apiKeyId: string; apiKeySecret: string } | undefined {
  const separator = apiKey.indexOf(".");
  if (separator <= 0 || separator !== apiKey.lastIndexOf(".")) return undefined;
  if (!apiKey.slice(0, separator).trim() || !apiKey.slice(separator + 1).trim()) return undefined;
  return { apiKeyId: apiKey.slice(0, separator), apiKeySecret: apiKey.slice(separator + 1) };
}

/** 本地 TS 库把 TextEncoder 结果声明为 ArrayBufferLike；WebCrypto 形参需要 ArrayBuffer。 */
function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("invalid base64");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** HKDF-SHA-256(ikm=secret, salt=固定盐, info, 32 字节)；与官方客户端的派生参数一致。 */
async function deriveBytes(secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encodeUtf8(KDF_SALT), info: encodeUtf8(info) }, key, 256,
  ));
}

function leadingZeroBits(hash: Uint8Array): number {
  let total = 0;
  for (const byte of hash) {
    if (byte === 0) {
      total += 8;
      continue;
    }
    let prefix = 0;
    for (let mask = 0x80; mask > 0 && !(byte & mask); mask >>= 1) prefix += 1;
    return total + prefix;
  }
  return total;
}

/** PoW：对 `id\nappId\nsessionId\nts` 的 SHA-256 hex 前缀找 8 个前导零比特。 */
export function solveClientRequestPow(input: { apiKeyId: string; sessionId: string; ts: string }, bits = POW_BITS): string {
  const prefix = createHash("sha256")
    .update(`${input.apiKeyId}\n${APP_ID}\n${input.sessionId}\n${input.ts}`)
    .digest("hex")
    .slice(0, 32);
  const salt = randomHex(POW_SALT_BYTES);
  for (let counter = 0; counter <= 0xffffffff; counter += 1) {
    const candidate = `${salt}${counter.toString(16).padStart(8, "0")}`;
    const digest = createHash("sha256").update(`${prefix}\n${candidate}`).digest();
    if (leadingZeroBits(digest) >= bits) return candidate;
  }
  throw new Error("Unable to solve client request proof of work");
}

/** 401 响应正文中的可刷新签名拒绝原因；与官方客户端同序检查 msg/data.reason/error.*。 */
export function clientSigningVerifyRejection(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const envelope = parsed as { msg?: unknown; data?: unknown; error?: unknown };
  const reasonOf = (value: unknown): { reason?: unknown; message?: unknown } => (
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { reason?: unknown; message?: unknown }) : {}
  );
  const data = reasonOf(envelope.data);
  const error = reasonOf(envelope.error);
  for (const candidate of [envelope.msg, data.reason, error.reason, error.message]) {
    if (candidate === VERIFY_SIGNATURE_INVALID || candidate === VERIFY_APIKEY_EXPIRED) return candidate;
  }
  return undefined;
}

export interface ZcodeClientSigningOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  randomHex?: (bytes: number) => string;
  handshakeTimeoutMs?: number;
  failureCooldownMs?: number;
}

export interface ZcodeClientSigningScope {
  apiKey: string;
  /** provider baseURL；握手 origin 与缓存键取自它（签名发生在端点重映射之前）。 */
  baseUrl: string;
  clientVersion: string;
  sessionId: string;
}

interface HandshakeEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: { privateCipher?: unknown };
}

export class ZcodeClientSigning {
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly randomHexImpl: (bytes: number) => string;
  private readonly handshakeTimeoutMs: number;
  private readonly failureCooldownMs: number;
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  private readonly retryAfter = new Map<string, number>();

  constructor(options: ZcodeClientSigningOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.randomHexImpl = options.randomHex ?? randomHex;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.failureCooldownMs = options.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
  }

  /**
   * 就地补齐一个请求的签名头；返回是否签名成功。除缺少必要输入外，任何失败
   * （网络、协议、密码学）都返回 false 并保持原头不动，由调用方按未签名继续。
   */
  async decorate(headers: Headers, scope: ZcodeClientSigningScope): Promise<boolean> {
    try {
      const credential = parseClientSigningCredential(scope.apiKey);
      if (!credential || !scope.clientVersion || !scope.sessionId) return false;
      const origin = new URL(scope.baseUrl).origin;
      const cacheKey = `${scope.apiKey}\n${origin}`;
      if ((this.retryAfter.get(cacheKey) ?? 0) > this.now()) return false;
      const privateKey = await (this.keys.get(cacheKey)
        ?? this.beginHandshake(cacheKey, { ...credential, apiKey: scope.apiKey }, origin));
      const ts = String(this.now());
      const nonce = this.randomHexImpl(NONCE_BYTES);
      const pow = solveClientRequestPow({ apiKeyId: credential.apiKeyId, sessionId: scope.sessionId, ts });
      const message = `${credential.apiKeyId}\n${ts}\n${scope.clientVersion}\n${scope.sessionId}\n${nonce}`;
      const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encodeUtf8(message))));
      headers.set("X-Client-Ts", ts);
      headers.set("X-Client-Version", scope.clientVersion);
      headers.set("X-Client-Sig", signature);
      headers.set("X-Session-Id", scope.sessionId);
      headers.set("X-Client-Nonce", nonce);
      headers.set("X-App-Id", APP_ID);
      headers.set("X-Client-Pow", pow);
      return true;
    } catch {
      return false;
    }
  }

  /** 服务端拒绝（VERIFY_*）或密钥疑似轮换后作废缓存；下一次 decorate 重新握手。 */
  invalidate(apiKey: string, baseUrl: string): void {
    try {
      const cacheKey = `${apiKey}\n${new URL(baseUrl).origin}`;
      this.keys.delete(cacheKey);
      this.retryAfter.delete(cacheKey);
    } catch { /* 无效 baseUrl 视为无可作废的缓存。 */ }
  }

  private beginHandshake(cacheKey: string, credential: { apiKeyId: string; apiKeySecret: string; apiKey: string }, origin: string): Promise<CryptoKey> {
    const promise = this.handshake(credential, origin).catch((error: unknown) => {
      this.keys.delete(cacheKey);
      // 失败不缓存结果，但短冷却避免上游故障时每个模型请求都打一次握手。
      this.retryAfter.set(cacheKey, this.now() + this.failureCooldownMs);
      throw error;
    });
    this.keys.set(cacheKey, promise);
    while (this.keys.size > MAX_KEY_ENTRIES) this.keys.delete(this.keys.keys().next().value!);
    return promise;
  }

  private async handshake(credential: { apiKeyId: string; apiKeySecret: string; apiKey: string }, origin: string): Promise<CryptoKey> {
    const ts = String(this.now());
    const nonce = this.randomHexImpl(NONCE_BYTES);
    const hmacKey = await crypto.subtle.importKey(
      "raw", await deriveBytes(credential.apiKeySecret, HMAC_INFO), { hash: "SHA-256", name: "HMAC" }, false, ["sign"],
    );
    const sig = bytesToBase64(new Uint8Array(await crypto.subtle.sign(
      "HMAC", hmacKey, encodeUtf8(`${HANDSHAKE_ACTION}\n${credential.apiKeyId}\n${ts}\n${nonce}`),
    )));
    const response = await this.fetchImpl(`${origin}${HANDSHAKE_PATH}`, {
      method: "POST",
      headers: { Authorization: credential.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: credential.apiKey, nonce, sig, ts }),
      redirect: "manual",
      signal: AbortSignal.timeout(this.handshakeTimeoutMs),
    });
    const envelope = await response.json() as HandshakeEnvelope | null;
    if (!response.ok || !envelope || typeof envelope !== "object") throw new Error("client signing handshake protocol error");
    if (envelope.code === 500) throw new Error("client signing handshake server error");
    if (envelope.code !== 200) throw new Error(`client signing handshake rejected: ${String(envelope.msg ?? "")}`);
    const cipher = typeof envelope.data?.privateCipher === "string" ? envelope.data.privateCipher : "";
    if (!cipher) throw new Error("client signing handshake omitted privateCipher");
    return decryptSigningPrivateKey(credential, cipher);
  }
}

/** privateCipher = base64([12 字节 IV | AES-GCM(密文+tag)])；明文是 pkcs8 的 base64 字符串。 */
async function decryptSigningPrivateKey(credential: { apiKeyId: string; apiKeySecret: string }, privateCipher: string): Promise<CryptoKey> {
  const cipher = base64ToBytes(privateCipher);
  if (cipher.byteLength <= 12 + 16) throw new Error("privateCipher is too short");
  const aesKey = await crypto.subtle.importKey("raw", await deriveBytes(credential.apiKeySecret, PRIVATE_KEY_INFO), "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: cipher.slice(0, 12), additionalData: encodeUtf8(credential.apiKeyId), tagLength: 128 },
    aesKey,
    cipher.slice(12),
  ));
  const pkcs8 = base64ToBytes(new TextDecoder().decode(plaintext));
  return crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
}
