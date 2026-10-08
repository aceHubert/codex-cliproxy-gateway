import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodebuddyRegion } from "../types.ts";

/**
 * CodeBuddy/WorkBuddy 桌面端登录凭据（.info 文件）的只读消费层。
 *
 * 站点路由语义照搬 codebuddy2api 的 site_routing.py：profile 由 `auth.domain`
 * 与 accessToken JWT 的 `iss` 双源判定，冲突或未知域名一律拒绝；四个 profile
 * 对应固定的官方 HTTPS 端点，绝不接受任意 URL（防 SSRF 与协议降级）。
 */

export type CodebuddyProfile = "cn-cli" | "cn-work" | "intl-cli" | "intl-work";

/** profile 对应的固定官方端点（唯一允许的上游基址，全部 https）。 */
export const CODEBUDDY_PROFILE_ENDPOINTS: Record<CodebuddyProfile, string> = {
  "cn-cli": "https://copilot.tencent.com",
  "cn-work": "https://www.workbuddy.cn",
  "intl-cli": "https://www.codebuddy.ai",
  "intl-work": "https://www.workbuddy.ai",
};

/** 已知站点域名 → profile；domain 与 JWT issuer 都必须命中这张表。 */
const DOMAIN_PROFILES: Record<string, CodebuddyProfile> = {
  "www.codebuddy.cn": "cn-cli",
  "www.workbuddy.cn": "cn-work",
  "copilot.tencent.com": "cn-cli",
  "www.codebuddy.ai": "intl-cli",
  "www.workbuddy.ai": "intl-work",
};

export function profileRegion(profile: CodebuddyProfile): "cn" | "intl" {
  return profile.startsWith("cn-") ? "cn" : "intl";
}

export function profileProduct(profile: CodebuddyProfile): "cli" | "work" {
  return profile.endsWith("-work") ? "work" : "cli";
}

export function profileSite(profile: CodebuddyProfile): "domestic" | "international" {
  return profileRegion(profile) === "intl" ? "international" : "domestic";
}

export function codebuddyEndpoint(profile: CodebuddyProfile): string {
  return CODEBUDDY_PROFILE_ENDPOINTS[profile];
}

export interface CodebuddyCredential {
  profile: CodebuddyProfile;
  endpoint: string;
  accessToken: string;
  /** 仅用于错误正文脱敏；网关只读不刷新，绝不外发 refreshToken。 */
  refreshToken: string;
  domain: string;
  accountUid: string;
  enterpriseId: string;
  /**
   * 展示用的非敏感账号标识（缺失为空串）：account.nickname、JWT preferred_username、
   * JWT email。只用于拼 `昵称 <邮箱> / 地域` 标签，不参与任何上游请求。
   */
  accountNickname: string;
  accountUsername: string;
  accountEmail: string;
  /** accessToken 到期时间（ms epoch）；来自 .info 的 auth.expiresAt。 */
  expiresAt?: number;
  /** 登录/最近刷新时间（ms epoch）；仅用于多凭据时的新旧排序，不是敏感值。 */
  lastRefreshTime?: number;
}

export class CodebuddyCredentialError extends Error {}

export interface CodebuddyCredentialDependencies {
  watch?: typeof fs.watch;
  stat?: typeof fs.statSync;
  readdir?: typeof fs.readdirSync;
  existsSync?: typeof fs.existsSync;
  now?: () => number;
  /** 每次实际解析 .info 成功的回调（测试统计读取次数）。 */
  onCredentialRead?: () => void;
  /** 锁定的 .info 文件名（配置 codebuddyAccount）；"auto" 或缺省走全扫 + 最近刷新选取。 */
  preferredAccount?: string;
  /** 锁定文件缺失回落 auto 时的告警回调；缺省 console.warn（launchd 下进 gateway.log）。 */
  onAccountFallback?: (account: string) => void;
}

