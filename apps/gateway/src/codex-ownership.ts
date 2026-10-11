import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_RUNTIME_DIRECTORY, LEGACY_RUNTIME_DIRECTORY, realPathOrResolve } from "./paths.ts";
import type { ResolvedPaths } from "./types.ts";

const OWNER_FILE = ".codex-cliproxy-owner.json";

interface ClientState {
  codexHome?: string;
  codexConfigManaged?: boolean;
  uninstallClientRestored?: boolean;
  configBackup?: { backup?: string };
  defaultRuntimeMigratedFrom?: string;
}

function readState(file: string): ClientState | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("invalid object");
    return state as ClientState;
  } catch (error) {
    throw new Error(`Cannot read installation state ${file}: ${String(error)}`);
  }
}

function normalizeCodexHome(value: string, home: string): string {
  const trimmed = value.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? path.join(home, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new Error(`CODEX_HOME must be an absolute path: ${value}; use an absolute path or ~/…`);
  }
  return realPathOrResolve(expanded);
}

function backupCodexHome(state: ClientState, home: string): string | undefined {
  const backup = state.configBackup?.backup;
  // 只接受本项目生成的生产备份命名，不能从任意文件位置猜测客户端目录。
  if (typeof backup !== "string" || !path.isAbsolute(backup)) return undefined;
  if (!/^config\.toml(?:\.bak-cliproxy-gateway-\d{14}|\.\d[\dT:_-]*\.backup)$/.test(path.basename(backup))) {
    return undefined;
  }
  return normalizeCodexHome(path.dirname(backup), home);
}

function withCodexHome(paths: ResolvedPaths, codexHome: string): ResolvedPaths {
  return {
    ...paths,
    codexHome,
    configToml: path.join(codexHome, "config.toml"),
    modelsCacheFile: path.join(codexHome, "models_cache.json"),
  };
}

/** 已安装实例恢复持久化的客户端目录，显式环境覆盖必须与原绑定一致。 */
export function resolveInstalledCodexPaths(
  paths: ResolvedPaths,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPaths {
  const state = readState(paths.stateFile);
  const explicitHome = env.CODEX_HOME?.trim()
    ? normalizeCodexHome(env.CODEX_HOME, paths.home) : undefined;
  if (!state) return withCodexHome(paths, explicitHome ?? normalizeCodexHome(paths.codexHome, paths.home));
  const recordedHome = typeof state.codexHome === "string"
    ? normalizeCodexHome(state.codexHome, paths.home) : undefined;
  // 手动安装不曾取得客户端配置归属，也不通过旧备份推导其他客户端目录。
  const inferredHome = state.codexConfigManaged === false ? undefined : backupCodexHome(state, paths.home);
  const installedHome = recordedHome ?? inferredHome;
  if (installedHome) {
    if (explicitHome && explicitHome !== installedHome) {
      throw new Error(`CODEX_HOME does not match this installation (${installedHome}); unset CODEX_HOME or use the recorded directory`);
    }
    return withCodexHome(paths, installedHome);
  }
  if (state.codexConfigManaged !== false && paths.instanceSuffix && !explicitHome) {
    throw new Error(`Legacy installation ${paths.stateFile} has no Codex directory binding; set the original CODEX_HOME explicitly before managing it`);
  }
  return withCodexHome(paths, explicitHome ?? normalizeCodexHome(path.join(paths.home, ".codex"), paths.home));
}

function ownerPath(paths: ResolvedPaths): string {
  return path.join(paths.codexHome, OWNER_FILE);
}

function readOwner(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!owner || typeof owner.runtimeHome !== "string" || !path.isAbsolute(owner.runtimeHome)) {
      throw new Error("invalid runtimeHome");
    }
    return realPathOrResolve(owner.runtimeHome);
  } catch (error) {
    throw new Error(`Cannot read Codex ownership ${file}: ${String(error)}; repair this file before managing Codex`);
  }
}

/** 当前客户端目录归属的实例主目录；无声明文件时返回 undefined，损坏内容按 readOwner 抛错。 */
export function codexOwnerRuntimeHome(paths: ResolvedPaths): string | undefined {
  const file = ownerPath(paths);
  if (!fs.existsSync(file)) return undefined;
  return readOwner(file);
}

