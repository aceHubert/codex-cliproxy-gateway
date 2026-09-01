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

export interface GatewayConfig {
  $schema?: string;
  configVersion?: string;
  host: string;
  port: number;
  mountPath: string;
  prefix: string;
  officialBaseUrl: string;
  cliproxyBaseUrl: string;
  catalogPath: string;
  model_merge_json?: string;
  selectedModels?: string[];
  requestLogging?: boolean;
  logDir?: string;
  /** 每类日志保留的最大文件数；0 表示不限制。 */
  maxRequestLogs?: number;
  /**
   * 网关进程日志（gateway.log 与 gateway.error.log）的最大字节数，超出时把当前内容复制为
   * 时间戳备份并原地清空（copy-truncate，进程持有的句柄不受影响）；设置上限同时约束
   * gateway.log 中配置审计的可追溯深度；0 表示不限制。
   */
  maxGatewayLogBytes?: number;
  /** 是否启用 CPA-only 纯转发：目录和请求均只使用 CLIProxy，模型名不加前缀。 */
  cpaOnly?: boolean;
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
  modelsCacheFile: string;
  stdoutLog: string;
  stderrLog: string;
  logDir: string;
  launchAgent: string;
}

export type CliOptions = Record<string, string | true>;