/**
 * codebuddyAccount 的合法形状：哨兵 `"auto"`，或认证目录内的 `.info` 纯文件名
 * （拒绝路径分隔符与空主干，防止把配置值拼成任意读取路径）。历史哨兵 "default"
 * 已在读取归一（migrateLegacyConfig）改写为 "auto"，这里不再接受。
 */
export function isCodebuddyAccountName(value: string): boolean {
  return value === "auto"
    || (value.endsWith(".info") && value.length > ".info".length && path.basename(value) === value);
}

function invalid(message: string): never {
  throw new CodebuddyCredentialError(`${message}；请在 CodeBuddy/WorkBuddy 桌面端或 CLI 重新登录后重试。`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 本机是否存在 CodeBuddy/WorkBuddy 登录凭据（认证目录下的 .info 文件）：只做存在性
 * 探测，不解析内容——Web UI 据此决定是否显示对应开关，凭据本身绝不进入 UI 进程。
 * 不同产品/客户端的登录各有独立的 authentication.id，落在同一目录的不同 .info 文件里。
 */
export function codebuddyCredentialsPresent(directory: string = defaultAuthDirectory()): boolean {
  try {
    return fs.readdirSync(directory).some((name) => name.endsWith(".info"));
  } catch {
    return false;
  }
}

/** 平台默认的认证目录（桌面扩展的公共认证存储；内含各产品独立的 .info 文件）。 */
export function defaultAuthDirectory(): string {
  const home = os.homedir();
  const relative = path.join("CodeBuddyExtension", "Data", "Public", "auth");
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, relative);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", relative);
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, relative);
}

/** 已知站点域名校验：拒绝非 https、userinfo、端口与任意路径（issuer 允许带路径）。 */
function knownHost(value: unknown, issuer: boolean): string {
  if (typeof value !== "string" || !value.trim()) invalid("CodeBuddy 凭据缺少有效的站点标识");
  const text = value.trim();
  if (/[\x00-\x1f\x7f]/.test(text) || /[\\?#]/.test(text)) invalid("CodeBuddy 凭据的站点标识含非法字符");
  let url: URL;
  try { url = new URL(text.includes("://") ? text : `https://${text}`); }
  catch { invalid("CodeBuddy 凭据的站点标识不是有效 URL"); }
  const host = url.hostname.toLowerCase();
  const profile = DOMAIN_PROFILES[host];
  if (url.protocol !== "https:" || !profile
    || url.username || url.password || url.port
    || (!issuer && url.pathname !== "" && url.pathname !== "/")) {
    invalid(`CodeBuddy 凭据的站点 ${text} 不在官方端点白名单内`);
  }
  return host;
}

/** 解码 JWT 形状 token 的载荷对象；非 JWT 或损坏载荷返回 undefined。 */
export function tokenClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return record(payload) ? payload : undefined;
  } catch { return undefined; }
}

/** 从 JWT 形状的 accessToken 提取 iss；非 JWT 或损坏载荷返回 undefined。 */
export function tokenIssuer(token: string): string | undefined {
  const iss = tokenClaims(token)?.iss;
  return typeof iss === "string" ? iss : undefined;
}

/**
 * profile 双源判定：domain 与 JWT issuer 各自归一为已知站点；区域（cn/intl）
 * 冲突或产品（cli/work）冲突都拒绝；两者都指向共享端点 copilot.tencent.com
 * 时默认 cn-cli（对齐 codebuddy2api 的 profile_for_auth）。
 */
