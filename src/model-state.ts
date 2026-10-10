import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { filterExcludedModels, normalizeCatalog } from "./catalog.ts";
import { isLocalAdapterModel } from "./config-update.ts";
import { managedCatalogFiles, resolvePaths } from "./paths.ts";
import { logConfigChange } from "./process-log.ts";
import { atomicWrite, hasRootTomlKey, patchRootToml, readRootTomlString, restoreRootTomlKeys } from "./toml.ts";
import { createZcodeAdapter, type ZcodeDependencies } from "./zcode/index.ts";
import { createCodebuddyAdapter, type CodebuddyDependencies } from "./codebuddy/index.ts";
import { createQoderAdapter, type QoderDependencies } from "./qoder/index.ts";
import { createAgyAdapter, type AgyDependencies } from "./agy/index.ts";
import { createOpencodeZenAdapter, type OpencodeZenDependencies } from "./opencode/index.ts";
import type { GatewayConfig, ModelCatalog, ModelEntry, ResolvedPaths } from "./types.ts";

export interface ModelCatalogDependencies {
  zcode?: ZcodeDependencies;
  codebuddy?: CodebuddyDependencies;
  qoder?: QoderDependencies;
  agy?: AgyDependencies;
  opencodeZen?: OpencodeZenDependencies;
}

/** Codex 的合成静态目录与上游已选目录分离，避免重复同步污染原始模型。 */
export function codexCatalogFile(paths: ResolvedPaths): string {
  return path.join(paths.runtimeHome, "codex-catalog.json");
}

interface CatalogAdapter {
  refreshCatalog(): Promise<ModelCatalog>;
  reloadCatalog(): Promise<ModelCatalog>;
  close(): void;
}

/** 临时适配器只由本次命令驱动；关闭启动刷新、TTL 与后台计时器。 */
export async function collectAdapterModels(
  config: GatewayConfig,
  deps: ModelCatalogDependencies = {},
  { refresh = false, cacheDirectory = resolvePaths().runtimeHome }: { refresh?: boolean; cacheDirectory?: string } = {},
): Promise<{ entries: ModelEntry[]; failures: string[] }> {
  // 自定义上游 catalogPath 不改变实例的 agent 缓存归属。
  const lifecycle = { cacheDirectory, catalogMode: "manual" as const, refreshCatalogOnStart: false };
  const sources: Array<{ name: string; enabled: boolean; create: () => CatalogAdapter }> = [
    { name: "ZCode", enabled: config.zcode === true, create: () => createZcodeAdapter(config, { ...deps.zcode, ...lifecycle, cacheDirectory: deps.zcode?.cacheDirectory ?? lifecycle.cacheDirectory }) },
    { name: "CodeBuddy", enabled: config.codebuddy === true, create: () => createCodebuddyAdapter(config, { ...deps.codebuddy, ...lifecycle, cacheDirectory: deps.codebuddy?.cacheDirectory ?? lifecycle.cacheDirectory }) },
    { name: "Qoder", enabled: config.qoder === true, create: () => createQoderAdapter(config, { ...deps.qoder, ...lifecycle, cacheDirectory: deps.qoder?.cacheDirectory ?? lifecycle.cacheDirectory }) },
    { name: "Antigravity", enabled: config.agy === true, create: () => createAgyAdapter(config, { ...deps.agy, ...lifecycle, cacheDirectory: deps.agy?.cacheDirectory ?? lifecycle.cacheDirectory }) },
    { name: "OpenCode Zen", enabled: config.opencodeZen === true, create: () => createOpencodeZenAdapter(config, { ...deps.opencodeZen, ...lifecycle, cacheDirectory: deps.opencodeZen?.cacheDirectory ?? lifecycle.cacheDirectory }) },
  ].filter((source) => source.enabled);
  const results = await Promise.allSettled(sources.map(async (source) => {
    const adapter = source.create();
    try {
      const catalog = refresh ? await adapter.refreshCatalog() : await adapter.reloadCatalog();
      return catalog.models;
    } finally {
      adapter.close();
    }
  }));
  const entries: ModelEntry[] = [];
  const failures: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") entries.push(...result.value);
    // 不转述上游正文：目录错误可能包含认证或请求信息。
    else failures.push(`${sources[index].name} 模型目录不可用；请检查本机登录、网络并重新运行模型更新命令`);
  }
  return { entries, failures };
}

export async function rebuildStaticCatalog(
  paths: ResolvedPaths,
  config: GatewayConfig,
  deps: ModelCatalogDependencies = {},
  { refreshAdapters = false }: { refreshAdapters?: boolean } = {},
): Promise<ModelCatalog> {
  const adapters = await collectAdapterModels(config, deps, { refresh: refreshAdapters, cacheDirectory: paths.runtimeHome });
  if (adapters.failures.length) throw new Error(adapters.failures.join("；"));
  return writeStaticCatalog(paths, config, adapters.entries);
}

/** 网关复用自身已加载的适配器发布静态目录，避免构造第二批目录缓存与计时器。 */
export function writeStaticCatalog(paths: ResolvedPaths, config: GatewayConfig, adapterModels: ModelEntry[]): ModelCatalog {
  const upstream = normalizeCatalog(JSON.parse(fs.readFileSync(config.catalogPath, "utf8")));
  const merged = [...upstream.models, ...adapterModels];
  const seen = new Set<string>();
  for (const entry of merged) {
    if (!entry || typeof entry.slug !== "string" || !entry.slug.trim()) throw new Error("模型目录存在缺少 slug 的条目，未发布静态目录");
    if (seen.has(entry.slug)) throw new Error(`模型目录存在重复 ID：${entry.slug}；请修正上游与 agent 的模型冲突`);
    seen.add(entry.slug);
  }
  const catalog = filterExcludedModels({ models: merged }, config.excludedModels, isLocalAdapterModel);
  if (!catalog.models.length) throw new Error("静态模型目录为空；请先选择上游模型或启用有可用目录的 agent");
  atomicWrite(codexCatalogFile(paths), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

/** 只改写受管目录指向；遇到不可解析或用户自管的值时拒绝覆盖。 */
export function applyModelCatalogToml(
  source: string,
  active: boolean,
  paths: ResolvedPaths,
  catalogFile: string,
): { patchedToml: string; previousCatalog: string | null } {
  const configuredCatalog = readRootTomlString(source, "model_catalog_json");
  const legacyCatalogFile = path.join(paths.codexHome, "cliproxy-catalog.json");
  if (configuredCatalog && ![...managedCatalogFiles(paths), codexCatalogFile(paths), legacyCatalogFile].includes(configuredCatalog)) {
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
  deps: ModelCatalogDependencies = {},
  { refreshAdapters = false, manual: manualOverride }: { refreshAdapters?: boolean; manual?: boolean } = {},
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
    : applyModelCatalogToml(source, active, paths, catalogPath);
  const tomlChanged = patchedToml !== source;
  const previousSnapshot = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : undefined;
  let snapshotWritten = false;
  let tomlWritten = false;
  let stateWritten = false;
  let stateBeforeWrite: string | undefined;
  let count = 0;
  try {
    if (active) {
      count = (await rebuildStaticCatalog(paths, config, deps, { refreshAdapters })).models.length;
      snapshotWritten = true;
    } else if (refreshAdapters) {
      // 动态模式同样由显式模型命令刷新 agent；无需生成 Codex 静态快照。
      const adapters = await collectAdapterModels(config, deps, { refresh: true, cacheDirectory: paths.runtimeHome });
      if (adapters.failures.length) throw new Error(adapters.failures.join("；"));
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
