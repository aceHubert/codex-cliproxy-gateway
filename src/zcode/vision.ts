/** zcode 链路图片识别适配：analyze_image 声明、图片清单、标识反查与网关侧执行器。 */
import { createHash } from "node:crypto";
import executorTemplateJson from "./vision-template.json";
import { isZcodeRecord } from "./wire.ts";

export const ANALYZE_IMAGE_TOOL_NAME = "analyze_image";

/** 网关收集的请求内图片（base64）；identifier 用于反查模型回传的 CDN URL。 */
export interface ZcodeRequestImage {
  identifier: string;
  media_type: string;
  data: string;
}

/** 被吸收的网关工具调用；由响应层在续跑时上报驱动层。 */
export interface ZcodeGatewayCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export class ZcodeVisionError extends Error {
  constructor(message: string) { super(message); this.name = "ZcodeVisionError"; }
}

/**
 * z.ai 内置工具的调用与结果是以普通助手 Markdown 流式输出的（实测 web_search_prime：
 * `**🌐 Z.ai Built-in Tool: …**` + Input 代码块 + `*Executing on server...*`，随后另起一条
 * `**Output:**\n**…_result_summary:** [...]`）。网关代执行 analyze_image 时复刻同一形状，
 * Codex 才会把它渲染成与 web_search_prime 相同的 "Z.ai Built-in Tool" 卡片。
 */
export function gatewayToolCallNarration(call: Pick<ZcodeGatewayCall, "name" | "input">): string {
  return [
    `**🌐 Z.ai Built-in Tool: ${call.name}**`,
    "",
    "**Input:**",
    "```json",
    JSON.stringify(call.input),
    "```",
    "*Executing on server...*",
    "",
  ].join("\n");
}

/** 与 z.ai 的 result_summary 旁白同形：结果作为 JSON 文本块出现在 Output 卡片里。 */
export function gatewayToolResultNarration(name: string, result: string): string {
  return `**Output:**\n**${name}_result_summary:** [{"text": ${JSON.stringify(result)}, "type": "text"}]`;
}

/**
 * 与 z.ai MCP 形状对齐（imageSource + prompt）；显式声明后模型会确定性地调用图片识别，
 * 并在 imageSource 里携带服务端改写给它的图片 URL。
 */
export const ANALYZE_IMAGE_TOOL_DECLARATION: Record<string, unknown> = {
  name: ANALYZE_IMAGE_TOOL_NAME,
  description: "Analyze an image using advanced AI vision models with comprehensive understanding capabilities. Only supports remote URL.",
  input_schema: {
    type: "object",
    properties: {
      imageSource: { type: "string", description: "Remote URL to the image (supports PNG, JPG, JPEG)" },
      prompt: { type: "string", description: "Detailed text prompt describing what to analyze, extract, or understand from the image." },
    },
    required: ["imageSource", "prompt"],
    additionalProperties: false,
  },
};

export const ANALYZE_IMAGE_SYSTEM_NOTE = [
  "## 图片识别适配",
  "当前模型无法直接查看图片像素；请求中的图片已由服务端上传并替换为 CDN URL（图片附近会给出以 maas-log-prod 开头的 URL，URL 文件名即图片标识）。",
  `请使用 ${ANALYZE_IMAGE_TOOL_NAME} 工具识别图片：imageSource 传图片 URL，prompt 传具体识别要求。`,
  "不要假装能看到图片内容，也不要用本地 OCR 命令替代；识别结果返回后再整理作答。",
].join("\n");

/**
 * 图片字节的内容标识。非安全用途：z.ai CDN 以图片字节摘要的 32 位十六进制作为 URL
 * 文件名（实测确认），网关用同一约定把模型回传的 URL 反查回本地 base64，不做完整性校验。
 */
export function imageIdentifier(data: string): string {
  return createHash("md5").update(Buffer.from(data, "base64")).digest("hex");
}

/** 遍历翻译后的 Anthropic messages，收集全部 base64 图片（按标识去重）。 */
export function collectZcodeImages(messages: unknown): ZcodeRequestImage[] {
  const images = new Map<string, ZcodeRequestImage>();
  const visitBlock = (block: unknown): void => {
    if (!isZcodeRecord(block)) return;
    if (block.type === "image" && isZcodeRecord(block.source)) {
      const source = block.source;
      if (source.type === "base64" && typeof source.data === "string" && source.data) {
        const mediaType = typeof source.media_type === "string" && source.media_type ? source.media_type : "image/png";
        const identifier = imageIdentifier(source.data);
        if (!images.has(identifier)) images.set(identifier, { identifier, media_type: mediaType, data: source.data });
      }
      return;
    }
    // tool_result 的图片在 content 数组内（view_image 等工具的返回形态）。
    if (block.type === "tool_result" && Array.isArray(block.content)) block.content.forEach(visitBlock);
  };
  const visitContent = (content: unknown): void => {
    if (Array.isArray(content)) content.forEach(visitBlock);
    else if (isZcodeRecord(content)) visitContent(content.content);
  };
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (isZcodeRecord(message)) visitContent(message.content);
    }
  }
  return [...images.values()];
}

