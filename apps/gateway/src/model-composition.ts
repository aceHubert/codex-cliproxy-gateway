import { createConfiguredPluginRegistry, isInstalledPluginModel, managedRuntimeCatalogFiles, type ModelCatalogDependencies } from "./gateway-composition.ts";
import {
  rebuildStaticCatalog as rebuildWithSource,
  updateCodexModelCatalog as updateWithSource,
  type ModelCatalogSource,
} from "./model-state.ts";
import { resolvePaths } from "./paths.ts";
import type { GatewayConfig, ModelEntry, ResolvedPaths } from "./types.ts";

export * from "./model-state.ts";
export type { ModelCatalogDependencies } from "./gateway-composition.ts";

/** 目录命令使用短期插件实例，关闭自动刷新和后台计时器。 */
function createCatalogSource(config: GatewayConfig, dependencies: ModelCatalogDependencies): ModelCatalogSource {
  return {
    ownsModel: isInstalledPluginModel,
    async collect(refresh, cacheDirectory) {
      const paths = { ...resolvePaths(), runtimeHome: cacheDirectory };
      const lifecycle = { cacheDirectory, catalogMode: "manual" as const, refreshCatalogOnStart: false };
      const registry = createConfiguredPluginRegistry(config, {
        zcode: { ...dependencies.zcode, ...lifecycle, cacheDirectory: dependencies.zcode?.cacheDirectory ?? cacheDirectory },
        codebuddy: { ...dependencies.codebuddy, ...lifecycle, cacheDirectory: dependencies.codebuddy?.cacheDirectory ?? cacheDirectory },
        qoder: { ...dependencies.qoder, ...lifecycle, cacheDirectory: dependencies.qoder?.cacheDirectory ?? cacheDirectory },
        agy: { ...dependencies.agy, ...lifecycle, cacheDirectory: dependencies.agy?.cacheDirectory ?? cacheDirectory },
        opencodeZen: { ...dependencies.opencodeZen, ...lifecycle, cacheDirectory: dependencies.opencodeZen?.cacheDirectory ?? cacheDirectory },
      }, undefined, paths, undefined, "manual");
      const entries: ModelEntry[] = [];
      const failures: string[] = [];
      try {
        const results = await Promise.allSettled(registry.plugins.map((plugin) =>
          refresh ? plugin.refreshCatalog() : plugin.reloadCatalog()));
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") {
            entries.push(...result.value.models);
          } else {
            // 目录错误不包含上游正文，避免错误信息带出凭据。
            const labels: Record<string, string> = { zcode: "ZCode", codebuddy: "CodeBuddy", qoder: "Qoder", agy: "Antigravity", "opencode-zen": "OpenCode Zen" };
            failures.push(`${labels[registry.plugins[index].id] ?? registry.plugins[index].id} 模型目录不可用；请检查本机登录、网络并重新运行模型更新命令`);
          }
        }
      } finally {
        await registry.close();
      }
      return { entries, failures };
    },
  };
}

export function collectAdapterModels(
  config: GatewayConfig,
  dependencies: ModelCatalogDependencies = {},
  { refresh = false, cacheDirectory = resolvePaths().runtimeHome }: { refresh?: boolean; cacheDirectory?: string } = {},
) {
  return createCatalogSource(config, dependencies).collect(refresh, cacheDirectory);
}

export function rebuildStaticCatalog(
  paths: ResolvedPaths,
  config: GatewayConfig,
  dependencies: ModelCatalogDependencies = {},
  options: { refreshAdapters?: boolean } = {},
) {
  return rebuildWithSource(paths, config, createCatalogSource(config, dependencies), options);
}

export function updateCodexModelCatalog(
  paths: ResolvedPaths,
  config: GatewayConfig,
  dependencies: ModelCatalogDependencies = {},
  options: { refreshAdapters?: boolean; manual?: boolean } = {},
) {
  // 受管值守卫要识别插件目录缓存的历史指向；组合层聚合注入，model-state 保持叶子。
  return updateWithSource(paths, config, createCatalogSource(config, dependencies), {
    ...options,
    managedFiles: managedRuntimeCatalogFiles(paths),
  });
}
