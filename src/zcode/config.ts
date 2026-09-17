import fs from "node:fs";
import path from "node:path";

export type ZcodeFamily = "zai" | "bigmodel";
export interface ZcodeProviderSnapshot {
  family: ZcodeFamily;
  providerID: string;
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
  /** 只统计实际业务 Key 的构建，不接收或暴露密钥。 */
  onCredentialBuild?: () => void;
  /** 用于验证差分检查只在需要时读取 provider 配置。 */
  onConfigRead?: () => void;
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
type Selection = Pick<ZcodeProviderSnapshot, "family" | "providerID">;
function isPlan(selection: Selection): boolean {
  return ["coding", "start"].some((plan) => selection.providerID === `builtin:${selection.family}-${plan}-plan`);
}
function readSelection(home: string): Selection {
  const setting = readPreferred(home, "setting.json");
  const family = setting.providerFamilyDomain;
  if (family !== "zai" && family !== "bigmodel") invalid("ZCode 未选择 zai 或 bigmodel 渠道");
  const selected = record(setting.modelProviderFamilySelectedKeys) ? setting.modelProviderFamilySelectedKeys[family] : undefined;
  if (typeof selected !== "string" || selected.indexOf(":") < 1) invalid("ZCode 当前渠道缺少有效 provider 选择");
  const providerID = selected.slice(selected.indexOf(":") + 1);
  if (!providerID) invalid("ZCode 当前 provider ID 为空");
  return { family, providerID };
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
function readRoute(home: string, { family, providerID }: Selection): Omit<ZcodeProviderSnapshot, "expiresAt"> {
  const config = readPreferred(home, "config.json");
  const provider = record(config.provider) && Object.hasOwn(config.provider, providerID) ? config.provider[providerID] : undefined;
  if (!record(provider) || !record(provider.options)) invalid("找不到 ZCode 当前 provider 的 options");
  if (provider.enabled === false || (typeof provider.systemDisabledReason === "string" && provider.systemDisabledReason.length > 0)) {
    invalid("ZCode 当前 provider 已停用");
  }
  const apiKey = provider.options.apiKey;
  if (typeof apiKey !== "string" || !apiKey || /[^\x21-\x7e]/.test(apiKey)) invalid("当前 provider 缺少有效 options.apiKey");
  return { family, providerID, apiKey, baseURL: baseURL(provider.options.baseURL), modelIds: modelIds(provider.models) };
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

/** 文件检查同步完成，凭证仅按 Key 的实际变化构建；事件不废弃有效快照。 */
export function createZcodeConfigCache(homeDirectory: string, dependencies: ZcodeCacheDependencies = {}): ZcodeConfigCache {
  const home = path.resolve(homeDirectory);
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
  let selection: Selection | undefined;
  let route: Omit<ZcodeProviderSnapshot, "expiresAt"> | undefined;
  let routeFailure: ZcodeConfigError | undefined;
  let oauthProjection: string | undefined;
  let firstEventAt: number | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryCheckedKey: string | undefined;
  let waiting: { promise: Promise<void>; resolve(): void } | undefined;

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
    clearTimeout(debounce);
    debounce = undefined;
    firstEventAt = undefined;
    const changed = new Set(dirtyFiles);
    dirtyFiles.clear();
    try { reconcile(); }
    catch { stop("无法持续监听 ZCode 配置，请检查权限并重启网关"); return; }
    try {
      let selectionChanged = false;
      if (!selection || changed.has("setting.json")) {
        let next: Selection;
        try { next = readSelection(home); }
        catch (error) { selection = undefined; throw error; }
        selectionChanged = !selection || next.family !== selection.family || next.providerID !== selection.providerID;
        selection = next;
      }
      let oauthChanged = false;
      if (isPlan(selection) && (selectionChanged || changed.has("credentials.json"))) {
        if (selectionChanged) oauthProjection = "[null,null,null]";
        try {
          const credentials = readPreferred(home, "credentials.json");
          // 只保存当前计划渠道的三个授权字段投影；全局 active_provider 不能改变模型选择。
          const projection = JSON.stringify([
            credentials[`oauth:${selection.family}:access_token`],
            credentials[`oauth:${selection.family}:refresh_token`],
            credentials.zcodejwttoken,
          ]);
          oauthChanged = projection !== oauthProjection;
          oauthProjection = projection;
        } catch { /* 缺失或损坏不撤销独立保存的业务 Key，也不回退到旧凭证文件。 */ }
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
      const hadFailure = failure !== undefined;
      const keyChanged = !credential || credential.apiKey !== next.apiKey;
      if (!credential || credential.apiKey !== next.apiKey) {
        dependencies.onCredentialBuild?.();
        credential = { apiKey: next.apiKey, expiresAt: expiresAt(next.apiKey) };
        expiryCheckedKey = undefined;
      }
      if (credential.expiresAt !== undefined && credential.expiresAt <= now()) {
        expiryCheckedKey = next.apiKey;
        invalid("ZCode 当前业务 Key 已过期");
      }
      if (!snapshot || snapshot.family !== next.family || snapshot.providerID !== next.providerID
        || snapshot.apiKey !== next.apiKey || snapshot.baseURL !== next.baseURL
        || snapshot.modelIds.length !== next.modelIds.length
        || snapshot.modelIds.some((id, index) => id !== next.modelIds[index])) {
        snapshot = Object.freeze({ ...next, ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }) });
      }
      failure = undefined;
      if (keyChanged || hadFailure) armExpiry();
    } catch (error) {
      failure = error instanceof ZcodeConfigError ? error : new ZcodeConfigError("无法检查 ZCode 当前配置，请修复配置");
      clearTimeout(expiryTimer);
    } finally { finish(); }
  }
  function expire(): void {
    if (!snapshot || snapshot.expiresAt === undefined || snapshot.expiresAt > now()) return;
    // 第一个到期请求执行共享重读；同值过期之后只等待文件事件。
    if (expiryCheckedKey !== snapshot.apiKey) {
      expiryCheckedKey = snapshot.apiKey;
      dirtyFiles.add("config.json");
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
      if (!snapshot) throw new ZcodeConfigError("ZCode 配置缓存不可用");
      return snapshot;
    },
    close() { stop("ZCode 配置监听已关闭，请重启网关"); },
  };
}
