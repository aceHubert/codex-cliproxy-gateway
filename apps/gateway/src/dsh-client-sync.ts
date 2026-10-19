import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML, { isMap, isSeq, YAMLMap, YAMLSeq, type ParsedNode } from "yaml";
import type { GatewayConfig, ModelEntry } from "./types.ts";
import {
  modelContextWindow,
  modelInputModalities,
  modelReasoningEfforts,
  writeAllOrRollback,
  type ModelPushOutcome,
  type ModelPushTarget,
} from "./models-push.ts";

/** 本命令在 dsh 侧的唯一受管 provider；与用户自建 provider（cliproxy* 等）完全无关。 */
const DSH_PROVIDER_KEY = "agent-proxy";
const DSH_PROVIDER_DISPLAY_NAME = "AgentProxy";
const DSH_PROVIDER_API = "anthropic-messages";
/**
 * 受管 provider 的 credential ref（用户裁决 + dsh 机制约束）：`apiKeyEnv` 指向的
 * ref 必须在 credentials service（`~/.dsh/.credentials.yaml` 的 refs 段，web Models
 * 页面写入）或进程环境变量里有值，否则 dsh 以 MISSING_CREDENTIAL 拒绝调用；完全不
 * 写该字段也不行——OpenAI 兼容协议层坚持要 key 或 Authorization 头。因此指向独立
 * ref `AGENT_PROXY_API_KEY`（与 CLIPROXY_API_KEY 等互不相干），值由**用户人工**经
 * dsh Models 页面存一次（存任意非空值即可，如 EMPTY）；推送工具不读写该凭据文件。
 * 网关模型端口忽略客户端 key、各 agent 插件用自有凭据自处理上游授权，该值仅用于
 * 通过 dsh 的调用前置校验。
 */
const DSH_API_KEY_ENV = "AGENT_PROXY_API_KEY";
const DSH_LLM_ENTRY_ID = "llm-pi-ai";
const DSH_PATCH_FILE = "cordis.patch.yml";

export interface DshClientPaths {
  home: string;
  profilesDir: string;
}

/** dsh 配置根：复用 dsh 原生 `DSH_HOME` 覆盖（测试同用），默认 `~/.dsh`。 */
export function resolveDshClientPaths(env: NodeJS.ProcessEnv = process.env): DshClientPaths {
  const home = env.DSH_HOME || path.join(env.HOME || os.homedir(), ".dsh");
  return { home, profilesDir: path.join(home, "profiles") };
}

/** dsh reasoningEfforts 的合法键（schema 校验，未知键会让整个 llm-pi-ai 插件激活失败）。 */
const DSH_EFFORT_KEYS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 档位键归一：zen 等目录里真实存在的 `none`（无推理）映射为 dsh 的 `off` 键，
 * 值保留原档位名（发送给上游的就是目录声明的 effort 值）；白名单外的键丢弃。
 */
function dshReasoningEfforts(efforts: readonly string[]): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const effort of efforts) {
    const key = effort === "none" ? "off" : effort;
    if (!DSH_EFFORT_KEYS.includes(key)) continue;
    if (!(key in mapped)) mapped[key] = effort;
  }
  return mapped;
}

/** 新模型的 dsh models[] 条目合成：仅按网关元数据填充，缺失字段省略（maxTokens 无来源，不写）。 */
export function synthesizeDshModel(entry: ModelEntry): Record<string, unknown> {
  const model: Record<string, unknown> = {
    id: entry.slug,
    name: typeof entry.display_name === "string" && entry.display_name ? entry.display_name : entry.slug,
  };
  const context = modelContextWindow(entry);
  if (context !== undefined) model.contextWindow = context;
  model.input = modelInputModalities(entry);
  const efforts = modelReasoningEfforts(entry);
  if (efforts.length > 0) {
    const reasoningEfforts = dshReasoningEfforts(efforts);
    if (Object.keys(reasoningEfforts).length > 0) model.reasoningEfforts = reasoningEfforts;
  }
  return model;
}

interface DshPatchDocument {
  file: string;
  profile: string;
  doc: YAML.Document;
  entry: YAMLMap;
}

/**
 * 以 Document 模式解析 patch 文件：未修改的部分（含 `!!js` 等自定义标签与注释）
 * 由 yaml 原样往返，解析告警留在 doc.warnings 不外抛；语法错误显式报错。
 */
function parseDshPatch(file: string, profile: string): DshPatchDocument[] {
  const raw = fs.readFileSync(file, "utf8");
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new Error(
      `${file} is not valid YAML (${first.message}); fix or restore it (see its .bak-* backups), then rerun models --push`,
    );
  }
  // 空文件（contents 为 null）按空 patch 层处理；新建节点缺 range，需断言为已解析形态。
  if (doc.contents === null) doc.contents = new YAMLSeq<ParsedNode>() as unknown as NonNullable<typeof doc.contents>;
  if (!isSeq(doc.contents)) throw new Error(`${file}: expected a top-level YAML array of patch entries`);
  const documents: DshPatchDocument[] = [];
  for (const item of doc.contents.items) {
    if (isMap(item) && item.toJS(doc).id === DSH_LLM_ENTRY_ID) documents.push({ file, profile, doc, entry: item });
  }
  return documents;
}

