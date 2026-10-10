import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedPaths, UpstreamType } from "./types.ts";

/**
 * 穿透最近已存在祖先的符号链接，再拼回尚未创建的目录。
 * 多级缺失目录首次创建前后保持同一身份，避免服务 label 与凭据槽位变化。
 */
export function realPathOrResolve(p: string): string {
  let ancestor = path.resolve(p);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(ancestor), ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return path.resolve(p);
      missingSegments.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * 历史独立 stderr 日志的文件名。stderr 已并入 gateway.log（同一路径同时作为
 * StandardOutPath 与 StandardErrorPath），这个名字只用于卸载时清理旧安装的残留。
 */
export const LEGACY_STDERR_LOG = "gateway.error.log";

/** 运行主目录的环境变量覆盖；用于 serve 前台实例、多实例隔离与容器/CI 部署。 */
export const RUNTIME_HOME_ENV = "CODEX_CLIPROXY_HOME";

/**
 * 调用所属的实例路径快照。异步任务继承自己的上下文，失败或完成后自动恢复，
 * 不修改进程环境，也不会污染同进程中的其他 CLI 调用。
 */
const instancePathsContext = new AsyncLocalStorage<ResolvedPaths>();
export function runWithInstancePaths<T>(paths: ResolvedPaths, callback: () => T): T {
  return instancePathsContext.run({ ...paths }, callback);
}

/**
 * 规范化运行主目录输入：trim、按本函数同一 HOME 规则展开 `~`/`~/`，空白视为未设置
 * （返回空串）；展开后仍非绝对路径直接报错——launchd 服务进程 cwd 是 /，静默 resolve
 * 只会把相对路径悄悄落到不该落的位置。软链规范化只用于实例身份判定（instanceMarker
 * 内部穿透符号链接），主目录保留用户拼写。
 */
export function normalizeRuntimeHomeInput(value: string, home: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? path.join(home, trimmed.slice(1))
    : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `${RUNTIME_HOME_ENV} must be an absolute path (got "${value}"); use an absolute path or ~/… instead`,
    );
  }
  return expanded;
}

/** 实例标记：规范化主目录的稳定哈希（8 位十六进制），默认实例与其他实例取值不同。 */
export function instanceMarker(runtimeHome: string): string {
  return createHash("sha256").update(realPathOrResolve(runtimeHome)).digest("hex").slice(0, 8);
}

/**
 * 解析网关的全部路径。运行主目录的优先级：显式 `runtimeHomeOverride`（Web UI 临时
 * 上下文按配置文件定位）> `CODEX_CLIPROXY_HOME` 环境变量 >
 * `~/.codex-cliproxy-gateway`。无实参调用优先读取调用级实例上下文；显式传入
 * env 或 override 时独立解析，不受当前上下文影响。所有数据目录
 * （日志、各适配器目录缓存、凭据、状态）一律从运行主目录派生，不从 catalogPath
 * 等文件位置倒推；目录不存在时由各写入方按需创建（atomicWrite 与请求日志 append
 * 都自带 recursive mkdir）。
 *
 * 服务身份：默认实例（主目录即 `~/.codex-cliproxy-gateway`，显式指到默认目录同理）
 * 保持历史 label 与 plist 文件名，存量安装零迁移；其他实例的 label 与 plist 文件名
 * 加 `instanceSuffix`（主目录哈希后缀）。plist 一律留在用户的 ~/Library/LaunchAgents/
 * （launchd 只在登录时扫描该目录，放到数据目录会失去登录自启），数据不离开实例主目录。
 */
export function resolvePaths(env?: NodeJS.ProcessEnv, runtimeHomeOverride?: string): ResolvedPaths {
  if (arguments.length === 0) {
    const scopedPaths = instancePathsContext.getStore();
    if (scopedPaths) return { ...scopedPaths };
  }
  env ??= process.env;
  const home = env.HOME || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const defaultRuntimeHome = path.join(home, ".codex-cliproxy-gateway");
  // 显式配置目录覆盖环境值：被覆盖的无效环境路径不应阻止该实例启动。
  const runtimeHomeInput = runtimeHomeOverride !== undefined
    ? normalizeRuntimeHomeInput(runtimeHomeOverride, home)
    : normalizeRuntimeHomeInput(env[RUNTIME_HOME_ENV] ?? "", home);
  const runtimeHome = runtimeHomeInput || defaultRuntimeHome;
  const marker = instanceMarker(runtimeHome);
  const instanceSuffix = marker === instanceMarker(defaultRuntimeHome) ? "" : `-${marker}`;
  return {
    home,
    codexHome,
    runtimeHome,
    instanceSuffix,
    configToml: path.join(codexHome, "config.toml"),
    gatewayConfig: path.join(runtimeHome, "config.json"),
    stateFile: path.join(runtimeHome, "state.json"),
    catalogFile: path.join(runtimeHome, "cliproxy-catalog.json"),
    modelMergeFile: path.join(runtimeHome, "models.json"),
    upstreamModelsCacheFile: path.join(runtimeHome, "models-cache.json"),
    modelsCacheFile: path.join(codexHome, "models_cache.json"),
    /** 进程日志：stdout、stderr、配置审计与请求摘要都写这一个文件。 */
    stdoutLog: path.join(runtimeHome, "gateway.log"),
    logDir: path.join(runtimeHome, "logs"),
    /** Web UI 访问令牌：网关启动时惰性生成，CLI web 命令读取它拼出带 token 的 URL。 */
    uiTokenFile: path.join(runtimeHome, "ui-token"),
    /** 上游 API key 的文件后端（非 darwin 平台替代 macOS Keychain）：0600、原子写，内容是明文密钥。 */
    credentialsFile: path.join(runtimeHome, "credentials.json"),
    launchAgent: runtimeHomeOverride
      ? path.join(runtimeHome, "Library", "LaunchAgents", "codex-cliproxy-gateway-temp.plist")
      : path.join(home, "Library", "LaunchAgents", `codex-cliproxy-gateway${instanceSuffix}.plist`),
    /** Web UI 的 LaunchAgent（默认不加载运行，`codex-cliproxy web` 按需启动）。 */
    webUiLaunchAgent: runtimeHomeOverride
      ? path.join(runtimeHome, "Library", "LaunchAgents", "codex-cliproxy-webui-temp.plist")
      : path.join(home, "Library", "LaunchAgents", `codex-cliproxy-webui${instanceSuffix}.plist`),
  };
}

/** 目录文件按上游类型命名（cliproxy-catalog.json / newapi-catalog.json），切换上游互不覆盖。 */
export function catalogFileFor(paths: ResolvedPaths, upstreamType: UpstreamType): string {
  return path.join(paths.runtimeHome, `${upstreamType}-catalog.json`);
}

/** 网关自管的全部目录文件；新增上游类型时必须同步补充，供卸载清理与 config.toml 守卫使用。 */
export function managedCatalogFiles(paths: ResolvedPaths): string[] {
  return [
    catalogFileFor(paths, "cliproxy"),
    catalogFileFor(paths, "newapi"),
    path.join(paths.runtimeHome, "codex-catalog.json"),
    path.join(paths.runtimeHome, "zcode-catalog.json"),
    path.join(paths.runtimeHome, "codebuddy-catalog.json"),
    path.join(paths.runtimeHome, "workbuddy-catalog.json"),
  ];
}
