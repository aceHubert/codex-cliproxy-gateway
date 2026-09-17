export interface ModelEntry {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  availability_nux?: unknown;
  upgrade?: unknown;
  [key: string]: unknown;
}

export interface ModelCatalog {
  models: ModelEntry[];
}

/** 第三方上游类型：cliproxy 直接消费其 Codex 目录；newapi 从 OpenAI /models 列表本地合成目录。 */
export type UpstreamType = "cliproxy" | "newapi";

export interface GatewayConfig {
  $schema?: string;
  configVersion?: string;
  host: string;
  port: number;
  mountPath: string;
  prefix: string;
  officialBaseUrl: string;
  /** 第三方上游 URL（CLIProxyAPI 或 OpenAI 兼容的 new-api）；旧键 cliproxyBaseUrl 在读取与同步时自动迁移。 */
  upstreamBaseUrl: string;
  /** 第三方上游类型；缺省视为 cliproxy，运行时仅显式识别 "newapi"，其余值按 cliproxy 处理。旧键 upstream_type 在读取与同步时自动迁移。 */
  upstreamType?: UpstreamType;
  catalogPath: string;
  model_merge_json?: string;
  selectedModels?: string[];
  requestLogging?: boolean;
  logDir?: string;
  /** 每类日志保留的最大文件数；0 表示不限制。 */
  maxRequestLogs?: number;
  /**
   * 网关进程日志 gateway.log 的最大字节数，超出时把当前内容复制为时间戳备份并原地清空
   * （copy-truncate，进程持有的句柄不受影响）；设置上限同时约束该文件中请求摘要与配置
   * 审计的可追溯深度；0 表示不限制。
   */
  maxGatewayLogBytes?: number;
  /** 是否启用 upstream-only 纯转发：目录和请求均只使用第三方上游，模型名不加前缀。 */
  upstreamOnly?: boolean;
  /** 是否启用 ZCode Responses 入口；默认关闭。 */
  zcode?: boolean;
}

/**
 * 网关进程日志（gateway.log）的目标与大小上限。
 * 请求摘要、错误摘要、配置审计与 launchd 抓到的 stdout/stderr 都落在同一个文件里，
 * 由 maxGatewayLogBytes 统一约束。
 */
export interface ProcessLogTarget {
  file: string;
  maxBytes: number;
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
  /** Web UI 的 LaunchAgent（默认不加载运行，`codex-cliproxy web` 按需启动）。 */
  webUiLaunchAgent: string;
}

export type CliOptions = Record<string, string | true>;
