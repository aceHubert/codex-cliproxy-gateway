import fs from "node:fs";
import { createHash } from "node:crypto";
import vendorModels from "../../models/vendor_models.json";
import bundledOverrides from "../../models.json";
import { compileModelOverrides, invalidateModelsCache, mergeCatalog, synthesizeModelEntry, normalizeCatalog } from "../catalog.ts";
import { atomicWrite } from "../toml.ts";
import type { ModelCatalog } from "../types.ts";
import type { ZcodeProviderSnapshot } from "./config.ts";

const MODEL_IDS = vendorModels["z.ai"].map((model) => model.name);
/** 对外统一命名空间：两种渠道共用 zcode/ 前缀，切换渠道不改变模型 ID。 */
const ZCODE_PREFIX = "zcode/";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function isZcodeModel(model: unknown): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith(ZCODE_PREFIX);
}

/** 目录使用厂商规范名称，上游使用当前套餐配置中的原始模型拼写。 */
export function zcodeUpstreamModel(model: string, snapshot: ZcodeProviderSnapshot): string | undefined {
  if (!isZcodeModel(model)) return;
  const id = model.slice(ZCODE_PREFIX.length).toLowerCase();
  if (!MODEL_IDS.some((candidate) => candidate.toLowerCase() === id)) return;
  return snapshot.modelIds.find((candidate) => candidate.toLowerCase() === id);
}

function readOverrides(overrideFile?: string): unknown {
  return overrideFile && fs.existsSync(overrideFile)
    ? JSON.parse(fs.readFileSync(overrideFile, "utf8")) : bundledOverrides;
}
/** 缓存可复用时返回目录；缺失、损坏、被改写或来源指纹过时都返回 undefined。 */
function cachedCatalog(file: string, fingerprint: string): ModelCatalog | undefined {
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    const catalog = normalizeCatalog(cached);
    if (cached.source_hash === fingerprint && cached.content_hash === digest(catalog.models)
      && catalog.models.length === MODEL_IDS.length
      && catalog.models.every((model) => typeof model.slug === "string" && MODEL_IDS.includes(model.slug))) return catalog;
  } catch { /* 缺失、损坏或过时缓存使用内联的厂商元数据重建。 */ }
}

/** 启动时校验并复用磁盘目录；两渠道共用裸模型 ID，文件内没有套餐或授权信息。 */
export function loadZcodeCatalogCache(file: string, overrideFile?: string, codexModelsCacheFile?: string): ModelCatalog {
  const rawOverrides = readOverrides(overrideFile);
  const fingerprint = digest({ version: 2, vendor: vendorModels["z.ai"], overrides: rawOverrides });
  const cached = cachedCatalog(file, fingerprint);
  if (cached) return cached;
  const vendors = compileModelOverrides(vendorModels, "vendor_models.json");
  const overrides = compileModelOverrides(rawOverrides, overrideFile ?? "models.json");
  const preset = { models: MODEL_IDS.map((id, index) =>
    synthesizeModelEntry(`z.ai/${id}`, index, { models: [] }, vendors)) };
  const refined = mergeCatalog({ models: [] }, preset, "", overrides);
  const catalog = { models: refined.models.map((entry) => {
    const slug = entry.slug.slice("z.ai/".length);
    return {
      ...entry,
      slug,
      // 对外目录统一标注 ZCode 渠道，与 cliproxy/new-api 的同名条目区分开。
      display_name: `${entry.display_name ?? slug} (ZCode)`,
      prefer_websockets: false,
      // zcode 链路已把 Responses web_search 原生映射为 web_search_20250305（实测 z.ai 支持）。
      supports_search_tool: true,
    };
  }) };
  atomicWrite(file, `${JSON.stringify({ ...catalog, source_hash: fingerprint, content_hash: digest(catalog.models) }, null, 2)}\n`);
  // 重建会改变 Codex 能看到的模型列表：过期它自己的目录缓存，让选择框重新拉取 /models。
  if (codexModelsCacheFile) invalidateModelsCache(codexModelsCacheFile);
  return catalog;
}

/** /models 只按当前套餐的支持集合筛选并加统一前缀，不重新合成厂商元数据。 */
export function createZcodeCatalog(snapshot: ZcodeProviderSnapshot, cached: ModelCatalog): ModelCatalog {
  const supported = new Set(snapshot.modelIds.map((model) => model.toLowerCase()));
  return { models: cached.models.filter((entry) => supported.has(entry.slug.toLowerCase())).map((entry) => ({
    ...entry,
    slug: `${ZCODE_PREFIX}${entry.slug}`,
  })) };
}

/** 启用 ZCode 时保留 zcode/ 顶层命名空间，防止上游同名条目与 ZCode 目录冲突。 */
export function mergeZcodeCatalog(base: ModelCatalog, zcode: ModelCatalog): ModelCatalog {
  const models = base.models.filter((model) => !isZcodeModel(model.slug));
  const priority = Math.max(0, ...models.map((model) => Number(model.priority) || 0)) + 100;
  return { models: [...models, ...zcode.models.map((model, index) => ({ ...model, priority: priority + index }))] };
}
