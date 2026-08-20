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
   * 是否把 cliproxy/* 的 Responses over WebSocket 转发到 CLIProxy（默认 false，回 426 走 HTTPS/SSE）。
   * 官方模型不受此开关控制，始终转发。
   */
  websocket?: boolean;
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
  upstreamModelsCacheFile: string;
  modelsCacheFile: string;
  staticCatalogFile: string;
  stdoutLog: string;
  stderrLog: string;
  logDir: string;
  launchAgent: string;
}

export type CliOptions = Record<string, string | true>;
