import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { filterExcludedModels, normalizeCatalog } from "./catalog.ts";
import { managedCatalogFiles } from "./paths.ts";
import { configuredCatalogFile } from "./upstream-catalog.ts";
import { logConfigChange } from "./process-log.ts";
import { atomicWrite, hasRootTomlKey, patchRootToml, readRootTomlString, restoreRootTomlKeys } from "./toml.ts";
import type { GatewayConfig, ModelCatalog, ModelEntry, ResolvedPaths } from "./types.ts";

export interface ModelCatalogSource {
  collect(refresh: boolean, cacheDirectory: string): Promise<{ entries: ModelEntry[]; failures: string[] }>;
  ownsModel(model: string): boolean;
}

/** Codex 的合成静态目录与上游已选目录分离，避免重复同步污染原始模型。 */
export function codexCatalogFile(paths: ResolvedPaths): string {
  return path.join(paths.runtimeHome, "codex-catalog.json");
}

export async function rebuildStaticCatalog(
  paths: ResolvedPaths,
  config: GatewayConfig,
  source: ModelCatalogSource,
  { refreshAdapters = false }: { refreshAdapters?: boolean } = {},
): Promise<ModelCatalog> {
  const adapters = await source.collect(refreshAdapters, paths.runtimeHome);
  // 插件可用性不决定上游选择能否保存；静态目录仅合并本次可用的模型。
  for (const failure of adapters.failures) console.warn(`WARNING: ${failure}；已跳过该插件，不影响模型选择保存。`);
  return writeStaticCatalog(paths, config, adapters.entries, (model) => source.ownsModel(model));
}

