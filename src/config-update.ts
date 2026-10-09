import fs from "node:fs";
import bytes from "bytes";
import { atomicWrite } from "./toml.ts";
import { gatewayConfigWarnings, isJsonObject, migrateLegacyConfig } from "./config.ts";
import { logConfigChange, type ConfigChange } from "./process-log.ts";
import { validateZcodeConfig } from "./zcode/index.ts";
import { isZcodeModel, zcodeStaticModelPrefixes } from "./zcode/catalog.ts";
import { validateCodebuddyConfig } from "./codebuddy/index.ts";
import { CODEBUDDY_PREFIX, isCodebuddyModel, WORKBUDDY_PREFIX, codebuddyModelPrefixes } from "./codebuddy/catalog.ts";
import { validateQoderConfig } from "./qoder/index.ts";
import { isQoderModel, QODER_CN_PREFIX, QODER_INTL_PREFIX } from "./qoder/catalog.ts";
import { validateAgyConfig, isAgyModel } from "./agy/index.ts";
import type { GatewayConfig, ResolvedPaths } from "./types.ts";

/**
 * 配置写入的共享路径：CLI `config` 命令与 Web UI `POST /ui/api/config` 共用的
 * 解析、读写与审计逻辑。gateway.ts 的依赖树不得反向引用 cli.ts，因此独立成模块。
 */

/** --max-request-logs 解析：整个日志目录保留的最大请求日志文件数，0 表示不限制。 */
export function parseMaxRequestLogs(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--max-request-logs expects a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

/** --max-log-size 解析：网关日志大小上限，bytes 包负责 512KB/10MB 到字节的换算，0 表示不限制。 */
export function parseMaxLogSize(value: string): number {
  // bytes.parse 不认无 B 后缀的单位，且会把 "1M"/"1MiB" 静默解析成 1 字节而非报错；
  // 先归一化（去空格、补 b 后缀），再用严格语法把关，超出语法的输入直接拒绝。
  // 语法与 bytes README 对齐：b/kb/mb/gb/tb/pb，1024 进制，大小写不敏感。
  const normalized = value.trim()
    .replace(/^([+-]?\d+(?:\.\d+)?)\s*/, "$1")
    .replace(/([kmgtp])$/i, "$1b");
  const parsed = /^[+-]?\d+(?:\.\d+)?(?:b|kb|mb|gb|tb|pb)?$/i.test(normalized)
    ? bytes.parse(normalized)
    : null;
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--max-log-size expects a non-negative byte size such as 512KB, 10MB, or 1M, got "${value}"`);
  }
  return parsed;
}

/** 读取 config.json 并做与 CLI 读取一致的旧字段迁移；文件形状不对时抛错。 */
export function readGatewayConfigFile(file: string): GatewayConfig {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isJsonObject(value)) throw new Error(`Gateway config must be a JSON object: ${file}`);
  migrateLegacyConfig(value);
  return value as unknown as GatewayConfig;
}

/**
 * URL 的 query 可能携带 token：凡对外展示（审计落盘、Web UI 响应）一律只保留
 * origin 与路径，query 折叠为 `?…`；diff 与比较仍按原始值进行。
 */
export function sanitizeUrlValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (!url.search) return value;
    return `${url.origin}${url.pathname}?…`;
  } catch {
    return value;
  }
}

function writeGatewayConfigFile(file: string, value: GatewayConfig): void {
  for (const warning of gatewayConfigWarnings(value)) {
    console.warn(`Warning: ${file}: ${warning}`);
  }
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Web UI 表单可提交的字段；数值/大小字段按字符串提交，与服务端 CLI 解析规则一致。
 * 注意：CodeBuddy 账号选择只在 CLI（codebuddy --switch / config --codebuddy），UI 只读。
 * 排除模型：UI 按兼容端分组提交（excludedModelGroups，条目不带前缀，写盘时补全），
 * excludedModels 仍接受完整规则数组（CLI/编程式写入共用严格校验）。 */
export interface WebUiConfigPatch {
  zcode?: unknown;
  codebuddy?: unknown;
  qoder?: unknown;
  agy?: unknown;
  excludedModels?: unknown;
  excludedModelGroups?: unknown;
  requestLogging?: unknown;
  maxRequestLogs?: unknown;
  maxGatewayLogBytes?: unknown;
}

const SUPPORTED_PATCH_FIELDS = new Set([
  "zcode",
  "codebuddy",
  "qoder",
  "agy",
  "excludedModels",
  "excludedModelGroups",
  "requestLogging",
  "maxRequestLogs",
  "maxGatewayLogBytes",
]);

/** selectedModels 提交校验：字符串数组，去首尾空白，拒绝空项与重复项。 */
export function parseSelectedModels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("selectedModels expects an array of model ID strings");
  }
  const models = [...new Set(value.map((item) => (item as string).trim()).filter(Boolean))];
  if (models.length !== value.length) {
    throw new Error("selectedModels contains empty or duplicate model IDs");
  }
  return models;
}

/**
 * excludedModels 的宽松归一：去首尾空白、丢空项并按小写去重。用于整理「已存在的
 * 配置值」（含 CLI 交互的 current/merge、Web UI 分组展开后的合并）——存量里可能
 * 有早期版本的整族规则（`qoder-cn/`、`qoder-cn/*`），运行期匹配引擎仍认它们，
 * 归一阶段不能因此报错把用户锁在配置外。
 */
export function normalizeExcludedModels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("excludedModels expects an array of model ID or pattern strings");
  }
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push(pattern);
  }
  return patterns;
}

