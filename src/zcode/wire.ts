/** ZCode 协议共享类型；元数据不包含授权凭据。 */
export interface ZcodeToolDefinition {
  name: string;
  custom: boolean;
  namespace?: string;
  /** 网关代执行标记：该工具由网关在上游续跑中执行并吸收，不回传客户端。 */
  gateway?: "analyze_image";
}
export type ZcodeToolMap = Map<string, ZcodeToolDefinition>;
export interface ZcodeTranslatedRequest {
  body: Record<string, unknown>;
  tools: ZcodeToolMap;
  /** 被剥离的服务器内置工具类型名，供日志与降级说明使用。 */
  dropped: string[];
  /** 请求含图片且已声明网关代执行的 analyze_image 工具。 */
  vision: boolean;
  /** 请求内收集到的 base64 图片清单（按内容标识去重），供代执行反查。 */
  images: import("./vision.ts").ZcodeRequestImage[];
}
export function isZcodeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const THINKING_PREFIX = "zcode-thinking-v1:";
/** 本地不透明回传载荷，不代表 OpenAI 的加密思考格式。 */
export function encodeZcodeThinking(model: string, blocks: Record<string, unknown>[]): string {
  return THINKING_PREFIX + Buffer.from(JSON.stringify({ model, blocks }), "utf8").toString("base64");
}
export function decodeZcodeThinking(value: unknown, model: string): Record<string, unknown>[] | undefined {
  if (typeof value !== "string" || !value.startsWith(THINKING_PREFIX)) return undefined;
  try {
    const data: unknown = JSON.parse(Buffer.from(value.slice(THINKING_PREFIX.length), "base64").toString("utf8"));
    if (!isZcodeRecord(data) || data.model !== model || !Array.isArray(data.blocks)) return undefined;
    if (!data.blocks.every((block) => isZcodeRecord(block)
      && ((block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string")
        || (block.type === "redacted_thinking" && typeof block.data === "string")))) return undefined;
    return data.blocks as Record<string, unknown>[];
  } catch {
    return undefined;
  }
}
