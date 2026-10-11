import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Antigravity CLI（agy）凭据的只读消费。
 *
 * 凭据文件是 CLI 写入的 `~/.gemini/antigravity-cli/antigravity-oauth-token`
 * （keyring 保存失败时的文件回退路径，本机即此形态）。网关只读 access_token 与
 * 过期时间，绝不刷新、绝不写回、绝不把令牌值带进日志或错误信息：
 * access_token 有效期整 1 小时，由 agy 进程（含 remote-control daemon）惰性刷新。
 */

export class AgyCredentialError extends Error {
  constructor(message: string) { super(message); this.name = "AgyCredentialError"; }
}

/** access_token 判定过期时预留的时钟偏移余量。 */
const EXPIRY_SKEW_MS = 10_000;

export interface AgyCredentials {
  accessToken: string;
  /** epoch 毫秒；0 表示文件未给出可解析的过期时间，按未过期处理并交由上游 401 兜底。 */
  expiryMs: number;
  /** 账号身份摘要（refresh_token 优先，缺失时用 id_token），只用于目录缓存键。 */
  identity: string;
  /** consumer（个人 Google 账号）或企业登录标记。 */
  authMethod: string;
}

export interface AgyCredentialOptions {
  /** 凭据文件路径；缺省取平台默认的 ~/.gemini/antigravity-cli/antigravity-oauth-token。 */
  credentialFile?: string;
  home?: string;
  readFile?: (file: string) => string;
}

export function defaultAgyCredentialFile(home = process.env.HOME ?? "", os = process.platform): string {
  if (os === "win32") {
    return path.join(home, "AppData", "Local", "Google", "antigravity-cli", "antigravity-oauth-token");
  }
  return path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function parseExpiry(value: unknown): number {
  // CLI 写入 RFC3339 带 6 位小数秒与时区偏移；无法解析时按未知处理（expiryMs=0），
  // 不因字段怪异拒用整份凭据——上游 401 会兜底。
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 只探测凭据文件是否存在（Web UI 开关显隐用）；不读取也不解析内容。 */
export function agyCredentialsPresent(credentialFile = defaultAgyCredentialFile()): boolean {
  try { return fs.statSync(credentialFile).isFile(); } catch { return false; }
}

/**
 * 读取并校验 agy 凭据。文件缺失与损坏分开报错，损坏时带文件路径与重建指引，
 * 不静默当作未登录。
 */
export function loadAgyCredentials(options: AgyCredentialOptions = {}): AgyCredentials {
  const file = options.credentialFile
    ?? defaultAgyCredentialFile(options.home ?? process.env.HOME ?? "");
  const read = options.readFile ?? ((source: string) => fs.readFileSync(source, "utf8"));
  let raw: string;
  try {
    raw = read(file);
  } catch {
    throw new AgyCredentialError(
      `未检测到 Antigravity CLI 登录（${file} 不存在）；请先运行 agy 并完成 Google 账号登录，或执行 agy remote-control start 保持登录态刷新`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgyCredentialError(
      `Antigravity 凭据文件损坏（${file} 不是有效 JSON）；请在 agy 内退出登录后重新登录以重建该文件`,
    );
  }
  const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : undefined;
  const tokenRaw = root?.token;
  const token = tokenRaw !== null && tokenRaw !== undefined && typeof tokenRaw === "object" && !Array.isArray(tokenRaw)
    ? tokenRaw as Record<string, unknown> : undefined;
  const accessToken = typeof token?.access_token === "string" ? token.access_token : "";
  if (!token || !accessToken) {
    throw new AgyCredentialError(
      `Antigravity 凭据缺少 access_token（${file}）；请运行 agy 重新登录后重试`,
    );
  }
  const seed = typeof token.refresh_token === "string" && token.refresh_token
    ? token.refresh_token
    : typeof root?.id_token === "string" && root.id_token ? root.id_token : accessToken;
  return {
    accessToken,
    expiryMs: parseExpiry(token.expiry),
    identity: createHash("sha256").update(seed).digest("hex"),
    authMethod: typeof root?.auth_method === "string" && root.auth_method ? root.auth_method : "consumer",
  };
}

/** access_token 是否已过期待判定：过期即快速失败，网关不做任何刷新。 */
export function agyTokenStale(credentials: AgyCredentials, now = Date.now()): boolean {
  return credentials.expiryMs > 0 && now >= credentials.expiryMs - EXPIRY_SKEW_MS;
}