function assertOwner(paths: ResolvedPaths, owner: string | undefined): void {
  if (owner && owner !== realPathOrResolve(paths.runtimeHome)) {
    throw new Error(`Codex directory ${paths.codexHome} is managed by gateway ${owner}; use a distinct CODEX_HOME or --manual-codex-config`);
  }
}

function decodeXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function xmlValue(plist: string, key: string): string | undefined {
  const match = plist.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`));
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
}

/** 缺失 state 的旧默认安装仍可由标准服务定义恢复客户端目录。 */
export function resolveLegacyServiceCodexPaths(paths: ResolvedPaths, env: NodeJS.ProcessEnv): ResolvedPaths {
  if (!fs.existsSync(paths.launchAgent)) return resolveInstalledCodexPaths(paths, env);
  const plist = fs.readFileSync(paths.launchAgent, "utf8");
  const args = plist.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  const configArg = args?.match(/<string>--config<\/string>\s*<string>([^<]*)<\/string>/)?.[1];
  if (!configArg || decodeXml(configArg) !== paths.gatewayConfig) return resolveInstalledCodexPaths(paths, env);
  const recorded = xmlValue(plist, "CODEX_HOME");
  if (!recorded) return resolveInstalledCodexPaths(paths, env);
  const codexHome = normalizeCodexHome(recorded, paths.home);
  if (env.CODEX_HOME?.trim() && normalizeCodexHome(env.CODEX_HOME, paths.home) !== codexHome) {
    throw new Error(`CODEX_HOME does not match the legacy installation (${codexHome}); unset CODEX_HOME or use the recorded directory`);
  }
  return withCodexHome(paths, codexHome);
}

function assertLegacyOwners(paths: ResolvedPaths): void {
  const defaultRuntime = path.join(paths.home, LEGACY_RUNTIME_DIRECTORY);
  const nextDefaultRuntime = path.join(paths.home, DEFAULT_RUNTIME_DIRECTORY);
  const legacyDefaultState = readState(path.join(defaultRuntime, "state.json"));
  const nextDefaultState = readState(path.join(nextDefaultRuntime, "state.json"));
  const clientForState = (state: ClientState): string => typeof state.codexHome === "string"
    ? normalizeCodexHome(state.codexHome, paths.home)
    : backupCodexHome(state, paths.home) ?? realPathOrResolve(path.join(paths.home, ".codex"));
  // 成功迁移后以新记录决定归属；manual/卸载释放后，旧目录的回滚材料不能再次声明。
  const defaultTransferred = nextDefaultState?.defaultRuntimeMigratedFrom === realPathOrResolve(defaultRuntime)
    && legacyDefaultState !== undefined && clientForState(nextDefaultState) === clientForState(legacyDefaultState)
    && clientForState(nextDefaultState) === realPathOrResolve(paths.codexHome);
  const migratedFrom = readState(paths.stateFile)?.defaultRuntimeMigratedFrom;
  const owner = readOwner(ownerPath(paths));
  const ownerMigration = owner ? (JSON.parse(fs.readFileSync(ownerPath(paths), "utf8")) as { defaultRuntimeMigratedFrom?: unknown }).defaultRuntimeMigratedFrom : undefined;
  const migrated = defaultTransferred || ((migratedFrom === realPathOrResolve(defaultRuntime) || ownerMigration === realPathOrResolve(defaultRuntime))
    && owner === realPathOrResolve(paths.runtimeHome));
  // 新旧默认目录都可能缺少 owner，已有 state/备份仍保留客户端归属证明。
  for (const runtimeHome of [nextDefaultRuntime, defaultRuntime]) {
    if (migrated && runtimeHome === defaultRuntime) continue;
    const defaultState = readState(path.join(runtimeHome, "state.json"));
    if (!defaultState || defaultState.codexConfigManaged === false || defaultState.uninstallClientRestored === true) continue;
    const defaultClient = clientForState(defaultState);
    if (defaultClient === realPathOrResolve(paths.codexHome)) assertOwner(paths, realPathOrResolve(runtimeHome));
  }
  // 旧安装没有 ownership 文件，标准服务定义仍可提供原来的客户端目录绑定。
  const agentsDir = path.join(paths.home, "Library", "LaunchAgents");
  if (!fs.existsSync(agentsDir)) return;
  for (const entry of fs.readdirSync(agentsDir)) {
    if (!/^codex-cliproxy-gateway(?:-[0-9a-f]{8})?\.plist$/.test(entry)) continue;
    const plist = fs.readFileSync(path.join(agentsDir, entry), "utf8");
    const args = plist.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
    const configArg = args?.match(/<string>--config<\/string>\s*<string>([^<]*)<\/string>/)?.[1];
    const runtimeHome = configArg ? path.dirname(decodeXml(configArg))
      : xmlValue(plist, "CODEX_CLIPROXY_HOME") ?? defaultRuntime;
    if (migrated && realPathOrResolve(runtimeHome) === realPathOrResolve(defaultRuntime)) continue;
    const state = readState(path.join(runtimeHome, "state.json"));
    if (state?.codexConfigManaged === false || state?.uninstallClientRestored === true) continue;
    const clientHome = xmlValue(plist, "CODEX_HOME") ?? path.join(paths.home, ".codex");
    if (normalizeCodexHome(clientHome, paths.home) === realPathOrResolve(paths.codexHome)) {
      assertOwner(paths, realPathOrResolve(runtimeHome));
    }
  }
}

/** 已有归属可证明缺失 state 的旧安装；查询只读，不补建声明。 */
export function hasLegacyCodexOwnership(paths: ResolvedPaths, legacyRuntimeHome: string): boolean {
  return readOwner(ownerPath(paths)) === realPathOrResolve(legacyRuntimeHome);
}

/** 默认目录迁移只允许从旧实例转交归属，返回原始内容供失败恢复。 */
export function migrateCodexOwnership(paths: ResolvedPaths, legacyRuntimeHome: string): () => void {
  const file = ownerPath(paths);
  const owner = readOwner(file);
  const current = realPathOrResolve(paths.runtimeHome);
  if (owner && owner !== current && owner !== realPathOrResolve(legacyRuntimeHome)) {
    throw new Error(`Codex ownership conflict at ${file}; repair the two installations before retrying install`);
  }
  if (owner === current) return () => {};
  const before = owner ? fs.readFileSync(file) : undefined;
  const mode = owner ? fs.statSync(file).mode & 0o777 : 0o600;
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ runtimeHome: current, defaultRuntimeMigratedFrom: realPathOrResolve(legacyRuntimeHome) })}\n`, { mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return () => {
    if (before) fs.writeFileSync(file, before, { mode });
    else fs.rmSync(file, { force: true });
  };
}

/** 纯只读守卫：手动模式不声明客户端所有权，托管实例必须使用独立目录。 */
export function assertCodexHomeAvailable(paths: ResolvedPaths, manual: boolean): void {
  if (manual) return;
  if (paths.instanceSuffix && realPathOrResolve(paths.codexHome) === realPathOrResolve(path.join(paths.home, ".codex"))) {
    throw new Error("Custom gateway instances must use a distinct CODEX_HOME; the default ~/.codex directory cannot be managed. Use --manual-codex-config instead");
  }
  assertOwner(paths, readOwner(ownerPath(paths)));
  assertLegacyOwners(paths);
}

/** 安装阶段原子声明所有权；返回的回滚函数只撤销本次新建且未被替换的声明。 */
export function claimCodexHome(paths: ResolvedPaths): () => void {
  assertCodexHomeAvailable(paths, false);
  const file = ownerPath(paths);
  const existingOwner = readOwner(file);
  assertOwner(paths, existingOwner);
  if (existingOwner) return () => {};
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let identity: fs.Stats | undefined;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ runtimeHome: realPathOrResolve(paths.runtimeHome) })}\n`, { flag: "wx", mode: 0o600 });
    const createdIdentity = fs.statSync(temporary);
    // 硬链接发布完整文件，既不会暴露半写 JSON，也不会覆盖并行安装的声明。
    try {
      fs.linkSync(temporary, file);
      identity = createdIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      assertOwner(paths, readOwner(file));
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return () => {
    if (!identity || !fs.existsSync(file)) return;
    const current = fs.statSync(file);
    if (current.dev === identity.dev && current.ino === identity.ino) releaseCodexHome(paths);
  };
}

/** 卸载仅释放本实例的声明，不删除其他实例的文件。 */
export function releaseCodexHome(paths: ResolvedPaths): void {
  const file = ownerPath(paths);
  const owner = readOwner(file);
  if (owner === realPathOrResolve(paths.runtimeHome)) fs.rmSync(file);
}