/**
 * excludedModels 的严格提交校验（新输入一律走这里：CLI `--exclude` 参数、Web UI
 * 原始数组、分组条目展开之外的用户输入）。在归一之上再拒绝：
 * - 纯通配（`*`）与家族形态（`qoder-cn/`、`qoder-cn/*`）——隐藏整个兼容端是开关的职责；
 * - 作用域外的规则（`cliproxy/…`、官方原生 ID 等）——排除只对本地兼容转发有效，
 *   上游模型的可选性由 `models --sync` 的 selectedModels 管理，官方模型不归本特性管。
 * 允许含字面量的通配（如 `qoder-cn/qoder-*`）。
 */
export function parseExcludedModels(value: unknown): string[] {
  const patterns = normalizeExcludedModels(value);
  for (const pattern of patterns) {
    if (/^\*+$/.test(pattern)) {
      throw new Error(
        `excludedModels pattern "${pattern}" would exclude every model; name concrete models instead (e.g. codebuddy-intl/gpt-4o)`,
      );
    }
    if (pattern.endsWith("/")) {
      throw new Error(
        `excludedModels pattern "${pattern}" would exclude the whole ${pattern} family; turn that compatibility endpoint off instead`,
      );
    }
    if (pattern.endsWith("/*")) {
      throw new Error(
        `excludedModels pattern "${pattern}" would exclude the whole ${pattern.slice(0, -2)}/ family; turn that compatibility endpoint off instead`,
      );
    }
    if (!isLocalAdapterExclusionPattern(pattern)) {
      throw new Error(
        `excludedModels pattern "${pattern}" must start with a full local adapter prefix (zcode/, zcode-<plan>/, codebuddy-*/, workbuddy-*/, qoder-*/, agy/); upstream models are selected via models --sync and official models are not excludable`,
      );
    }
  }
  return patterns;
}

/** 每个兼容端下按前缀细分的排除模型分组；前缀只在网关侧补全，Web UI 不展示也不要求填写。
 * 排除作用域仅限本地兼容端，且每条规则都必须带确定的适配器前缀；上游
 * （cliproxy/new-api）由 selectedModels 管理、官方原生模型不参与排除，因此没有
 * 也不需要无前缀的输入口。分组按「用户可感知的产品」归一，不按前缀逐条列举：
 * 套餐档位（zcode 各 plan）与凭据地域（cn/intl）都跟登录/订阅走，Web 用户既看不到
 * 也输入不了前缀，一律折叠为产品级家族通配（ZCODE_FAMILY_GLOB_PREFIX 等 4 个常量）；
 * 产品名（CodeBuddy 与 WorkBuddy）是用户装哪个应用的直接感知，保留独立分组。
 * CLI 仍可用确定前缀写精确规则。 */
