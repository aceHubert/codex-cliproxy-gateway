import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./toml.ts";
import type { ModelCatalog, ModelEntry } from "./types.ts";

function normalizeCatalog(value: unknown): ModelCatalog {
  if (Array.isArray(value)) return { models: value };
  if (value && typeof value === "object" && "models" in value && Array.isArray(value.models)) {
    return { models: value.models };
  }
  throw new Error("Native Codex model catalog does not contain a models array");
}

export function loadNativeCatalog(codexHome: string): ModelCatalog {
  const cacheFile = path.join(codexHome, "models_cache.json");
  try {
    return normalizeCatalog(JSON.parse(fs.readFileSync(cacheFile, "utf8")));
  } catch (error) {
    throw new Error(
      `Unable to load app-server models from ${cacheFile}: ${error instanceof Error ? error.message : String(error)}. Open Codex once to refresh its model cache.`,
    );
  }
}

export async function fetchCliProxyCatalog(baseUrl: string, apiKey: string): Promise<ModelCatalog> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
  url.searchParams.set("client_version", "codex-cliproxy");
  const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CLIProxy /models returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("models" in data) || !Array.isArray(data.models)) {
    throw new Error("CLIProxy Codex catalog does not contain a models array");
  }
  const models = data.models.filter(
    (model): model is ModelEntry => Boolean(
      model && typeof model === "object" && "slug" in model && typeof model.slug === "string" && model.slug,
    ),
  );
  if (models.length === 0) throw new Error("CLIProxy Codex catalog returned no models");
  return { models: [...new Map(models.map((model) => [model.slug, model])).values()] };
}

function prefixModel(source: ModelEntry, prefix: string, priority: number): ModelEntry {
  const model = structuredClone(source);
  model.slug = `${prefix}${source.slug}`;
  model.display_name = source.display_name || source.slug;
  model.priority = priority;
  return model;
}

export function mergeCatalog(nativeCatalog: ModelCatalog, proxyCatalog: ModelCatalog, prefix = "cliproxy/"): ModelCatalog {
  const nativeModels = nativeCatalog.models.filter((model) => !String(model.slug).startsWith(prefix));
  const highestPriority = Math.max(0, ...nativeModels.map((model) => Number(model.priority) || 0));
  const proxyModels = proxyCatalog.models.map(
    (model, index) => prefixModel(model, prefix, highestPriority + 100 + index),
  );
  return { models: [...nativeModels, ...proxyModels] };
}

export function invalidateModelsCache(codexHome: string): { cacheFile: string; existed: boolean } {
  const cacheFile = path.join(codexHome, "models_cache.json");
  const existed = fs.existsSync(cacheFile);
  fs.rmSync(cacheFile, { force: true });
  return { cacheFile, existed };
}

interface SyncCatalogOptions {
  codexHome: string;
  catalogFile: string;
  proxyModels: ModelEntry[];
  prefix: string;
}

export async function syncCatalog({ codexHome, catalogFile, proxyModels, prefix }: SyncCatalogOptions) {
  const native = loadNativeCatalog(codexHome);
  const merged = mergeCatalog(native, { models: proxyModels }, prefix);
  atomicWrite(catalogFile, `${JSON.stringify(merged, null, 2)}\n`);
  const cache = invalidateModelsCache(codexHome);
  return {
    nativeCount: native.models.length,
    proxyCount: proxyModels.length,
    catalogFile,
    cacheFile: cache.cacheFile,
    cacheInvalidated: true,
    cachePreviouslyExisted: cache.existed,
  };
}