/** 模型回传的 imageSource（CDN URL 或其他引用）反查请求图片；单图时无条件兜底。 */
export function matchZcodeAnalyzeImage(source: unknown, images: ZcodeRequestImage[]): ZcodeRequestImage | undefined {
  if (images.length === 0) return undefined;
  if (images.length === 1) return images[0];
  if (typeof source !== "string" || !source) return undefined;
  const match = source.match(/([0-9a-f]{32})\.(?:png|jpe?g|webp|gif|bmp)/i);
  if (!match) return undefined;
  const identifier = match[1]!.toLowerCase();
  return images.find((image) => image.identifier === identifier);
}

const executorTemplate = executorTemplateJson as {
  system: Array<{ type: string; text: string }>;
  tools: Array<Record<string, unknown>>;
};

/** 执行器 SSE 把公告与结果拼接成文本；结果通常跟在最后一个 result_summary 标记后。 */
export function analysisFromExecutorText(text: string): string {
  const marker = "analyze_image_result_summary";
  const index = text.lastIndexOf(marker);
  if (index < 0) return text.trim();
  const tail = text.slice(index + marker.length).trim();
  const unwrapped = tail.replace(/^[::*`\s"']+/, "").replace(/[`"']+$/, "").trim();
  return unwrapped || text.trim();
}

export interface ZcodeExecutorOptions {
  url: string;
  model: string;
  image: ZcodeRequestImage;
  prompt: string;
  /** 每次执行现场构建（含可能的客户端签名）；签名头不可跨请求复用。 */
  headers: () => Headers | Promise<Headers>;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  /** 总尝试次数（含首次）；未出现 server_tool_use(analyze_image) 视为未命中。 */
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  /**
   * 错误正文脱敏（遮蔽 API key）：必须在**截断之前**对完整正文执行——key 跨截断
   * 边界时，先截断再脱敏会留下可还原的前缀片段。由调用方（zcode.ts）注入。
   */
  redact?: (text: string) => string;
}

async function attemptOnce(options: ZcodeExecutorOptions): Promise<string> {
  const headers = await options.headers();
  const timeout = AbortSignal.timeout(options.attemptTimeoutMs ?? 120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const instruction = `使用 analyze_image 工具识别这张图片，按以下要求输出：${options.prompt}`;
  const body = {
    model: options.model,
    max_tokens: 4096,
    stream: true,
    // 完整 Claude Code 指纹（system+tools）是服务端代执行的触发条件，模板逐字来自实测请求。
    system: executorTemplate.system,
    tools: executorTemplate.tools,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: options.image.media_type, data: options.image.data } },
        { type: "text", text: instruction },
      ],
    }],
  };
  const response = await options.fetchImpl(options.url, {
    method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    // 先对完整正文脱敏、后截断：截断会把跨边界的 key 切成脱敏匹配不到的前缀片段。
    const sanitized = options.redact ? options.redact(text) : text;
    throw new ZcodeVisionError(`执行信封上游返回 HTTP ${response.status}${sanitized ? `：${sanitized.slice(0, 200)}` : ""}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let executed = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
      const block = isZcodeRecord(frame.content_block) ? frame.content_block : undefined;
      if (frame.type === "content_block_start" && block?.type === "server_tool_use" && block.name === ANALYZE_IMAGE_TOOL_NAME) executed = true;
      const delta = isZcodeRecord(frame.delta) ? frame.delta : undefined;
      if (frame.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") text += delta.text;
    }
  }
  if (!executed) throw new ZcodeVisionError("执行信封未触发服务端 analyze_image");
  return analysisFromExecutorText(text);
}

/** 网关侧执行 analyze_image：以 Claude Code 指纹信封侧请求，服务端在同一条 SSE 内完成识别。 */
export async function executeZcodeAnalyzeImage(options: ZcodeExecutorOptions): Promise<string> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new ZcodeVisionError("analyze_image 执行已取消");
    try {
      return await attemptOnce(options);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
    }
  }
  throw new ZcodeVisionError(`analyze_image 执行失败（${maxAttempts} 次尝试）：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
