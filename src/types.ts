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

/** CodeBuddy 凭据地域（历史值）。字段已过时：凭据选择一律走 codebuddyAccount。 */
export type CodebuddyRegion = "auto" | "cn" | "intl";

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
  /**
   * 排除模型规则（默认 []）：网关在所有适配器与上游目录合并后统一过滤，命中
   * （精确 ID、以 / 结尾的前缀族、含 * 的轻量 glob，大小写不敏感，如
   * codebuddy-intl/、qoder-cn/*、agy/gemini-2.5-flash）的模型不再出现在
   * /models，对这些模型的推理请求也会被网关以 404 拦截。
   */
  excludedModels?: string[];
  requestLogging?: boolean;
  logDir?: string;
  /** 每类日志保留的最大文件数；0 表示不限制。 */
  maxRequestLogs?: number;
  /**
   * 是否开启调试转储：上游错误时把完整请求体落盘到日志目录（当前覆盖 agy
   * 上游 400 的 agy-debug-400.json）。与 requestLogging 互相独立，默认关闭。
   */
  debug?: boolean;
  /**
   * 网关进程日志 gateway.log 的最大字节数，超出时把当前内容复制为时间戳备份并原地清空
   * （copy-truncate，进程持有的句柄不受影响）；设置上限同时约束该文件中请求摘要与配置
   * 审计的可追溯深度；0 表示不限制。
   */
  maxGatewayLogBytes?: number;
  /** default 是否仅使用第三方上游裸模型 ID；不影响 agent 启用，Codex 使用合并静态目录。 */
  upstreamOnly?: boolean;
  /** 是否启用 ZCode Responses 入口；默认关闭。 */
  zcode?: boolean;
  /** 是否启用 CodeBuddy/WorkBuddy Responses 入口；默认关闭。 */
  codebuddy?: boolean;
  /**
   * @deprecated 已由 codebuddyAccount 取代。读取时旧值（auto/cn/intl）一次性迁移为
   * codebuddyAccount="auto"；写入一律归一到 codebuddyAccount。
   */
  codebuddyRegion?: CodebuddyRegion;
  /**
   * CodeBuddy/WorkBuddy 凭据选择：值为认证目录内的 `.info` 文件名时锁定该账号登录
   * （文件缺失时运行期回退 auto，不改写配置）；值为 "auto" 或缺省时按最近刷新的
   * 登录自动选取并随客户端切换跟随。展示标签（昵称 <邮箱> / 地域）由 Web UI 实时
   * 解析，不落配置。历史哨兵 "default" 读取时归一为 "auto"。
   */
  codebuddyAccount?: string;
  /** 是否启用 Qoder Responses 入口；默认关闭，自动发现各地域登录。 */
  qoder?: boolean;
  /** 是否启用 Antigravity（agy）Responses 入口；默认关闭，只读消费本机 agy 登录。 */
  agy?: boolean;
  /**
   * 是否启用 OpenCode Zen（opencode-zen/）Chat Completions 入口；默认关闭，经指纹
   * 转发消费 Zen 免费模型（公共鉴权 Bearer public，可选 OPENCODE_API_KEY）。
   */
  opencodeZen?: boolean;
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
  /**
   * launchd 服务身份后缀：默认实例（主目录即 ~/.codex-cliproxy-gateway）为空串，
   * 保持历史 label 与 plist 文件名；其他实例为主目录哈希后缀，label/plist 文件名/
   * Keychain 服务名随之派生，多实例互不冲突。
   */
  instanceSuffix: string;
}

export type CliOptions = Record<string, string | true>;
