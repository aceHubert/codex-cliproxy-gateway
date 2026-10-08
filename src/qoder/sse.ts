/** Qoder SSE 公共解析：帧读取与排队状态信封拆包，供响应转换与排队恢复共用。 */
export interface Frame { event: string; data: string; }
export type Json = Record<string, unknown>;

export const encoder = new TextEncoder();

export function asObject(value: unknown, field: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Qoder ${field} 必须是对象`);
  return value as Json;
}

export function parseJsonObject(value: string, field: string): Json {
  try { return asObject(JSON.parse(value), field); }
  catch { throw new Error(`Qoder ${field} 包含无效 JSON 对象`); }
}

/** 保留事件名，并严格拒绝截断和无效 UTF-8，避免把断流当成成功。 */
export async function* readFrames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let frameSize = 0;
  while (true) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    while (true) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0 || (buffer[index] === "\r" && index === buffer.length - 1 && !done)) break;
      const line = buffer.slice(0, index);
      const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(index + width);
      if (!line) {
        if (data.length || event) yield { event, data: data.join("\n") };
        data = [];
        event = "";
        frameSize = 0;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let content = colon < 0 ? "" : line.slice(colon + 1);
        if (content.startsWith(" ")) content = content.slice(1);
        if (field === "data") { data.push(content); frameSize += content.length; }
        if (field === "event") event = content;
      }
      if (frameSize > 8 * 1024 * 1024) throw new Error("Qoder SSE 单帧超过大小限制");
    }
    if (buffer.length + frameSize > 8 * 1024 * 1024) throw new Error("Qoder SSE 单帧超过大小限制");
    if (done) {
      if (buffer.length || data.length || event) throw new Error("Qoder SSE 在事件结束前意外 EOF");
      return;
    }
  }
}

export interface QoderQueueStatus {
  isQueued?: boolean;
  serviceAvailable?: boolean;
  retryAfterSeconds?: number;
  waitTime?: number;
  queueCount?: number;
  queueType?: string;
}

function nestedMessage(value: Json): unknown {
  // 排队信息藏在多层 {code,message} 的 JSON 字符串里，逐层拆包后才能看到 isQueued 等字段。
  let current: unknown = value;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object" && !Array.isArray(current); depth++) {
    const record = current as Json;
    const message = record.message;
    if (typeof message !== "string" || !message.startsWith("{")) return current;
    try { current = JSON.parse(message); } catch { return record; }
  }
  return current;
}

/** 识别上游排队信封：statusCodeValue=403 + body 为 {code:"403"/"10605", message:…} 链。 */
export function parseQueueStatus(envelope: Json): QoderQueueStatus | undefined {
  const body = envelope.body;
  const chunk: Json | undefined = typeof body === "string" && body.startsWith("{")
    ? (() => { try { return asObject(JSON.parse(body), "排队信封 body"); } catch { return undefined; } })()
    : body !== null && typeof body === "object" && !Array.isArray(body) ? body as Json : undefined;
  if (!chunk) return undefined;
  const code = chunk.code;
  if (code !== "403" && code !== 403 && code !== "10605" && code !== 10605) return undefined;
  const inner = nestedMessage(chunk);
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return undefined;
  const status: QoderQueueStatus = {};
  const record = inner as Json;
  for (const field of ["isQueued", "serviceAvailable"] as const) {
    if (typeof record[field] === "boolean") status[field] = record[field] as boolean;
  }
  for (const field of ["retryAfterSeconds", "waitTime", "queueCount"] as const) {
    if (typeof record[field] === "number" && Number.isFinite(record[field] as number)) status[field] = record[field] as number;
  }
  if (typeof record.queueType === "string") status.queueType = record.queueType;
  return status.isQueued === undefined && status.serviceAvailable === undefined ? undefined : status;
}
