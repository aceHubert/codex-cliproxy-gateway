import type { GatewayConfig } from "./types.ts";

/** UI 与模型 API 使用独立监听端口。 */
export function webUiPort(config: Pick<GatewayConfig, "port">): number {
  return config.port + 1;
}
