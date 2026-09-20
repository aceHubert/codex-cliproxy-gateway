import fs from "node:fs";
import { atomicWrite } from "./toml.ts";
import type { ModelCatalog, ModelEntry, UpstreamType } from "./types.ts";

export interface ModelOverrideRule {
  patterns: string[];
  prefix: boolean;
  fields: Record<string, unknown>;
}

function invalidOverrides(file: string, message: string): never {
  throw new Error(`Invalid model overrides ${file}: ${message}`);
}

/** 编译分组覆盖表（根目录 models.json 与 models/vendor_models.json 同构）。 */
export function compileModelOverrides(value: unknown, source = "models"): ModelOverrideRule[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidOverrides(source, "expected an object of model groups");
  }

  const rules: ModelOverrideRule[] = [];
  for (const [rawGroup, entries] of Object.entries(value as Record<string, unknown>)) {
    const group = rawGroup.trim();
    if (!group || group.includes("/")) invalidOverrides(source, `invalid group ${JSON.stringify(rawGroup)}`);
    if (!Array.isArray(entries)) invalidOverrides(source, `group ${JSON.stringify(group)} must be an array`);

    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        invalidOverrides(source, `${group}[${index}] must be an object`);
      }
      const fields = entry as Record<string, unknown>;
      const name = typeof fields.name === "string" ? fields.name.trim() : "";
      if (!name) invalidOverrides(source, `${group}[${index}].name must be a non-empty string`);
      const star = name.indexOf("*");
      if (star >= 0 && star !== name.length - 1) {
        invalidOverrides(source, `${group}[${index}].name may contain only one trailing *`);
      }
      if (Object.hasOwn(fields, "slug") || Object.hasOwn(fields, "priority")) {
        invalidOverrides(source, `${group}[${index}] may not override slug or priority`);
      }

      const { name: _name, ...overrides } = fields;
      // openai 组的模型 ID 不带组名前缀；其余组同时编译「组名/名称」与裸「名称」两种
      // 模式，让同一份覆盖表既能命中 CLIProxy 的 vendor/model ID，也能命中 new-api
      // 这类 OpenAI 兼容上游的裸模型 ID。通配全部（*）的规则不加裸别名，否则它
      // 会升级成全局兜底，误伤其他组的模型。
      const scopedNames = group.toLowerCase() === "openai"
        ? [name]
        : name === "*" ? [`${group}/${name}`] : [`${group}/${name}`, name];
      rules.push({
        patterns: scopedNames.map((scoped) =>
          (star >= 0 ? scoped.slice(0, -1) : scoped).toLowerCase()),
        prefix: star >= 0,
        fields: overrides,
      });
    }
  }
  return rules;
}

export function loadModelOverrides(file: string): ModelOverrideRule[] {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    invalidOverrides(file, error instanceof Error ? error.message : String(error));
  }
  return compileModelOverrides(value, file);
}

export async function resolveModelMergeJson(
  cacheFile: string,
  bundledFile: string,
  url?: string,
  refresh = false,
): Promise<string> {
  if (url && (refresh || !fs.existsSync(cacheFile))) {
    let source: URL;
    try {
      source = new URL(url);
    } catch {
      throw new Error(`Invalid model_merge_json URL: ${url}`);
    }
    const parts = source.pathname.split("/").filter(Boolean);
    const githubRepository = ["github.com", "www.github.com"].includes(source.hostname)
      && parts.length === 2;
    if (!["http:", "https:"].includes(source.protocol)
      || source.username
      || source.password
      || parts.length === 0
      || (!githubRepository && source.pathname.endsWith("/"))) {
      throw new Error("model_merge_json must be a GitHub repository or an HTTP(S) URL with a file name");
    }
    if (githubRepository) {
      source.hostname = "github.com";
      source.pathname = `/${parts[0]}/${parts[1].replace(/\.git$/, "")}/releases/latest/download/models.json`;
      source.search = "";
      source.hash = "";
    }

    const response = await fetch(source, { redirect: "follow" });
    if (!response.ok) throw new Error(`model_merge_json download returned HTTP ${response.status}`);
    const contents = await response.text();
    if (Buffer.byteLength(contents) > 16 * 1024 * 1024) {
      throw new Error("model_merge_json download exceeds 16 MiB");
    }
    const stagingFile = `${cacheFile}.download`;
    try {
      atomicWrite(stagingFile, contents.endsWith("\n") ? contents : `${contents}\n`);
      loadModelOverrides(stagingFile);
      fs.renameSync(stagingFile, cacheFile);
    } finally {
      fs.rmSync(stagingFile, { force: true });
    }
  }
  return fs.existsSync(cacheFile) ? cacheFile : bundledFile;
}

export function normalizeCatalog(value: unknown): ModelCatalog {
  if (Array.isArray(value)) return { models: value };
  if (value && typeof value === "object" && "models" in value && Array.isArray(value.models)) {
    return { models: value.models };
  }
  throw new Error("Model catalog does not contain a models array");
}

