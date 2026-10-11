/**
 * Zen SSE → 完整 chat.completion JSON 的聚合器。
 *
 * 免费层上游只接受流式请求（非流式一律 403），因此非流式客户端由适配器在上游强制
 * `stream: true`，再在这里把 SSE 帧聚合成标准 OpenAI Chat Completions 响应：
 * 增量 content/reasoning 拼接、tool_calls 按 index 合并（arguments 分片到达）、
 * include_usage 帧的 usage 原样透传。上游非标准字段（如 delta.reasoning）以
 * `reasoning` 保留在 message 上，客户端不识别时自然忽略。
 */

interface AggregatedToolCall {
  index: number;
  id?: string;
  type?: string;
  name: string;
  arguments: string;
}

interface AggregationState {
  id?: string;
  created?: number;
  model?: string;
  content: string;
  reasoning: string;
  toolCalls: Map<number, AggregatedToolCall>;
  finishReason: string | null;
  usage?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function mergeDelta(state: AggregationState, delta: Record<string, unknown>): void {
  if (typeof delta.content === "string") state.content += delta.content;
  if (typeof delta.reasoning === "string") state.reasoning += delta.reasoning;
  const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const raw of calls) {
    const call = asRecord(raw);
    if (!call) continue;
    const index = typeof call.index === "number" ? call.index : 0;
    const fn = asRecord(call.function);
    const existing = state.toolCalls.get(index) ?? { index, name: "", arguments: "" };
    if (typeof call.id === "string" && call.id) existing.id = call.id;
    if (typeof call.type === "string" && call.type) existing.type = call.type;
    if (fn) {
      if (typeof fn.name === "string" && fn.name) existing.name += fn.name;
      if (typeof fn.arguments === "string") existing.arguments += fn.arguments;
    }
    state.toolCalls.set(index, existing);
  }
}

/**
 * 消费上游 SSE 流并聚合为单个 chat.completion 对象；流提前断开（无 finish 帧）时
 * finish_reason 兜底为 "stop"，usage 缺失时省略，保证返回结构始终可被客户端解析。
 */
export async function aggregateOpencodeZenStreamToCompletion(
  body: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>> {
  const state: AggregationState = {
    content: "",
    reasoning: "",
    toolCalls: new Map(),
    finishReason: null,
  };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      frames.push(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  frames.push(buffer);
  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof chunk.id === "string" && chunk.id) state.id = chunk.id;
      if (typeof chunk.created === "number") state.created = chunk.created;
      if (typeof chunk.model === "string" && chunk.model) state.model = chunk.model;
      if (asRecord(chunk.usage)) state.usage = chunk.usage as Record<string, unknown>;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const raw of choices) {
        const choice = asRecord(raw);
        if (!choice) continue;
        const delta = asRecord(choice.delta);
        if (delta) mergeDelta(state, delta);
        if (typeof choice.finish_reason === "string" && choice.finish_reason) {
          state.finishReason = choice.finish_reason;
        }
      }
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: state.content };
  if (state.reasoning) message.reasoning = state.reasoning;
  const toolCalls = [...state.toolCalls.values()].sort((a, b) => a.index - b.index)
    .map((call) => ({
      index: call.index,
      id: call.id ?? `call_${call.index}`,
      type: call.type ?? "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const completion: Record<string, unknown> = {
    id: state.id ?? `zen-${Date.now()}`,
    object: "chat.completion",
    created: state.created ?? Math.floor(Date.now() / 1000),
    model: state.model ?? "opencode-zen",
    choices: [{
      index: 0,
      message,
      finish_reason: state.finishReason ?? "stop",
    }],
    ...(state.usage ? { usage: state.usage } : {}),
  };
  return completion;
}
