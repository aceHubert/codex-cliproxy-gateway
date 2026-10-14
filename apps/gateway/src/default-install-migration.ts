import fs from "node:fs";
import path from "node:path";
import { isJsonObject, mergeMissingConfig, migrateLegacyConfig } from "./config.ts";
import { hasLegacyCodexOwnership, migrateCodexOwnership, resolveInstalledCodexPaths, resolveLegacyServiceCodexPaths } from "./codex-ownership.ts";
import { createApiKeyStore } from "./keychain.ts";
import { prepareManagedWebUiMigration, type LaunchctlExecutor } from "./launchd.ts";
import { DEFAULT_RUNTIME_DIRECTORY, LEGACY_RUNTIME_DIRECTORY, RUNTIME_HOME_ENV, realPathOrResolve, resolvePaths } from "./paths.ts";
import { atomicWrite } from "./toml.ts";
import type { ResolvedPaths } from "./types.ts";

type JsonObject = Record<string, unknown>;

function entryStat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readObject(file: string): JsonObject | undefined {
  const stat = entryStat(file);
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Installation migration requires a regular file: ${file}; preserve this entry and repair it before retrying install`);
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isJsonObject(value)) throw new Error("expected a JSON object");
    return value;
  } catch (error) {
    throw new Error(`Cannot migrate installation file ${file}; repair it before running install again`, { cause: error });
  }
}

/** 仅受管派生地址参与迁移；自定义路径、URL 与未知字段不替换。
 * catalogPath 已过时（目录文件按上游类型固定派生），残留键不再改写，由配置同步移除。 */
export function migrateManagedDefaultPaths(config: JsonObject, legacyHome: string, nextHome: string): JsonObject {
  const result = structuredClone(config);
  if (result.model_merge_json === path.join(legacyHome, "models.json")) result.model_merge_json = path.join(nextHome, "models.json");
  return result;
}

interface FileSnapshot { content: Buffer; mode: number }

export interface DefaultInstallMigration {
  paths: ResolvedPaths;
  legacyPaths: ResolvedPaths;
  apply(): () => void;
  complete(): void;
}

/** 只读准备：显式目录或环境覆盖绝不被视为默认安装迁移。 */
export function prepareDefaultInstallMigration(
  paths: ResolvedPaths,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  launchctlExecutor?: LaunchctlExecutor,
  manualCodexConfig = false,
): DefaultInstallMigration | undefined {
  if (env[RUNTIME_HOME_ENV]?.trim()
    || realPathOrResolve(paths.runtimeHome) !== realPathOrResolve(path.join(paths.home, DEFAULT_RUNTIME_DIRECTORY))) return undefined;
  const legacyPaths = resolvePaths({ ...env, HOME: paths.home, CODEX_CLIPROXY_HOME: path.join(paths.home, LEGACY_RUNTIME_DIRECTORY) });
  // 根目录也属于源链接跳过边界，必须在读取配置和状态之前检查。
  const legacyRoot = entryStat(legacyPaths.runtimeHome);
  if (!legacyRoot || legacyRoot.isSymbolicLink()) return undefined;
  if (!legacyRoot.isDirectory()) throw new Error(`Migration source is not a directory: ${legacyPaths.runtimeHome}; preserve this entry and repair it before retrying install`);
  const legacyConfig = readObject(legacyPaths.gatewayConfig);
  const legacyState = readObject(legacyPaths.stateFile);
  if (!legacyConfig && !legacyState) return undefined;
  const nextState = readObject(paths.stateFile);
  const nextConfig = readObject(paths.gatewayConfig);
  if (nextState?.defaultRuntimeMigratedFrom === realPathOrResolve(legacyPaths.runtimeHome)) return undefined;
  for (const key of ["installedAt", "codexHome", "codexConfigManaged", "installedConfigHash", "configBackup"]) {
    if (legacyState?.[key] !== undefined && nextState?.[key] !== undefined
      && JSON.stringify(legacyState[key]) !== JSON.stringify(nextState[key])) {
      throw new Error(`Installation state conflict (${key}) between ${legacyPaths.stateFile} and ${paths.stateFile}; preserve both files and repair their ownership before retrying install`);
    }
  }
  const installedPaths = typeof nextState?.codexHome === "string" || legacyState
    ? resolveInstalledCodexPaths(typeof nextState?.codexHome === "string" ? paths : legacyPaths, env)
    : resolveLegacyServiceCodexPaths(legacyPaths, env);
  const resolved = { ...paths, codexHome: installedPaths.codexHome, configToml: installedPaths.configToml, modelsCacheFile: installedPaths.modelsCacheFile };
  const mergedConfig = mergeMissingConfig(
    migrateLegacyConfig(nextConfig ?? {}),
    migrateLegacyConfig(legacyConfig ?? (isJsonObject(legacyState?.config) ? legacyState.config : {})),
  ).config;
  const config = migrateManagedDefaultPaths(mergedConfig, legacyPaths.runtimeHome, paths.runtimeHome);
  const state = mergeMissingConfig(nextState ?? {}, legacyState ?? {}).config;
  state.config = config;
  state.defaultRuntimeMigratedFrom = realPathOrResolve(legacyPaths.runtimeHome);
  let completeMigration: (() => void) | undefined;

  return {
    paths: resolved,
    legacyPaths,
    complete() {
      if (!completeMigration) throw new Error("Default installation migration has not been applied");
      completeMigration();
    },
    apply() {
      const snapshots = new Map<string, FileSnapshot>();
      const created = new Set<string>();
      const createdDirectories = new Map<string, number>();
      let restoreOwner: (() => void) | undefined;
      let restoreWebUi: (() => void) | undefined;
      let credentialWritten = false;
      const ensureDirectory = (directory: string, mode = 0o700): boolean => {
        const stat = entryStat(directory);
        if (stat) {
          if (!stat.isDirectory()) throw new Error(`Migration target is not a directory: ${directory}`);
          return false;
        }
        ensureDirectory(path.dirname(directory));
        fs.mkdirSync(directory, { mode });
        createdDirectories.set(directory, mode);
        fs.chmodSync(directory, mode);
        return true;
      };
      const capture = (file: string): void => {
        if (snapshots.has(file) || created.has(file)) return;
        const stat = entryStat(file);
        if (stat) {
          if (!stat.isFile()) throw new Error(`Migration target is not a regular file: ${file}`);
          snapshots.set(file, { content: fs.readFileSync(file), mode: stat.mode & 0o777 });
        } else created.add(file);
      };
      const copy = (source: string, target: string): void => {
        // 同名目标整体保留，目录也不递归合并；lstat 同时识别悬空链接。
        if (entryStat(target)) return;
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
          const mode = stat.mode & 0o777;
          // 先保留所有者写入权限，避免只读源目录阻止复制子项。
          if (!ensureDirectory(target, mode | 0o700)) return;
          createdDirectories.set(target, mode);
          for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name));
          fs.chmodSync(target, mode);
        } else if (stat.isFile()) {
          ensureDirectory(path.dirname(target));
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          created.add(target);
          fs.chmodSync(target, stat.mode & 0o777);
        } else throw new Error(`Migration source is not a regular file: ${source}; preserve this entry and repair it before retrying install`);
      };
      const rollback = (): void => {
        const errors: string[] = [];
        const restore = (action: () => void): void => {
          try { action(); } catch (error) { errors.push(String(error)); }
        };
        // 服务恢复失败也必须继续恢复磁盘与 ownership，最终统一报告失败原因。
        restore(() => restoreWebUi?.());
        restore(() => restoreOwner?.());
        // 副本可能已恢复只读权限；清理期间临时开放，保留的目录随后恢复原权限。
        for (const [directory, mode] of createdDirectories) restore(() => {
          const stat = entryStat(directory);
          if (stat?.isDirectory()) fs.chmodSync(directory, mode | 0o700);
        });
        if (credentialWritten) restore(() => createApiKeyStore(platform, paths.credentialsFile).delete());
        for (const [file, snapshot] of snapshots) restore(() => atomicWrite(file, snapshot.content, snapshot.mode));
        for (const file of created) restore(() => fs.rmSync(file, { force: true }));
        // 只回收清单内文件和已空的新增目录，保留安装后续步骤产生的其他内容。
        for (const [directory, mode] of [...createdDirectories].reverse()) restore(() => {
          const stat = entryStat(directory);
          if (!stat?.isDirectory()) return;
          if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
          else fs.chmodSync(directory, mode);
        });
        if (errors.length) throw new Error(`Default installation restore incomplete: ${errors.join("; ")}`);
      };
      try {
        // 准备后源根目录可能被替换，写入目标前再次拒绝链接和非目录。
        const sourceRoot = entryStat(legacyPaths.runtimeHome);
        if (!sourceRoot?.isDirectory()) throw new Error(`Migration source is not a directory: ${legacyPaths.runtimeHome}; preserve this entry and repair it before retrying install`);
        const runtimeMode = sourceRoot.mode & 0o777;
        if (ensureDirectory(paths.runtimeHome, runtimeMode | 0o700)) createdDirectories.set(paths.runtimeHome, runtimeMode);
        for (const name of fs.readdirSync(legacyPaths.runtimeHome)) {
          // 顶层凭据继续交由平台存储接口读写，不作为普通文件复制。
          if (name !== "credentials.json") copy(path.join(legacyPaths.runtimeHome, name), path.join(paths.runtimeHome, name));
        }
        capture(paths.gatewayConfig);
        const backupStamp = Date.now().toString();
        for (const file of [paths.gatewayConfig, paths.stateFile]) {
          capture(file);
          const previous = snapshots.get(file);
          if (previous) {
            const backup = `${file}.bak-agent-proxy-migration-${backupStamp}`;
            capture(backup);
            fs.writeFileSync(backup, previous.content, { mode: previous.mode, flag: "wx" });
          }
        }
        atomicWrite(paths.gatewayConfig, `${JSON.stringify(config, null, 2)}\n`, snapshots.get(paths.gatewayConfig)?.mode
          ?? (fs.existsSync(legacyPaths.gatewayConfig) ? fs.statSync(legacyPaths.gatewayConfig).mode & 0o777 : 0o600));
        if (legacyState || nextState) {
          capture(paths.stateFile);
          atomicWrite(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, snapshots.get(paths.stateFile)?.mode ?? 0o600);
        }
        const credentialTarget = entryStat(paths.credentialsFile);
        if (credentialTarget && !credentialTarget.isFile()) throw new Error(`Migration target is not a regular file: ${paths.credentialsFile}`);
        const credentialSource = entryStat(legacyPaths.credentialsFile);
        if (platform !== "darwin" && credentialSource && !credentialTarget) {
          if (!credentialSource.isFile()) throw new Error(`Migration source is not a regular file: ${legacyPaths.credentialsFile}`);
          const key = createApiKeyStore(platform, legacyPaths.credentialsFile).read(true);
          capture(paths.credentialsFile);
          createApiKeyStore(platform, paths.credentialsFile).save(key);
          credentialWritten = true;
        }
        // 已托管实例切手动仍须先转交旧归属，成功后由 install 释放；首次手动安装不声明。
        if (hasLegacyCodexOwnership(resolved, legacyPaths.runtimeHome)
          || (state.codexConfigManaged !== false && (!manualCodexConfig || legacyState || nextState))) {
          restoreOwner = migrateCodexOwnership(resolved, legacyPaths.runtimeHome);
        }
        if (platform === "darwin") {
          const migrateWebUi = prepareManagedWebUiMigration({
            plistPath: paths.webUiLaunchAgent,
            gatewayPlistPath: paths.launchAgent,
            legacyRuntimeHome: legacyPaths.runtimeHome,
            runtimeHome: paths.runtimeHome,
            cliPath: fs.realpathSync(process.argv[1]!),
            bunPath: process.execPath,
          }, launchctlExecutor);
          restoreWebUi = migrateWebUi?.();
        }
        completeMigration = () => {
          // 首次安装必须先由 install 创建真实 state，不能提前伪造已安装状态。
          const installedState = readObject(paths.stateFile);
          if (!installedState) throw new Error(`Cannot complete default migration without installation state: ${paths.stateFile}`);
          installedState.defaultRuntimeMigratedFrom = realPathOrResolve(legacyPaths.runtimeHome);
          atomicWrite(paths.stateFile, `${JSON.stringify(installedState, null, 2)}\n`, fs.statSync(paths.stateFile).mode & 0o777);
        };
        if (createdDirectories.has(paths.runtimeHome)) fs.chmodSync(paths.runtimeHome, runtimeMode);
        return rollback;
      } catch (error) {
        try { rollback(); } catch (restoreError) {
          throw new Error(`${String(error)}; ${String(restoreError)}`, { cause: error });
        }
        throw error;
      }
    },
  };
}
