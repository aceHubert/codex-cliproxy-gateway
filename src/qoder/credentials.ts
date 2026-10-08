import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { constants, createCipheriv, createDecipheriv, createHash, pbkdf2Sync, publicEncrypt, randomBytes } from "node:crypto";

export type QoderRegion = "intl" | "cn";

/** Web UI 只读展示的当前生效登录来源；每地域只保留实际会被加载的一种客户端。 */
export type QoderActiveSource = "CLI-INTL" | "CLI-CN" | "DESKTOP-INTL" | "DESKTOP-CN";

export const QODER_REGION_LABELS: Record<QoderRegion, string> = { intl: "国际版", cn: "国内版" };

/** Qoder 登录的只读快照；只在模型进程内部使用，禁止进入配置、日志与 UI。 */
export interface QoderCredentials {
  region: QoderRegion;
  /** 凭据来源客户端：决定上游请求的产品标识头（cli → product=cli/5，desktop → product=app/10）。 */
  clientProfile: "cli" | "desktop";
  accountUid: string;
  authDirectory: string;
  identity: string;
  machineId: string;
  organizationId: string;
  organizationTags: string[];
  dataPolicyAgreed: boolean;
  accessToken: string;
  expireTime: number;
  encryptUserInfo: string;
  key: string;
}

export class QoderCredentialError extends Error {}

export interface QoderCredentialOptions {
  region?: QoderRegion;
  configDir?: string;
  /** 桌面版数据目录；null 表示显式禁用桌面回退，缺省按平台与地域解析。 */
  desktopDir?: string | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 毫秒时间戳，用于判断官方凭据是否过期。 */
  now?: number;
  /** 读取 macOS 钥匙串中桌面版 safeStorage 密码；仅供测试注入。 */
  keychainPassword?: (region: QoderRegion) => string | null;
}

/** 国际版默认 ~/.qoder（QODER_CONFIG_DIR），国内版默认 ~/.qoder-cn（QODERCN_CONFIG_DIR）。 */
export function defaultQoderConfigDir(region: QoderRegion = "intl", home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = region === "cn" ? env.QODERCN_CONFIG_DIR?.trim() : env.QODER_CONFIG_DIR?.trim();
  return override || path.join(home, region === "cn" ? ".qoder-cn" : ".qoder");
}

/** 桌面版数据目录（仅 macOS）；认证文件与 CLI 完全独立。 */
export const QODER_DESKTOP_BUNDLES: Record<QoderRegion, string> = {
  intl: "com.qoder.app.stable",
  cn: "com.qodercn.app.stable",
};

const QODER_DESKTOP_KEYCHAIN: Record<QoderRegion, { service: string; account: string }> = {
  intl: { service: "Qoder App Safe Storage", account: "Qoder App Key" },
  cn: { service: "Qoder CN App Safe Storage", account: "Qoder CN App Key" },
};

export function defaultQoderDesktopDir(region: QoderRegion = "intl", home = os.homedir()): string | null {
  if (process.platform !== "darwin") return null;
  return path.join(home, "Library", "Application Support", QODER_DESKTOP_BUNDLES[region]);
}

/** 仅检查 CLI 文件存在性；UI 无需解密或读取登录内容。 */
export function qoderCredentialsPresent(configDir = defaultQoderConfigDir()): boolean {
  try {
    const directory = path.join(configDir, ".auth");
    return ["user", "machine_id"].every((name) => fs.lstatSync(path.join(directory, name)).isFile());
  } catch { return false; }
}

/** 仅检查指定地域的 CLI 登录文件存在性。 */
export function qoderCliCredentialsPresent(region: QoderRegion, configDir?: string, home = os.homedir()): boolean {
  return qoderCredentialsPresent(configDir ?? defaultQoderConfigDir(region, home));
}

