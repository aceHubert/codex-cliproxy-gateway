import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const LEGACY_PREFIX = "enc:v1:";
const ENCRYPTED_PREFIX = "enc:v2:";
const CIPHER_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const require = createRequire(import.meta.url);

/** 仅携带本模块生成的安全错误，调用方可向用户报告并终止鉴权。 */
export class ZcodeCredentialError extends Error {}

type SystemKeyCache = Map<string, Buffer | ZcodeCredentialError>;
const systemKeys: SystemKeyCache = new Map();
// 注入读取器的生命周期与生产缓存隔离，测试不会污染真实系统条目。
const injectedSystemKeys = new WeakMap<NonNullable<ZcodeCredentialCipherDependencies["readSystemKey"]>, SystemKeyCache>();

function invalid(message: string): never {
  throw new ZcodeCredentialError(message);
}

export interface ZcodeCredentialCipherDependencies {
  filePath?: string;
  platform?: NodeJS.Platform;
  /** 测试只注入模拟的系统密钥，不访问真实凭据存储。 */
  readSystemKey?: (service: string, account: string) => string;
}

/** 根目录优先，只允许文件缺失时回退 v2，错误由读取路径明确上报。 */
export function resolveZcodeCredentialPath(home: string): string {
  const root = path.join(path.resolve(home), "credentials.json");
  try { fs.lstatSync(root); return root; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(path.resolve(home), "v2", "credentials.json");
  }
}

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function legacyKeys(env: NodeJS.ProcessEnv): Buffer[] {
  let username = "unknown";
  try { username = os.userInfo().username; } catch { /* 与 ZCode 保持一致，失败时使用 unknown。 */ }
  const fallback = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
  return [...new Set([env.ZCODE_CREDENTIAL_SECRET || fallback,
    env.ZCODE_CREDENTIAL_SECRET?.trim() || fallback, fallback])].map(digest);
}

function decryptPayload(value: string, key: Buffer): string {
  const parts = value.split(".");
  const [iv, authTag, ciphertext] = parts;
  if (parts.length !== 3 || !iv || !authTag || ciphertext === undefined
    || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) invalid("ZCode 凭据密文格式无效");
  const ivBuffer = Buffer.from(iv, "base64url");
  const authTagBuffer = Buffer.from(authTag, "base64url");
  const ciphertextBuffer = Buffer.from(ciphertext, "base64url");
  if (ivBuffer.length !== IV_LENGTH) invalid("ZCode 凭据 IV 无效");
  if (authTagBuffer.length !== AUTH_TAG_LENGTH) invalid("ZCode 凭据认证标签无效");
  const decipher = createDecipheriv(
    CIPHER_ALGORITHM,
    key,
    ivBuffer,
  );
  decipher.setAuthTag(authTagBuffer);
  try {
    return Buffer.concat([decipher.update(ciphertextBuffer), decipher.final()]).toString("utf8");
  } catch {
    invalid("ZCode 凭据解密失败；请核对本地凭据与解密密钥，修复后重启网关");
  }
}

function unavailable(): never {
  invalid("无法读取 ZCode 系统凭据密钥；请解锁系统凭据存储并重启网关，Linux 需启动 Secret Service；无桌面环境可在 ZCode 与网关同时配置 ZCODE_CREDENTIAL_SECRET 或 ZCODE_CREDENTIAL_SECRET_FILE，再在 ZCode 中重新登录");
}

function managedSecret(env: NodeJS.ProcessEnv, filePath: string, implicit = false): string | undefined {
  if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) {
    invalid("ZCODE_CREDENTIAL_SECRET 与 ZCODE_CREDENTIAL_SECRET_FILE 不能同时设置");
  }
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  const explicit = env.ZCODE_CREDENTIAL_SECRET_FILE;
  if (!explicit && !implicit) return undefined;
  const secretFile = explicit || path.join(path.dirname(filePath), "credential-secret");
  try {
    const stat = fs.statSync(secretFile);
    if (!stat.isFile() || !explicit && process.platform !== "win32" && (stat.mode & 0o77) !== 0) unavailable();
    const text = fs.readFileSync(secretFile, "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes < 32 || bytes > 4096) unavailable();
    return text;
  } catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    unavailable();
  }
}

