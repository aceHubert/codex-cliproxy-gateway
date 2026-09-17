import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedPaths, UpstreamType } from "./types.ts";

/**
 * 解析到真实路径（穿透符号链接）；目标不存在时解析父目录再拼 basename，
 * 父目录也不可解析则退回 path.resolve。用于生产实例判定，避免软链绕过。
 */
export function realPathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const dir = path.dirname(p);
    const base = path.basename(p);
    try {
      return path.join(fs.realpathSync(dir), base);
    } catch {
      return path.resolve(p);
    }
  }
}

/**
 * 历史独立 stderr 日志的文件名。stderr 已并入 gateway.log（同一路径同时作为
 * StandardOutPath 与 StandardErrorPath），这个名字只用于卸载时清理旧安装的残留。
 */
export const LEGACY_STDERR_LOG = "gateway.error.log";

/**
 * 解析网关的全部路径。`runtimeHomeOverride` 用于 `serve --config <file>` 的临时实例：
 * 以配置文件所在目录为运行时根，Web UI 的读写（config/state/ui-token/日志）就全部落在
 * 该目录内。LaunchAgent 在覆盖模式下使用 `-temp` 占位名——配置放在 $HOME 下时
 * `home` 几何派生会恰好命中默认服务的真实路径，占位名保证结构上永不相同；临时实例
 * 的服务管理另由 WebUiContext.instanceOnly 显式禁止，不依赖路径不存在这一隐式前提。
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env, runtimeHomeOverride?: string): ResolvedPaths {
  const home = env.HOME || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const runtimeHome = runtimeHomeOverride ?? path.join(home, ".codex-cliproxy-gateway");
  return {
    home,
    codexHome,
    runtimeHome,
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
      ? path.join(runtimeHomeOverride, "Library", "LaunchAgents", "codex-cliproxy-gateway-temp.plist")
      : path.join(home, "Library", "LaunchAgents", "codex-cliproxy-gateway.plist"),
    webUiLaunchAgent: runtimeHomeOverride
      ? path.join(runtimeHomeOverride, "Library", "LaunchAgents", "codex-cliproxy-webui-temp.plist")
      : path.join(home, "Library", "LaunchAgents", "codex-cliproxy-webui.plist"),
  };
}

/** 目录文件按上游类型命名（cliproxy-catalog.json / newapi-catalog.json），切换上游互不覆盖。 */
export function catalogFileFor(paths: ResolvedPaths, upstreamType: UpstreamType): string {
  return path.join(paths.runtimeHome, `${upstreamType}-catalog.json`);
}

/** 网关自管的全部目录文件；新增上游类型时必须同步补充，供卸载清理与 config.toml 守卫使用。 */
export function managedCatalogFiles(paths: ResolvedPaths): string[] {
  return [catalogFileFor(paths, "cliproxy"), catalogFileFor(paths, "newapi"), path.join(paths.runtimeHome, "zcode-catalog.json")];
}