export function profileForAuth(auth: Record<string, unknown>): CodebuddyProfile {
  const domain = auth.domain === undefined || auth.domain === "" ? undefined : knownHost(auth.domain, false);
  const token = typeof auth.accessToken === "string" ? auth.accessToken : "";
  const issuerRaw = tokenIssuer(token);
  const issuer = issuerRaw === undefined ? undefined : knownHost(issuerRaw, true);
  const sites = new Set([domain, issuer].filter(Boolean).map((host) => profileSite(DOMAIN_PROFILES[host!])));
  if (sites.size > 1) invalid("CodeBuddy 凭据的 domain 与 token issuer 指向不同区域站点");
  // 共享的 copilot.tencent.com 不能区分产品；显式品牌域名优先。
  const branded = [domain, issuer].filter((host): host is string => Boolean(host && host !== "copilot.tencent.com"));
  const profiles = new Set(branded.map((host) => DOMAIN_PROFILES[host]));
  if (profiles.size > 1) invalid("CodeBuddy 凭据的 domain 与 token issuer 指向不同产品");
  return profiles.values().next().value ?? "cn-cli";
}

/** 读取并校验 .info：损坏、缺字段、符号链接都不回退（对齐 ZCode 配置读取约束）。 */
function readCredential(file: string): CodebuddyCredential {
  let value: unknown;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { value = JSON.parse(fs.readFileSync(fd, "utf8")); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") invalid("CodeBuddy 凭据文件不能是符号链接");
    invalid(`无法读取 CodeBuddy 凭据文件（${path.basename(file)}）`);
  }
  if (!record(value) || !record(value.auth)) invalid("CodeBuddy 凭据文件必须是包含 auth 的 JSON 对象");
  const auth = value.auth;
  const accessToken = auth.accessToken;
  const refreshToken = auth.refreshToken;
  if (typeof accessToken !== "string" || !accessToken || accessToken.split(".").length !== 3) {
    invalid("CodeBuddy 凭据缺少有效的 accessToken");
  }
  if (typeof refreshToken !== "string" || !refreshToken) invalid("CodeBuddy 凭据缺少 refreshToken");
  if (!tokenIssuer(accessToken)) invalid("CodeBuddy accessToken 不是有效 JWT");
  const account = record(value.account) ? value.account : {};
  const expiresAt = typeof auth.expiresAt === "number" && Number.isFinite(auth.expiresAt) ? auth.expiresAt : undefined;
  const lastRefreshTime = typeof auth.lastRefreshTime === "number" && Number.isFinite(auth.lastRefreshTime) ? auth.lastRefreshTime : undefined;
  const profile = profileForAuth(auth);
  // 展示标签用的非敏感标识：昵称来自 account，用户名/邮箱来自 accessToken 的 JWT 载荷。
  const claims = tokenClaims(accessToken) ?? {};
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  return {
    profile,
    endpoint: codebuddyEndpoint(profile),
    accessToken,
    refreshToken,
    domain: typeof auth.domain === "string" && auth.domain ? auth.domain : `https://${codebuddyDomainForProfile(profile)}`,
    accountUid: typeof account.uid === "string" ? account.uid : "",
    enterpriseId: typeof account.enterpriseId === "string" ? account.enterpriseId : "",
    accountNickname: text(account.nickname),
    accountUsername: text(claims.preferred_username),
    accountEmail: text(claims.email),
    expiresAt,
    lastRefreshTime,
  };
}

function codebuddyDomainForProfile(profile: CodebuddyProfile): string {
  // X-Domain 头的兜底顺序与 codebuddy2api 的 domain_for_auth 一致：domain > issuer > www.codebuddy.cn。
  return { "cn-cli": "www.codebuddy.cn", "cn-work": "www.workbuddy.cn", "intl-cli": "www.codebuddy.ai", "intl-work": "www.workbuddy.ai" }[profile];
}

/** 临近过期阈值：剩余不足 5 分钟视为过期，返回带修复指引的 503。 */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface CodebuddyCredentialCache {
  /**
   * 按产品接口选取凭据。配置锁定账号（.info 文件名）时只读该文件：其 profile 决定
   * region/product，请求 slug 地域与账号地域不匹配时直接报错，不跨地域回退；接口产品
   * 不一致时沿用同账号换端点的产品适配。auto/未锁定时全扫 + 最近刷新选取：模型 slug
   * 中的地域是硬性路由（该地域没有任何凭据时直接报错），目录刷新没有 slug 可依据，
   * 走最近刷新登录的 auto 规则；同产品凭据优先，缺失时回退同地域另一产品登录。
   */
  forProduct(product: "cli" | "work", region?: Exclude<CodebuddyRegion, "auto">): Promise<CodebuddyCredential>;
  close(): void;
}

