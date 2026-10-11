import { identifyClientEndpoint, PluginRegistry, type GatewayPlugin } from "@agent-proxy/plugin-api";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

/** 只提供模式契约，帧路由测试不创建真实 agent 的凭据缓存和后台任务。 */
export function routingRegistry(config: Partial<GatewayConfig> = {}): PluginRegistry {
  const definitions = [
    ["zcode", "zcode", ["zcode/*", "zcode-*/*"]],
    ["codebuddy", "codebuddy", ["codebuddy/*", "workbuddy/*", "codebuddy-cn/*", "codebuddy-intl/*", "workbuddy-cn/*", "workbuddy-intl/*"]],
    ["qoder", "qoder", ["qoder/*", "qoder-cn/*", "qoder-intl/*"]],
    ["agy", "agy", ["agy/*"]],
    ["opencodeZen", "opencode-zen", ["opencode-zen/*"]],
  ] as const;
  return new PluginRegistry(definitions.filter(([key]) => config[key] !== false).map(([, id, modelPatterns]): GatewayPlugin => ({
    id, modelPatterns, websocket: false,
    handleHttp: () => new Response(null, { status: 204 }),
    getCatalog: () => ({ models: [] }),
    refreshCatalog: async () => ({ models: [] }),
    reloadCatalog: async () => ({ models: [] }),
    ready: async () => {},
    close: () => {},
  })));
}

const allPlugins = routingRegistry();
export const routingPluginFamily = (model: string): string | undefined => allPlugins.match(model)?.plugin.id;

export function matchesPluginUpgrade(request: Request, config: GatewayConfig, pluginId: string): boolean {
  const endpoint = identifyClientEndpoint(new URL(request.url).pathname, config.mountPath);
  const model = /(?:^|[;,\s])model=([^;,\s]+)/.exec(request.headers.get("x-codex-routing-hint") ?? "")?.[1];
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
    && endpoint?.from === "responses" && endpoint.operation === "generate"
    && model !== undefined && routingRegistry(config).match(model)?.plugin.id === pluginId;
}
