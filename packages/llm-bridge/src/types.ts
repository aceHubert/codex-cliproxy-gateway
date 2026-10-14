/**
 * 桥接包公共类型：协议标识统一为 chat-completions / responses / anthropic / gemini，
 * 不出现客户端产品名；外部库的 ProviderType 只在实现内部使用，不对外泄漏。
 */

export type BridgeProtocol = "chat-completions" | "responses" | "anthropic" | "gemini";

/** 客户端可请求的协议面（gemini 仅作为上游目标）。 */
export type ClientBridgeProtocol = Exclude<BridgeProtocol, "gemini">;

/** 工具身份：custom 与 namespace 是 Responses 输入的标准扩展。 */
export interface ToolIdentity {
  /** 客户端声明的原始工具名。 */
  name: string;
  /** custom（自由文本输入）工具；跨协议目标以可逆 {input:string} 参数降级。 */
  custom: boolean;
  /** namespace 声明中的工具所属命名空间。 */
  namespace?: string;
  /** 命名空间内声明继承的描述文本（已并入 description，仅供审计）。 */
  source?: "declaration" | "history" | "choice";
}

/** 映射后（安全）工具名 → 原始身份；插件用它在上游响应中还原工具名。 */
export type ToolIdentityMap = Map<string, ToolIdentity>;

export class BridgeConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConversionError";
  }
}

export interface ConvertRequestOptions {
  /** 覆盖目标请求的 model 字段；缺省保留源 model。 */
  model?: string;
  /**
   * 服务安全名策略：把原始工具身份映射为上游可接受的名称。缺省使用内置
   * 可逆映射（与 main 的 safeToolName 等价：非法字符折叠 + 名称哈希后缀）。
   * 声明、调用历史与 named tool_choice 共用同一映射。
   */
  mapToolName?: (identity: { name: string; namespace?: string }) => string;
}

export interface ConvertRequestResult {
  /** 目标协议请求体；from === to 时为源体的结构化克隆直通。 */
  body: Record<string, unknown>;
  /** 工具身份映射（含 custom/namespace 语义），供响应侧还原。 */
  tools: ToolIdentityMap;
  /** 明确记录的降级/不可表达处理（如 custom 降级、stop 丢弃），不静默丢失。 */
  notes: string[];
}

/* ---------------------------- 流式事件模型 ---------------------------- */

export interface BridgeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 缓存命中与写入（Anthropic cache_read/cache_creation、Chat prompt cached_tokens）。 */
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** 推理 token 明细（Chat completion_tokens_details.reasoning_tokens）。 */
  reasoningTokens?: number;
  /** 插件提取的私有计费字段（credits 等）；随标准 usage 一并呈现在最终快照。 */
  billing?: Record<string, unknown>;
}

export type BridgeStopReason = "stop" | "tool_calls" | "length" | "content_filter" | "other";

export type BridgeStreamEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "content_delta"; delta: { text?: string; thinking?: string; refusal?: string } }
  | { type: "thinking_signature"; signature: string }
  | { type: "tool_call_start"; tool_call: { id: string; name: string } }
  | { type: "tool_call_delta"; tool_call: { id: string; arguments_delta: string } }
  | { type: "tool_call_end"; tool_call: { id: string } }
  | {
      type: "message_end";
      stop_reason: BridgeStopReason;
      raw_stop_reason?: string;
      usage?: BridgeUsage;
      model?: string;
    }
  | { type: "error"; error: { message: string; code?: string; type?: string } };

/** 三种客户端协议的 SSE 帧或聚合 JSON 的统一外壳描述。 */
export interface ProtocolErrorShape {
  status: number;
  body: Record<string, unknown>;
}