interface CacheState {
  /** 每个 profile 保留一份凭据（同 profile 多文件取最近刷新的）。 */
  byProfile: Map<CodebuddyProfile, CodebuddyCredential>;
  /** byProfile 中每份凭据来自的 .info 文件名（auto 标签解析与凭据选取同源）。 */
  fileByProfile: Map<CodebuddyProfile, string>;
  failure: CodebuddyCredentialError | undefined;
}

/** 全量扫描认证目录：同 profile 多文件取最近刷新的一份，并记下其来源文件名。 */
function scanAuthDirectory(
  directory: string,
  readdir: typeof fs.readdirSync,
  onCredentialRead?: () => void,
): CacheState {
  let names: string[];
  try { names = readdir(directory); }
  catch {
    return {
      byProfile: new Map(),
      fileByProfile: new Map(),
      failure: new CodebuddyCredentialError("无法读取 CodeBuddy/WorkBuddy 认证目录；请在桌面端或 CLI 登录后重试"),
    };
  }
  const byProfile = new Map<CodebuddyProfile, CodebuddyCredential>();
  const fileByProfile = new Map<CodebuddyProfile, string>();
  let firstFailure: CodebuddyCredentialError | undefined;
  for (const name of names.sort()) {
    if (!name.endsWith(".info")) continue;
    try {
      const credential = readCredential(path.join(directory, name));
      onCredentialRead?.();
      // 同 profile 多份文件（重复登录/多客户端）取最近刷新的。
      const existing = byProfile.get(credential.profile);
      if (existing === undefined || (credential.lastRefreshTime ?? 0) > (existing.lastRefreshTime ?? 0)) {
        byProfile.set(credential.profile, credential);
        fileByProfile.set(credential.profile, name);
      }
    } catch (error) {
      firstFailure ??= error instanceof CodebuddyCredentialError
        ? new CodebuddyCredentialError(`${path.basename(name)}: ${error.message}`)
        : new CodebuddyCredentialError(`${path.basename(name)} 无法读取`);
    }
  }
  if (byProfile.size === 0) {
    return {
      byProfile,
      fileByProfile,
      failure: firstFailure ?? new CodebuddyCredentialError("认证目录内没有可用的 CodeBuddy/WorkBuddy 登录凭据（.info）；请在桌面端或 CLI 登录后重试"),
    };
  }
  return { byProfile, fileByProfile, failure: undefined };
}

/** auto 规则的核心：最近刷新的一份登录（活动地域即它的地域）。 */
function freshestCredential(byProfile: Map<CodebuddyProfile, CodebuddyCredential>): CodebuddyCredential | undefined {
  let freshest: CodebuddyCredential | undefined;
  for (const credential of byProfile.values()) {
    if (freshest === undefined || (credential.lastRefreshTime ?? 0) > (freshest.lastRefreshTime ?? 0)) freshest = credential;
  }
  return freshest;
}

/**
 * 账号展示标签（`昵称 <邮箱> / 地域`）：主标识取 account.nickname，缺失退 JWT
 * preferred_username → accountUid → 文件名；JWT 有 email 时追加 `<email>`。只含
 * 非敏感的账号标识与 profile 地域，token 绝不出现在标签里。
 */
function formatAccountLabel(credential: CodebuddyCredential, file: string): string {
  const primary = credential.accountNickname || credential.accountUsername || credential.accountUid || file;
  const email = credential.accountEmail && credential.accountEmail !== primary ? ` <${credential.accountEmail}>` : "";
  return `${primary}${email} / ${profileRegion(credential.profile)}`;
}

