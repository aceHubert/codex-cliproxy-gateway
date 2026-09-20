import fs from "node:fs";
import { createHash } from "node:crypto";
import vendorModels from "../../models/vendor_models.json";
import bundledOverrides from "../../models.json";
import { compileModelOverrides, mergeCatalog, synthesizeModelEntry } from "../catalog.ts";
import { atomicWrite } from "../toml.ts";
import type { ModelCatalog } from "../types.ts";
import type { ZcodeProviderSnapshot, ZcodeSelection } from "./config.ts";

const MODEL_IDS = vendorModels["z.ai"].map((model) => model.name);
/** 对外统一命名空间：api-key 自定义 provider 沿用裸 zcode/ 前缀，保持既有行为。 */
const ZCODE_PREFIX = "zcode/";
/** 套餐作用域前缀与 ZcodeSelection.kind 一一对应；模型在套餐间重叠时会话靠这段选套餐。 */
const PLAN_PREFIXES: Record<ZcodeSelection["kind"], string> = {
  "individual-coding-plan": "zcode-individual-coding-plan/",
  "team-coding-plan": "zcode-team-coding-plan/",
  "start-plan": "zcode-start-plan/",
  "api-key": ZCODE_PREFIX,
};
/** 显示名后缀与 ZCode 客户端模型选择器的套餐分组（个人/团队/免费）一致。 */
const PLAN_DISPLAY_SUFFIXES: Record<ZcodeSelection["kind"], string> = {
  "individual-coding-plan": " (ZCode个人)",
  "team-coding-plan": " (ZCode团队)",
  "start-plan": " (ZCode免费)",
  "api-key": " (ZCode)",
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function isZcodeModel(model: unknown): boolean {
  return typeof model === "string" && /^zcode(?:\/|-)/i.test(model);
}

/** 从对外模型 ID 解析套餐连接形态；未声明的 zcode- 段不属于任何套餐。 */
export function zcodeModelPlan(model: string): ZcodeSelection["kind"] | undefined {
  if (!isZcodeModel(model)) return undefined;
  const id = model.toLowerCase();
  for (const [kind, prefix] of Object.entries(PLAN_PREFIXES) as [ZcodeSelection["kind"], string][]) {
    if (kind !== "api-key" && id.startsWith(prefix)) return kind;
  }
  return id.startsWith(ZCODE_PREFIX) ? "api-key" : undefined;
}

/** 目录使用厂商规范名称，上游使用当前套餐配置中的原始模型拼写。 */
export function zcodeUpstreamModel(model: string, snapshot: ZcodeProviderSnapshot): string | undefined {
  const plan = zcodeModelPlan(model);
  // 套餐段必须与快照的连接形态一致：会话选了哪个套餐，就只能用该套餐的模型拼写。
  if (!plan || plan !== snapshot.plan) return;
  const id = model.slice(PLAN_PREFIXES[plan].length).toLowerCase();
  if (!id) return;
  if (!MODEL_IDS.some((candidate) => candidate.toLowerCase() === id)) return;
  return snapshot.modelIds.find((candidate) => candidate.toLowerCase() === id);
}

function readOverrides(overrideFile?: string): unknown {
  return overrideFile && fs.existsSync(overrideFile)
    ? JSON.parse(fs.readFileSync(overrideFile, "utf8")) : bundledOverrides;
}

/**
 * 由内置厂商预设与覆盖规则合成全量裸 ID 目录。纯内存计算：数据源是构建期静态 import，
 * 重建成本与模型条数同级，不需要磁盘缓存，也不携带任何套餐或授权信息。
 */
export function buildZcodeVendorCatalog(overrideFile?: string): ModelCatalog {
  const rawOverrides = readOverrides(overrideFile);
  const vendors = compileModelOverrides(vendorModels, "vendor_models.json");
  const overrides = compileModelOverrides(rawOverrides, overrideFile ?? "models.json");
  const preset = { models: MODEL_IDS.map((id, index) =>
    synthesizeModelEntry(`z.ai/${id}`, index, { models: [] }, vendors)) };
  const refined = mergeCatalog({ models: [] }, preset, "", overrides);
  return { models: refined.models.map((entry) => {
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
}

/** /models 只按快照套餐的支持集合筛选并加套餐作用域前缀，不重新合成厂商元数据。 */
export function createZcodeCatalog(snapshot: ZcodeProviderSnapshot, cached: ModelCatalog): ModelCatalog {
  return createZcodeCatalogForModels(snapshot.modelIds, cached, snapshot.plan);
}

/** 按套餐支持集合（或多个套餐/entitlement 的能力并集）合成带套餐作用域前缀的目录。 */
export function createZcodeCatalogForModels(
  modelIds: readonly string[],
  cached: ModelCatalog,
  plan: ZcodeSelection["kind"] = "api-key",
): ModelCatalog {
  const supported = new Set(modelIds.map((model) => model.toLowerCase()));
  return { models: cached.models.filter((entry) => supported.has(entry.slug.toLowerCase())).map((entry) => ({
    ...entry,
    slug: `${PLAN_PREFIXES[plan]}${entry.slug}`,
    display_name: `${(entry.display_name ?? entry.slug).replace(/ \(ZCode\)$/, "")}${PLAN_DISPLAY_SUFFIXES[plan]}`,
  })) };
}

/** 启用 ZCode 时保留 zcode/ 顶层命名空间，防止上游同名条目与 ZCode 目录冲突。 */
export function mergeZcodeCatalog(base: ModelCatalog, zcode: ModelCatalog): ModelCatalog {
  const models = base.models.filter((model) => !isZcodeModel(model.slug));
  const priority = Math.max(0, ...models.map((model) => Number(model.priority) || 0)) + 100;
  return { models: [...models, ...zcode.models.map((model, index) => ({ ...model, priority: priority + index }))] };
}

/**
 * 把当前套餐的对外目录落盘。watch 驱动的账号/套餐切换与启动首读都会经过这里，
 * `/v1/models` 只消费内存中的同一份结果；配置失效时写入空 models，不留旧套餐模型。
 * 内容未变化时不写盘，返回是否发生了实际变更。
 */
export function writeZcodeServedCatalog(file: string, catalog: ModelCatalog): boolean {
  const contents = `${JSON.stringify({
    content_hash: digest(catalog.models),
    models: catalog.models,
  }, null, 2)}\n`;
  try {
    if (fs.readFileSync(file, "utf8") === contents) return false;
  } catch { /* 缺失或不可读时直接写入。 */ }
  atomicWrite(file, contents);
  return true;
}