export interface ExcludedModelGroupDefinition {
  /** 稳定标识（= 保存前缀去掉尾部斜杠；前端按 key 回传条目并渲染文案）。 */
  key: string;
  /** 所属兼容端：决定输入框挂在哪个端的配置块下。 */
  endpoint: "zcode" | "codebuddy" | "qoder" | "agy";
  /** 保存时自动补充的前缀（zcode 组为家族通配，见 ZCODE_FAMILY_GLOB_PREFIX）。 */
  prefix: string;
  /** 回显拆分时可识别的前缀集合；缺省即 [prefix]。 */
  matchPrefixes?: string[];
}

function groupDefinition(
  endpoint: ExcludedModelGroupDefinition["endpoint"],
  prefix: string,
  matchPrefixes?: string[],
): ExcludedModelGroupDefinition {
  // 家族通配前缀（zcode*\/、codebuddy-*\/）的 key 去掉通配段与斜杠，仍是产品名。
  const key = prefix.replace(/-?\*?\/$/, "");
  return matchPrefixes === undefined
    ? { key, endpoint, prefix }
    : { key, endpoint, prefix, matchPrefixes };
}

/** zcode 家族通配保存前缀：一条规则同时覆盖 zcode/、各套餐前缀与动态 provider 前缀。 */
const ZCODE_FAMILY_GLOB_PREFIX = "zcode*/";
/** CodeBuddy/WorkBuddy/Qoder 的产品级家族通配：地域（cn/intl）与旧前缀一并覆盖。 */
const CODEBUDDY_FAMILY_GLOB_PREFIX = "codebuddy-*/";
const WORKBUDDY_FAMILY_GLOB_PREFIX = "workbuddy-*/";
const QODER_FAMILY_GLOB_PREFIX = "qoder-*/";

const CODEBUDDY_CATALOG_PREFIXES = codebuddyModelPrefixes();

const ADAPTER_EXCLUDED_GROUPS: ExcludedModelGroupDefinition[] = [
  groupDefinition("zcode", ZCODE_FAMILY_GLOB_PREFIX,
    [...zcodeStaticModelPrefixes(), ZCODE_FAMILY_GLOB_PREFIX]),
  groupDefinition("codebuddy", CODEBUDDY_FAMILY_GLOB_PREFIX, [
    ...CODEBUDDY_CATALOG_PREFIXES.filter((prefix) => prefix.startsWith("codebuddy-")),
    CODEBUDDY_PREFIX, CODEBUDDY_FAMILY_GLOB_PREFIX,
  ]),
  // WorkBuddy 组挂在 CodeBuddy 端（同一开关行）下，key 按产品名区分。
  groupDefinition("codebuddy", WORKBUDDY_FAMILY_GLOB_PREFIX, [
    ...CODEBUDDY_CATALOG_PREFIXES.filter((prefix) => prefix.startsWith("workbuddy-")),
    WORKBUDDY_PREFIX, WORKBUDDY_FAMILY_GLOB_PREFIX,
  ]),
  groupDefinition("qoder", QODER_FAMILY_GLOB_PREFIX,
    [QODER_INTL_PREFIX, QODER_CN_PREFIX, "qoder/", QODER_FAMILY_GLOB_PREFIX]),
  groupDefinition("agy", "agy/"),
];

/** 当前配置下的分组定义（适配器对外前缀的权威清单）。 */
export function excludedModelGroupsFor(_config: GatewayConfig): ExcludedModelGroupDefinition[] {
  return ADAPTER_EXCLUDED_GROUPS.map((group) => ({ ...group }));
}

/**
 * 本地兼容端作用域（模型 slug 维度，网关过滤与路由拦截共用）：复用各适配器的
 * 权威 `is*Model` 谓词。作用域外（官方原生、cliproxy/ 上游）的模型不受
 * excludedModels 影响。
 */
export function isLocalAdapterModel(slug: string): boolean {
  return isZcodeModel(slug) || isCodebuddyModel(slug) || isQoderModel(slug) || isAgyModel(slug);
}

/**
 * 排除规则是否落在本地兼容端作用域内且带完整前缀（写入校验用）：规则必须以一条
 * 确定的适配器前缀开头——固定前缀按权威清单匹配，zcode 的动态 provider 前缀
 * （zcode-<id>/，无法静态枚举）按 isZcodeModel 的边界接受完整前缀段（段内不允许
 * 通配）。通配只允许出现在前缀之后（如 `qoder-cn/qoder-*`、`zcode/glm*`）；
 * `zcode-*`、`gpt-*`、`cliproxy/…` 等无完整前缀或作用域外的写法一律拒绝。
 */