export function invalidateModelsCache(file: string): void {
  let current: Record<string, unknown> = { models: [] };
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {}
  }
  atomicWrite(file, `${JSON.stringify({
    ...current,
    fetched_at: "2000-01-01T00:00:00Z",
    client_version: "0.0.0",
  }, null, 2)}\n`);
}

/**
 * 从 Codex 目录缓存中移除匹配条目，同时过期时间戳与版本。用于 provider 配置变化或
 * 解析失败时立即撤下旧模型：只重置新鲜度会保留已下线条目，客户端仍可继续选择。
 */
export function clearModelsCacheEntries(file: string, matches: (slug: string) => boolean): boolean {
  let current: Record<string, unknown> = { models: [] };
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {}
  }
  const models = Array.isArray(current.models)
    ? (current.models as unknown[]).filter((model) => {
      const slug = model && typeof model === "object" && typeof (model as { slug?: unknown }).slug === "string"
        ? (model as { slug: string }).slug
        : "";
      return !slug || !matches(slug);
    })
    : [];
  if (Array.isArray(current.models) && models.length === current.models.length) return false;
  atomicWrite(file, `${JSON.stringify({
    ...current,
    fetched_at: "2000-01-01T00:00:00Z",
    client_version: "0.0.0",
    models,
  }, null, 2)}\n`);
  return true;
}

export async function fetchCliProxyCatalog(
  baseUrl: string,
  apiKey: string,
  clientVersion = "0.0.0",
): Promise<ModelCatalog> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
  url.searchParams.set("client_version", clientVersion || "0.0.0");
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

/**
 * 未知模型合成时使用的基底条目（CLIProxyAPI 同款做法：克隆 Codex 目录快照中的
 * gpt-5.5 条目，仅替换标识字段），保证字段集与真实 Codex catalog 完全一致。
 */
export const NEWAPI_FALLBACK_BASE_SLUG = "gpt-5.5";

/**
 * 校验 Codex 目录格式的快照（{"models":[...]}，兼容 models/codex_client_models.json
 * 与 models/vendor_models.json 两种来源）。二者均通过构建期 import 内联进 dist。
 */
export function parseCodexCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models)) {
    throw new Error('Invalid codex catalog: expected { "models": [...] }');
  }
  const models = (value as { models: unknown[] }).models.filter(
    (model): model is ModelEntry => Boolean(
      model && typeof model === "object" && "slug" in model
      && typeof (model as ModelEntry).slug === "string" && (model as ModelEntry).slug,
    ),
  );
  if (models.length === 0) {
    throw new Error("Invalid codex catalog: no models with a non-empty slug");
  }
  return { models: [...new Map(models.map((model) => [model.slug, model])).values()] };
}

/**
 * models.json 已知厂商命中的合成基底：仅包含 Codex 解析所需的保守字段，不携带任何
 * GPT 专属配置（model_messages、reasoning levels、prefer_websockets 等），由命中的
 * 覆盖规则补全厂商元数据。字段集与仓库 models.json 覆盖条目同源。
 */
function minimalModelEntry(id: string, priority: number): ModelEntry {
  return {
    slug: id,
    display_name: id,
    description: `OpenAI-compatible model "${id}" served by the configured upstream.`,
    visibility: "list",
    supported_in_api: true,
    priority,
    base_instructions: "",
    shell_type: "shell_command",
    apply_patch_tool_type: "freeform",
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: 10000 },
    context_window: 128000,
    max_context_window: 128000,
    effective_context_window_percent: 95,
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
  };
}

const EMPTY_RULES: ModelOverrideRule[] = [];

/**
 * 以厂商预设/官方目录为元数据源为 new-api 模型 ID 合成条目，优先级：
 * 1. 厂商预设（models/vendor_models.json，z.ai/deepseek/moonshotai 分组，与根目录
 *    models.json 同构）规则命中 → 极简基底 + 官方条目字段，不继承任何 GPT 专属配置；
 * 2. Codex 目录快照（models/codex_client_models.json）精确命中 → 沿用真实条目；
 * 3. 根目录 models.json 覆盖规则命中 → 极简基底 + 规则字段；
 * 4. 均未命中 → 克隆 {@link NEWAPI_FALLBACK_BASE_SLUG} 条目并替换标识字段、解除最小
 *    客户端版本限制（CLIProxyAPI 的兜底做法）。
 * 大小写不敏感匹配；priority 一律按序重排；syncCatalog 落盘时覆盖规则仍会再套用一遍。
 */
export function synthesizeModelEntry(
  id: string,
  priority: number,
  snapshot: ModelCatalog,
  vendors: ModelOverrideRule[] = EMPTY_RULES,
  overrides: ModelOverrideRule[] = EMPTY_RULES,
  baseSlug = NEWAPI_FALLBACK_BASE_SLUG,
): ModelEntry {
  const vendorRule = findMatchingRule(id, vendors);
  if (vendorRule) {
    return applyModelOverrides(minimalModelEntry(id, priority), vendors);
  }
  const known = snapshot.models.find((model) => model.slug.toLowerCase() === id.toLowerCase());
  if (known) {
    const model = structuredClone(known);
    model.slug = id;
    model.priority = priority;
    return model;
  }
  if (findMatchingRule(id, overrides)) {
    return applyModelOverrides(minimalModelEntry(id, priority), overrides);
  }
  const base = snapshot.models.find((model) => model.slug === baseSlug);
  if (!base) {
    throw new Error(`codex_client_models snapshot does not contain the "${baseSlug}" base entry`);
  }
  const model = structuredClone(base);
  model.slug = id;
  model.display_name = id;
  model.description = `OpenAI-compatible model "${id}" served by the configured upstream.`;
  delete model.minimal_client_version;
  model.priority = priority;
  return model;
}