/** 网关复用自身已加载的适配器发布静态目录，避免构造第二批目录缓存与计时器。 */
export function writeStaticCatalog(paths: ResolvedPaths, config: GatewayConfig, adapterModels: ModelEntry[], ownsModel: (model: string) => boolean = () => false): ModelCatalog {
  const upstream = normalizeCatalog(JSON.parse(fs.readFileSync(configuredCatalogFile(paths, config), "utf8")));
  const merged = [...upstream.models, ...adapterModels];
  const seen = new Set<string>();
  for (const entry of merged) {
    if (!entry || typeof entry.slug !== "string" || !entry.slug.trim()) throw new Error("模型目录存在缺少 slug 的条目，未发布静态目录");
    if (seen.has(entry.slug)) throw new Error(`模型目录存在重复 ID：${entry.slug}；请修正上游与 agent 的模型冲突`);
    seen.add(entry.slug);
  }
  const catalog = filterExcludedModels({ models: merged }, config.excludedModels, ownsModel);
  if (!catalog.models.length) throw new Error("静态模型目录为空；请先选择上游模型或启用有可用目录的 agent");
  atomicWrite(codexCatalogFile(paths), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

/**
 * 只改写受管目录指向；遇到不可解析或用户自管的值时拒绝覆盖。
 * managedFiles 是受管目录文件全集（网关自有 + 已装配插件产物），由调用方注入；
 * 本模块保持叶子地位，不 import 组合层，历史插件目录指向仍须被识别为受管值。
 */
export function applyModelCatalogToml(
  source: string,
  active: boolean,
  paths: ResolvedPaths,
  catalogFile: string,
  managedFiles: string[],
): { patchedToml: string; previousCatalog: string | null } {
  const configuredCatalog = readRootTomlString(source, "model_catalog_json");
  const legacyCatalogFile = path.join(paths.codexHome, "cliproxy-catalog.json");
  if (configuredCatalog && ![...managedFiles, codexCatalogFile(paths), legacyCatalogFile].includes(configuredCatalog)) {
    throw new Error(`Refusing to replace unmanaged model_catalog_json: ${configuredCatalog}`);
  }
  if (configuredCatalog === undefined && hasRootTomlKey(source, "model_catalog_json")) {
    throw new Error("model_catalog_json exists but its value cannot be parsed; fix ~/.codex/config.toml manually");
  }
  return {
    patchedToml: active ? patchRootToml(source, { model_catalog_json: catalogFile }) : restoreRootTomlKeys(source, "", ["model_catalog_json"]),
    previousCatalog: configuredCatalog ?? null,
  };
}

interface ModelInstallState {
  codexConfigManaged?: boolean;
  installedConfigHash?: string;
  [key: string]: unknown;
}

const hash = (source: string): string => createHash("sha256").update(source).digest("hex");

/** 更新快照和受管 TOML；任何落盘失败都恢复本次调用前的文件。 */
export async function updateCodexModelCatalog(
  paths: ResolvedPaths,
  config: GatewayConfig,
  catalogSource: ModelCatalogSource,
  {
    refreshAdapters = false,
    manual: manualOverride,
    managedFiles = managedCatalogFiles(paths),
  }: { refreshAdapters?: boolean; manual?: boolean; managedFiles?: string[] } = {},
): Promise<{ catalogPath: string; count: number; manual: boolean; tomlChanged: boolean }> {
  const stateSource = fs.existsSync(paths.stateFile) ? fs.readFileSync(paths.stateFile, "utf8") : undefined;
  const state: ModelInstallState = stateSource === undefined ? {} : JSON.parse(stateSource);
  const manual = manualOverride ?? state.codexConfigManaged === false;
  const tomlExisted = fs.existsSync(paths.configToml);
  const source = tomlExisted ? fs.readFileSync(paths.configToml, "utf8") : "";
  const catalogPath = codexCatalogFile(paths);
  const active = config.upstreamOnly === true;
  // 先执行受管值守卫，拒绝后不发网络请求也不写入任何目录快照。
  const { patchedToml, previousCatalog } = manual
    ? { patchedToml: source, previousCatalog: readRootTomlString(source, "model_catalog_json") ?? null }
    : applyModelCatalogToml(source, active, paths, catalogPath, managedFiles);
  const tomlChanged = patchedToml !== source;
  const previousSnapshot = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : undefined;
  let snapshotWritten = false;
  let tomlWritten = false;
  let stateWritten = false;
  let stateBeforeWrite: string | undefined;
  let count = 0;
  try {
    if (active) {
      count = (await rebuildStaticCatalog(paths, config, catalogSource, { refreshAdapters })).models.length;
      snapshotWritten = true;
    } else if (refreshAdapters) {
      // 动态模式同样由显式模型命令刷新 agent；无需生成 Codex 静态快照。
      const adapters = await catalogSource.collect(true, paths.runtimeHome);
      for (const failure of adapters.failures) console.warn(`WARNING: ${failure}；已跳过该插件，不影响模型选择保存。`);
      count = adapters.entries.length;
    }
    if (tomlChanged) {
      const latestToml = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
      if (latestToml !== source || fs.existsSync(paths.configToml) !== tomlExisted) {
        throw new Error("模型刷新期间 Codex 配置发生变化；请重新运行命令，避免覆盖用户修改");
      }
      // 每次实际改写保留独立备份，卸载所依赖的首次备份不变。
      if (tomlExisted) fs.copyFileSync(paths.configToml, `${paths.configToml}.bak-cliproxy-gateway-${Date.now()}-${randomUUID()}`);
      atomicWrite(paths.configToml, patchedToml);
      tomlWritten = true;
      // 刷新可能耗时，重新读取状态以保留期间其它配置命令写入的字段。
      if (fs.existsSync(paths.stateFile)) {
        stateBeforeWrite = fs.readFileSync(paths.stateFile, "utf8");
        const latestState: ModelInstallState = JSON.parse(stateBeforeWrite);
        if (latestState.installedConfigHash === hash(source)) {
          latestState.installedConfigHash = hash(patchedToml);
          atomicWrite(paths.stateFile, `${JSON.stringify(latestState, null, 2)}\n`);
          stateWritten = true;
        }
      }
    }
  } catch (error) {
    if (stateWritten && stateBeforeWrite !== undefined) atomicWrite(paths.stateFile, stateBeforeWrite);
    if (tomlWritten) {
      if (tomlExisted) atomicWrite(paths.configToml, source);
      else fs.rmSync(paths.configToml, { force: true });
    }
    if (snapshotWritten) {
      if (previousSnapshot !== undefined) atomicWrite(catalogPath, previousSnapshot);
      else fs.rmSync(catalogPath, { force: true });
    }
    throw error;
  }
  if (tomlChanged) logConfigChange(paths.stdoutLog, {
    command: "model catalog update",
    changes: [{ field: "model_catalog_json (config.toml)", before: previousCatalog, after: active ? catalogPath : null }],
  }, config.maxGatewayLogBytes ?? 0);
  if (manual) {
    if (active) console.log(`手动配置模式：请在 ${paths.configToml} 根表设置 model_catalog_json = ${JSON.stringify(catalogPath)}，再完全退出并重启 Codex。`);
    else if (hasRootTomlKey(source, "model_catalog_json")) console.log(`手动配置模式：请从 ${paths.configToml} 根表移除 model_catalog_json，再完全退出并重启 Codex。`);
  }
  return { catalogPath, count, manual, tomlChanged };
}