/**
 * 只读账号解析的第一步：按 codebuddyAccount（.info 文件名 / "auto" / 缺省）解析出
 * 实际命中的 `.info` 文件名。auto 不是特殊分支——它等价于「由 auto 规则（最近刷新
 * 的登录）解析出的固定文件名」，与网关凭据选取共用同一 scanAuthDirectory/freshestCredential
 * 实现，保证展示等于网关真实命中。目录不存在或无有效凭据返回 undefined。
 */
export function resolveCodebuddyAccountFile(
  authDirectory: string,
  account?: string,
  dependencies: { readdir?: typeof fs.readdirSync; existsSync?: typeof fs.existsSync } = {},
): string | undefined {
  const directory = path.resolve(authDirectory);
  const existsSync = dependencies.existsSync ?? fs.existsSync;
  if (typeof account === "string" && isCodebuddyAccountName(account) && account !== "auto") {
    if (existsSync(path.join(directory, account))) return account;
    // 锁定文件缺失：与网关运行期一致，回落 auto 解析真实命中的登录。
  }
  const scan = scanAuthDirectory(directory, dependencies.readdir ?? fs.readdirSync);
  const freshest = scan.byProfile.size === 0 ? undefined : freshestCredential(scan.byProfile);
  return freshest === undefined ? undefined : scan.fileByProfile.get(freshest.profile);
}

/**
 * 只读账号解析（两步）：先解析实际命中的 `.info` 文件名，再读该文件拼出
 * `昵称 <邮箱> / 地域` 标签。Web UI 展示与 CLI 列表共用；只提取非敏感的
 * accountUid 与 profile 地域，其余字段（含 token）立即丢弃，绝不返回。
 * 锁定文件存在但持续损坏时返回「文件名（凭据无法读取）」的诊断标签（与网关
 * 直读失败报错一致，不假装命中了别的账号）；auto 路径解析成功后随即读失败的
 * 小概率竞态同样落入该标签，下一次解析自愈。
 */
export function codebuddyAccountLabel(authDirectory: string, account?: string): string | undefined {
  const file = resolveCodebuddyAccountFile(authDirectory, account);
  if (file === undefined) return undefined;
  try {
    return formatAccountLabel(readCredential(path.join(path.resolve(authDirectory), file)), file);
  } catch {
    return `${file}（凭据无法读取）`;
  }
}

export interface CodebuddyAccountEntry {
  file: string;
  /** `昵称 <邮箱> / 地域` 展示标签；损坏/未知域名的登录为带原因的说明。 */
  label: string;
  /** 损坏/未知域名的登录不可被选中。 */
  broken: boolean;
}

/** 列出认证目录内全部 `.info` 登录（`--switch` 的选择列表）；按文件名排序。 */
export function listCodebuddyAccounts(authDirectory: string = defaultAuthDirectory()): CodebuddyAccountEntry[] {
  const directory = path.resolve(authDirectory);
  let names: string[];
  try { names = fs.readdirSync(directory); }
  catch { return []; }
  const entries: CodebuddyAccountEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".info")) continue;
    try {
      entries.push({ file: name, label: formatAccountLabel(readCredential(path.join(directory, name)), name), broken: false });
    } catch (error) {
      const reason = error instanceof CodebuddyCredentialError ? error.message : "无法读取";
      entries.push({ file: name, label: `${name}（${reason}）`, broken: true });
    }
  }
  return entries;
}

/** 锁定账号文件缺失时的缺省告警：console.warn 在 launchd 下随 stderr 落进 gateway.log。 */
function defaultAccountFallbackWarning(account: string): void {
  console.warn(`[codebuddy] 配置锁定的账号文件 ${account} 不存在，本次运行回退 auto 选取最近刷新的登录；配置未修改`);
}

/**
 * 只读凭据缓存：扫描认证目录下全部 `.info`（不同产品/客户端各一份文件），目录事件
 * 触发重扫（本机 CLI 会持续刷新这些文件），网关自身绝不刷新 token；临近过期直接报
 * 带指引的错误。单个文件损坏/未知域名只跳过该文件，不拖垮其余有效登录。
 */
