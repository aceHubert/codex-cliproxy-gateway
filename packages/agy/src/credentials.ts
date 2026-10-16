import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * Antigravity CLI（agy）凭据的只读消费。
 *
 * 凭据有两处落点，读取顺序对齐终端 CLI（1.3.6+ 默认直读钥匙串）：
 * macOS 钥匙串条目 `gemini/antigravity`（`go-keyring-base64:` 前缀 + base64 的
 * JSON，仅在登录/交互使用时写入）有**合法（未过期）令牌**时优先采用——凭据文件
 * 被完全屏蔽，哪怕其内容本身是对的；钥匙串无合法令牌（缺失/损坏/过期）才回落
 * `~/.gemini/antigravity-cli/antigravity-oauth-token` 文件——remote-control
 * daemon 只刷新文件，钥匙串令牌过期后由文件兜底。
 * 网关只读 access_token 与过期时间，绝不刷新、绝不写回、绝不把令牌值带进日志或
 * 错误信息：access_token 有效期整 1 小时，由 agy 进程（含 daemon）惰性刷新并
 * 写回上述存储；每次请求重新读取，写回自然生效。
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
  /** 钥匙串条目读取（测试注入）；缺省经 security 命令读 gemini/antigravity 的值。 */
  readKeychain?: () => string;
  os?: NodeJS.Platform;
}

/** 新版 agy CLI 的 macOS 钥匙串条目（go-keyring 惯例：服务 gemini、账户 antigravity）。 */
const AGY_KEYCHAIN_SERVICE = "gemini";
const AGY_KEYCHAIN_ACCOUNT = "antigravity";
const GO_KEYRING_PREFIX = "go-keyring-base64:";

function readAgyKeychainValue(): string {
  return execFileSync(
    "security", ["find-generic-password", "-s", AGY_KEYCHAIN_SERVICE, "-a", AGY_KEYCHAIN_ACCOUNT, "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
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

/** 只探测凭据是否可读（Web UI 开关显隐用）；文件缺失时（darwin）再看钥匙串条目。 */
export function agyCredentialsPresent(
  credentialFile = defaultAgyCredentialFile(),
  options: { os?: NodeJS.Platform; probeKeychain?: () => boolean } = {},
): boolean {
  try { return fs.statSync(credentialFile).isFile(); } catch { /* 继续探测钥匙串。 */ }
  if ((options.os ?? process.platform) !== "darwin") return false;
  const probe = options.probeKeychain ?? (() => {
    try {
      execFileSync(
        "security", ["find-generic-password", "-s", AGY_KEYCHAIN_SERVICE, "-a", AGY_KEYCHAIN_ACCOUNT],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      return true;
    } catch {
      return false;
    }
  });
  return probe();
}

/**
 * 读取并校验 agy 凭据。读取顺序对齐终端 CLI（1.3.6+ 默认直读钥匙串）：
 *
 * 1. 钥匙串条目（darwin）存在且令牌**未过期** → 采用，凭据文件被完全屏蔽
 *    （哪怕文件内容本身是合法的）；
 * 2. 钥匙串无合法令牌（缺失/损坏/过期）→ 回落凭据文件——remote-control daemon
 *    只刷新文件，钥匙串令牌过期后由文件兜底；
 * 3. 文件也拿不到时，若钥匙串至少解析出凭据（已过期）则原样返回，交由请求层
 *    按过期 401 给出刷新指引；两边都无凭据才报未登录（附钥匙串侧的具体问题）。
 *
 * 网关只读不刷新：钥匙串仅在登录/交互使用时由 agy 写入，文件由 daemon 持续续期；
 * 每次请求重新读取，daemon 的写回自然生效。
 */
export function loadAgyCredentials(options: AgyCredentialOptions = {}): AgyCredentials {
  const file = options.credentialFile
    ?? defaultAgyCredentialFile(options.home ?? process.env.HOME ?? "");
  const read = options.readFile ?? ((source: string) => fs.readFileSync(source, "utf8"));
  const keychainLabel = `keychain:${AGY_KEYCHAIN_SERVICE}/${AGY_KEYCHAIN_ACCOUNT}`;

  /** 解析单个来源的 JSON 文本；损坏与缺字段分开报错（带来源标注）。 */
  const parse = (raw: string, label: string): AgyCredentials => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgyCredentialError(
        `Antigravity 凭据损坏（${label} 不是有效 JSON）；请在 agy 内退出登录后重新登录以重建`,
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
        `Antigravity 凭据缺少 access_token（${label}）；请运行 agy 重新登录后重试`,
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
  };

  /** 读凭据文件；缺失/不可读返回 undefined（由调用方决定回退或报错），损坏抛错。 */
  const readFileCredentials = (): AgyCredentials | undefined => {
    let raw: string;
    try {
      raw = read(file);
    } catch {
      return undefined;
    }
    return parse(raw, file);
  };

  if ((options.os ?? process.platform) === "darwin") {
    const readKeychain = options.readKeychain ?? readAgyKeychainValue;
    let keychainCredentials: AgyCredentials | undefined;
    let keychainProblem: string | undefined;
    try {
      const raw = readKeychain();
      if (!raw.startsWith(GO_KEYRING_PREFIX)) {
        throw new AgyCredentialError(
          `Antigravity 钥匙串条目格式异常（${AGY_KEYCHAIN_SERVICE}/${AGY_KEYCHAIN_ACCOUNT} 不以 ${GO_KEYRING_PREFIX} 开头）；请在 agy 内退出登录后重新登录以重建`,
        );
      }
      keychainCredentials = parse(
        Buffer.from(raw.slice(GO_KEYRING_PREFIX.length), "base64").toString("utf8"),
        keychainLabel,
      );
    } catch (error) {
      keychainProblem = error instanceof AgyCredentialError ? error.message : String(error);
    }
    // 钥匙串有合法（未过期）令牌：直接采用，文件被完全屏蔽。
    if (keychainCredentials && !agyTokenStale(keychainCredentials)) return keychainCredentials;
    // 回落文件（daemon 只刷新文件；钥匙串过期/损坏/缺失均落到这里）。
    const fromFile = readFileCredentials();
    if (fromFile) return fromFile;
    // 文件也没有：过期钥匙串凭据原样返回（请求层按过期给指引），否则报未登录。
    if (keychainCredentials) return keychainCredentials;
    throw new AgyCredentialError(
      `未检测到 Antigravity CLI 登录（钥匙串条目 ${AGY_KEYCHAIN_SERVICE}/${AGY_KEYCHAIN_ACCOUNT} 无可用令牌`
      + `${keychainProblem ? `：${keychainProblem}` : ""}，且 ${file} 不存在或不可读）；`
      + "请先运行 agy 并完成 Google 账号登录，或执行 agy remote-control start 保持登录态刷新",
    );
  }

  const fromFile = readFileCredentials();
  if (!fromFile) {
    throw new AgyCredentialError(
      `未检测到 Antigravity CLI 登录（${file} 不存在，且当前平台无钥匙串回退）；`
      + "请先运行 agy 并完成 Google 账号登录，或执行 agy remote-control start 保持登录态刷新",
    );
  }
  return fromFile;
}

/** access_token 是否已过期待判定：过期即快速失败，网关不做任何刷新。 */
export function agyTokenStale(credentials: AgyCredentials, now = Date.now()): boolean {
  return credentials.expiryMs > 0 && now >= credentials.expiryMs - EXPIRY_SKEW_MS;
}
