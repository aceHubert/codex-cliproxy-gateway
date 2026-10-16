import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { getHostServices } from "@agent-proxy/plugin-api";
import os from "node:os";
import path from "node:path";

/** CodeBuddy 凭据地域；具体请求按模型地域筛选凭据，auto 表示自动选择。 */
export type CodebuddyRegion = "auto" | "cn" | "intl";

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
  /** 锁定的账号选择值（配置 codebuddyAccount：`profile:uid` 钉住地域、裸 uid 跟随
   * 该账号最新登录、历史 .info 文件名读取时换算）；"auto" 或缺省走全扫 + 最近刷新选取。 */
  preferredAccount?: string;
  /** 锁定文件缺失回落 auto 时的告警回调；缺省 console.warn（launchd 下进 gateway.log）。 */
  onAccountFallback?: (account: string) => void;
}

/**
 * codebuddyAccount 的合法形状：哨兵 `"auto"`、账号 uid，或历史 `.info` 纯文件名
 * （读取时按同账号最新登录解析）。拒绝路径分隔符与空串，防止把配置值拼成任意
 * 读取路径。历史哨兵 "default" 已在读取归一（migrateLegacyConfig）改写为
 * "auto"，这里不再特殊处理。
 */
export function isCodebuddyAccountValue(value: string): boolean {
  return value === "auto"
    || (value.length > 0 && !value.includes("/") && !value.includes("\\") && !value.includes("\u0000"));
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
export function defaultAuthDirectory(home = os.homedir()): string {
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
   * 按产品接口选取凭据，选取基于内存缓存的目录快照（intl/cn 各 profile 独立成条，
   * 同时调用互不影响）；缓存更新只来自 fs.watch 提前触发与 refresh() 强制重扫。
   * 配置锁定账号（账号 uid；历史 .info 文件名值选取时换算为
   * 同账号 uid）时按「该账号最近刷新的登录」选取：命中凭据的 profile 决定
   * region/product，请求 slug 地域与账号地域不匹配时直接报错，不跨地域回退；接口
   * 产品不一致时沿用同账号换端点的产品适配——CLI 刷新换文件后经 watch/refresh 跟随。
   * 账号不存在时告警一次并回落 auto。auto/未锁定时按缓存快照最近刷新选取：模型 slug
   * 中的地域是硬性路由（该地域没有任何凭据时直接报错），目录枚举同样显式指定地域；
   * 未指定地域的调用走最近刷新登录的 auto 规则。同产品凭据优先，缺失时回退
   * 同地域另一产品登录。
   */
  forProduct(product: "cli" | "work", region?: Exclude<CodebuddyRegion, "auto">): Promise<CodebuddyCredential>;
  /**
   * 强制重扫认证目录并同步更新内存缓存（同步文件读，目录内只有少量几 KB 的 .info）。
   * 供请求路径在疑似缓存过期（凭据错误、上游 401/403）与目录刷新容错时兜底调用；
   * fs.watch 只是提前触发，refresh 是正确性的兜底。
   */
  refresh(): void;
  close(): void;
}

interface CacheState {
  /** 每个 profile 保留一份凭据（同 profile 多文件取最近刷新的）。 */
  byProfile: Map<CodebuddyProfile, CodebuddyCredential>;
  /** byProfile 中每份凭据来自的 .info 文件名（auto 标签解析与凭据选取同源）。 */
  fileByProfile: Map<CodebuddyProfile, string>;
  /** 每个账号 uid（跨 profile）保留最近刷新的一份：裸 uid 锁定的选取来源。 */
  byUid: Map<string, CodebuddyCredential>;
  fileByUid: Map<string, string>;
  /** 每个 (uid, profile) 保留最近刷新的一份：profile 作用域锁定的选取来源。 */
  byAccount: Map<string, CodebuddyCredential>;
  fileByAccount: Map<string, string>;
  failure: CodebuddyCredentialError | undefined;
}

/** 「最新」判据（auto 选取、账号列表去重、uid 锁定共用）：lastRefreshTime 为主，
 * 平手比文件 mtime；两者都平手时保持先到者（文件名序迭代）。 */
function isFresherCredential(nextRefresh: number, nextMtime: number, currentRefresh: number, currentMtime: number): boolean {
  return nextRefresh > currentRefresh || (nextRefresh === currentRefresh && nextMtime > currentMtime);
}

function fileMtimeMs(directory: string, file: string): number {
  try { return fs.statSync(path.join(directory, file)).mtimeMs; } catch { return 0; }
}

/** 全量扫描认证目录：同 profile 多文件取最近刷新的一份，并记下其来源文件名；
 * 同账号（uid，跨 profile）也各自保留最近刷新的一份（uid 锁定的选取来源）。 */
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
      byUid: new Map(),
      fileByUid: new Map(),
      byAccount: new Map(),
      fileByAccount: new Map(),
      failure: new CodebuddyCredentialError("无法读取 CodeBuddy/WorkBuddy 认证目录；请在桌面端或 CLI 登录后重试"),
    };
  }
  const byProfile = new Map<CodebuddyProfile, CodebuddyCredential>();
  const fileByProfile = new Map<CodebuddyProfile, string>();
  const byUid = new Map<string, CodebuddyCredential>();
  const fileByUid = new Map<string, string>();
  const byAccount = new Map<string, CodebuddyCredential>();
  const fileByAccount = new Map<string, string>();
  let firstFailure: CodebuddyCredentialError | undefined;
  for (const name of names.sort()) {
    if (!name.endsWith(".info")) continue;
    try {
      const credential = readCredential(path.join(directory, name));
      onCredentialRead?.();
      const mtime = fileMtimeMs(directory, name);
      // 同 profile 多份文件（重复登录/多客户端）取最近刷新的。
      const existing = byProfile.get(credential.profile);
      const existingFile = fileByProfile.get(credential.profile);
      if (existing === undefined || existingFile === undefined
        || isFresherCredential(credential.lastRefreshTime ?? 0, mtime, existing.lastRefreshTime ?? 0, fileMtimeMs(directory, existingFile))) {
        byProfile.set(credential.profile, credential);
        fileByProfile.set(credential.profile, name);
      }
      // 同账号 uid 跨 profile 的多份文件（cn/intl 各一份登录）也取最近刷新的：
      // 裸 uid 锁定跟随该账号最新登录；(uid, profile) 组合再各留一份，供
      // profile 作用域锁定（`cn-cli:<uid>`）钉住地域/产品。
      if (credential.accountUid) {
        const existingUid = byUid.get(credential.accountUid);
        const existingUidFile = fileByUid.get(credential.accountUid);
        if (existingUid === undefined || existingUidFile === undefined
          || isFresherCredential(credential.lastRefreshTime ?? 0, mtime, existingUid.lastRefreshTime ?? 0, fileMtimeMs(directory, existingUidFile))) {
          byUid.set(credential.accountUid, credential);
          fileByUid.set(credential.accountUid, name);
        }
        const accountKey = `${credential.accountUid}::${credential.profile}`;
        const existingAccount = byAccount.get(accountKey);
        const existingAccountFile = fileByAccount.get(accountKey);
        if (existingAccount === undefined || existingAccountFile === undefined
          || isFresherCredential(credential.lastRefreshTime ?? 0, mtime, existingAccount.lastRefreshTime ?? 0, fileMtimeMs(directory, existingAccountFile))) {
          byAccount.set(accountKey, credential);
          fileByAccount.set(accountKey, name);
        }
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
      byUid,
      fileByUid,
      byAccount,
      fileByAccount,
      failure: firstFailure ?? new CodebuddyCredentialError("认证目录内没有可用的 CodeBuddy/WorkBuddy 登录凭据（.info）；请在桌面端或 CLI 登录后重试"),
    };
  }
  return { byProfile, fileByProfile, byUid, fileByUid, byAccount, fileByAccount, failure: undefined };
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

/** 账号选择器：uid 必有；profile 存在时为 profile 作用域锁定（钉住地域/产品），
 * 缺失时为裸 uid 锁定（跟随该账号最近刷新的登录，地域随之）。 */
interface AccountSelector {
  uid: string;
  profile?: CodebuddyProfile;
}

/** 配置锁定值 → 账号选择器。三种形态：`profile:uid`（如 `cn-cli:uid-x`，钉住
 * 该地域/产品）、裸 uid（跟随该账号最新登录）、历史 `.info` 文件名（读该文件
 * 换算为 `该文件的 profile + uid`，等同钉住其地域）。路径形状一律非法；文件
 * 缺失/损坏/无 uid 返回 undefined（调用方按直读或回退处理）。网关选取与展示
 * 解析共用，保证锁定语义在文件轮换（CLI 刷新另写新文件）下仍指向同一账号。 */
function lockedAccountSelector(
  directory: string,
  account: string | undefined,
  existsSync: typeof fs.existsSync = fs.existsSync,
): AccountSelector | undefined {
  if (typeof account !== "string" || !account || account === "auto") return undefined;
  // 路径形状一律非法（防止拼接出任意读取路径）。
  if (account.includes("/") || account.includes("\\") || path.basename(account) !== account) return undefined;
  if (!account.endsWith(".info")) {
    const separator = account.indexOf(":");
    if (separator > 0) {
      const prefix = account.slice(0, separator);
      if (prefix === "cn-cli" || prefix === "cn-work" || prefix === "intl-cli" || prefix === "intl-work") {
        const uid = account.slice(separator + 1);
        return uid ? { uid, profile: prefix } : undefined;
      }
    }
    // 无已知 profile 前缀：整个值按裸 uid 处理（跟随最新）。
    return { uid: account };
  }
  if (!existsSync(path.join(directory, account))) return undefined;
  try {
    const credential = readCredential(path.join(directory, account));
    return credential.accountUid ? { uid: credential.accountUid, profile: credential.profile } : undefined;
  } catch { return undefined; }
}

/**
 * 只读账号解析的第一步：按 codebuddyAccount（账号 uid / 历史 .info 文件名 /
 * "auto" / 缺省）解析出实际命中的 `.info` 文件名。锁定账号命中「该 uid 最近刷新
 * 的登录」（与网关选取同源，文件轮换后自动指向新快照）；账号不存在回落 auto；
 * 无 uid 的旧客户端登录按文件名直读展示。auto 等价于「由 auto 规则（最近刷新的
 * 登录）解析出的固定文件名」。目录不存在或无有效凭据返回 undefined。
 */
export function resolveCodebuddyAccountFile(
  authDirectory: string,
  account?: string,
  dependencies: { readdir?: typeof fs.readdirSync; existsSync?: typeof fs.existsSync } = {},
): string | undefined {
  const directory = path.resolve(authDirectory);
  const existsSync = dependencies.existsSync ?? fs.existsSync;
  const scan = scanAuthDirectory(directory, dependencies.readdir ?? fs.readdirSync);
  const freshest = scan.byProfile.size === 0 ? undefined : freshestCredential(scan.byProfile);
  const fallback = freshest === undefined ? undefined : scan.fileByProfile.get(freshest.profile);
  const selector = lockedAccountSelector(directory, account, existsSync);
  if (selector !== undefined) {
    // profile 作用域锁定只解析该地域/产品下的最新登录；裸 uid 跟随账号最新登录。
    // 选择器无命中（账号或地域不存在）回落 auto，与运行期一致。
    const file = selector.profile !== undefined
      ? scan.fileByAccount.get(`${selector.uid}::${selector.profile}`)
      : scan.fileByUid.get(selector.uid);
    if (file !== undefined) return file;
    return fallback;
  }
  // 无 uid 的旧客户端登录：锁定值即文件名，展示该文件本身。
  if (typeof account === "string" && account.endsWith(".info")
    && path.basename(account) === account && existsSync(path.join(directory, account))) {
    return account;
  }
  return fallback;
}

/** 配置锁定值 → 下拉展示/提交用的规范值："auto"；profile 作用域值（`cn-cli:uid`）
 * 命中登录时原样（地域钉住）；裸 uid 规范化为该账号当前命中行的 profile 作用域
 * 值（下拉直接选中运行期实际使用的登录）；历史 `.info` 文件名换算为
 * `该文件的 profile:uid`。无 uid 登录保持文件名；无命中（账号/地域不存在、文件
 * 缺失/损坏）保留原值，前端按「登录不存在」占位。 */
export function canonicalCodebuddyAccountValue(authDirectory: string, account?: string): string {
  if (typeof account !== "string" || !account || account === "auto") return "auto";
  const directory = path.resolve(authDirectory);
  const selector = lockedAccountSelector(directory, account);
  if (selector === undefined) return account;
  const scan = scanAuthDirectory(directory, fs.readdirSync);
  if (selector.profile !== undefined) {
    return scan.byAccount.has(`${selector.uid}::${selector.profile}`)
      ? `${selector.profile}:${selector.uid}`
      : account;
  }
  const freshest = scan.byUid.get(selector.uid);
  return freshest ? `${freshest.profile}:${selector.uid}` : account;
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

export interface CodebuddyInstanceContext {
  /** 测试或独立宿主可显式提供认证目录，生产缺省按当前实例用户目录派生。 */
  authDirectory?: string;
  getConfig(): Readonly<{ codebuddyAccount?: string }>;
  getHome?(): string;
}

const instanceContexts = new AsyncLocalStorage<CodebuddyInstanceContext>();

export function withInstanceContext<T>(context: CodebuddyInstanceContext, callback: () => T): T {
  return instanceContexts.run(context, callback);
}

/** 每次请求重新读只读 .info，实时反映当前实例账号及桌面端切换。 */
export function getActiveAccount(): string | undefined {
  const context = instanceContexts.getStore();
  const host = context ? undefined : getHostServices();
  const home = context?.getHome?.() ?? host?.getPaths().home;
  const directory = context?.authDirectory ?? defaultAuthDirectory(home);
  const account = context?.getConfig().codebuddyAccount ?? host?.getConfig().codebuddyAccount;
  return codebuddyAccountLabel(directory, account);
}

export interface CodebuddyAccountEntry {
  /** 选择控件的值：`profile:uid`（同账号跨地域多行时值唯一，且可钉住地域/产品）；
   * 无 uid 的旧客户端登录为文件名。 */
  value: string;
  /** 账号 uid（无 uid 的旧客户端登录为空串）。 */
  uid: string;
  file: string;
  /** `昵称 <邮箱> / 地域` 展示标签；损坏/未知域名的登录为带原因的说明。 */
  label: string;
  /** 损坏/未知域名的登录不可被选中。 */
  broken: boolean;
}

/** 列出认证目录内的登录账号（`--switch` 菜单与 Web UI 下拉共用）；按文件名排序。
 * 本机 CLI 的 logout/刷新会把旧登录改名为带时间戳的 `.info` 备份保留，同一账号
 * （相同 uid 与 profile）会积累多份文件——按 (uid, profile) 去重，只保留最新
 * （lastRefreshTime 为主、平手比文件 mtime）的一份。同一 uid 在不同地域/产品
 * （cn 与 intl、cli 与 work）是合法的不同登录，不合并；uid 缺失或损坏的文件无法
 * 归并，逐个原样保留（损坏仍标不可选）。 */
export function listCodebuddyAccounts(authDirectory: string = defaultAuthDirectory()): CodebuddyAccountEntry[] {
  const directory = path.resolve(authDirectory);
  let names: string[];
  try { names = fs.readdirSync(directory); }
  catch { return []; }
  const freshest = new Map<string, { entry: CodebuddyAccountEntry; refresh: number; mtime: number }>();
  const unmerged: CodebuddyAccountEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".info")) continue;
    try {
      const credential = readCredential(path.join(directory, name));
      const entry: CodebuddyAccountEntry = {
        value: credential.accountUid ? `${credential.profile}:${credential.accountUid}` : name,
        uid: credential.accountUid,
        file: name,
        label: formatAccountLabel(credential, name),
        broken: false,
      };
      // uid 缺失（旧版客户端字段不全）无法归并，按独立登录保留。
      if (!credential.accountUid) {
        unmerged.push(entry);
        continue;
      }
      const key = `${credential.accountUid}::${credential.profile}`;
      const current = freshest.get(key);
      const refresh = credential.lastRefreshTime ?? 0;
      const mtime = fileMtimeMs(directory, name);
      if (current === undefined || isFresherCredential(refresh, mtime, current.refresh, current.mtime)) {
        freshest.set(key, { entry, refresh, mtime });
      }
    } catch (error) {
      const reason = error instanceof CodebuddyCredentialError ? error.message : "无法读取";
      unmerged.push({ value: name, uid: "", file: name, label: `${name}（${reason}）`, broken: true });
    }
  }
  return [...freshest.values()].map(({ entry }) => entry)
    .concat(unmerged)
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
}

