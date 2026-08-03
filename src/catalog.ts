import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { atomicWrite } from "./toml.ts";
import type { ModelCatalog, ModelEntry } from "./types.ts";

export interface ModelOverrideRule {
  pattern: string;
  prefix: boolean;
  fields: Record<string, unknown>;
}

function invalidOverrides(file: string, message: string): never {
  throw new Error(`Invalid model overrides ${file}: ${message}`);
}

export function loadModelOverrides(file: string): ModelOverrideRule[] {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    invalidOverrides(file, error instanceof Error ? error.message : String(error));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidOverrides(file, "expected an object of model groups");
  }

  const rules: ModelOverrideRule[] = [];
  for (const [rawGroup, entries] of Object.entries(value)) {
    const group = rawGroup.trim();
    if (!group || group.includes("/")) invalidOverrides(file, `invalid group ${JSON.stringify(rawGroup)}`);
    if (!Array.isArray(entries)) invalidOverrides(file, `group ${JSON.stringify(group)} must be an array`);

    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        invalidOverrides(file, `${group}[${index}] must be an object`);
      }
      const fields = entry as Record<string, unknown>;
      const name = typeof fields.name === "string" ? fields.name.trim() : "";
      if (!name) invalidOverrides(file, `${group}[${index}].name must be a non-empty string`);
      const star = name.indexOf("*");
      if (star >= 0 && star !== name.length - 1) {
        invalidOverrides(file, `${group}[${index}].name may contain only one trailing *`);
      }
      if (Object.hasOwn(fields, "slug") || Object.hasOwn(fields, "priority")) {
        invalidOverrides(file, `${group}[${index}] may not override slug or priority`);
      }

      const { name: _name, ...overrides } = fields;
      const scopedName = group.toLowerCase() === "openai" ? name : `${group}/${name}`;
      rules.push({
        pattern: (star >= 0 ? scopedName.slice(0, -1) : scopedName).toLowerCase(),
        prefix: star >= 0,
        fields: overrides,
      });
    }
  }
  return rules;
}

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
  model.priority = priority;
  return model;
}

function applyModelOverrides(source: ModelEntry, rules: ModelOverrideRule[]): ModelEntry {
  const slug = source.slug.toLowerCase();
  let model = structuredClone(source);
  for (const rule of rules) {
    if (rule.prefix ? slug.startsWith(rule.pattern) : slug === rule.pattern) {
      model = { ...model, ...rule.fields };
    }
  }
  return model;
}

export function mergeCatalog(
  nativeCatalog: ModelCatalog,
  proxyCatalog: ModelCatalog,
  prefix = "cliproxy/",
  overrides: ModelOverrideRule[] = [],
): ModelCatalog {
  const nativeModels = nativeCatalog.models
    .filter((model) => !String(model.slug).startsWith(prefix))
    .map((model) => applyModelOverrides(model, overrides));
  const highestPriority = Math.max(0, ...nativeModels.map((model) => Number(model.priority) || 0));
  const proxyModels = proxyCatalog.models.map(
    (model, index) => prefixModel(
      applyModelOverrides(model, overrides),
      prefix,
      highestPriority + 100 + index,
    ),
  );
  return { models: [...nativeModels, ...proxyModels] };
}

interface SyncCatalogOptions {
  catalogFile: string;
  nativeCatalogFile?: string;
  modelsConfigFile: string;
  proxyModels: ModelEntry[];
  prefix: string;
}

export async function syncCatalog({ catalogFile, nativeCatalogFile, modelsConfigFile, proxyModels, prefix }: SyncCatalogOptions) {
  const overrides = loadModelOverrides(modelsConfigFile);
  const native = loadNativeCatalog(nativeCatalogFile);
  const merged = mergeCatalog(native, { models: proxyModels }, prefix, overrides);
  atomicWrite(catalogFile, `${JSON.stringify(merged, null, 2)}\n`);
  return {
    nativeCount: native.models.length,
    proxyCount: proxyModels.length,
    catalogFile,
  };
}
