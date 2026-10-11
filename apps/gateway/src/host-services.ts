import type { AgentConfig, HostServices } from "@agent-proxy/plugin-api";
import * as catalog from "./catalog.ts";
import { resolvePaths } from "./paths.ts";
import { appendProcessLog, logGatewayError, logRequestSummary } from "./process-log.ts";
import { localTime, logExchange, logGroupFromPath } from "./request-log.ts";
import { atomicWrite } from "./toml.ts";
import { configuredModelPrefix } from "./upstream-catalog.ts";
import type { GatewayConfig, ProcessLogTarget, ResolvedPaths } from "./types.ts";

/**
 * 面向 agent 插件的配置视图：已过时的 prefix 字段一律替换为按上游类型派生的值
 * （cliproxy/ 或 newapi/），插件侧不感知配置文件里的残留键。
 */
export function agentConfigView(config: GatewayConfig): AgentConfig {
  return { ...config, prefix: configuredModelPrefix(config) };
}

/** 实例能力在组合入口注入；插件契约不承载主机实现，也不读取全局配置。 */
export function createGatewayHostServices(
  config: GatewayConfig,
  processLog?: ProcessLogTarget,
  runtimePaths?: ResolvedPaths,
  apiKey?: string,
): HostServices<AgentConfig> {
  const getPaths = () => runtimePaths ?? resolvePaths();
  return {
    runtimeDirectory: getPaths().runtimeHome,
    getConfig: () => agentConfigView(config),
    getPaths,
    fetch: globalThis.fetch,
    getApiKey: () => apiKey,
    log: (event) => appendProcessLog(processLog, `[${event.level}] ${event.pluginId}: ${event.message}`),
    atomicWrite,
    catalog,
    requestLog: {
      localTime,
      logExchange,
      logGroupFromPath,
      requestLogDir: () => getPaths().logDir,
    },
    processLog: { logGatewayError, logRequestSummary },
  };
}
