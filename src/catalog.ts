import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { atomicWrite } from "./toml.ts";
import type { ModelCatalog, ModelEntry } from "./types.ts";

const ONE_M_CONTEXT_WINDOW = 1_000_000;
const ONE_M_DISPLAY_NAME_SUFFIX = /\[1m\]\s*$/i;

function normalizeCatalog(value: unknown): ModelCatalog {
  if (Array.isArray(value)) return { models: value };
  if (value && typeof value === "object" && "models" in value && Array.isArray(value.models)) {
    return { models: value.models };
  }
  throw new Error("Native Codex model catalog does not contain a models array");
}

export function loadNativeCatalog(catalogFile?: string, codexCommand = "codex"): ModelCatalog {
  if (catalogFile && fs.existsSync(catalogFile)) {
    return normalizeCatalog(JSON.parse(fs.readFileSync(catalogFile, "utf8")));
  }

  try {
    const output = execFileSync(codexCommand, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return normalizeCatalog(JSON.parse(output));
  } catch (error) {
    throw new Error(
      `Unable to load the bundled Codex model catalog: ${error instanceof Error ? error.message : String(error)}. Ensure the codex CLI is installed and supports "codex debug models --bundled".`,
    );
  }
}

export async function fetchCliProxyCatalog(baseUrl: string, apiKey: string): Promise<ModelCatalog> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
  url.searchParams.set("client_version", "codex-cliproxy");
  const response = await fetch(url, apiKey
    ? { headers: { authorization: `Bearer ${apiKey}` } }
    : undefined);
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
  if (ONE_M_DISPLAY_NAME_SUFFIX.test(String(model.display_name))) {
    model.context_window = ONE_M_CONTEXT_WINDOW;
    model.max_context_window = ONE_M_CONTEXT_WINDOW;
  }
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

interface SyncCatalogOptions {
  catalogFile: string;
  nativeCatalogFile?: string;
  proxyModels: ModelEntry[];
  prefix: string;
}

export async function syncCatalog({ catalogFile, nativeCatalogFile, proxyModels, prefix }: SyncCatalogOptions) {
  const native = loadNativeCatalog(nativeCatalogFile);
  const merged = mergeCatalog(native, { models: proxyModels }, prefix);
  atomicWrite(catalogFile, `${JSON.stringify(merged, null, 2)}\n`);
  return {
    nativeCount: native.models.length,
    proxyCount: proxyModels.length,
    catalogFile,
  };
}