/** 锁定账号不存在时的缺省告警：console.warn 在 launchd 下随 stderr 落进 gateway.log。 */
function defaultAccountFallbackWarning(account: string): void {
  console.warn(`[codebuddy] 配置锁定的账号 ${account} 不存在，本次运行回退 auto 选取最近刷新的登录；配置未修改`);
}

/**
 * 只读凭据缓存：扫描认证目录下全部 `.info`（不同产品/客户端各一份文件）缓存在
 * 内存，目录事件触发重扫（本机 CLI 会持续刷新这些文件），请求路径在凭据错误或
 * 上游 401/403 时经 refresh() 强制重扫兜底；网关自身绝不刷新 token；临近过期直接
 * 报带指引的错误。单个文件损坏/未知域名只跳过该文件，不拖垮其余有效登录。
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
  // 配置锁定的账号值（账号 uid，或历史 .info 文件名——选取时换算为同账号 uid）；
  // "auto"/缺省/路径形状一律 undefined（走全扫 + 最近刷新选取）。
  const lockedValue = typeof dependencies.preferredAccount === "string"
    && isCodebuddyAccountValue(dependencies.preferredAccount)
    && dependencies.preferredAccount !== "auto"
    ? dependencies.preferredAccount
    : undefined;
  let state: CacheState = { byProfile: new Map(), fileByProfile: new Map(), byUid: new Map(), fileByUid: new Map(), byAccount: new Map(), fileByAccount: new Map(), failure: undefined };
  /** 锁定文件缺失的 fallback 告警只记一次，文件恢复存在后重新布防。 */
  let accountFallbackWarned = false;
  let identity = "";
  let debounce: ReturnType<typeof setTimeout> | undefined;
  /**
   * 凭据列表只缓存在内存：请求选取不重扫，缓存更新来自 fs.watch 提前触发与
   * refresh() 强制重扫（请求路径在凭据错误/上游 401/403 时调用）。CLI `--switch`
   * 与 Web UI 的账号列表不走本缓存，始终实时全扫。
   */
  let closed = false;
  let watcher: fs.FSWatcher | undefined;

  function scanSync(): CacheState {
    return scanAuthDirectory(directory, readdir, dependencies.onCredentialRead);
  }

  function schedule(): void {
    clearTimeout(debounce);
    // 写入方（CLI 刷新）通常先写临时文件再 rename，短去抖合并同一轮事件。
    debounce = setTimeout(() => {
      debounce = undefined;
      applyScan();
    }, 100);
    debounce.unref?.();
  }

  let reconciled = false;
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
    // 构造时已同步扫过一次；之后 watcher 重建（目录被删除重建/inode 变化/watch 出错
    // 退出）意味着事件可能丢失，主动补一次重扫，不再依赖下次 refresh 兜底。
    if (reconciled) schedule();
    reconciled = true;
  }

  function applyScan(): void {
    state = scanSync();
  }

  // uid 锁定与 auto 都依赖全扫结果；目录内只有少量几 KB 的 .info，初始扫描成本可忽略。
  applyScan();
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
      /** 锁定凭据的地域/产品适配：地域不匹配直接报错（不跨地域回退），接口产品
       * 不一致时沿用同账号 token 只切换端点（对齐 auto 的同地域产品回退）。 */
      const lockedCredential = (credential: CodebuddyCredential): CodebuddyCredential => {
        const credentialRegion = profileRegion(credential.profile);
        if (region !== undefined && region !== credentialRegion) {
          throw new CodebuddyCredentialError(`没有可用的 ${region === "cn" ? "国内" : "国际"} CodeBuddy/WorkBuddy 登录凭据`);
        }
        const wanted = `${credentialRegion}-${product}` as CodebuddyProfile;
        const adapted = credential.profile === wanted
          ? credential
          : { ...credential, profile: wanted, endpoint: codebuddyEndpoint(wanted) };
        if (expired(adapted)) throw expiryError();
        return adapted;
      };
      // 锁定账号（`profile:uid` 钉住地域/产品；裸 uid 或换算后的历史文件名值跟随
      // 该账号最近刷新的登录）：同键取最新，文件轮换（CLI 刷新另写新文件）后经
      // watch/refresh 更新缓存并自动跟随；账号/地域不存在时告警一次并回落 auto，
      // 绝不改写配置。
      if (lockedValue !== undefined) {
        const selector = lockedAccountSelector(directory, lockedValue, existsSync);
        if (selector !== undefined) {
          const credential = selector.profile !== undefined
            ? state.byAccount.get(`${selector.uid}::${selector.profile}`)
            : state.byUid.get(selector.uid);
          if (credential !== undefined) {
            accountFallbackWarned = false;
            return lockedCredential(credential);
          }
        } else if (lockedValue.endsWith(".info") && existsSync(path.join(directory, lockedValue))) {
          // 无 uid 的旧客户端登录：无法归并到账号，保持文件级直读；
          // 损坏/符号链接等读取失败直接抛出（readCredential 已包成带指引的错误）。
          accountFallbackWarned = false;
          dependencies.onCredentialRead?.();
          return lockedCredential(readCredential(path.join(directory, lockedValue)));
        }
        if (!accountFallbackWarned) {
          accountFallbackWarned = true;
          (dependencies.onAccountFallback ?? defaultAccountFallbackWarning)(lockedValue);
        }
      }
      // auto 路径（含锁定文件缺失的运行期 fallback）：直接在内存缓存快照上选取，
      // 快照更新由 fs.watch 提前触发与请求路径的 refresh() 兜底负责。
      let credential = state.failure || state.byProfile.size === 0 ? undefined : select(state.byProfile, product, region);

      if (state.failure) throw state.failure;
      if (!credential) throw new CodebuddyCredentialError("CodeBuddy 凭据不可用");
      if (expired(credential)) throw expiryError();
      return credential;
    },
    refresh() {
      if (closed) return;
      applyScan();
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