/** 仅检查指定地域的桌面版登录文件存在性；desktopDir 为 null 时显式禁用桌面检测。 */
export function qoderDesktopCredentialsPresent(region: QoderRegion, desktopDir?: string | null, home = os.homedir()): boolean {
  const desktop = desktopDir !== undefined ? desktopDir : defaultQoderDesktopDir(region, home);
  if (!desktop) return false;
  try {
    return ["auth.v1.dat", "auth.machine-id"].every((name) => fs.lstatSync(path.join(desktop, name)).isFile());
  } catch { return false; }
}

/** CLI 或桌面版任一登录即视为可用；desktopDir 为 null 时只看 CLI。 */
export function qoderRegionCredentialsPresent(region: QoderRegion, configDir?: string, desktopDir?: string | null, home = os.homedir()): boolean {
  return qoderCliCredentialsPresent(region, configDir, home)
    || qoderDesktopCredentialsPresent(region, desktopDir, home);
}

/**
 * 返回当前实际会被凭据加载器选中的来源。
 * 每个地域独立判断：默认 CLI 优先，CLI 缺失才回退桌面版；
 * QODER_FORCE_DESKTOP 开启时跳过 CLI，只显示桌面版。
 */
export function qoderActiveSources(options: {
  intlConfigDir?: string;
  cnConfigDir?: string;
  intlDesktopDir?: string | null;
  cnDesktopDir?: string | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
} = {}): QoderActiveSource[] {
  const home = options.home ?? os.homedir();
  const forceDesktop = qoderForceDesktop(options.env ?? process.env);
  const sources: QoderActiveSource[] = [];
  for (const region of ["intl", "cn"] as const) {
    const configDir = region === "intl" ? options.intlConfigDir : options.cnConfigDir;
    const desktopDir = region === "intl" ? options.intlDesktopDir : options.cnDesktopDir;
    if (!forceDesktop && qoderCliCredentialsPresent(region, configDir, home)) {
      sources.push(region === "intl" ? "CLI-INTL" : "CLI-CN");
    } else if (qoderDesktopCredentialsPresent(region, desktopDir, home)) {
      sources.push(region === "intl" ? "DESKTOP-INTL" : "DESKTOP-CN");
    }
  }
  return sources;
}

function invalid(directory: string, label: string, reason: string): never {
  throw new QoderCredentialError(`Qoder ${label}登录${reason}（${directory}）；请运行 qoder login 更新登录后重试。网关只读凭据，不会刷新或写回。`);
}

function readFile(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("invalid credential file");
    return fs.readFileSync(fd, "utf8").trim();
  } finally { fs.closeSync(fd); }
}

const RUNTIME_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

function runtimeFields(credential: Pick<QoderCredentials, "accountUid" | "organizationId" | "organizationTags" | "dataPolicyAgreed">): { encryptUserInfo: string; key: string } {
  // 运行时认证只加密身份与组织信息，不把设备 OAuth/refresh token 放进推理签名。
  const bytes = randomBytes(16).reverse();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const aesKey = Buffer.from(bytes.toString("hex").slice(0, 16), "ascii");
  const cipher = createCipheriv("aes-128-cbc", aesKey, aesKey);
  const raw = JSON.stringify({ uid: credential.accountUid, organization_id: credential.organizationId,
    organization_tags: credential.organizationTags, data_policy_agreed: credential.dataPolicyAgreed });
  return {
    encryptUserInfo: Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]).toString("base64"),
    key: publicEncrypt({ key: RUNTIME_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, aesKey).toString("base64"),
  };
}

/** 桌面版 auth.v1.dat 是 Electron safeStorage 的 os_crypt v10 信封：PBKDF2(saltysalt) + AES-CBC(空格 IV)。 */
function decryptDesktopAuth(blob: Buffer, password: string): Record<string, unknown> {
  if (blob.subarray(0, 3).toString("latin1") !== "v10") throw new Error("unsupported envelope");
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString("utf8");
  const value: unknown = JSON.parse(plain);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid auth payload");
  return value as Record<string, unknown>;
}

function readDesktopKeychainPassword(region: QoderRegion): string | null {
  if (process.platform !== "darwin") return null;
  const item = QODER_DESKTOP_KEYCHAIN[region];
  try {
    const output = execFileSync("security", ["find-generic-password", "-s", item.service, "-a", item.account, "-w"],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, encoding: "utf8" });
    const value = output.trim();
    return value ? value : null;
  } catch { return null; }
}