/** new-api 只提供 OpenAI 标准模型列表（{"data":[{"id":…}]}），Codex 目录需按快照本地合成。 */
export async function fetchNewApiCatalog(
  baseUrl: string,
  apiKey: string,
  snapshot: ModelCatalog,
  vendors: ModelOverrideRule[] = EMPTY_RULES,
  overrides: ModelOverrideRule[] = EMPTY_RULES,
): Promise<ModelCatalog> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, apiKey
    ? { headers: { authorization: `Bearer ${apiKey}` } }
    : undefined);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`new-api /models returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('new-api /models did not return JSON; expected {"data":[{"id":"…"}]}');
  }
  const list = data && typeof data === "object" && "data" in data && Array.isArray(data.data)
    ? data.data
    : undefined;
  if (list === undefined) {
    throw new Error('new-api /models does not contain a data array; expected {"data":[{"id":"…"}]}');
  }
  // 按 ID 大小写不敏感去重（new-api 里 gpt-5.2 与 GPT-5.2 是同一个模型），保留先出现的写法。
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of list) {
    const id = item && typeof item === "object" && "id" in item && typeof item.id === "string"
      ? item.id.trim()
      : "";
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  ids.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (ids.length === 0) throw new Error("new-api /models returned no models");
  return { models: ids.map((id, index) => synthesizeModelEntry(id, index, snapshot, vendors, overrides)) };
}

export interface UpstreamCatalogOptions {
  /** newapi 合成所需的 Codex 目录快照（cli.ts 从内联的 codex_client_models.json 解析）。 */
  snapshot?: ModelCatalog;
  /** 厂商预设规则（models/vendor_models.json，z.ai/deepseek/moonshotai 分组），合成时优先命中。 */
  vendors?: ModelOverrideRule[];
  /** models.json 覆盖规则：合成时命中走干净基底；落盘时对全部条目做 refine。 */
  overrides?: ModelOverrideRule[];
}

/**
 * 目录拉取统一入口：cliproxy 消费上游的 Codex 目录，newapi 从 OpenAI 列表按快照本地合成。
 * newapi 必须提供 snapshot（缺省时直接报错）；隐藏条目不进入 CLI/Web 的可选目录。
 */
export async function fetchUpstreamCatalog(
  baseUrl: string,
  apiKey: string,
  type: UpstreamType = "cliproxy",
  clientVersion = "0.0.0",
  options: UpstreamCatalogOptions = {},
): Promise<ModelCatalog> {
  let catalog: ModelCatalog;
  if (type === "newapi") {
    if (!options.snapshot) throw new Error("newapi catalog synthesis requires a codex_client_models snapshot");
    catalog = await fetchNewApiCatalog(
      baseUrl,
      apiKey,
      options.snapshot,
      options.vendors ?? EMPTY_RULES,
      options.overrides ?? EMPTY_RULES,
    );
  } else {
    catalog = await fetchCliProxyCatalog(baseUrl, apiKey, clientVersion);
  }
  // 仅过滤上游选择入口，不改变官方目录及其 last-good 缓存的完整内容。
  return { ...catalog, models: catalog.models.filter((model) => model.visibility !== "hide") };
}

function prefixModel(source: ModelEntry, prefix: string, priority: number): ModelEntry {
  const model = structuredClone(source);
  model.slug = `${prefix}${source.slug}`;
  model.display_name = source.display_name || source.slug;
  model.priority = priority;
  return model;
}

function findMatchingRule(slug: string, rules: ModelOverrideRule[]): ModelOverrideRule | undefined {
  const lower = slug.toLowerCase();
  return rules.find((rule) =>
    rule.patterns.some((pattern) => (rule.prefix ? lower.startsWith(pattern) : lower === pattern)));
}

function applyModelOverrides(source: ModelEntry, rules: ModelOverrideRule[]): ModelEntry {
  const rule = findMatchingRule(source.slug, rules);
  const model = structuredClone(source);
  return rule ? { ...model, ...rule.fields } : model;
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
  modelsConfigFile: string;
  proxyModels: ModelEntry[];
}

export async function syncCatalog({
  catalogFile,
  modelsConfigFile,
  proxyModels,
}: SyncCatalogOptions) {
  const overrides = loadModelOverrides(modelsConfigFile);
  const output: ModelCatalog = {
    models: proxyModels.map((model) => applyModelOverrides(model, overrides)),
  };
  atomicWrite(catalogFile, `${JSON.stringify(output, null, 2)}\n`);
  return {
    proxyCount: proxyModels.length,
    catalogFile,
  };
}
