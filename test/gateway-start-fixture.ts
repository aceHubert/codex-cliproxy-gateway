import { startGateway } from "../apps/gateway/src/gateway-composition.ts";
import type { ZcodeDependencies } from "@agent-proxy/zcode";
import type { RealtimeProviderMode } from "../apps/gateway/src/realtime.ts";
import type { GatewayConfig, ProcessLogTarget, ResolvedPaths } from "../apps/gateway/src/types.ts";

/** 本地监听用例固定实例，显式传空密钥以跳过系统凭据读取。 */
export function startTestGateway(
  config: GatewayConfig,
  runtimePaths: ResolvedPaths,
  realtimeProviderMode: RealtimeProviderMode = "invalid",
  { processLog, zcodeDependencies }: { processLog?: ProcessLogTarget; zcodeDependencies?: ZcodeDependencies } = {},
) {
  return startGateway(config, realtimeProviderMode, undefined, zcodeDependencies, processLog,
    undefined, undefined, undefined, undefined, { runtimePaths, apiKey: "" });
}