export function isLocalAdapterExclusionPattern(pattern: string): boolean {
  const lower = pattern.toLowerCase();
  // 家族通配（zcode*/、codebuddy-*/…）：Web 保存的形态，必须有具体模型；
  // 整族排除（前缀本身）在更早的家族形态检查里被拒。
  const familyGlobs = [ZCODE_FAMILY_GLOB_PREFIX, CODEBUDDY_FAMILY_GLOB_PREFIX, WORKBUDDY_FAMILY_GLOB_PREFIX, QODER_FAMILY_GLOB_PREFIX];
  if (familyGlobs.some((prefix) => lower.startsWith(prefix) && lower.length > prefix.length)) return true;
  // zcode 的 API Key 多 provider 前缀（zcode-<id>/）动态生成，无法静态枚举。
  if (/^zcode-[^/*\s]+\/.+/.test(lower)) return true;
  return ADAPTER_EXCLUDED_GROUPS
    .flatMap((definition) => definition.matchPrefixes ?? [definition.prefix])
    .some((prefix) => lower.startsWith(prefix) && lower.length > prefix.length);
}

export interface ExcludedModelsByGroup {
  /** 分组 key → 去掉前缀后的模型名/规则条目。 */
  entries: Record<string, string[]>;
  /** 无法归入任何分组的规则（官方原生模型、家族形态、未知前缀），原样保留。 */
  other: string[];
}

/**
 * 完整规则 → 分组条目（GET /ui/api/config 与回显用）：按规范前缀（大小写不敏感）
 * 剥离；整族规则（剥离后为空或纯通配）、套餐/旧前缀规则（如 zcode-team-coding-plan/）
 * 与上游/官方规则一律进 other 原样保留，保证往返不丢。
 */
export function splitExcludedModelsByGroup(
  patterns: readonly string[],
  definitions: readonly ExcludedModelGroupDefinition[],
): ExcludedModelsByGroup {
  const entries: Record<string, string[]> = {};
  for (const definition of definitions) entries[definition.key] = [];
  const other: string[] = [];
  for (const raw of patterns) {
    const pattern = String(raw).trim();
    if (!pattern) continue;
    const lower = pattern.toLowerCase();
    // 具体前缀在前（zcode 套餐前缀优先于家族通配 zcode*/），保证回显条目不带前缀残留。
    const matched = definitions.flatMap((definition) =>
      (definition.matchPrefixes ?? [definition.prefix]).map((prefix) => ({ definition, prefix })))
      .find((candidate) => lower.startsWith(candidate.prefix.toLowerCase()));
    if (matched) {
      const entry = pattern.slice(matched.prefix.length);
      if (entry && !/^\*+$/.test(entry)) {
        entries[matched.definition.key].push(entry);
        continue;
      }
    }
    other.push(pattern);
  }
  return { entries, other };
}

/**
 * 分组条目 → 完整规则（POST 保存用）：条目必须是不带前缀的模型名（允许含字面量
 * 的通配）；检测到条目自带已知前缀（整条粘贴完整 ID 的常见误操作）或包含 `/`
 * 直接报错。分组整组替换 excludedModels：归不进任何分组的存量规则（旧整族形态、
 * 动态 provider 前缀等）随保存移除——排除只覆盖分组所代表的确定前缀族。
 */
export function expandExcludedModelGroups(
  groupsInput: unknown,
  definitions: readonly ExcludedModelGroupDefinition[],
): string[] {
  if (typeof groupsInput !== "object" || groupsInput === null || Array.isArray(groupsInput)) {
    throw new Error("excludedModelGroups expects an object of group key to model name arrays");
  }
  const known = new Map(definitions.map((definition) => [definition.key, definition]));
  const rules: string[] = [];
  for (const [key, value] of Object.entries(groupsInput as Record<string, unknown>)) {
    const definition = known.get(key);
    if (!definition) throw new Error(`Unknown excluded model group: ${key}`);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`excludedModelGroups.${key} expects an array of model name strings`);
    }
    for (const raw of value) {
      const entry = raw.trim();
      if (!entry) continue;
      if (/^\*+$/.test(entry)) {
        throw new Error(
          `excludedModelGroups.${key} entry "${raw}" would exclude every model of this group; turn the endpoint off instead`,
        );
      }
      const lower = entry.toLowerCase();
      const pasted = definitions.find((item) =>
        (item.matchPrefixes ?? [item.prefix]).some((prefix) => lower.startsWith(prefix.toLowerCase())));
      if (pasted) {
        throw new Error(
          `excludedModelGroups.${key} entry "${raw}" already carries the ${pasted.key} prefix; enter the model name without it`,
        );
      }
      if (entry.includes("/")) {
        throw new Error(
          `excludedModelGroups.${key} entry "${raw}" must be a bare model name without "/"`,
        );
      }
      rules.push(`${definition.prefix}${entry}`);
    }
  }
  return normalizeExcludedModels(rules);
}

