import type { AgentConfig } from "@agent-proxy/plugin-api";
// 类型导入加载已安装插件的配置增强，不增加运行时依赖调用。
import type {} from "@agent-proxy/codebuddy";
import type {} from "@agent-proxy/agy";

/** 目录契约类型的单一来源在 @agent-proxy/plugin-api（契约包），网关侧只再导出，调用点不变。 */
export type { ModelCatalog, ModelEntry } from "@agent-proxy/plugin-api";

/**
 * 网关进程日志（gateway.log）的目标与大小上限。
 * 请求摘要、错误摘要、配置审计与 launchd 抓到的 stdout/stderr 都落在同一个文件里，
 * 由 maxGatewayLogBytes 统一约束；类型定义在 @agent-proxy/plugin-api。
 */
export type { ProcessLogTarget } from "@agent-proxy/plugin-api";

/** 第三方上游类型：cliproxy 直接消费其 Codex 目录；newapi 从 OpenAI /models 列表本地合成目录。 */
export type UpstreamType = "cliproxy" | "newapi";

/**
 * 固定路由值：mountPath 与 officialBaseUrl 由代码写死；prefix 按上游类型派生
 * （cliproxy/ 或 newapi/，见 upstream-catalog.ts 的 configuredModelPrefix）；
 * 上游已选目录按上游类型落在运行主目录（{cliproxy|newapi}-catalog.json）。
 * 历史配置中的对应字段读取时忽略，配置同步时移除，不再声明为网关配置项。
 */
export const MOUNT_PATH = "/v1";
export const OFFICIAL_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface GatewayConfig extends AgentConfig {
  $schema?: string;
  /** 第三方上游 URL（CLIProxyAPI 或 OpenAI 兼容的 new-api）；旧键 cliproxyBaseUrl 在读取与同步时自动迁移。 */
  upstreamBaseUrl: string;
  /** 第三方上游类型；缺省视为 cliproxy，运行时仅显式识别 "newapi"，其余值按 cliproxy 处理。旧键 upstream_type 在读取与同步时自动迁移。 */
  upstreamType?: UpstreamType;
  /** default 是否仅使用第三方上游裸模型 ID；不影响 agent 启用，Codex 使用合并静态目录。 */
  upstreamOnly?: boolean;
  modelMergeJson?: string;
  selectedModels?: string[];
  /**
   * 排除模型规则（默认 []）：网关在所有适配器与上游目录合并后统一过滤，命中
   * （精确 ID、以 / 结尾的前缀族、含 * 的轻量 glob，大小写不敏感，如
   * codebuddy-intl/、qoder-cn/*、agy/gemini-2.5-flash）的模型不再出现在
   * /models，对这些模型的推理请求也会被网关以 404 拦截。
   */
  excludedModels?: string[];
  /**
   * 网关进程日志 gateway.log 的最大字节数，超出时把当前内容复制为时间戳备份并原地清空
   * （copy-truncate，进程持有的句柄不受影响）；设置上限同时约束该文件中请求摘要与配置
   * 审计的可追溯深度；0 表示不限制。
   */
  maxGatewayLogBytes?: number;
  /** 是否启用 ZCode Responses 入口；缺省开启，显式 false 保持关闭。 */
  zcode?: boolean;
  /** 是否启用 CodeBuddy/WorkBuddy Responses 入口；缺省开启，显式 false 保持关闭。 */
  codebuddy?: boolean;
  /** 是否启用 Qoder Responses 入口；缺省开启，自动发现各地域登录。 */
  qoder?: boolean;
  /** 是否启用 Antigravity（agy）Responses 入口；缺省开启，只读消费本机 agy 登录。 */
  agy?: boolean;
  /**
   * 是否启用 OpenCode Zen（opencode-zen/）Chat Completions 入口；缺省开启，经指纹
   * 转发消费 Zen 免费模型（公共鉴权 Bearer public，可选 OPENCODE_API_KEY）。
   */
  opencodeZen?: boolean;
}

export interface ResolvedPaths {
  home: string;
  codexHome: string;
  runtimeHome: string;
  configToml: string;
  gatewayConfig: string;
  stateFile: string;
  catalogFile: string;
  modelMergeFile: string;
  /** 网关侧目录缓存：/models 请求记录消费客户端的 client_version，也是同步时发送版本的依据。 */
  upstreamModelsCacheFile: string;
  modelsCacheFile: string;
  /** 网关进程日志：stdout、stderr、配置审计与请求摘要共用这一个文件。 */
  stdoutLog: string;
  logDir: string;
  /** Web UI 访问令牌文件（0600）；Web UI 是网关内建能力，随网关启动即存在。 */
  uiTokenFile: string;
  /** 上游 API key 文件后端（非 darwin 平台替代 macOS Keychain）；0600、原子写。 */
  credentialsFile: string;
  launchAgent: string;
  /** Web UI 的 LaunchAgent（默认不加载运行，`agent-proxy web` 按需启动）。 */
  webUiLaunchAgent: string;
  /**
   * launchd 服务身份后缀：默认实例（主目录即 ~/.agent-proxy-gateway）为空串，
   * 保持历史 label 与 plist 文件名；其他实例为主目录哈希后缀，label/plist 文件名/
   * Keychain 服务名随之派生，多实例互不冲突。
   */
  instanceSuffix: string;
}

export type CliOptions = Record<string, string | true>;
