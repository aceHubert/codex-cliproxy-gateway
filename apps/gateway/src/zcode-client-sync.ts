import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isZcodeModel } from "@agent-proxy/zcode/catalog";
import type { GatewayConfig, ModelEntry } from "./types.ts";
import {
  modelContextWindow,
  modelInputModalities,
  modelReasoningEfforts,
  writeAllOrRollback,
  type ModelPushOutcome,
  type ModelPushTarget,
} from "./models-push.ts";

/**
 * 本命令在 ZCode 侧的唯一受管 provider（与 dsh 的 agent-proxy 同构）；用户自建的
 * cliproxy 等条目一概不动。协议 anthropic-messages，apiKey 仅为占位——网关模型
 * 端口忽略客户端 key，各 agent 插件用自有凭据访问上游。
 */
/** 受管显示名（与 dsh 侧 displayName 对称）：config.json 的 name 与 rule 的 providerName 均用它。 */
const ZCODE_PROVIDER_DISPLAY_NAME = "AgentProxy";
/**
 * 受管 providerName 匹配：ZCode 界面显示的就是 rule 的 providerName，因此写入
 * 显示名 `AgentProxy`；同时兼容早期版本写入的 `agent-proxy`（去连字符后小写比较）。
 */
function isManagedProviderName(name: unknown): boolean {
  return typeof name === "string" && name.toLowerCase().replace(/-/g, "") === "agentproxy";
}
/** apiKey 占位（用户裁决：字面值 EMPTY）——网关忽略客户端 key，各插件自处理上游授权。 */
const ZCODE_API_KEY_PLACEHOLDER = "EMPTY";
/**
 * rule 的 UI 分组：真实显示条目（cliproxy/test/atria/Local 等）全部使用
 * `standard-personal`，缺失该字段的 provider 不会出现在 ZCode 的供应商列表。
 */
const ZCODE_PROVIDER_GROUP = "standard-personal";

export interface ZcodeClientPaths {
  home: string;
  v2: string;
  configFile: string;
  providerConfigFile: string;
}

/** ZCode 配置根：`ZCODE_HOME` 覆盖（测试用），默认 `~/.zcode`。 */
export function resolveZcodeClientPaths(env: NodeJS.ProcessEnv = process.env): ZcodeClientPaths {
  const home = env.ZCODE_HOME || path.join(env.HOME || os.homedir(), ".zcode");
  const v2 = path.join(home, "v2");
  return { home, v2, configFile: path.join(v2, "config.json"), providerConfigFile: path.join(v2, "provider_config.json") };
}

interface ZcodeProviderRule {
  providerId?: unknown;
  providerName?: unknown;
  config?: Record<string, unknown>;
}

interface ZcodeProviderConfigDocument {
  config?: {
    providerOrder?: unknown;
    providerConfigRules?: { providerRules?: unknown };
    modelConfigRules?: { providerModelRules?: unknown; manualProviderModelRules?: unknown };
  };
}

interface ZcodeConfigDocument {
  provider?: Record<string, ZcodeProviderEntry>;
}

interface ZcodeProviderEntry {
  name?: unknown;
  kind?: unknown;
  options?: unknown;
  source?: unknown;
  models?: Record<string, Record<string, unknown>>;
  zcode?: { deletedModels?: unknown };
}

export interface ZcodePushOptions {
  config: Pick<GatewayConfig, "host" | "port">;
  env?: NodeJS.ProcessEnv;
}