/**
 * 模型选择的持久化路径（Web UI 专用）：写 config.json 的 selectedModels、按需同步
 * state.json 并落审计。它只改配置字段，不改目录文件——目录重建必须与配置写入
 * 原子地由调用方（webui.ts 的 POST /ui/api/upstream/models）完成，因此通用配置
 * 补丁白名单不含 selectedModels，防止「只改字段、目录不同步」的半更新。
 */
export function applySelectedModelsPatch(
  paths: ResolvedPaths,
  selectedModels: string[],
  syncState = true,
): { applied: ConfigChange[] } {
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = readGatewayConfigFile(paths.gatewayConfig);
  const before = Array.isArray(config.selectedModels) ? config.selectedModels : [];
  if (JSON.stringify(before) === JSON.stringify(selectedModels)) {
    return { applied: [] };
  }
  config.selectedModels = selectedModels;
  validateZcodeConfig(config);
  validateCodebuddyConfig(config);
  validateQoderConfig(config);
  validateAgyConfig(config);
  writeGatewayConfigFile(paths.gatewayConfig, config);
  if (syncState && fs.existsSync(paths.stateFile)) {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as { config?: unknown };
    state.config = config;
    atomicWrite(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
  const applied: ConfigChange[] = [{ field: "selectedModels", before, after: selectedModels }];
  logConfigChange(paths.stdoutLog, { command: "webui models", changes: applied }, config.maxGatewayLogBytes ?? 0);
  return { applied };
}

/**
 * 校验并应用 Web UI 的配置子集：写 config.json（含 schema 软告警）、按需同步
 * state.json 里的 config（仅生产实例；临时实例的派生 state 可能与默认安装同文件，
 * 绝不写入）、向 gateway.log 追加 `webui config` 审计。校验失败抛带修复方式的错误，
 * 不做任何写盘；白名单外的字段一律拒绝，避免拼写错误被静默忽略。返回应用后的配置
 * 与实际变化的字段（供响应展示）。
 */
export function applyWebUiConfigPatch(
  paths: ResolvedPaths,
  patch: WebUiConfigPatch,
  syncState = true,
): { config: GatewayConfig; applied: ConfigChange[] } {
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new Error("Request body contains no supported fields");
  for (const key of keys) {
    if (!SUPPORTED_PATCH_FIELDS.has(key)) throw new Error(`Unsupported field: ${key}`);
  }
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = readGatewayConfigFile(paths.gatewayConfig);
  const before = config as unknown as Record<string, unknown>;
  const applied: ConfigChange[] = [];
  const change = (field: string, next: unknown): void => {
    applied.push({ field, before: before[field] ?? null, after: next });
  };

  if (patch.zcode !== undefined) {
    if (typeof patch.zcode !== "boolean") throw new Error("zcode expects a boolean");
    if (config.zcode !== patch.zcode) change("zcode", patch.zcode);
    config.zcode = patch.zcode;
  }
  if (patch.codebuddy !== undefined) {
    if (typeof patch.codebuddy !== "boolean") throw new Error("codebuddy expects a boolean");
    if (config.codebuddy !== patch.codebuddy) change("codebuddy", patch.codebuddy);
    config.codebuddy = patch.codebuddy;
  }
  if (patch.qoder !== undefined) {
    if (typeof patch.qoder !== "boolean") throw new Error("qoder expects a boolean");
    if (config.qoder !== patch.qoder) change("qoder", patch.qoder);
    config.qoder = patch.qoder;
  }
  if (patch.agy !== undefined) {
    if (typeof patch.agy !== "boolean") throw new Error("agy expects a boolean");
    if (config.agy !== patch.agy) change("agy", patch.agy);
    config.agy = patch.agy;
  }
  if (patch.excludedModels !== undefined && patch.excludedModelGroups !== undefined) {
    throw new Error("provide either excludedModels or excludedModelGroups, not both");
  }
  if (patch.excludedModels !== undefined) {
    const models = parseExcludedModels(patch.excludedModels);
    const before = Array.isArray(config.excludedModels) ? config.excludedModels : [];
    if (JSON.stringify(before) !== JSON.stringify(models)) change("excludedModels", models);
    config.excludedModels = models;
  } else if (patch.excludedModelGroups !== undefined) {
    // 分组条目在网关侧补全前缀后整组替换 excludedModels；归不进分组的存量规则
    // （旧整族形态、动态 provider 前缀）随保存移除。
    const models = expandExcludedModelGroups(
      patch.excludedModelGroups,
      excludedModelGroupsFor(config),
    );
    const before = Array.isArray(config.excludedModels) ? config.excludedModels : [];
    if (JSON.stringify(before) !== JSON.stringify(models)) change("excludedModels", models);
    config.excludedModels = models;
  }
  if (patch.requestLogging !== undefined) {
    if (typeof patch.requestLogging !== "boolean") throw new Error("requestLogging expects a boolean");
    if (config.requestLogging !== patch.requestLogging) change("requestLogging", patch.requestLogging);
    config.requestLogging = patch.requestLogging;
    if (config.requestLogging) config.logDir ||= paths.logDir;
  }
  if (patch.maxRequestLogs !== undefined) {
    const value = typeof patch.maxRequestLogs === "number"
      ? String(patch.maxRequestLogs)
      : patch.maxRequestLogs;
    if (typeof value !== "string") throw new Error("maxRequestLogs expects a non-negative integer");
    const parsed = parseMaxRequestLogs(value.trim());
    if ((config.maxRequestLogs ?? 0) !== parsed) change("maxRequestLogs", parsed);
    config.maxRequestLogs = parsed;
  }
  if (patch.maxGatewayLogBytes !== undefined) {
    const value = patch.maxGatewayLogBytes === 0 ? "0" : patch.maxGatewayLogBytes;
    if (typeof value !== "string") {
      throw new Error("maxGatewayLogBytes expects 0 or a non-negative byte size such as 512KB or 10MB");
    }
    const parsed = parseMaxLogSize(value.trim());
    if ((config.maxGatewayLogBytes ?? 0) !== parsed) change("maxGatewayLogBytes", parsed);
    config.maxGatewayLogBytes = parsed;
  }

  if (applied.length === 0) {
    // 所有字段的值都未变化：不写盘也不落审计，直接返回当前配置。
    return { config, applied };
  }
  // 组合校验先于写盘：保留前缀冲突、非回环监听等组合会被新进程的 validate*Config
  // 拒绝启动——在这里挡下并保留原配置，避免"保存成功但重启后网关与管理页一起死亡"。
  validateZcodeConfig(config);
  validateCodebuddyConfig(config);
  validateQoderConfig(config);
  validateAgyConfig(config);
  writeGatewayConfigFile(paths.gatewayConfig, config);
  if (syncState && fs.existsSync(paths.stateFile)) {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as { config?: unknown };
    state.config = config;
    atomicWrite(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
  logConfigChange(paths.stdoutLog, { command: "webui config", changes: applied }, config.maxGatewayLogBytes ?? 0);
  return { config, applied };
}

/** 置位 pendingRestart：重启失败后下一次 CLI 命令会自动补一次重启。 */
export function markPendingRestart(stateFile: string): void {
  if (!fs.existsSync(stateFile)) return;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { pendingRestart?: boolean };
    state.pendingRestart = true;
    atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // state 写失败不阻断配置写入；重启标记只是兜底。
  }
}

/** 网关进程带着当前配置启动成功后清除 pendingRestart，避免下一次命令被误补重启。 */
export function clearPendingRestart(stateFile: string): void {
  if (!fs.existsSync(stateFile)) return;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { pendingRestart?: boolean };
    if (state.pendingRestart !== true) return;
    state.pendingRestart = false;
    atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // 同上，标记清理失败不影响服务。
  }
}