export interface DshPushOptions {
  config: Pick<GatewayConfig, "host" | "port">;
  env?: NodeJS.ProcessEnv;
}

/**
 * 把网关模型清单按 ID 全量替换进各 profile `cordis.patch.yml` 中 `llm-pi-ai` 条目下
 * 的受管 provider `agent-proxy`（AgentProxy / anthropic-messages / 网关本地根地址）：
 * - provider 缺失时创建，此后只同步 `models[]`，displayName/api/baseURL/apiKeyEnv
 *   等字段永不回写（用户可自行改指公网域名）；
 * - 每次按目录重建整个 models[]，包括已有模型的定义，清除旧能力及手动添加的模型字段；
 * - 未触及的条目、`!!js` 表达式、头部注释与用户自建 provider 不动；
 * - `settings.yaml`（legacy，dsh 启动时迁移）与 `.credentials.yaml` 不触碰。
 */
export function pushDshModels(models: readonly ModelEntry[], options: DshPushOptions): ModelPushOutcome {
  const paths = resolveDshClientPaths(options.env);
  if (!fs.existsSync(paths.profilesDir)) {
    throw new Error(`dsh profiles directory is missing (${paths.profilesDir}); reinstall dsh or point DSH_HOME at it`);
  }
  const profileNames = fs.readdirSync(paths.profilesDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort();
  const touched: DshPatchDocument[] = [];
  for (const profile of profileNames) {
    const file = path.join(paths.profilesDir, profile, DSH_PATCH_FILE);
    if (!fs.existsSync(file)) continue;
    touched.push(...parseDshPatch(file, profile));
  }
  if (touched.length === 0) {
    throw new Error(
      `dsh is installed but no profile has an "${DSH_LLM_ENTRY_ID}" patch entry under ${paths.profilesDir};`
      + " configure any custom provider inside dsh once so the patch layer exists, then rerun models --push",
    );
  }

  const baseURL = `http://${options.config.host}:${options.config.port}`;
  const createdProfiles: string[] = [];
  const pendingWrites: Array<{ file: string; contents: string }> = [];
  for (const { file, profile, doc, entry } of touched) {
    const before = doc.toString();
    let config: YAMLMap;
    const rawConfig = entry.get("config");
    if (isMap(rawConfig)) config = rawConfig;
    else {
      config = new YAMLMap();
      entry.set("config", config);
    }
    let providers: YAMLMap;
    const rawProviders = config.get("providers");
    if (isMap(rawProviders)) providers = rawProviders;
    else {
      providers = new YAMLMap();
      config.set("providers", providers);
    }
    let provider: YAMLMap;
    const rawProvider = providers.get(DSH_PROVIDER_KEY);
    if (isMap(rawProvider)) provider = rawProvider;
    else {
      provider = doc.createNode({
        displayName: DSH_PROVIDER_DISPLAY_NAME,
        apiKeyEnv: DSH_API_KEY_ENV,
        api: DSH_PROVIDER_API,
        baseURL,
      }) as YAMLMap;
      providers.set(DSH_PROVIDER_KEY, provider);
      createdProfiles.push(profile);
    }
    // 模型定义以本次目录为准，全量重建，避免旧模态、窗口和推理档位继续残留。
    provider.set("models", doc.createNode(models.map(synthesizeDshModel)));

    const after = doc.toString();
    if (after === before) continue;
    pendingWrites.push({ file, contents: after });
  }
  const backups = writeAllOrRollback(pendingWrites);

  const managedProfiles = [...new Set(touched.map((item) => item.profile))].join(", ");
  return {
    summary: backups.length === 0
      ? `dsh: provider "${DSH_PROVIDER_KEY}" already up to date (${models.length} models, profiles: ${managedProfiles})`
      : `dsh: ${models.length} models pushed to provider "${DSH_PROVIDER_KEY}"`
        + ` (${DSH_PROVIDER_DISPLAY_NAME}, ${DSH_PROVIDER_API}; profiles: ${managedProfiles})`,
    notes: [
      ...createdProfiles.length > 0
        ? [`provider "${DSH_PROVIDER_KEY}" created in: ${createdProfiles.join(", ")}`
          + ` (apiKey is a placeholder; the gateway ignores client keys — its plugins authorize upstreams themselves)`]
        : [],
      ...backups.map((backup) => `backup: ${backup}`),
      "note: the gateway /v1/messages endpoint currently converts only OpenCode Zen models end-to-end;"
        + " models from other sources may fail over this provider",
      "restart DeepSeek Harness (dsh) to refresh its model list",
    ],
  };
}

/** `models --push dsh` 的目标实现；env 注入供测试隔离 DSH_HOME。 */
export function createDshPushTarget(options: DshPushOptions): ModelPushTarget {
  return {
    id: "dsh",
    assertInstalled() {
      const paths = resolveDshClientPaths(options.env);
      if (!fs.existsSync(paths.home)) {
        throw new Error(`dsh (DeepSeek Harness) is not installed (no ${paths.home}); install dsh or point DSH_HOME at it`);
      }
    },
    push(models) {
      return pushDshModels(models, options);
    },
  };
}
