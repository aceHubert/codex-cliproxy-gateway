import type { ModelCatalog } from "@agent-proxy/plugin-api";
import codexClientModels from "../codex_client_models.json";
import vendorModels from "../vendor_models.json";

export interface VendorModelPreset { name: string; [key: string]: unknown; }
export type VendorModelPresets = Record<string, VendorModelPreset[]>;

const codexSnapshot: ModelCatalog = codexClientModels;

/** 预设与主机上下文无关；独立副本防止调用方污染其他目录。 */
export function getCodexModelSnapshot(): ModelCatalog {
  return structuredClone(codexSnapshot);
}

export function getVendorModelPresets(): VendorModelPresets {
  return structuredClone(vendorModels);
}