/** ZCode 模型定义合成：仅按网关元数据填充，缺失的字段一律省略，不臆造。 */
export function synthesizeZcodeModelDefinition(entry: ModelEntry): Record<string, unknown> {
  const definition: Record<string, unknown> = {};
  // 显示名（UI 模型列表渲染的就是这个字段；缺失时列表只显示模型 ID）。
  definition.name = typeof entry.display_name === "string" && entry.display_name ? entry.display_name : entry.slug;
  const efforts = modelReasoningEfforts(entry);
  if (efforts.length > 0) {
    const declared = typeof entry.default_reasoning_level === "string" ? entry.default_reasoning_level : undefined;
    definition.reasoning = {
      enabled: true,
      variants: [...efforts],
      defaultVariant: declared && efforts.includes(declared) ? declared : efforts[efforts.length - 1],
    };
  }
  const context = modelContextWindow(entry);
  if (context !== undefined) definition.limit = { context };
  definition.modalities = { input: modelInputModalities(entry), output: ["text"] };
  definition.zcode = { modalitiesConfigured: true, modified: true };
  return definition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${file} does not contain a JSON object`);
  return parsed;
}

/**
 * 把网关本地 agent 插件模型清单按 ID 全量替换进 ZCode 的受管 provider `agent-proxy`
 * （AgentProxy 同构 / anthropic-messages / 网关本地根地址；缺失时自动创建）：
 * - `provider_config.json`：受管 rule 的 modelOrder/personalModelIds 换为新清单，其
 *   providerModelRules 与清单一一对齐，同步 inputFormat.supportsImage 与
 *   reasoningLevel 档位（档位选择器只读规则字段，config.json 的 reasoning 不驱动
 *   选择器），providerOrder 补齐；
 * - `config.json`：受管 provider 的 `models` 映射及模型定义均按当前目录重建；
 *   `zcode.deletedModels` 视为用户删除意图，跳过且数组不动；
 * - 受管 provider 的手动模型规则清除，避免旧能力覆盖当前目录；其他 provider 保留；
 * - ZCode 插件自身模型（zcode/ 与 zcode-<plan>/ 前缀）绝不写入（ZCode 直连自家上游）；
 * - 已创建 provider 的 kind/options（apiKey/baseURL）等连接字段永不回写，显示名统一为 AgentProxy；
 *   用户自建 provider（cliproxy 等）与其他字段一概不动。
 */
export function pushZcodeModels(models: readonly ModelEntry[], options: ZcodePushOptions): ModelPushOutcome {
  const paths = resolveZcodeClientPaths(options.env);
  const pushModels = models.filter((model) => !isZcodeModel(model.slug));
  if (pushModels.length === 0) {
    throw new Error("zcode push aborted; no models remain after excluding ZCode plugin models");
  }

  const providerDoc = readJsonFile(paths.providerConfigFile) as ZcodeProviderConfigDocument;
  const configDoc = readJsonFile(paths.configFile) as ZcodeConfigDocument;
  const providerRules = providerDoc.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(providerRules)) {
    throw new Error(`${paths.providerConfigFile}: config.providerConfigRules.providerRules is missing or not an array`);
  }
  const modelRules = providerDoc.config?.modelConfigRules?.providerModelRules;
  if (!Array.isArray(modelRules)) {
    throw new Error(`${paths.providerConfigFile}: config.modelConfigRules.providerModelRules is missing or not an array`);
  }
  configDoc.provider ??= {};

  // 定位（或补建）受管 provider：兼容存量 "agent-proxy" 与现行 "AgentProxy"。
  const existingRule = providerRules.find(
    (item): item is ZcodeProviderRule => isRecord(item) && isManagedProviderName(item.providerName),
  );
  const baseURL = `http://${options.config.host}:${options.config.port}`;
  let rule = existingRule;
  let providerId = rule && typeof rule.providerId === "string" ? rule.providerId : undefined;
  if (providerId === undefined) {
    providerId = randomUUID();
    rule = {
      providerId,
      providerName: ZCODE_PROVIDER_DISPLAY_NAME,
      config: {
        group: ZCODE_PROVIDER_GROUP,
        access: { type: "api-key", apiKey: ZCODE_API_KEY_PLACEHOLDER },
        api: { type: "anthropic-messages", baseUrl: baseURL },
        personalModelIds: [],
        modelOrder: [],
      },
    };
    providerRules.push(rule);
    if (Array.isArray(providerDoc.config?.providerOrder) && !providerDoc.config.providerOrder.includes(providerId)) {
      providerDoc.config.providerOrder.push(providerId);
    }
  } else {
    const managedRule = rule as ZcodeProviderRule;
    if (Array.isArray(providerDoc.config?.providerOrder) && !providerDoc.config.providerOrder.includes(providerId)) {
      providerDoc.config.providerOrder.push(providerId);
    }
    // 受管 rule 的显示名（界面渲染的就是 providerName）统一为 AgentProxy。
    if (managedRule.providerName !== ZCODE_PROVIDER_DISPLAY_NAME) managedRule.providerName = ZCODE_PROVIDER_DISPLAY_NAME;
  }
  if (!isRecord(rule!.config)) throw new Error(`${paths.providerConfigFile}: managed provider rule has no config object`);
  // 早期版本创建的受管 rule 缺 group（供应商列表不显示的根因之一）：补齐。
  if (rule!.config.group !== ZCODE_PROVIDER_GROUP) rule!.config.group = ZCODE_PROVIDER_GROUP;

  let entry = configDoc.provider[providerId];
  if (!isRecord(entry)) {
    entry = {
      name: ZCODE_PROVIDER_DISPLAY_NAME,
      kind: "anthropic",
      options: { apiKey: ZCODE_API_KEY_PLACEHOLDER, apiKeyRequired: true, baseURL },
      source: "custom",
      models: {},
    };
    configDoc.provider[providerId] = entry;
  } else if (entry.name !== ZCODE_PROVIDER_DISPLAY_NAME) {
    // 受管条目的显示名由本工具维护（早期版本写的是 agent-proxy）。
    entry.name = ZCODE_PROVIDER_DISPLAY_NAME;
  }

  const deletedModels: unknown = isRecord(entry.zcode) ? entry.zcode.deletedModels : undefined;
  const deleted = new Set(
    (Array.isArray(deletedModels) ? deletedModels : [])
      .filter((item): item is string => typeof item === "string")
      .map((slug) => slug.toLowerCase()),
  );
  const newSlugs = pushModels.filter((model) => !deleted.has(model.slug.toLowerCase())).map((model) => model.slug);
  if (newSlugs.length === 0) {
    throw new Error("zcode push aborted; every remaining model is hidden by ZCode deletedModels");
  }
  const newSet = new Set(newSlugs.map((slug) => slug.toLowerCase()));
  const bySlug = new Map(pushModels.map((model) => [model.slug.toLowerCase(), model] as const));
  const oldOrder = Array.isArray(rule!.config.modelOrder)
    ? rule!.config.modelOrder.filter((item): item is string => typeof item === "string")
    : [];
  const oldSet = new Set(oldOrder.map((slug) => slug.toLowerCase()));
  const addedCount = newSlugs.filter((slug) => !oldSet.has(slug.toLowerCase())).length;
  const removedCount = oldOrder.filter((slug) => !newSet.has(slug.toLowerCase())).length;
  const unchangedCount = newSlugs.length - addedCount;

  rule!.config.modelOrder = [...newSlugs];
  rule!.config.personalModelIds = [...newSlugs];
  const syncedRules = newSlugs.map((slug) => {
    const model = bySlug.get(slug.toLowerCase())!;
    const context = modelContextWindow(model);
    const efforts = modelReasoningEfforts(model);
    // 新版 ZCode 的视觉标签读取规则字段，按本次目录重建并清除过时属性。
    // 档位同理：选择器读 optionSpecs.reasoningLevel.values（schema 仅接受 values/map，
    // 默认档位取末位），目录无档位的模型不写，保持 ZCode 的 enabled/disabled 开关兜底。
    return {
      modelId: slug,
      providerId,
      config: {
        properties: {
          ...(context === undefined ? {} : { contextWindow: context }),
          inputFormat: { supportsImage: modelInputModalities(model).includes("image") },
        },
        ...(efforts.length > 0 ? { optionSpecs: { reasoningLevel: { values: [...efforts] } } } : {}),
      },
    };
  });
  providerDoc.config!.modelConfigRules!.providerModelRules = [
    ...modelRules.filter((item) => !(isRecord(item) && item.providerId === providerId)),
    ...syncedRules,
  ];

  const manualRules = providerDoc.config!.modelConfigRules!.manualProviderModelRules;
  if (Array.isArray(manualRules)) {
    providerDoc.config!.modelConfigRules!.manualProviderModelRules = manualRules.filter(
      (item) => !(isRecord(item) && item.providerId === providerId),
    );
  }
  entry.models = Object.fromEntries(newSlugs.map((slug) => [
    slug,
    synthesizeZcodeModelDefinition(bySlug.get(slug.toLowerCase())!),
  ]));

  const pendingWrites = [
    { file: paths.providerConfigFile, contents: `${JSON.stringify(providerDoc, null, 2)}\n` },
    { file: paths.configFile, contents: `${JSON.stringify(configDoc, null, 2)}\n` },
  ];
  // 供应商显示顺序名单（UI 按它渲染供应商列表）：存在但缺受管 id 时追加到尾部，
  // 其余顺序不动；文件不存在（zsh 首启前）则跳过，由 zcode 首启生成后再补。
  const displayOrderFile = path.join(paths.v2, "model-provider-display-order.json");
  if (fs.existsSync(displayOrderFile)) {
    try {
      const displayOrder: { providerIds?: unknown; updatedAt?: unknown } = JSON.parse(fs.readFileSync(displayOrderFile, "utf8"));
      if (Array.isArray(displayOrder.providerIds) && !displayOrder.providerIds.includes(providerId)) {
        displayOrder.providerIds.push(providerId);
        displayOrder.updatedAt = Date.now();
        pendingWrites.push({ file: displayOrderFile, contents: `${JSON.stringify(displayOrder, null, 2)}\n` });
      }
    } catch {
      // 名单损坏不阻塞推送：zcode 会按自身逻辑重建它。
    }
  }
  const backups = writeAllOrRollback(pendingWrites);

  return {
    summary: backups.length === 0
      ? `zcode: provider "${ZCODE_PROVIDER_DISPLAY_NAME}" already up to date (${newSlugs.length} models)`
      : `zcode: ${newSlugs.length} models pushed to provider "${ZCODE_PROVIDER_DISPLAY_NAME}"`
        + ` (+${addedCount} added, -${removedCount} removed, ${unchangedCount} unchanged)`,
    notes: [
      ...backups.map((backup) => `backup: ${backup}`),
      "note: the gateway /v1/messages endpoint currently converts only OpenCode Zen models end-to-end;"
        + " models from other sources may fail over this provider",
      "restart ZCode to refresh its model list",
    ],
  };
}

/** `models --push zcode` 的目标实现；env 注入供测试隔离 ZCODE_HOME。 */
export function createZcodePushTarget(options: ZcodePushOptions): ModelPushTarget {
  return {
    id: "zcode",
    assertInstalled() {
      const paths = resolveZcodeClientPaths(options.env);
      if (!fs.existsSync(paths.configFile) || !fs.existsSync(paths.providerConfigFile)) {
        throw new Error(
          `ZCode is not installed (expected ${paths.v2}/config.json and provider_config.json);`
          + ` install ZCode or point ZCODE_HOME at its config directory`,
        );
      }
    },
    push(models) {
      return pushZcodeModels(models, options);
    },
  };
}
