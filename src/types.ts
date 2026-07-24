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
  host: string;
  port: number;
  mountPath: string;
  prefix: string;
  officialBaseUrl: string;
  cliproxyBaseUrl: string;
  catalogPath: string;
  selectedModels?: string[];
}

export interface ResolvedPaths {
  home: string;
  codexHome: string;
  runtimeHome: string;
  configToml: string;
  gatewayConfig: string;
  stateFile: string;
  catalogFile: string;
  stdoutLog: string;
  stderrLog: string;
  launchAgent: string;
}

export type CliOptions = Record<string, string | true>;
