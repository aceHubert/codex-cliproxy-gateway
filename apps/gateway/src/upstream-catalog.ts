import fs from "node:fs";
import path from "node:path";
import bundledModelOverrides from "../models.json";
import {
  compileModelOverrides,
  fetchUpstreamCatalog,
  loadModelOverrides,
  resolveModelMergeJson,
  syncCatalog,
} from "./catalog.ts";
import type { ModelOverrideRule } from "./catalog.ts";
import { getCodexModelSnapshot, getVendorModelPresets } from "@agent-proxy/models";
import { FALLBACK_CLIENT_VERSION, resolveCodexClientVersion } from "./codex-version.ts";
import { readApiKey } from "./keychain.ts";
import { catalogFileFor } from "./paths.ts";
import type { GatewayConfig, ModelCatalog, ResolvedPaths, UpstreamType } from "./types.ts";

/**
 * 「按 config.json 拉取上游模型目录 + 重建已选目录」的共享路径：CLI（install /
 * models --sync）与 Web UI（拉取模型按钮、保存模型选择）共用。webui.ts 的依赖树
 * 不得反向引用 cli.ts，因此从 cli.ts 独立成模块；不依赖 gateway.ts，避免
 * gateway → webui → 本模块 → gateway 的循环引用。
 */

/**
 * newapi 目录合成的两份内联数据源（均随构建打进 dist/index.js）：
 * codex_client_models.json 是 OpenAI 官方模型快照，vendor_models.json 是官方支持 Codex 的
 * 厂商预设（z.ai/deepseek/moonshotai 分组，与网关 models.json 同构）。惰性编译：
 * cliproxy 上游完全不触碰它们。
 */
let codexClientModels: ModelCatalog | undefined;
let vendorModelRules: ModelOverrideRule[] | undefined;

/** 配置里只显式信任 "newapi"，其余值（含手改错的）一律按 cliproxy 处理。 */
export function configuredUpstreamType(config: Pick<GatewayConfig, "upstreamType">): UpstreamType {
  return config.upstreamType === "newapi" ? "newapi" : "cliproxy";
}

/**
 * 第三方模型前缀：按上游类型派生（cliproxy/ 或 newapi/）。已过时配置 prefix 的
 * 替代——运行时一律取本函数结果，文件残留值读取时忽略。
 */
export function configuredModelPrefix(config: Pick<GatewayConfig, "upstreamType">): string {
  return `${configuredUpstreamType(config)}/`;
}

/**
 * 上游已选目录文件：固定按上游类型落在运行主目录（{cliproxy|newapi}-catalog.json）。
 * 已过时配置 catalogPath 的替代——运行时一律取本函数结果，文件残留值读取时忽略。
 */
export function configuredCatalogFile(paths: ResolvedPaths, config: Pick<GatewayConfig, "upstreamType">): string {
  return catalogFileFor(paths, configuredUpstreamType(config));
}

export function newapiCatalogOptions(
  upstreamType: UpstreamType,
  overrides: ReturnType<typeof loadModelOverrides>,
): { snapshot?: ModelCatalog; vendors?: ModelOverrideRule[]; overrides: ReturnType<typeof loadModelOverrides> } {
  if (upstreamType !== "newapi") return { overrides };
  codexClientModels ??= getCodexModelSnapshot();
  vendorModelRules ??= compileModelOverrides(getVendorModelPresets(), "models/vendor_models.json");
  return { snapshot: codexClientModels, vendors: vendorModelRules, overrides };
}

/**
 * 拉取上游目录时要发送的 client_version。CLIProxy 按它决定目录内容——版本过低会把
 * `max`/`ultra` 这类较新的 reasoning 等级过滤掉，所以必须探测真实客户端版本；new-api
 * 只返回 OpenAI 裸列表、Codex 目录在本地合成，与该参数无关。
 */
export function upstreamClientVersion(paths: ResolvedPaths, type: UpstreamType): string {
  return type === "cliproxy"
    ? resolveCodexClientVersion(paths.upstreamModelsCacheFile)
    : FALLBACK_CLIENT_VERSION;
}

/**
 * 解析 models.json 来源（缓存优先，--model-merge-json 传入时强制刷新）并加载覆盖规则。
 * 无缓存时使用构建内联的网关自有规则，不写入运行目录缓存。
 * newapi 合成在拉取阶段就要用规则区分已知厂商，所以提前到 fetch 前执行。
 */
export async function loadModelOverrideRules(
  paths: ResolvedPaths,
  config: GatewayConfig,
  refreshModelMerge: boolean,
): Promise<{ modelsConfigFile: string | undefined; rules: ReturnType<typeof loadModelOverrides> }> {
  const modelsConfigFile = await resolveModelMergeJson(
    paths.modelMergeFile,
    undefined,
    config.model_merge_json,
    refreshModelMerge,
  );
  return {
    modelsConfigFile,
    rules: modelsConfigFile === undefined
      ? compileModelOverrides(bundledModelOverrides, "bundled models.json")
      : loadModelOverrides(modelsConfigFile),
  };
}

/** 回环上游允许空 key（与 gateway.isLoopbackUrl 同判定；独立实现避免循环引用）。 */
export function upstreamKeyOptional(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** fetchConfiguredUpstreamCatalog 的测试注入点：目前只有 key 读取。 */
export interface UpstreamCatalogDeps {
  readKey?: (optional?: boolean) => string;
}

/**
 * 按当前配置拉取上游完整目录：解析覆盖规则 → 经 keychain 分派读取 key（回环上游
 * 允许缺失）→ 按上游类型拉取/合成。key 只进上游请求头，绝不进日志或响应。
 */
export async function fetchConfiguredUpstreamCatalog(
  paths: ResolvedPaths,
  config: GatewayConfig,
  deps: UpstreamCatalogDeps = {},
): Promise<{ catalog: ModelCatalog; modelsConfigFile: string | undefined }> {
  const type = configuredUpstreamType(config);
  const { modelsConfigFile, rules } = await loadModelOverrideRules(paths, config, false);
  const apiKey = (deps.readKey ?? readApiKey)(upstreamKeyOptional(config.upstreamBaseUrl));
  const catalog = await fetchUpstreamCatalog(
    config.upstreamBaseUrl,
    apiKey,
    type,
    upstreamClientVersion(paths, type),
    newapiCatalogOptions(type, rules),
  );
  return { catalog, modelsConfigFile };
}

/** 重建上游已选目录（固定按上游类型落盘）：套用覆盖规则后原子写盘，并清掉目录元数据缓存。 */
export async function rebuildCatalog(
  paths: ResolvedPaths,
  config: GatewayConfig,
  proxyModels: ModelCatalog["models"],
  modelsConfigFile: string | undefined,
) {
  const result = await syncCatalog({
    catalogFile: configuredCatalogFile(paths, config),
    proxyModels,
    ...(modelsConfigFile === undefined
      ? { overrides: compileModelOverrides(bundledModelOverrides, "bundled models.json") }
      : { modelsConfigFile }),
  });
  fs.rmSync(path.join(paths.runtimeHome, "catalog-metadata.json"), { force: true });
  return result;
}