interface DesktopCacheEntry { mtimeMs: number; size: number; expiresAt: number; credential: QoderCredentials }
const desktopCredentialCache = new Map<QoderRegion, DesktopCacheEntry>();

function desktopInvalid(directory: string, label: string, reason: string): never {
  throw new QoderCredentialError(`Qoder ${label}桌面版登录${reason}（${directory}）；请打开 Qoder 桌面版重新登录后重试，或运行 qoder login 使用 CLI 登录。网关只读凭据，不会刷新或写回。`);
}

/**
 * CLI 登录缺失时回退读取桌面版登录。桌面版令牌与 CLI 令牌来自同一账号体系，
 * 对算法网关等价；解密密钥每次从 macOS 钥匙串读取（可能弹出一次授权，选择「始终允许」），
 * 解密结果按文件修改时间缓存在进程内存，凭据不落盘、不写回。
 */
async function loadDesktopQoderCredentials(options: QoderCredentialOptions & { region: QoderRegion; label: string }): Promise<QoderCredentials | null> {
  const { region, label } = options;
  // desktopDir 为 null 表示显式禁用桌面回退；undefined 时使用平台与地域默认目录。
  const directory = options.desktopDir === undefined ? defaultQoderDesktopDir(region, options.home) : options.desktopDir;
  if (!directory) return null;
  const authFile = path.join(directory, "auth.v1.dat");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(authFile); }
  catch { return null; }
  if (!stat.isFile()) return null;
  const cached = desktopCredentialCache.get(region);
  if (cached && cached.credential.authDirectory === directory && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // 文件未变不代表令牌仍有效，缓存命中也必须检查原始毫秒到期时间。
    if (cached.expiresAt <= (options.now ?? Date.now())) desktopInvalid(directory, label, "已过期");
    return cached.credential;
  }
  let machineId: string;
  try {
    machineId = readFile(path.join(directory, "auth.machine-id"));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(machineId)) throw new Error("invalid machine id");
    if (stat.size > 1024 * 1024) throw new Error("invalid auth size");
  } catch { desktopInvalid(directory, label, "机器标识缺失或不可读"); }
  const password = options.keychainPassword ? options.keychainPassword(region) : readDesktopKeychainPassword(region);
  if (!password) {
    desktopInvalid(directory, label, "的加密密钥无法从 macOS 钥匙串读取；若系统弹出授权框请选择「始终允许」");
  }
  let auth: Record<string, unknown>;
  try {
    const fd = fs.openSync(authFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { auth = decryptDesktopAuth(fs.readFileSync(fd), password); }
    finally { fs.closeSync(fd); }
  } catch { desktopInvalid(directory, label, "文件损坏或格式不受支持"); }
  const accountUid = typeof auth.user === "object" && auth.user !== null && !Array.isArray(auth.user)
    && typeof (auth.user as Record<string, unknown>).id === "string" ? (auth.user as Record<string, unknown>).id as string : "";
  const accessToken = typeof auth.token === "string" ? auth.token : "";
  if (!accountUid || !accessToken || /[\r\n]/.test(accessToken)) desktopInvalid(directory, label, "缺少账号或访问令牌");
  const expiresAt = typeof auth.expiresAt === "string" ? Date.parse(auth.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) desktopInvalid(directory, label, "缺少有效到期时间");
  if (expiresAt <= (options.now ?? Date.now())) desktopInvalid(directory, label, "已过期");
  const credential: QoderCredentials = { region, clientProfile: "desktop", accountUid, authDirectory: directory,
    identity: createHash("sha256").update(JSON.stringify([region, accountUid, "desktop"])).digest("hex"),
    machineId, organizationId: "", organizationTags: [], dataPolicyAgreed: true,
    accessToken, expireTime: Math.floor(expiresAt / 1000), encryptUserInfo: "", key: "" };
  try { Object.assign(credential, runtimeFields(credential)); }
  catch { desktopInvalid(directory, label, "运行时认证生成失败"); }
  desktopCredentialCache.set(region, { mtimeMs: stat.mtimeMs, size: stat.size, expiresAt, credential });
  return credential;
}

