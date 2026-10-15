/**
 * 严格 SSE 解析：任意字节切片、UTF-8 多字节边界、CRLF/LF、多行 data、注释行、
 * event 字段与 [DONE] 哨兵。解析失败抛错而不是静默丢帧——沿用 main 适配器在
 * zcode/codebuddy 已验证的读取器语义，作为桥接包的共享基础。
 */

export type SseFrame = { event?: string; data: string } | "[DONE]";

/**
 * 逐帧读取 SSE 流。每帧是注释剥离后的 event/data 聚合；data 为 [DONE] 时产出
 * 哨兵。流在事件中途结束时抛错（截断流不是成功结束）。
 */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  // 解码器保存跨切片的字节状态，必须由每个流独立持有。
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = body.getReader();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  const line = (value: string): SseFrame | undefined => {
    if (value === "") {
      if (!data.length) {
        event = "";
        return;
      }
      const joined = data.join("\n");
      data = [];
      const frameEvent = event;
      event = "";
      if (joined === "[DONE]") return "[DONE]";
      return { event: frameEvent || undefined, data: joined };
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") data.push(content);
    else if (field === "event") event = content;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      while (true) {
        const position = buffer.search(/[\r\n]/);
        if (position < 0) break;
        if (buffer[position] === "\r" && position + 1 === buffer.length && !done) break;
        const width = buffer[position] === "\r" && buffer[position + 1] === "\n" ? 2 : 1;
        const next = line(buffer.slice(0, position));
        buffer = buffer.slice(position + width);
        if (next) yield next;
      }
      if (done) {
        if (buffer.length || data.length) throw new Error("SSE 在事件结束前意外 EOF");
        return;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 正在取消的读取由 cancel 收尾。 */
    }
  }
}

export function sseFrameBytes(event: string | undefined, payload: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const lines = event ? `event: ${event}\n` : "";
  return encoder.encode(`${lines}data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}
