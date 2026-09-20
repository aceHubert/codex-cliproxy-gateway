import fs from "node:fs";
import path from "node:path";
import { decryptZcodeCredential } from "./credential-cipher.ts";
import { readZcodeIndividualCredential } from "./individual-credentials.ts";
import {
  readZcodeTeamCredentialInputs,
  resolveZcodeTeamApiKey,
} from "./team-credentials.ts";

export type ZcodeFamily = "zai" | "bigmodel";
export interface ZcodeSelection {
  family: ZcodeFamily;
  providerID: string;
  kind: "individual-coding-plan" | "team-coding-plan" | "start-plan" | "api-key";
  team?: {
    productId: string;
    organizationId: string;
    projectId: string;
  };
}
export interface ZcodeProviderSnapshot {
  family: ZcodeFamily;
  providerID: string;
  /** 该快照所属的套餐连接形态；决定对外 slug 作用域、显示名与鉴权头差异。 */
  plan: ZcodeSelection["kind"];
  apiKey: string;
  baseURL: string;
  modelIds: readonly string[];
  expiresAt?: number;
}
export interface ZcodeConfigCache {
  get(): Promise<ZcodeProviderSnapshot>;
  close(): void;
}
export class ZcodeConfigError extends Error {}
export interface ZcodeCacheDependencies {
  watch?: typeof fs.watch;
  stat?: typeof fs.statSync;
  now?: () => number;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /**
   * 固定解析某个套餐槽位（个人/团队/Start Plan/api-key），缺省跟随 ZCode 客户端
   * 当前渠道的选择。套餐槽位从两个渠道的连接形态汇总而来，当前渠道优先。
   */
  plan?: ZcodeSelection["kind"];
  /** 只统计实际业务 Key 的构建，不接收或暴露密钥。 */
  onCredentialBuild?: () => void;
  /** 用于验证差分检查只在需要时读取 provider 配置。 */
  onConfigRead?: () => void;
  /** 套餐选择变化或当前选择不可解析时通知调用方，用于立即撤下已失效的下游目录条目。 */
  onSelectionChange?: () => void;
  /** 内存快照（渠道/套餐/模型集合/凭据）变化后触发，用于重建对外目录。 */
  onSnapshotChange?: (snapshot: ZcodeProviderSnapshot) => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(message: string): never {
  throw new ZcodeConfigError(`${message}；请在 ZCode 中修复当前 provider 配置。`);
}
function readJson(file: string): Record<string, unknown> {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!record(value)) invalid("ZCode 配置必须是 JSON 对象");
    return value;
  } finally { fs.closeSync(fd); }
}
/** 三个文件各自选择生效位置；损坏、权限和符号链接不能触发回退。 */
function readPreferred(home: string, name: string): Record<string, unknown> {
  try {
    try { return readJson(path.join(home, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return readJson(path.join(home, "v2", name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") invalid("ZCode 配置文件不能是符号链接");
    invalid(`无法读取 ZCode ${name}`);
  }
}
/** 仅文件缺失时返回空对象；损坏、权限和符号链接仍由 readPreferred 明确报错。 */
function readOptionalPreferred(home: string, name: string): Record<string, unknown> {
  const present = [path.join(home, name), path.join(home, "v2", name)].some((file) => {
    try { fs.lstatSync(file); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  });
  return present ? readPreferred(home, name) : {};
}
function baseURL(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("当前 provider 缺少 Anthropic baseURL");
  let url: URL;
  try { url = new URL(value); } catch { invalid("当前 provider 的 Anthropic baseURL 无效"); }
  const allowed = ["z.ai", "bigmodel.cn"].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  if (url.protocol !== "https:" || url.username || url.password || !allowed || url.search || url.hash
    || !/\/anthropic(?:\/v1)?\/*$/.test(url.pathname)) {
    invalid("当前 provider 必须使用官方 HTTPS Anthropic 基址");
  }
  return url.href.replace(/\/+$/, "");
}
function isPlan(selection: ZcodeSelection): boolean {
  return selection.kind !== "api-key";
}
/**
 * Start Plan 的请求鉴权走套餐服务凭证：`/api/auth/z/login` 用 OAuth token 换出的
 * biz JWT（credentials 的 zcodejwttoken）。实测 OAuth access token 会被 zcode-plan
 * 中继与 billing 一并 401；镜像里的旧 JWT 仅作官方同款回退（readRoute 提供）。
 */
function startPlanApiKey(credentials: Record<string, unknown>, _family: ZcodeFamily, env: NodeJS.ProcessEnv = process.env): string {
  const value = credentials.zcodejwttoken;
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return decryptZcodeCredential(value, env).trim();
  } catch {
    invalid("Start Plan 凭据解密失败");
  }
}
/**
 * ZCode 3.12.3 起切换套餐只写 `providerFamilyConnectionSelections[family].kind`，
 * legacy `modelProviderFamilySelectedKeys` 已冻结。在入口把已知 kind 归一化为与 legacy
 * 解析同构的 providerID，下游镜像查找、套餐判定与协议转换零改动。
 * 条目缺失或形状非法时返回 undefined，由 legacy 路径接管：3.12.3 的迁移是惰性持久化，
 * 未重启 / api-key 模式被跳过 / team 连接未解析三个窗口下磁盘长期只有 legacy。
 */
function connectionSelection(setting: Record<string, unknown>, family: ZcodeFamily): Record<string, unknown> | undefined {
  const selections = setting.providerFamilyConnectionSelections;
  if (!record(selections)) return undefined;
  const entry = selections[family];
  if (!record(entry) || typeof entry.kind !== "string" || !entry.kind) return undefined;
  return entry;
}
function teamContext(entry: Record<string, unknown>): ZcodeSelection["team"] {
  const values = [entry.productId, entry.organizationId, entry.projectId].map((value) => {
    if (typeof value !== "string") return "";
    return value.trim();
  });
  if (!values.every((value) => value && !/[\x00-\x1f\x7f]/.test(value))) {
    invalid("团队套餐缺少有效的 productId、organizationId 或 projectId");
  }
  return { productId: values[0]!, organizationId: values[1]!, projectId: values[2]! };
}
function legacyKind(family: ZcodeFamily, providerID: string): ZcodeSelection["kind"] {
  if (providerID === `builtin:${family}-coding-plan`) return "individual-coding-plan";
  if (providerID === `builtin:${family}-start-plan`) return "start-plan";
  return "api-key";
}
function selectionIdentity(selection: ZcodeSelection): string {
  return JSON.stringify([selection.family, selection.kind, selection.providerID, selection.team ?? null]);
}
/**
 * ZCode 3.14 起 `providerFamilyConnectionSelections[family].kind` 只表达当前渠道
 * 的连接形态，切换渠道后另一渠道的旧连接可能继续留在磁盘里。只有该渠道仍持有
 * OAuth access token 时才把槽位暴露给会话；否则个人/团队请求会命中已失效连接。
 * 各渠道严格读取自己的 key，不能回退到另一渠道。
 */
function hasOAuthCredential(credentials: Record<string, unknown>, family: ZcodeFamily): boolean {
  const token = credentials[`oauth:${family}:access_token`];
  return typeof token === "string" && token.trim().length > 0;
}
/**
 * 单个渠道的双源选择解析：3.12.3 的 `providerFamilyConnectionSelections[family].kind`
 * 优先，条目缺失或形状非法时回退该渠道的 legacy `modelProviderFamilySelectedKeys`。
 * `scope` 只用于报错文案：当前渠道沿用「当前渠道」，另一渠道写明渠道名。
 */
function familySelection(setting: Record<string, unknown>, family: ZcodeFamily, scope: string): ZcodeSelection {
  const entry = connectionSelection(setting, family);
  if (entry) {
    const kind = entry.kind;
    if (kind === "individual-coding-plan") return { family, kind, providerID: `builtin:${family}-coding-plan` };
    if (kind === "team-coding-plan") {
      return { family, kind, providerID: `builtin:${family}-coding-plan`, team: teamContext(entry) };
    }
    if (kind === "start-plan") return { family, kind, providerID: `builtin:${family}-start-plan` };
    // 条目存在且 kind 已解析，说明用户做了真实的新选择；回退会静默跟随冻结的旧渠道。
    invalid(`ZCode ${scope}的选择类型 "${kind}" 暂不被网关支持，请在 ZCode 中切换到 Coding Plan 或 Start Plan`);
  }
  const selected = record(setting.modelProviderFamilySelectedKeys) ? setting.modelProviderFamilySelectedKeys[family] : undefined;
  if (typeof selected !== "string" || selected.indexOf(":") < 1) invalid(`ZCode ${scope}缺少有效 provider 选择`);
  const providerID = selected.slice(selected.indexOf(":") + 1);
  if (!providerID) invalid(`ZCode ${scope}的 provider ID 为空`);
  return { family, kind: legacyKind(family, providerID), providerID };
}

export interface ZcodePlanSelections {
  /** 当前渠道（providerFamilyDomain）；失败根因优先取它的解析错误。 */
  domain: ZcodeFamily;
  /** 各套餐槽位当前可解析的选择；同一槽位两个渠道都有时取当前渠道。 */
  plans: Partial<Record<ZcodeSelection["kind"], ZcodeSelection>>;
  /** 渠道级解析失败（未知 kind、缺 provider 选择等）；该渠道的所有槽位都不可用。 */
  failures: Partial<Record<ZcodeFamily, ZcodeConfigError>>;
}

const PLAN_UNAVAILABLE: Record<ZcodeSelection["kind"], string> = {
  "individual-coding-plan": "没有可用的个人 Coding Plan 连接，请在 ZCode 中连接个人套餐",
  "team-coding-plan": "没有可用的团队 Coding Plan 连接，请在 ZCode 中连接团队套餐",
  "start-plan": "没有可用的 Start Plan 连接，请在 ZCode 中连接后重试",
  "api-key": "ZCode 当前渠道未选择自定义 provider",
};

/**
 * 按套餐槽位汇总两个渠道的连接形态（当前渠道优先），供网关把多个套餐同时暴露给
 * 会话级路由。api-key 只跟随当前渠道的自定义 provider 选择；单个渠道解析失败只
 * 影响该渠道能提供的槽位，不拖垮另一个渠道。
 */
function readZcodePlanSelections(home: string): ZcodePlanSelections {
  const setting = readPreferred(home, "setting.json");
  const domain = setting.providerFamilyDomain;
  if (domain !== "zai" && domain !== "bigmodel") invalid("ZCode 未选择 zai 或 bigmodel 渠道");
  const plans: ZcodePlanSelections["plans"] = {};
  const failures: ZcodePlanSelections["failures"] = {};
  const other = domain === "zai" ? "bigmodel" : "zai";
  // 文件缺失只撤销 OAuth 套餐槽位；损坏或权限问题仍需明确报错，不能静默降级。
  const credentials = readOptionalPreferred(home, "credentials.json");
  for (const family of [domain, other] as const) {
    try {
      const selection = familySelection(setting, family, family === domain ? "当前渠道" : `${family} 渠道`);
      if (selection.kind === "api-key") {
        if (family === domain) plans["api-key"] ??= selection;
      } else if (hasOAuthCredential(credentials, family)) {
        plans[selection.kind] ??= selection;
      }
    } catch (error) {
      failures[family] = error instanceof ZcodeConfigError ? error : new ZcodeConfigError(`无法解析 ZCode ${family} 渠道选择`);
    }
  }
  // Start Plan 不依赖连接形态：账号态 OAuth 即可鉴权，资格由 billing/balance 判定、
  // 上游最终拒绝；槽位兜底指向当前渠道的 start-plan provider，让免费档始终可选。
  plans["start-plan"] ??= { family: domain, kind: "start-plan", providerID: `builtin:${domain}-start-plan` };
  return { domain, plans, failures };
}

function readSelection(home: string, plan?: ZcodeSelection["kind"]): ZcodeSelection {
  if (plan === undefined) {
    const setting = readPreferred(home, "setting.json");
    const family = setting.providerFamilyDomain;
    if (family !== "zai" && family !== "bigmodel") invalid("ZCode 未选择 zai 或 bigmodel 渠道");
    return familySelection(setting, family, "当前渠道");
  }
  const { domain, plans, failures } = readZcodePlanSelections(home);
  const selection = plans[plan];
  if (selection) return selection;
  // 槽位缺失时优先透出当前渠道的解析根因（如未知 kind），比笼统的缺连接提示更可
  // 执行；另一渠道的失败与本套餐无关，不劫持提示。根因消息自带修复指引，不再叠
  // 加 invalid 的后缀。
  throw new ZcodeConfigError(failures[domain]?.message ?? PLAN_UNAVAILABLE[plan]);
}
/** models 的字典键才是上游 ID；显示名和其他元数据不参与路由投影。 */
function modelIds(value: unknown): readonly string[] {
  if (!record(value)) return Object.freeze([]);
  const ids = Object.keys(value).map((id) => id.trim()).filter(Boolean).sort((a, b) => {
    const lowerA = a.toLowerCase();
    const lowerB = b.toLowerCase();
    // 同一 ID 的不同拼写也稳定排序，避免字典插入顺序改变所选拼写。
    return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const seen = new Set<string>();
  return Object.freeze(ids.filter((id) => {
    const normalized = id.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }));
}
function readRoute(home: string, selection: ZcodeSelection): Omit<ZcodeProviderSnapshot, "expiresAt" | "apiKey"> & { apiKey?: string } {
  const { family, providerID, kind: plan } = selection;
  const config = readPreferred(home, "config.json");
  const provider = record(config.provider) && Object.hasOwn(config.provider, providerID) ? config.provider[providerID] : undefined;
  if (!record(provider) || !record(provider.options)) invalid("找不到 ZCode 当前 provider 的 options");
  if (selection.kind === "team-coding-plan") {
    // team 的 enabled 镜像仍跟随个人 OAuth 状态；团队权益由官方项目接口校验。
    return { family, providerID, plan, baseURL: baseURL(provider.options.baseURL), modelIds: modelIds(provider.models) };
  }
  if (selection.kind === "start-plan") {
    // start-plan 的镜像状态与旧 JWT 都可能冻结在个人 Coding Plan 结果；鉴权首选
    // credentials 的 zcodejwttoken（biz JWT），镜像 JWT 仅作官方同款回退，权益由
    // ZCode 自己的 billing/balance 判定，上游仍会最终拒绝。
    const mirror = provider.options.apiKey;
    return { family, providerID, plan,
      ...(typeof mirror === "string" && mirror && !/[^\x21-\x7e]/.test(mirror) ? { apiKey: mirror } : {}),
      baseURL: baseURL(provider.options.baseURL), modelIds: modelIds(provider.models) };
  }
  if (provider.enabled === false || (typeof provider.systemDisabledReason === "string" && provider.systemDisabledReason.length > 0)) {
    invalid("ZCode 当前 provider 已停用");
  }
  const apiKey = provider.options.apiKey;
  if (typeof apiKey !== "string" || !apiKey || /[^\x21-\x7e]/.test(apiKey)) invalid("当前 provider 缺少有效 options.apiKey");
  return { family, providerID, plan, apiKey, baseURL: baseURL(provider.options.baseURL), modelIds: modelIds(provider.models) };
}
function expiresAt(apiKey: string): number | undefined {
  const parts = apiKey.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (record(payload) && typeof payload.exp === "number" && Number.isFinite(payload.exp)
      && Number.isFinite(payload.exp * 1000)) return payload.exp * 1000;
  } catch { /* 非 JWT Key 不推测有效期。 */ }
}

/**
 * 本机 ZCode 配置是否就绪：setting.json（渠道/provider 选择）与 config.json
 * （provider 路由）都存在才算可用——两者缺一，缓存取快照时必然报错。只做
 * 存在性探测，不读文件内容；home 与 v2 两种布局各自按 readPreferred 的回退顺序判定。
 */
export function zcodeConfigPresent(homeDirectory: string): boolean {
  const home = path.resolve(homeDirectory);
  const locations = (name: string) => [path.join(home, name), path.join(home, "v2", name)];
  return ["setting.json", "config.json"].every((name) => locations(name).some((file) => fs.existsSync(file)));
}

/** 文件检查同步完成，凭证仅按 Key 的实际变化构建；事件不废弃有效快照。 */
export function createZcodeConfigCache(homeDirectory: string, dependencies: ZcodeCacheDependencies = {}): ZcodeConfigCache {
  const home = path.resolve(homeDirectory);
  const plan = dependencies.plan;
  const now = dependencies.now ?? Date.now;
  const watch = dependencies.watch ?? fs.watch;
  const stat = dependencies.stat ?? fs.statSync;
  const names = new Map<string, Set<string>>();
  let child = path.join(home, "v2");
  while (path.dirname(child) !== child) {
    const parent = path.dirname(child);
    names.set(parent, new Set([path.basename(child)]));
    child = parent;
  }
  for (const directory of [home, path.join(home, "v2")]) {
    const entries = names.get(directory) ?? new Set<string>();
    for (const file of ["setting.json", "config.json", "credentials.json"]) entries.add(file);
    names.set(directory, entries);
  }
  const directories = [...names.keys()].sort((a, b) => a.length - b.length);
  const watchers = new Map<string, { watcher: fs.FSWatcher; identity: string; closing: boolean }>();
  let snapshot: ZcodeProviderSnapshot | undefined;
  // 即使路由暂时失效也保留上次凭证语义，恢复同值配置不会重新计算 exp。
  let credential: { apiKey: string; expiresAt?: number } | undefined;
  let failure: ZcodeConfigError | undefined;
  let closed = false;
  const dirtyFiles = new Set<string>(["setting.json", "config.json", "credentials.json"]);
  let selection: ZcodeSelection | undefined;
  let route: (Omit<ZcodeProviderSnapshot, "expiresAt" | "apiKey"> & { apiKey?: string }) | undefined;
  let routeFailure: ZcodeConfigError | undefined;
  let oauthProjection: string | undefined;
  let teamCredential: { identity: string; fingerprint: string; apiKey: string } | undefined;
  let teamCredentialFingerprint: string;
  let teamForceRefresh = false;
  let credentialGeneration = 0;
  let resolving: { generation: number; promise: Promise<void> } | undefined;
  let firstEventAt: number | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryCheckedKey: string | undefined;
  let waiting: { promise: Promise<void>; resolve(): void } | undefined;
  /** 最近一次已通知调用方的快照；仅按对象身份比较，避免重复重建目录。 */
  let notifiedSnapshot: ZcodeProviderSnapshot | undefined;

  function finish(): void { const previous = waiting; waiting = undefined; previous?.resolve(); }
  function stop(message: string): void {
    if (closed) return;
    closed = true;
    dirtyFiles.clear();
    selection = undefined;
    route = undefined;
    oauthProjection = undefined;
    snapshot = undefined;
    credential = undefined;
    teamCredential = undefined;
    teamCredentialFingerprint = "";
    teamForceRefresh = false;
    credentialGeneration++;
    resolving = undefined;
    expiryCheckedKey = undefined;
    failure = new ZcodeConfigError(message);
    clearTimeout(debounce);
    clearTimeout(expiryTimer);
    for (const entry of watchers.values()) { entry.closing = true; entry.watcher.close(); }
    watchers.clear();
    finish();
  }
  function markDirty(file?: string): void {
    if (closed || (file === "credentials.json" && selection && !isPlan(selection))) return;
    if (file === "credentials.json" && selection?.kind === "team-coding-plan") {
      credentialGeneration++;
      resolving = undefined;
      teamCredential = undefined;
      credential = undefined;
      snapshot = undefined;
      expiryCheckedKey = undefined;
      clearTimeout(expiryTimer);
    }
    if (file === "setting.json" && selection) {
      try {
        const next = readSelection(home, plan);
        if (selectionIdentity(next) !== selectionIdentity(selection)) {
          credentialGeneration++;
          resolving = undefined;
          teamCredential = undefined;
          teamCredentialFingerprint = "";
          teamForceRefresh = false;
          credential = undefined;
          snapshot = undefined;
          expiryCheckedKey = undefined;
          clearTimeout(expiryTimer);
        }
      } catch {
        snapshot = undefined;
        credential = undefined;
      }
    }
    if (file) dirtyFiles.add(file);
    else for (const name of ["setting.json", "config.json", "credentials.json"]) dirtyFiles.add(name);
    firstEventAt ??= now();
    clearTimeout(debounce);
    debounce = setTimeout(check, Math.max(0, Math.min(100, 500 - (now() - firstEventAt))));
    debounce.unref?.();
  }
  function reconcile(): void {
    const present = new Set<string>();
    for (const directory of directories) {
      let info: fs.Stats;
      try { info = stat(directory); }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      if (!info.isDirectory()) continue;
      present.add(directory);
      const identity = `${info.dev}:${info.ino}`;
      const previous = watchers.get(directory);
      if (previous?.identity === identity) continue;
      if (previous) { previous.closing = true; previous.watcher.close(); watchers.delete(directory); }
      const watcher = watch(directory, { persistent: false }, (_event, filename) => {
        const name = filename?.toString();
        if (name === undefined || names.get(directory)!.has(name)) {
          markDirty(name && ["setting.json", "config.json", "credentials.json"].includes(name) ? name : undefined);
        }
      });
      const entry = { watcher, identity, closing: false };
      const failed = () => { if (!entry.closing) stop("无法持续监听 ZCode 配置，请检查权限并重启网关"); };
      watcher.on("error", failed);
      watcher.on("close", failed);
      watchers.set(directory, entry);
    }
    for (const [directory, entry] of watchers) {
      if (!present.has(directory)) { entry.closing = true; entry.watcher.close(); watchers.delete(directory); }
    }
  }
  function armExpiry(): void {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (!snapshot || snapshot.expiresAt === undefined || failure) return;
    const remaining = snapshot.expiresAt - now();
    if (remaining <= 0) return;
    // Node/Bun 对超过有符号 32 位毫秒数的定时器会截断，分段等待。
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (closed || !snapshot) return;
      if (snapshot.expiresAt! <= now()) expire();
      else armExpiry();
    }, Math.min(remaining, 2_147_483_647));
    expiryTimer.unref?.();
  }
  function check(): void {
    if (closed) return;
    const beforeSnapshot = snapshot;
    clearTimeout(debounce);
    debounce = undefined;
    firstEventAt = undefined;
    const changed = new Set(dirtyFiles);
    dirtyFiles.clear();
    try { reconcile(); }
    catch { stop("无法持续监听 ZCode 配置，请检查权限并重启网关"); return; }
    try {
      let selectionChanged = false;
      if (!selection || changed.has("setting.json") || (isPlan(selection) && changed.has("credentials.json"))) {
        let next: ZcodeSelection;
        try { next = readSelection(home, plan); }
        catch (error) {
          const hadSelection = selection !== undefined;
          selection = undefined;
          // 选择不可解析时旧套餐目录必须立即失效，不能继续留在客户端缓存里。
          if (hadSelection) dependencies.onSelectionChange?.();
          throw error;
        }
        const hadSelection = selection !== undefined;
        selectionChanged = !selection || selectionIdentity(next) !== selectionIdentity(selection);
        if (hadSelection && selectionChanged) dependencies.onSelectionChange?.();
        if (selectionChanged) {
          credentialGeneration++;
          resolving = undefined;
          teamCredential = undefined;
          teamCredentialFingerprint = "";
          teamForceRefresh = false;
          credential = undefined;
          snapshot = undefined;
          expiryCheckedKey = undefined;
          clearTimeout(expiryTimer);
        }
        selection = next;
      }
      let oauthChanged = false;
      let personalApiKey: string | undefined;
      let teamInputs: Awaited<ReturnType<typeof readZcodeTeamCredentialInputs>> | undefined;
      if (isPlan(selection) && (selectionChanged || changed.has("credentials.json"))) {
        if (selectionChanged) {
          oauthProjection = selection.kind === "team-coding-plan" ? undefined : "[null,null,null]";
          teamCredentialFingerprint = "";
        }
        try {
          const credentials = readOptionalPreferred(home, "credentials.json");
          if (selection.kind === "team-coding-plan") {
            teamInputs = readZcodeTeamCredentialInputs(credentials, selection.family, dependencies.env);
            const nextFingerprint = teamInputs.fingerprint;
            if (teamCredentialFingerprint !== nextFingerprint) {
              teamCredentialFingerprint = nextFingerprint;
              oauthChanged = true;
            }
          } else {
            // 只保存当前计划渠道的授权字段与个人账号 Key 投影；全局 active_provider 不能改变模型选择。
            const individual = selection.kind === "individual-coding-plan"
              ? readZcodeIndividualCredential(credentials, selection.family, dependencies.env)
              : undefined;
            const key = individual?.state === "available"
              ? individual.apiKey
              : individual?.state === "unavailable"
                ? ""
                : selection.kind === "start-plan"
                  ? startPlanApiKey(credentials, selection.family, dependencies.env)
                  : "";
            // 账号身份存在却拿不到该账号的 Key 时禁止镜像回退：切换账号后
            // config.json 里的旧 Key 可能属于上一账号。
            if (individual?.state === "unavailable") {
              throw new ZcodeConfigError("ZCode 个人套餐凭据不可用；请在 ZCode 中重新连接当前账号");
            }
            personalApiKey = key || undefined;
            const projection = JSON.stringify([
              credentials[`oauth:${selection.family}:access_token`],
              credentials[`oauth:${selection.family}:refresh_token`],
              credentials.zcodejwttoken,
              individual?.state === "available" ? individual.identity : individual?.state ?? null,
              key,
            ]);
            oauthChanged = projection !== oauthProjection;
            oauthProjection = projection;
          }
        } catch (error) {
          if (selection.kind === "team-coding-plan") {
            snapshot = undefined;
            credential = undefined;
            throw error instanceof ZcodeConfigError ? error : new ZcodeConfigError("无法读取 ZCode 团队凭据");
          }
          if (selection.kind === "start-plan") {
            snapshot = undefined;
            credential = undefined;
            throw error instanceof ZcodeConfigError ? error : new ZcodeConfigError("无法读取 ZCode Start Plan 凭据");
          }
          if (error instanceof ZcodeConfigError) {
            snapshot = undefined;
            credential = undefined;
            throw error;
          }
          /* 无账号身份（旧安装）仍保留 config 镜像里的独立业务 Key。 */
        }
      } else if (selectionChanged) oauthProjection = undefined;
      if (selectionChanged || changed.has("config.json") || oauthChanged || (!route && !routeFailure)) {
        dependencies.onConfigRead?.();
        try { route = readRoute(home, selection); routeFailure = undefined; }
        catch (error) {
          route = undefined;
          routeFailure = error instanceof ZcodeConfigError ? error : new ZcodeConfigError("无法读取 ZCode provider 配置");
        }
      }
      if (routeFailure) throw routeFailure;
      if (!route) invalid("ZCode 当前路由不可用");
      const next = route;
      if (selection.kind === "team-coding-plan") {
        const identity = selectionIdentity(selection);
        const fingerprint = teamCredentialFingerprint;
        const expired = credential?.expiresAt !== undefined && credential.expiresAt <= now();
        const mustResolve = teamForceRefresh || expired || !teamCredential
          || teamCredential.identity !== identity || teamCredential.fingerprint !== fingerprint;
        if (resolving) {
          snapshot = undefined;
          return;
        }
        if (!teamInputs || !fingerprint || mustResolve) {
          if (!teamInputs || !fingerprint) {
            const credentials = readOptionalPreferred(home, "credentials.json");
            teamInputs = readZcodeTeamCredentialInputs(credentials, selection.family, dependencies.env);
            teamCredentialFingerprint = teamInputs.fingerprint;
          }
          const generation = ++credentialGeneration;
          const targetInputs = teamInputs;
          snapshot = undefined;
          credential = undefined;
          expiryCheckedKey = undefined;
          teamForceRefresh = false;
          clearTimeout(expiryTimer);
          const promise = (async () => {
            try {
              const apiKey = await resolveZcodeTeamApiKey(selection, targetInputs, dependencies);
              if (credentialGeneration !== generation || selection.kind !== "team-coding-plan") return;
              dependencies.onCredentialBuild?.();
              credential = { apiKey, expiresAt: expiresAt(apiKey) };
              teamCredential = { identity, fingerprint: teamCredentialFingerprint!, apiKey };
              if (credential.expiresAt !== undefined && credential.expiresAt <= now()) invalid("ZCode 当前业务 Key 已过期");
              const currentRoute = route;
              if (!currentRoute) invalid("ZCode 当前路由不可用");
              snapshot = Object.freeze({ ...currentRoute, apiKey,
                ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }) });
              failure = undefined;
              armExpiry();
            } catch {
              if (credentialGeneration !== generation) return;
              snapshot = undefined;
              credential = undefined;
              teamCredential = undefined;
              failure = new ZcodeConfigError("无法读取 ZCode 团队项目凭据；请在 ZCode 中重新连接团队套餐");
              clearTimeout(expiryTimer);
            } finally {
              if (credentialGeneration === generation) resolving = undefined;
              finish();
            }
          })();
          resolving = { generation, promise };
          return;
        }
        const cachedTeamCredential = teamCredential;
        if (!cachedTeamCredential) invalid("ZCode 团队项目凭据不可用");
        const apiKey = cachedTeamCredential.apiKey;
        const expires = expiresAt(apiKey);
        credential = { apiKey, expiresAt: expires };
        if (expires !== undefined && expires <= now()) {
          expiryCheckedKey = apiKey;
          invalid("ZCode 当前业务 Key 已过期");
        }
        snapshot = Object.freeze({ ...next, apiKey, ...(expires === undefined ? {} : { expiresAt: expires }) });
        failure = undefined;
        armExpiry();
        return;
      }
      // start-plan：上次套餐凭据优先于镜像 JWT（镜像只是无 zcodejwttoken 时的引导回退），
      // 否则不重读凭据的检查轮次会把 key 静默换成可能冻结的镜像值。
      const routeApiKey = personalApiKey
        ?? (selection.kind === "start-plan" ? credential?.apiKey ?? next.apiKey : next.apiKey);
      if (!routeApiKey) invalid(selection.kind === "start-plan" ? "Start Plan 缺少可用的 zcode JWT 凭据" : "当前 provider 缺少有效 options.apiKey");
      const hadFailure = failure !== undefined;
      const keyChanged = !credential || credential.apiKey !== routeApiKey;
      if (keyChanged) {
        dependencies.onCredentialBuild?.();
        credential = { apiKey: routeApiKey, expiresAt: expiresAt(routeApiKey) };
        expiryCheckedKey = undefined;
      }
      const currentCredential = credential;
      if (!currentCredential) invalid("ZCode 当前业务 Key 不可用");
      if (currentCredential.expiresAt !== undefined && currentCredential.expiresAt <= now()) {
        expiryCheckedKey = routeApiKey;
        invalid("ZCode 当前业务 Key 已过期");
      }
      if (!snapshot || snapshot.family !== next.family || snapshot.providerID !== next.providerID
        || snapshot.plan !== next.plan
        || snapshot.apiKey !== routeApiKey || snapshot.baseURL !== next.baseURL
        || snapshot.modelIds.length !== next.modelIds.length
        || snapshot.modelIds.some((id, index) => id !== next.modelIds[index])) {
        snapshot = Object.freeze({ family: next.family, providerID: next.providerID, plan: next.plan, apiKey: routeApiKey,
          baseURL: next.baseURL, modelIds: next.modelIds,
          ...(currentCredential.expiresAt === undefined ? {} : { expiresAt: currentCredential.expiresAt }) });
      }
      failure = undefined;
      if (keyChanged || hadFailure) armExpiry();
    } catch (error) {
      failure = error instanceof ZcodeConfigError ? error : new ZcodeConfigError("无法检查 ZCode 当前配置，请修复配置");
      clearTimeout(expiryTimer);
    } finally {
      // 快照身份变化才通知：watch 驱动的账号/套餐/模型集合变化由此重建对外目录。
      if (snapshot !== beforeSnapshot && snapshot !== notifiedSnapshot) {
        notifiedSnapshot = snapshot;
        if (snapshot) dependencies.onSnapshotChange?.(snapshot);
      }
      finish();
    }
  }
  function expire(): void {
    if (!snapshot || snapshot.expiresAt === undefined || snapshot.expiresAt > now()) return;
    // 第一个到期请求执行共享重读；同值过期之后只等待文件事件。
    if (expiryCheckedKey !== snapshot.apiKey) {
      expiryCheckedKey = snapshot.apiKey;
      dirtyFiles.add("config.json");
      if (selection?.kind === "team-coding-plan") {
        dirtyFiles.add("credentials.json");
        teamForceRefresh = true;
      }
      check();
    }
  }
  check();
  return {
    async get() {
      if (!closed) expire();
      if ((!snapshot || failure) && dirtyFiles.size > 0) {
        if (!waiting) {
          let resolve!: () => void;
          const promise = new Promise<void>((done) => { resolve = done; });
          waiting = { promise, resolve };
        }
        await waiting.promise;
      }
      if (failure) throw failure;
      if (resolving) await resolving.promise;
      if (failure) throw failure;
      if (!snapshot) throw new ZcodeConfigError("ZCode 配置缓存不可用");
      return snapshot;
    },
    close() { stop("ZCode 配置监听已关闭，请重启网关"); },
  };
}