/** 每次读取当前登录（CLI 优先，缺失时回退桌面版），以跟随账号切换与令牌更新；绝不写入认证目录。
 * 调试变量 QODER_FORCE_DESKTOP=1/true 跳过 CLI，强制只读桌面版登录。 */
export function qoderForceDesktop(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test(env.QODER_FORCE_DESKTOP?.trim() ?? "");
}

export async function loadQoderCredentials(options: QoderCredentialOptions = {}): Promise<QoderCredentials | null> {
  const region = options.region ?? "intl";
  const label = QODER_REGION_LABELS[region];
  if (qoderForceDesktop(options.env ?? process.env)) {
    return loadDesktopQoderCredentials({ ...options, region, label });
  }
  const directory = path.join(options.configDir ?? defaultQoderConfigDir(region, options.home, options.env), ".auth");
  const userFile = path.join(directory, "user");
  try { fs.lstatSync(userFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return loadDesktopQoderCredentials({ ...options, region, label });
    invalid(directory, label, "目录不可读");
  }
  let machineId: string;
  let user: Record<string, unknown>;
  try {
    machineId = readFile(path.join(directory, "machine_id"));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(machineId)) throw new Error("invalid machine id");
    const content = readFile(userFile);
    let raw = content;
    if (!content.startsWith("{")) {
      const encrypted = Buffer.from(content, "base64");
      if (!encrypted.length || encrypted.toString("base64") !== content || encrypted.length % 16) throw new Error("invalid envelope");
      const aesKey = Buffer.from(machineId.slice(0, 16), "utf8");
      const decipher = createDecipheriv("aes-128-cbc", aesKey, aesKey);
      raw = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid user");
    user = value as Record<string, unknown>;
  } catch { invalid(directory, label, "文件损坏或格式不受支持"); }
  const accountUid = typeof user.uid === "string" ? user.uid : "";
  const accessToken = typeof user.security_oauth_token === "string" && user.security_oauth_token
    ? user.security_oauth_token : typeof user.access_token === "string" ? user.access_token : "";
  if (!accountUid || !accessToken || /[\r\n]/.test(accessToken)) invalid(directory, label, "缺少账号或访问令牌");
  const expireTime = typeof user.expire_time === "number" ? user.expire_time : 0;
  if (!Number.isFinite(expireTime) || expireTime <= 0) invalid(directory, label, "缺少有效到期时间");
  if (expireTime * 1000 <= (options.now ?? Date.now())) invalid(directory, label, "已过期");
  const organizationId = typeof user.organization_id === "string" ? user.organization_id : "";
  const organizationTags = Array.isArray(user.organization_tags)
    ? user.organization_tags.filter((tag): tag is string => typeof tag === "string") : [];
  if ([accountUid, machineId, organizationId, ...organizationTags].some((value) => /[\r\n]/.test(value))) invalid(directory, label, "身份字段不合法");
  const credential: QoderCredentials = { region, clientProfile: "cli", accountUid, authDirectory: directory,
    identity: createHash("sha256").update(JSON.stringify([region, accountUid, organizationId])).digest("hex"),
    machineId, organizationId, organizationTags, dataPolicyAgreed: user.data_policy_agreed === true,
    accessToken, expireTime, encryptUserInfo: "", key: "" };
  if (typeof user.encrypt_user_info === "string" && user.encrypt_user_info && typeof user.key === "string" && user.key) {
    if (/[\r\n]/.test(user.key) || /[\r\n]/.test(user.encrypt_user_info)) invalid(directory, label, "运行时认证字段不合法");
    credential.encryptUserInfo = user.encrypt_user_info;
    credential.key = user.key;
  } else {
    try { Object.assign(credential, runtimeFields(credential)); }
    catch { invalid(directory, label, "运行时认证生成失败"); }
  }
  return credential;
}
