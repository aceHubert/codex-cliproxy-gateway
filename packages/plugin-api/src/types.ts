/** 客户端入口协议；HTTP 路径分别为 /chat/completions、/responses、/messages 与 /models/{model}:generateContent。 */
export type ClientProtocol = "chat-completions" | "responses" | "anthropic" | "gemini";
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
  /** 调用方 route 协议（to）：请求的源协议、响应的终点；语义链路上游 endpoint (from) → 调用方 route (to)。 */
  to: ClientProtocol;
  operation: RequestOperation;
  signal: AbortSignal;
  /** gemini 入口：model 由 URL 路径携带，流式由 :streamGenerateContent 后缀决定；其余协议由 body 表达。 */
  pathModel?: string;
  pathStream?: boolean;
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

/**
 * 插件读取的有效配置及扩展入口。
 *
 * agent 开关的判断由网关装配层完成，插件通过模块增强声明专属配置字段。
 * 配置文件的读取与持久化由应用负责，运行时规范由 config.schema.json 定义。
 */
export interface AgentConfig {
  configVersion?: string;
  host: string;
  port: number;
  requestLogging?: boolean;
  /** 每类日志保留的最大文件数；0 表示不限制。 */
  maxRequestLogs?: number;
  /**
   * 任意字段扩展：插件通过 `declare module` 声明专属字段（具名、带类型），
   * 未声明的运行期字段不因类型层多余属性检查被拒绝；读取方对未知字段
   * 一律按 unknown 处理，不假设其语义。
   */
  [key: string]: unknown;
}
export interface ProcessLogTarget { file: string; maxBytes: number; }
export interface RequestLogSink { dir: string; maxLogs: number; processLog?: ProcessLogTarget; }
/** 日志子目录名；由调用方按实际命中的插件或产品线声明，契约层不枚举插件 ID。 */
export type LogNamespace = string;
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
  invalidateModelsCache(file: string): void;
  clearModelsCacheEntries(file: string, matches: (slug: string) => boolean): boolean;
}
export interface RequestLogServices {
  localTime(at?: Date): string;
  /** 请求日志目录；固定取实例路径，日志目录配置不参与。 */
  requestLogDir(): string;
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