export function createCodebuddyCredentialCache(
  authDirectory: string,
  dependencies: CodebuddyCredentialDependencies = {},
): CodebuddyCredentialCache {
  const now = dependencies.now ?? Date.now;
  const stat = dependencies.stat ?? fs.statSync;
  const readdir = dependencies.readdir ?? fs.readdirSync;
  const existsSync = dependencies.existsSync ?? fs.existsSync;
  const watch = dependencies.watch ?? fs.watch;
  const directory = path.resolve(authDirectory);
  // 配置锁定的 .info 文件名；"auto"/缺省/非法形状一律 undefined（走全扫 + 最近刷新选取）。
  const lockedAccount = typeof dependencies.preferredAccount === "string"
    && isCodebuddyAccountName(dependencies.preferredAccount)
    && dependencies.preferredAccount !== "auto"
    ? dependencies.preferredAccount
    : undefined;
  let state: CacheState = { byProfile: new Map(), fileByProfile: new Map(), failure: undefined };
  /** 锁定文件缺失的 fallback 告警只记一次，文件恢复存在后重新布防。 */
  let accountFallbackWarned = false;
  let identity = "";
  let debounce: ReturnType<typeof setTimeout> | undefined;
  /**
   * 选取前总是重扫：认证目录内只有少量几 KB 的 .info 文件，一次读+解析相对模型
   * 请求可忽略；正确性完全不依赖 fs.watch 事件的到达时机（watch 仅作提前触发）。
   */
  let closed = false;
  let watcher: fs.FSWatcher | undefined;

  function scanSync(): CacheState {
    return scanAuthDirectory(directory, readdir, dependencies.onCredentialRead);
  }

  function schedule(): void {
    // 锁定账号时 state 不参与选取（锁定命中的直读文件，缺失 fallback 也会在选取前
    // 同步重扫），watch 触发的提前全扫只是无效读取，直接跳过。
    if (lockedAccount !== undefined) return;
    clearTimeout(debounce);
    // 写入方（CLI 刷新）通常先写临时文件再 rename，短去抖合并同一轮事件。
    debounce = setTimeout(() => {
      debounce = undefined;
      applyScan(state.byProfile);
    }, 100);
    debounce.unref?.();
  }

  function reconcileWatcher(): void {
    let info: fs.Stats;
    try { info = stat(directory); }
    catch { watcher?.close(); watcher = undefined; return; }
    if (!info.isDirectory()) { watcher?.close(); watcher = undefined; return; }
    const next = `${info.dev}:${info.ino}`;
    if (watcher && identity === next) return;
    watcher?.close();
    const active = watch(directory, { persistent: false }, (_event, filename) => {
      if (!filename || filename.toString().endsWith(".info")) schedule();
    });
    active.on("error", () => { active.close(); if (watcher === active) watcher = undefined; });
    watcher = active;
    identity = next;
  }

  function applyScan(previous: Map<CodebuddyProfile, CodebuddyCredential>): void {
    state = scanSync();
    const unchanged = state.byProfile.size === previous.size
      && [...state.byProfile].every(([profile, credential]) => previous.get(profile)?.accessToken === credential.accessToken);
  }

  // 锁定账号时跳过初始全扫：选取路径直读该文件，首次缺失 fallback 才需要扫描结果。
  if (lockedAccount === undefined) applyScan(new Map());
  reconcileWatcher();

  function expired(credential: CodebuddyCredential): boolean {
    return credential.expiresAt !== undefined && credential.expiresAt - now() <= EXPIRY_MARGIN_MS;
  }

  function expiryError(): CodebuddyCredentialError {
    return new CodebuddyCredentialError(
      "CodeBuddy 凭据已过期或临近过期；网关不主动刷新 token（避免与本机 CLI 冲突），请在 CodeBuddy/WorkBuddy 桌面端或 CLI 重新登录",
    );
  }

  /** 活动地域：最近刷新的登录所在地域（混合地域登录时以最新一次为准）。 */
  function activeRegion(byProfile: Map<CodebuddyProfile, CodebuddyCredential>): "cn" | "intl" {
    return profileRegion(freshestCredential(byProfile)!.profile);
  }

  function regionFor(
    byProfile: Map<CodebuddyProfile, CodebuddyCredential>,
    requested?: Exclude<CodebuddyRegion, "auto">,
  ): "cn" | "intl" {
    if (requested !== undefined) {
      if (![...byProfile.keys()].some((profile) => profileRegion(profile) === requested)) {
        throw new CodebuddyCredentialError(`没有可用的 ${requested === "cn" ? "国内" : "国际"} CodeBuddy/WorkBuddy 登录凭据`);
      }
      return requested;
    }
    return activeRegion(byProfile);
  }

  function select(
    byProfile: Map<CodebuddyProfile, CodebuddyCredential>,
    product: "cli" | "work",
    requestedRegion?: Exclude<CodebuddyRegion, "auto">,
  ): CodebuddyCredential {
    const region = regionFor(byProfile, requestedRegion);
    const wanted = `${region}-${product}` as CodebuddyProfile;
    const exact = byProfile.get(wanted);
    if (exact !== undefined) return exact;
    const sibling = byProfile.get(`${region}-${product === "cli" ? "work" : "cli"}` as CodebuddyProfile)!;
    // 同地域另一产品回退：接口换成请求前缀的产品，token 与账号沿用现有登录。
    return { ...sibling, profile: wanted, endpoint: codebuddyEndpoint(wanted) };
  }

  return {
    async forProduct(product, region) {
      if (closed) throw new CodebuddyCredentialError("CodeBuddy 凭据监听已关闭，请重启网关");
      reconcileWatcher();
      // 锁定账号（codebuddyAccount 为具体 .info 文件名）：存在即只读该文件，跳过全扫；
      // 文件缺失时记一次 fallback 告警并回落 auto，绝不改写配置。
      if (lockedAccount !== undefined) {
        const file = path.join(directory, lockedAccount);
        if (existsSync(file)) {
          accountFallbackWarned = false;
          // 损坏/符号链接等读取失败直接抛出（readCredential 已包成带指引的错误）。
          const credential = readCredential(file);
          dependencies.onCredentialRead?.();
          const credentialRegion = profileRegion(credential.profile);
          if (region !== undefined && region !== credentialRegion) {
            throw new CodebuddyCredentialError(`没有可用的 ${region === "cn" ? "国内" : "国际"} CodeBuddy/WorkBuddy 登录凭据`);
          }
          // 接口产品不一致时沿用同账号的 token，只切换端点与身份（对齐 auto 的同地域产品回退）。
          const wanted = `${credentialRegion}-${product}` as CodebuddyProfile;
          const adapted = credential.profile === wanted
            ? credential
            : { ...credential, profile: wanted, endpoint: codebuddyEndpoint(wanted) };
          if (expired(adapted)) throw expiryError();
          return adapted;
        }
        if (!accountFallbackWarned) {
          accountFallbackWarned = true;
          (dependencies.onAccountFallback ?? defaultAccountFallbackWarning)(lockedAccount);
        }
      }
      // auto 路径（含锁定文件缺失的运行期 fallback）。
      // 每次选取前重扫：文件量小、读取廉价，正确性不依赖 fs.watch 事件到达时机。
      applyScan(state.byProfile);
      let credential = state.failure || state.byProfile.size === 0 ? undefined : select(state.byProfile, product, region);

      if (state.failure) throw state.failure;
      if (!credential) throw new CodebuddyCredentialError("CodeBuddy 凭据不可用");
      if (expired(credential)) throw expiryError();
      return credential;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(debounce);
      watcher?.close();
      watcher = undefined;
    },
  };
}