function loadSystemKey(filePath: string, dependencies: ZcodeCredentialCipherDependencies): Buffer {
  const service = "ZCode Credential Encryption";
  const account = digest(path.resolve(filePath)).toString("hex");
  try {
    let encoded: string;
    if (dependencies.readSystemKey) encoded = dependencies.readSystemKey(service, account);
    else {
      if ((dependencies.platform ?? process.platform) === "darwin") {
        encoded = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
          encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } else {
        // 与官方客户端相同的系统后端，Linux 禁止回退到重启即失效的 keyutils。
        const keyring = require("@napi-rs/keyring") as {
          Entry: new (service: string, account: string, options: { linux: { store: string } }) => { getPassword(): string | null };
        };
        const password = new keyring.Entry(service, account, { linux: { store: "secret-service" } }).getPassword();
        if (password === null) unavailable();
        encoded = password;
      }
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) unavailable();
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32) unavailable();
    return key;
  } catch { unavailable(); }
}

/** 系统条目按进程缓存；解密失败时允许调用方显式刷新一次。 */
function systemKey(filePath: string, dependencies: ZcodeCredentialCipherDependencies, refresh = false): Buffer {
  let cache = systemKeys;
  if (dependencies.readSystemKey) {
    cache = injectedSystemKeys.get(dependencies.readSystemKey) ?? new Map();
    injectedSystemKeys.set(dependencies.readSystemKey, cache);
  }
  const identity = `${dependencies.platform ?? process.platform}:${path.resolve(filePath)}`;
  if (refresh) {
    const current = loadSystemKey(filePath, dependencies);
    cache.set(identity, current);
    return current;
  }
  let cached = cache.get(identity);
  if (!cached) {
    try { cached = loadSystemKey(filePath, dependencies); }
    catch (error) {
      // loadSystemKey 已将系统异常转换为不含密钥材料的固定错误。
      if (!(error instanceof ZcodeCredentialError)) throw error;
      cached = error;
    }
    cache.set(identity, cached);
  }
  if (cached instanceof ZcodeCredentialError) throw cached;
  return cached;
}

/** 复刻官方 v1/v2 只读解密，不执行凭据迁移、密钥创建或权限变更。 */
export function decryptZcodeCredential(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ZcodeCredentialCipherDependencies = {},
): string {
  if (value.startsWith(LEGACY_PREFIX)) {
    for (const key of legacyKeys(env)) {
      try { return decryptPayload(value.slice(LEGACY_PREFIX.length), key); }
      catch { /* 官方迁移期间依次尝试显式、去空白与机器派生密钥。 */ }
    }
    invalid("ZCode 凭据解密失败");
  }
  if (!value.startsWith(ENCRYPTED_PREFIX)) {
    if (value.startsWith("enc:")) invalid("ZCode 凭据加密版本暂不支持；请更新网关");
    return value;
  }
  const [source, fingerprint, payload, extra] = value.slice(ENCRYPTED_PREFIX.length).split(":");
  if (extra !== undefined || !["os", "env"].includes(source) || !/^[a-f0-9]{24}$/.test(fingerprint ?? "") || !payload) {
    invalid("ZCode 凭据密文格式无效");
  }
  const filePath = path.resolve(dependencies.filePath ?? path.join(env.ZCODE_DATA_BASE_DIR || os.homedir(), ".zcode", "v2", "credentials.json"));
  let key: Buffer;
  let actualSource: "os" | "env";
  let secret = managedSecret(env, filePath);
  if (secret === undefined) {
    let marker: string | undefined;
    try { marker = fs.readFileSync(path.join(path.dirname(filePath), "credential-source"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unavailable(); }
    if (marker !== undefined && marker !== "os\n") unavailable();
    if (marker === undefined && source !== "os") secret = managedSecret({}, filePath, true);
  }
  if (secret === undefined && source === "env") unavailable();
  if (secret === undefined) { actualSource = "os"; key = systemKey(filePath, dependencies); }
  else { actualSource = "env"; key = digest(secret); }
  if (source !== actualSource) {
    invalid("ZCode 凭据解密密钥来源或指纹不匹配；请核对本地凭据与解密密钥，修复后重启网关");
  }
  const decrypt = (candidate: Buffer): string => {
    if (digest(candidate).toString("hex").slice(0, 24) !== fingerprint) {
      invalid("ZCode 凭据解密密钥指纹不匹配；请核对本地凭据与解密密钥，修复后重启网关");
    }
    return decryptPayload(payload, candidate);
  };
  try { return decrypt(key); }
  catch (error) {
    if (actualSource !== "os" || !(error instanceof ZcodeCredentialError)) throw error;
    // 仅失败路径重新读取。密钥未变时保留原错误，更新后也只重试一次。
    const current = systemKey(filePath, dependencies, true);
    if (current.equals(key)) throw error;
    return decrypt(current);
  }
}
