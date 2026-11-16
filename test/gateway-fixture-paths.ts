import { withHostServices } from "@agent-proxy/plugin-api";
import { createGatewayHostServices } from "../apps/gateway/src/host-services.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";
import type { GatewayConfig, ResolvedPaths } from "../apps/gateway/src/types.ts";

/** 从调用方已创建的临时目录派生用户、运行实例及 Codex 路径。 */
export function gatewayFixturePaths(directory: string): ResolvedPaths {
  return resolvePaths({ HOME: directory }, directory);
}

/** 直接构造插件适配器时固定主机路径，不依赖测试包装器的默认主机。 */
export function withFixtureAdapterHost<T>(config: GatewayConfig, paths: ResolvedPaths, create: () => T): T {
  return withHostServices(createGatewayHostServices(config, undefined, paths), create);
}
