import type { ModelCatalog, ModelEntry } from "@agent-proxy/plugin-api";
import codexClientModels from "../codex_client_models.json";
import vendorModels from "../vendor_models.json";

export interface VendorModelPreset { name: string; [key: string]: unknown; }
export type VendorModelPresets = Record<string, VendorModelPreset[]>;

const codexSnapshot: ModelCatalog = codexClientModels;

/** 目录合成首选基底：与官方目录同名条目；上游下线后仍作为首选，缺失时回退快照首条。
 * 2026-10-15 由 gpt-5.5（服务端已下线，CLI bundle 兜留）切换为 gpt-6-luna。 */
export const CODEX_BASELINE_SLUG = "gpt-6-luna";

/**
 * 目录合成基底选择：优先 preferredSlug（默认 gpt-6-luna），缺失时回退快照首条
 * （对齐 CLIProxyAPI e240bd8 的兜底行为——首选基底被上游下线后，快照刷新可能不再
 * 携带该条目，回退保证基底始终是真实官方条目而非手维护副本）。
 */
export function codexBaselineEntry(models: ModelEntry[], preferredSlug: string = CODEX_BASELINE_SLUG): ModelEntry {
  const base = models.find((model) => model.slug === preferredSlug) ?? models[0];
  if (!base) throw new Error(`Codex 模型快照为空，无法确定目录合成基底（期望 "${preferredSlug}"）`);
  return base;
}

/** 预设与主机上下文无关；独立副本防止调用方污染其他目录。 */
export function getCodexModelSnapshot(): ModelCatalog {
  return structuredClone(codexSnapshot);
}

/** 插件目录合成的基底条目（独立副本，见 codexBaselineEntry 的回退语义）。 */
export function getCodexBaselineEntry(): ModelEntry {
  return codexBaselineEntry(getCodexModelSnapshot().models);
}

export function getVendorModelPresets(): VendorModelPresets {
  return structuredClone(vendorModels);
}
