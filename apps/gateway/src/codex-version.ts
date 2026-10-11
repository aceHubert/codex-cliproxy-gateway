import fs from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * 探测不到任何真实版本时的保守值。CLIProxy 会把它当作最老的客户端：目录里只下发
 * 基础 reasoning 等级，`max`/`ultra` 被过滤掉（同样地，模型条目的 minimal_client_version
 * 也按此判断）。所以只有在探测全部失败时才用它。
 */
export const FALLBACK_CLIENT_VERSION = "0.0.0";

/** 显式指定发送给上游的版本；用于 codex 不在 PATH（如只有桌面端）或需要固定版本的场景。 */
export const CLIENT_VERSION_ENV = "CODEX_CLIPROXY_CLIENT_VERSION";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const VERSION_IN_TEXT = /\d+\.\d+\.\d+/;

/** 从 `codex --version` 输出（形如 `codex-cli 0.153.4`）里取版本号。 */
export function parseCodexVersion(output: string): string | undefined {
  return output.match(VERSION_IN_TEXT)?.[0];
}

/**
 * 探测本机 Codex 客户端版本：目录按客户端版本下发内容，传真实版本才能拿到 `max` 等
 * 新等级。PATH 上没有 codex、命令超时或输出不含版本号都视为探测失败（返回 undefined），
 * 由调用方继续往下一级回退，绝不因为探测失败中断命令。
 */
export function probeCodexCliVersion(): string | undefined {
  try {
    const output = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return parseCodexVersion(output);
  } catch {
    return undefined;
  }
}

/**
 * 读取网关自己记录的客户端版本（`models-cache.json` 的 client_version）：网关在 /models
 * 请求里记下消费客户端自报的版本，是保真度最高的来源，且不依赖 Codex 自己的缓存文件
 * （设了 model_catalog_json 走 static manager 时 Codex 不请求 /models、也不写 models_cache.json）。
 * 缺失、非法或为 0.0.0 一律视为不可用。
 */
export function readCachedClientVersion(file: string): string | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || !("client_version" in value)) return undefined;
    const cached = (value as { client_version?: unknown }).client_version;
    if (typeof cached !== "string") return undefined;
    const version = parseCodexVersion(cached);
    return version === FALLBACK_CLIENT_VERSION ? undefined : version;
  } catch {
    return undefined;
  }
}

/**
 * 解析要发送给 CLIProxy 的 client_version，按保真度依次回退：
 * 1. {@link CLIENT_VERSION_ENV} 显式指定（用户意图优先）；
 * 2. 网关 `models-cache.json` 记录的客户端自报版本（最贴近真实消费者）；
 * 3. 本机 `codex --version`——PATH 上可能是另一个安装（更旧或更新的全局 CLI），
 *    因此排在自报版本之后，只在尚无记录时兜底；
 * 4. {@link FALLBACK_CLIENT_VERSION}。
 */
export function resolveCodexClientVersion(
  cacheFile: string,
  probe: () => string | undefined = probeCodexCliVersion,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = (env[CLIENT_VERSION_ENV] ?? "").trim();
  if (override) {
    if (!VERSION_PATTERN.test(override)) {
      throw new Error(`${CLIENT_VERSION_ENV} must be a version like 0.153.4, got "${override}"`);
    }
    return override;
  }
  return readCachedClientVersion(cacheFile) ?? probe() ?? FALLBACK_CLIENT_VERSION;
}
