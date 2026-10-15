import type { HostServices, PluginLogEvent } from "@agent-proxy/plugin-api";
import * as catalog from "./catalog.ts";
import { resolvePaths } from "./paths.ts";
import { appendProcessLog, logGatewayError, logRequestSummary } from "./process-log.ts";
import { localTime, logExchange, logGroupFromPath } from "./request-log.ts";
import { atomicWrite } from "./toml.ts";
import type { GatewayConfig, ProcessLogTarget, ResolvedPaths } from "./types.ts";

/** 实例能力在组合入口注入；插件契约不承载主机实现，也不读取全局配置。 */
export function createGatewayHostServices(
  config: GatewayConfig,
  processLog?: ProcessLogTarget,
  runtimePaths?: ResolvedPaths,
  apiKey?: string,
): HostServices<GatewayConfig> {
  const getPaths = () => runtimePaths ?? resolvePaths();
  return {
    runtimeDirectory: getPaths().runtimeHome,
    getConfig: () => ({ ...config }),
    getPaths,
    fetch: globalThis.fetch,
    getApiKey: () => apiKey,
    log: (event: PluginLogEvent) => appendProcessLog(processLog, `[${event.level}] ${event.pluginId}: ${event.message}`),
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
