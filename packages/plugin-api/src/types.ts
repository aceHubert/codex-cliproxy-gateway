export type ClientProtocol = "chat" | "responses";
export type RequestOperation = "generate" | "compact";

/** 目录字段与现有 Codex 目录兼容，契约包不读取宿主配置。 */
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

export interface RequestBody {
  bytes(): Promise<Uint8Array>;
  json(): Promise<unknown>;
}

export interface RequestContext {
  request: Request;
  url: URL;
  model: string;
  from: ClientProtocol;
  operation: RequestOperation;
  signal: AbortSignal;
}

export interface ModelMatch {
  model: string;
  matchedPattern: string;
  /** 精确模型为空字符串；前缀模式返回包含末尾 / 的真实前缀。 */
  matchedPrefix: string;
}

export interface HttpRequestContext extends RequestContext, ModelMatch {
  body: RequestBody;
}

export interface PluginWebSocket {
  send(data: string | Uint8Array): number | void;
  close(code?: number, reason?: string): void;
}

/** 宿主把实际服务器会话事件送给插件，插件无需依赖 Bun 的服务器类型。 */
export interface WebSocketSession {
  open?(socket: PluginWebSocket): void | Promise<void>;
  message(socket: PluginWebSocket, data: string | Uint8Array): void | Promise<void>;
  drain?(socket: PluginWebSocket): void | Promise<void>;
  close?(socket: PluginWebSocket, code: number, reason: string): void | Promise<void>;
  error?(socket: PluginWebSocket, error: Error): void | Promise<void>;
}

export interface WebSocketRequestContext extends RequestContext, ModelMatch {
  /** 成功时宿主已调用真实 upgrade；false 表示握手尚未完成。 */
  upgrade(session: WebSocketSession, options?: { headers?: HeadersInit }): boolean;
}

export interface PluginLogEvent {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  pluginId: string;
  requestId?: string;
}

/** 主机实现日志、实例路径和凭据分派；插件不能反向导入应用。 */
export interface HostServices<Config extends object = object> {
  runtimeDirectory: string;
  getConfig(): Readonly<Config>;
  fetch: typeof globalThis.fetch;
  log(event: PluginLogEvent): void;
  getApiKey(): string | undefined;
  catalogChanged?(pluginId: string): void;
  getPaths(): { home: string; runtimeHome: string; logDir: string };
  atomicWrite(file: string, content: string): void;
  catalog: CatalogServices;
  requestLog: RequestLogServices;
  processLog: ProcessLogServices;
}

/** 代理实现仅消费这些配置字段，安装及服务管理配置留在应用。 */
export interface AgentConfig {
  host: string;
  /** 已过时：模型前缀按上游类型派生（cliproxy/ 或 newapi/），宿主注入 AgentConfig 时填充；消费方一律按可选处理。 */
  prefix?: string;
  requestLogging?: boolean;
  logDir?: string;
  maxRequestLogs?: number;
  debug?: boolean;
  zcode?: boolean;
  codebuddy?: boolean;
  codebuddyRegion?: CodebuddyRegion;
  codebuddyAccount?: string;
  qoder?: boolean;
  agy?: boolean;
  opencodeZen?: boolean;
}
export type CodebuddyRegion = "auto" | "cn" | "intl";
export interface ProcessLogTarget { file: string; maxBytes: number; }
export interface RequestLogSink { dir: string; maxLogs: number; processLog?: ProcessLogTarget; }
export type LogNamespace = "cliproxy" | "zcode" | "bigmodel" | "codebuddy" | "workbuddy" | "qoder" | "agy" | "opencode-zen";
export interface ExchangeEntry {
  requestTime: string; method: string; url: string;
  reqHeaders: Headers; reqBody: unknown; status: number;
  resHeaders: Headers; resBody: string;
  upstreamUrl?: string; upstreamRequestHeaders?: Headers; upstreamRequestBody?: unknown; durationMs?: number;
}
export interface RequestSummary { requestTime: string; method: string; url: string; status: number; durationMs?: number; upstreamUrl?: string; }
export interface ErrorEntry extends RequestSummary { message: string; errorName?: string; stack?: string; }
export interface ModelOverrideRule { patterns: string[]; prefix: boolean; fields: Record<string, unknown>; }
export interface CatalogServices {
  compileModelOverrides(value: unknown, source?: string): ModelOverrideRule[];
  mergeCatalog(native: ModelCatalog, proxy: ModelCatalog, prefix?: string, overrides?: ModelOverrideRule[]): ModelCatalog;
  synthesizeModelEntry(id: string, priority: number, snapshot: ModelCatalog, vendors?: ModelOverrideRule[], overrides?: ModelOverrideRule[], baseSlug?: string): ModelEntry;
  parseCodexCatalog(value: unknown): ModelCatalog;
  withAgentSystemPrompt(entry: ModelEntry, prompt: string): ModelEntry;
  invalidateModelsCache(file: string): void;
  clearModelsCacheEntries(file: string, matches: (slug: string) => boolean): boolean;
}
export interface RequestLogServices {
  localTime(at?: Date): string;
  requestLogDir(config: AgentConfig): string;
  logGroupFromPath(pathname: string): string;
  logExchange(sink: RequestLogSink | undefined, group: string, entry: ExchangeEntry, namespace?: LogNamespace): void;
}
export interface ProcessLogServices {
  logGatewayError(target: ProcessLogTarget | undefined, entry: ErrorEntry): void;
  logRequestSummary(target: ProcessLogTarget | undefined, entry: RequestSummary): void;
}

export interface GatewayPlugin {
  id: string;
  modelPatterns: readonly string[];
  websocket?: boolean;
  handleHttp(context: HttpRequestContext): Response | Promise<Response>;
  handleWebSocket?(context: WebSocketRequestContext): Response | undefined | Promise<Response | undefined>;
  getCatalog(): ModelCatalog | Promise<ModelCatalog>;
  refreshCatalog(): Promise<ModelCatalog>;
  reloadCatalog(): Promise<ModelCatalog>;
  ready(): Promise<void>;
  close(): void | Promise<void>;
}

export type GatewayPluginFactory<Config extends object = object> = (host: HostServices<Config>) => GatewayPlugin;
export type CandidateSelector = (plugin: GatewayPlugin, match: ModelMatch) => boolean | Promise<boolean>;
