/**
 * 客户端输出外壳与事件驱动器。
 *
 * - ResponsesOutputShell：Responses 事件/输出外壳（response.created → 条目生命周期
 *   → 终态），事件序号连续、快照聚合、一次终态；从 main 适配器（codebuddy/zcode
 *   response.ts）已验证的实现收敛而来，插件（zcode 多腿、server tool 折叠）可直接
 *   驱动同一外壳，序号跨腿连续。
 * - createResponsesClientOutput / createChatCompletionsClientOutput /
 *   createAnthropicClientOutput：以 BridgeStreamEvent 驱动三种客户端协议的
 *   SSE / 聚合 JSON 输出；工具身份（含 custom / namespace）在输出前还原。
 * - createClientResponse：上游响应 → 解析 →（可选数据变换）→ 客户端协议输出的
 *   高层组合入口。
 */

import { parseUpstreamEvents } from "./events.ts";
import type { BridgeProtocol, BridgeStreamEvent, BridgeUsage, ClientBridgeProtocol, ToolIdentityMap } from "./types.ts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safely(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    /* 观测回调不能中断协议转换。 */
  }
}
function randomId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}
const encoder = new TextEncoder();

export function bridgeUsageToJson(usage: BridgeUsage | undefined): Json | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const result: Json = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage.totalTokens ?? input + output,
  };
  const inputDetails: Json = {};
  if (usage.cachedInputTokens !== undefined) inputDetails.cached_tokens = usage.cachedInputTokens;
  if (usage.cacheCreationInputTokens !== undefined) inputDetails.cache_creation_tokens = usage.cacheCreationInputTokens;
  if (Object.keys(inputDetails).length > 0) result.input_tokens_details = inputDetails;
  if (usage.reasoningTokens !== undefined) result.output_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  if (usage.billing) Object.assign(result, usage.billing);
  return result;
}

/* ============================ Responses 输出外壳 ============================ */

interface ShellBlock {
  kind: "message" | "reasoning" | "tool";
  item: Json;
  outputIndex: number;
  text: string;
  refusal: string;
  signature: string;
  arguments: string;
  custom: boolean;
  hasDelta: boolean;
}

export interface ResponsesShellOptions {
  model: string;
  /** reasoning 条目收尾时生成 encrypted_content（纯数据映射：插件私有信封）。 */
  encodeReasoning?: (text: string, signature: string) => string | undefined;
  onTerminal?: (response: Json) => void;
  sanitizeError?: (error: Json) => Json;
  /** custom 工具总是在收尾校验后以单条正文 delta 下发；启用此选项也不会重复发送。 */
  customToolInputAtClose?: boolean;
  /** 工具参数没有任何增量时在收尾重放一条完整 delta（z.ai 形状）。 */
  replayToolArgumentsAtClose?: boolean;
}

/**
 * Responses 客户端输出的公共外壳。帧级 API（appendText/openToolCall/closeBlock）
 * 由高层事件驱动器或插件驱动；同一客户端响应的起始与终态只出现一次。
 */
export class ResponsesOutputShell {
  private readonly blocks = new Map<string, ShellBlock>();
  private readonly output: Json[] = [];
  private readonly pending: Json[] = [];
  private sequence = 0;
  private started = false;
  private upstreamUsage: Json | null = null;
  private terminalResponse: Json | undefined;
  private identity = { id: randomId("resp_"), createdAt: Math.floor(Date.now() / 1000) };

  constructor(private readonly options: ResponsesShellOptions) {}

  /** 采纳上游响应身份（同协议 responses 渲染时保留上游 id/created_at）；仅 start 前生效。 */
  adoptIdentity(id: string, createdAt?: number): void {
    if (this.started) return;
    if (id) this.identity.id = id;
    if (typeof createdAt === "number") this.identity.createdAt = createdAt;
  }

  get id(): string {
    return this.identity.id;
  }

  get createdAt(): number {
    return this.identity.createdAt;
  }

  get finished(): boolean {
    return this.terminalResponse !== undefined;
  }

  get finalResponse(): Json | undefined {
    return this.terminalResponse;
  }

  private event(type: string, fields: Json = {}): Json {
    return { type, sequence_number: this.sequence++, ...fields };
  }

  snapshot(status: string): Json {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      model: this.options.model,
      status,
      output: structuredClone(this.output),
      error: null,
      incomplete_details: null,
      usage: null,
    };
  }

  /** response.created + response.in_progress；只生效一次。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.pending.push(this.event("response.created", { response: this.snapshot("in_progress") }));
    this.pending.push(this.event("response.in_progress", { response: this.snapshot("in_progress") }));
  }

  mergeUsage(usage: Json | null): void {
    if (usage) this.upstreamUsage = usage;
  }

  private fields(block: ShellBlock): Json {
    return { item_id: block.item.id, output_index: block.outputIndex };
  }

  private ensureMessage(): ShellBlock {
    const existing = this.blocks.get("message");
    if (existing) return existing;
    const item: Json = { id: randomId("item_"), type: "message", role: "assistant", status: "in_progress", content: [] };
    const block: ShellBlock = { kind: "message", item, outputIndex: this.output.length, text: "", refusal: "", signature: "", arguments: "", custom: false, hasDelta: false };
    this.blocks.set("message", block);
    this.output.push(item);
    this.pending.push(this.event("response.output_item.added", { output_index: block.outputIndex, item: structuredClone(item) }));
    return block;
  }

  appendText(value: string): void {
    if (!value) return;
    const block = this.ensureMessage();
    const content = block.item.content as Json[];
    let index = content.findIndex((part) => part.type === "output_text");
    if (index < 0) {
      const part = { type: "output_text", text: "", annotations: [], logprobs: [] };
      content.push(part);
      index = content.length - 1;
      this.pending.push(this.event("response.content_part.added", { ...this.fields(block), content_index: index, part: structuredClone(part) }));
    }
    block.text += value;
    content[index]!.text = block.text;
    this.pending.push(this.event("response.output_text.delta", { ...this.fields(block), content_index: index, delta: value, logprobs: [] }));
  }

  appendRefusal(value: string): void {
    if (!value) return;
    const block = this.ensureMessage();
    const content = block.item.content as Json[];
    let index = content.findIndex((part) => part.type === "refusal");
    if (index < 0) {
      content.push({ type: "refusal", refusal: "" });
      index = content.length - 1;
      this.pending.push(this.event("response.content_part.added", { ...this.fields(block), content_index: index, part: { type: "refusal", refusal: "" } }));
    }
    block.refusal += value;
    content[index]!.refusal = block.refusal;
    this.pending.push(this.event("response.refusal.delta", { ...this.fields(block), content_index: index, delta: value }));
  }

  private ensureReasoning(): ShellBlock {
    const existing = this.blocks.get("reasoning");
    if (existing) return existing;
    const item: Json = { id: randomId("item_"), type: "reasoning", status: "in_progress", summary: [] };
    const block: ShellBlock = { kind: "reasoning", item, outputIndex: this.output.length, text: "", refusal: "", signature: "", arguments: "", custom: false, hasDelta: false };
    this.blocks.set("reasoning", block);
    this.output.push(item);
    this.pending.push(this.event("response.output_item.added", { output_index: block.outputIndex, item: structuredClone(item) }));
    return block;
  }

  appendThinking(value: string): void {
    // encodeReasoning 表示服务需要 reasoning 回放（如 DeepSeek 信封）：空增量也
    // 保留条目存在性；普通输出跳过空增量。
    if (!value && !this.options.encodeReasoning) return;
    const block = this.ensureReasoning();
    if (!value) return;
    const summary = block.item.summary as Json[];
    if (!summary.length) {
      const part = { type: "summary_text", text: "" };
      summary.push(part);
      this.pending.push(this.event("response.reasoning_summary_part.added", { ...this.fields(block), summary_index: 0, part: structuredClone(part) }));
    }
    block.text += value;
    summary[0]!.text = block.text;
    this.pending.push(this.event("response.reasoning_summary_text.delta", { ...this.fields(block), summary_index: 0, delta: value }));
  }

  appendThinkingSignature(value: string): void {
    if (!value) return;
    const block = this.blocks.get("reasoning");
    if (block) block.signature += value;
  }

  /** 打开工具调用条目；custom 决定 custom_tool_call/input 与 function_call/arguments。 */
  openToolCall(key: string, call: { id: string; name: string; namespace?: string; custom: boolean }): void {
    if (this.blocks.has(key)) return;
    const item: Json = call.custom
      ? { id: randomId("item_"), type: "custom_tool_call", call_id: call.id, name: call.name, ...(call.namespace === undefined ? {} : { namespace: call.namespace }), status: "in_progress", input: "" }
      : { id: randomId("item_"), type: "function_call", call_id: call.id, name: call.name, ...(call.namespace === undefined ? {} : { namespace: call.namespace }), status: "in_progress", arguments: "" };
    const block: ShellBlock = { kind: "tool", item, outputIndex: this.output.length, text: "", refusal: "", signature: "", arguments: "", custom: call.custom, hasDelta: false };
    this.blocks.set(key, block);
    this.output.push(item);
    this.pending.push(this.event("response.output_item.added", { output_index: block.outputIndex, item: structuredClone(item) }));
  }

  appendToolArguments(key: string, value: string): void {
    if (!value) return;
    const block = this.blocks.get(key);
    if (!block || block.kind !== "tool") throw new Error("tool delta 引用了未声明的工具调用");
    block.hasDelta = true;
    block.arguments += value;
    // custom 的增量是上游 JSON 包装，必须完整校验并解包后才能作为可执行正文下发。
    if (!block.custom) {
      (block.item as { arguments: string }).arguments = block.arguments;
      this.pending.push(this.event("response.function_call_arguments.delta", { ...this.fields(block), delta: value }));
    }
  }

  /** 插件专用条目（如 zcode 的 web_search_call）：直接 output_item.added。 */
  addRawItem(item: Json): number {
    const outputIndex = this.output.length;
    this.output.push(item);
    this.pending.push(this.event("response.output_item.added", { output_index: outputIndex, item: structuredClone(item) }));
    return outputIndex;
  }

  /** 关闭插件专用条目；patch 可在 done 事件前修改条目（如补充 results）。 */
  closeRawItem(outputIndex: number, patch?: (item: Json) => void): void {
    const item = this.output[outputIndex];
    if (!item) throw new Error(`output_index ${outputIndex} 不存在`);
    patch?.(item);
    if (item.status === undefined) item.status = "completed";
    this.pending.push(this.event("response.output_item.done", { output_index: outputIndex, item: structuredClone(item) }));
  }

  /** 一次性合成完整生命周期的助手文本条目（插件旁白卡片）。 */
  synthesizeMessage(value: string): void {
    const item: Json = { id: randomId("item_"), type: "message", role: "assistant", status: "in_progress", content: [] };
    const outputIndex = this.output.length;
    this.output.push(item);
    this.pending.push(this.event("response.output_item.added", { output_index: outputIndex, item: structuredClone(item) }));
    const empty: Json = { type: "output_text", text: "", annotations: [], logprobs: [] };
    this.pending.push(this.event("response.content_part.added", { output_index: outputIndex, item_id: item.id, content_index: 0, part: empty }));
    this.pending.push(this.event("response.output_text.delta", { output_index: outputIndex, item_id: item.id, content_index: 0, delta: value, logprobs: [] }));
    this.pending.push(this.event("response.output_text.done", { output_index: outputIndex, item_id: item.id, content_index: 0, text: value, logprobs: [] }));
    this.pending.push(this.event("response.content_part.done", { output_index: outputIndex, item_id: item.id, content_index: 0, part: { ...empty, text: value } }));
    item.status = "completed";
    (item.content as Json[]).push({ ...empty, text: value });
    this.pending.push(this.event("response.output_item.done", { output_index: outputIndex, item: structuredClone(item) }));
  }

  /** 块是否仍处于 in_progress（未关闭）。 */
  blocksOpen(key: string): boolean {
    const block = this.blocks.get(key);
    return block !== undefined && block.item.status === "in_progress";
  }

  /** 关闭单个开放块并产出 done 事件；重复关闭抛错。 */
  closeBlock(key: string): void {
    const block = this.blocks.get(key);
    if (!block) throw new Error(`关闭了不存在的输出块 ${key}`);
    if (block.item.status === "completed" || block.item.status === "incomplete") {
      throw new Error("输出块重复结束");
    }
    const base = this.fields(block);
    if (block.kind === "message") {
      const content = block.item.content as Json[];
      const textIndex = content.findIndex((entry) => entry.type === "output_text");
      if (textIndex >= 0 && block.text) {
        const part = content[textIndex]!;
        this.pending.push(this.event("response.output_text.done", { ...base, content_index: textIndex, text: block.text, logprobs: [] }));
        this.pending.push(this.event("response.content_part.done", { ...base, content_index: textIndex, part: structuredClone(part) }));
      }
      const refusalIndex = content.findIndex((entry) => entry.type === "refusal");
      if (refusalIndex >= 0 && block.refusal) {
        this.pending.push(this.event("response.refusal.done", { ...base, content_index: refusalIndex, refusal: block.refusal }));
        this.pending.push(this.event("response.content_part.done", { ...base, content_index: refusalIndex, part: structuredClone(content[refusalIndex]!) }));
      }
    } else if (block.kind === "reasoning") {
      const envelope = this.options.encodeReasoning?.(block.text, block.signature);
      if (envelope !== undefined) block.item.encrypted_content = envelope;
      if ((block.item.summary as Json[]).length) {
        this.pending.push(this.event("response.reasoning_summary_text.done", { ...base, summary_index: 0, text: block.text }));
        this.pending.push(this.event("response.reasoning_summary_part.done", { ...base, summary_index: 0, part: { type: "summary_text", text: block.text } }));
      }
    } else {
      const parsedArguments = block.arguments || "{}";
      let parsed: unknown;
      try {
        parsed = JSON.parse(parsedArguments);
      } catch {
        throw new Error("tool arguments 包含无效或未结束的 JSON");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("tool arguments 必须是 JSON 对象");
      }
      if (block.custom) {
        const input = (parsed as Json).input;
        if (typeof input !== "string") throw new Error("custom tool input 必须是字符串");
        block.item.input = input;
        if (input) {
          this.pending.push(this.event("response.custom_tool_call_input.delta", { ...base, delta: input }));
        }
        this.pending.push(this.event("response.custom_tool_call_input.done", { ...base, input }));
      } else {
        if (!block.hasDelta && parsedArguments && parsedArguments !== "{}" && this.options.replayToolArgumentsAtClose) {
          this.pending.push(this.event("response.function_call_arguments.delta", { ...base, delta: parsedArguments }));
        }
        this.pending.push(this.event("response.function_call_arguments.done", { ...base, arguments: parsedArguments }));
      }
    }
    block.item.status = "completed";
    this.pending.push(this.event("response.output_item.done", { output_index: block.outputIndex, item: structuredClone(block.item) }));
  }

  /** 关闭全部仍开放的块（按 open 顺序）。 */
  closeAllBlocks(options: { skipCustomTools?: boolean } = {}): void {
    for (const [key, block] of this.blocks) {
      if (block.item.status !== "in_progress") continue;
      if (options.skipCustomTools && block.custom) continue;
      this.closeBlock(key);
    }
  }

  /**
   * 终态：未闭合块标记 incomplete（reasoning 块收尾时补 encrypted_content），生成
   * 最终快照并把 response.{status} 事件入队；只生效一次。
   */
  terminal(status: "completed" | "incomplete" | "failed", options: { error?: Json; incompleteReason?: string } = {}): Json | undefined {
    if (this.terminalResponse) return undefined;
    for (const block of this.blocks.values()) {
      if (block.item.status !== "in_progress") continue;
      if (block.kind === "reasoning") {
        const envelope = this.options.encodeReasoning?.(block.text, block.signature);
        if (envelope !== undefined) block.item.encrypted_content = envelope;
      }
      block.item.status = "incomplete";
    }
    this.terminalResponse = { ...this.snapshot(status), usage: this.upstreamUsage };
    if (status === "incomplete") {
      this.terminalResponse.incomplete_details = { reason: options.incompleteReason ?? "max_output_tokens" };
    }
    if (options.error !== undefined) {
      try {
        this.terminalResponse.error = this.options.sanitizeError ? this.options.sanitizeError(options.error) : options.error;
      } catch {
        this.terminalResponse.error = { code: "upstream_error", message: "上游响应失败" };
      }
    }
    safely(() => this.options.onTerminal?.(structuredClone(this.terminalResponse!)));
    const terminal = this.event(`response.${status}`, { response: structuredClone(this.terminalResponse) });
    this.pending.push(terminal);
    return terminal;
  }

  /** 取走待输出事件（含 start 与终态事件）。 */
  drain(): Json[] {
    return this.pending.splice(0);
  }
}

/* ============================= 事件 → 客户端输出 ============================= */

export interface ClientOutputOptions {
  /** 客户端展示的模型名（回填到响应）。 */
  model: string;
  /** false 时聚合为完整 JSON（Responses response / chat completion / Anthropic message）。 */
  stream: boolean;
  signal?: AbortSignal;
  abort?: () => void;
  onChunk?: (chunk: string) => void;
  onComplete?: (payload: Json) => void;
  sanitizeError?: (error: Json) => Json;
  /** 上游（映射后）工具名 → 客户端身份；用于恢复原始名称与 custom 语义。 */
  toolIdentities?: ToolIdentityMap;
  /** 数据级事件变换（插件私有信封/身份处理）；无执行语义。 */
  transform?: (events: AsyncIterable<BridgeStreamEvent>) => AsyncIterable<BridgeStreamEvent>;
  /** chat-completions 客户端输出 reasoning 增量使用的厂商字段（如 reasoning_content）。 */
  chatReasoningField?: string;
  /** 上游 finish_reason 无法归一时：error（默认，报协议错误）或 stop（宽松服务）。 */
  unknownStopReason?: "error" | "stop";
  /** Responses 输出 reasoning 条目的 encrypted_content 数据映射。 */
  encodeReasoning?: (text: string, signature: string) => string | undefined;
}

export interface ClientOutputResult {
  response: Response;
  /** 非流式时为聚合 JSON；流式时在终态后填充。 */
  final: Promise<Json | undefined>;
}

/** 事件驱动的 Responses 客户端输出。 */
export async function createResponsesClientOutput(events: AsyncIterable<BridgeStreamEvent>, options: ClientOutputOptions): Promise<ClientOutputResult> {
  const shell = new ResponsesOutputShell({
    model: options.model,
    encodeReasoning: options.encodeReasoning,
    onTerminal: (response) => {
      safely(() => options.onComplete?.(structuredClone(response)));
      finalResolve(structuredClone(response));
    },
    sanitizeError: options.sanitizeError,
  });
  let finalResolve!: (value: Json | undefined) => void;
  const final = new Promise<Json | undefined>((resolve) => {
    finalResolve = resolve;
  });
  let canceled = false;
  let messageEnded = false;
  const customCalls = new Map<string, boolean>();
  const handleAbort = (): void => {
    if (canceled || shell.finished) return;
    canceled = true;
    shell.terminal("failed", { error: { code: "response_cancelled", message: "响应已取消" } });
    // 立即唤醒上游读取：客户端已取消时不能等待一个永不结束的上游帧。
    safely(options.abort);
  };
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  if (options.signal?.aborted) handleAbort();

  /** 单个事件 → 外壳操作；message_start 在身份采纳阶段已消费。 */
  function feedEvent(event: BridgeStreamEvent): void {
    switch (event.type) {
      case "content_delta": {
        if (event.delta.text) shell.appendText(event.delta.text);
        if (event.delta.thinking !== undefined) shell.appendThinking(event.delta.thinking);
        if (event.delta.refusal) shell.appendRefusal(event.delta.refusal);
        break;
      }
      case "thinking_signature": {
        shell.appendThinkingSignature(event.signature);
        break;
      }
      case "tool_call_start": {
        const identity = options.toolIdentities?.get(event.tool_call.name);
        if (options.toolIdentities !== undefined && identity === undefined) {
          throw new Error(`上游返回了未声明的工具：${event.tool_call.name}`);
        }
        shell.openToolCall(event.tool_call.id, {
          id: event.tool_call.id,
          name: identity?.name ?? event.tool_call.name,
          namespace: identity?.namespace,
          custom: identity?.custom === true,
        });
        if (identity?.custom === true) customCalls.set(event.tool_call.id, false);
        break;
      }
      case "tool_call_delta": {
        shell.appendToolArguments(event.tool_call.id, event.tool_call.arguments_delta);
        break;
      }
      case "tool_call_end": {
        // custom 等待响应终态，避免上游先结束工具块、随后报告截断时执行残缺输入。
        if (customCalls.has(event.tool_call.id)) customCalls.set(event.tool_call.id, true);
        else if (shell.blocksOpen(event.tool_call.id)) shell.closeBlock(event.tool_call.id);
        break;
      }
      case "message_end": {
        if (event.stop_reason === "other" && options.unknownStopReason !== "stop") {
          throw new Error(`上游返回了不支持的结束原因：${event.raw_stop_reason ?? "unknown"}`);
        }
        shell.mergeUsage(bridgeUsageToJson(event.usage));
        messageEnded = true;
        incomplete = event.stop_reason === "length" || event.stop_reason === "content_filter";
        incompleteReason = event.stop_reason === "length" ? "max_output_tokens" : event.stop_reason === "content_filter" ? "content_filter" : undefined;
        break;
      }
      case "error": {
        shell.terminal("failed", {
          error: {
            code: event.error.code ?? "upstream_error",
            message: event.error.message,
            ...(event.error.type !== undefined ? { upstream_type: event.error.type } : {}),
            upstream_error: { ...event.error },
          },
        });
        break;
      }
    }
  }
  let incomplete = false;
  let incompleteReason: string | undefined;

  async function* frames(): AsyncGenerator<Json> {
    const iterator = (options.transform ? options.transform(events) : events)[Symbol.asyncIterator]();
    try {
      if (canceled) return;
      // 同协议上游的身份（response.created 的 id/created_at）随首个事件到达；先采纳
      // 再产出起始事件，客户端看到的响应身份与上游一致。
      const first = await iterator.next();
      if (!first.done && first.value.type === "message_start") {
        shell.adoptIdentity(first.value.id);
      } else if (!first.done) {
        feedEvent(first.value);
        yield* shell.drain();
      }
      shell.start();
      yield* shell.drain();
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        if (canceled) return;
        feedEvent(next.value);
        if (shell.finished) {
          yield* shell.drain();
          return;
        }
        yield* shell.drain();
      }
      if (canceled) return;
      if (!shell.finished) {
        if (!messageEnded) throw new Error("上游响应提前断开，缺少 message_end 终态");
        if (!incomplete && [...customCalls.values()].some((ended) => !ended)) {
          throw new Error("custom 工具调用提前断开，缺少 tool_call_end");
        }
        shell.closeAllBlocks({ skipCustomTools: incomplete });
        shell.terminal(incomplete ? "incomplete" : "completed", incomplete ? { incompleteReason } : {});
      }
      yield* shell.drain();
    } catch (error) {
      if (!shell.finished) {
        shell.terminal("failed", { error: { code: "upstream_protocol_error", message: error instanceof Error ? error.message : String(error) } });
      }
      yield* shell.drain();
    } finally {
      safely(options.abort);
      options.signal?.removeEventListener("abort", handleAbort);
      finalResolve(structuredClone(shell.finalResponse));
    }
  }

  if (options.stream) {
    const iterator = frames();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            // 取消/中止后仍需排空已生成的终态事件（插件超时与取消合同依赖 failed 终态）。
            const remaining = shell.drain();
            for (const value of remaining) {
              const chunk = `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
              safely(() => options.onChunk?.(chunk));
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
            return;
          }
          const chunk = `event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`;
          safely(() => options.onChunk?.(chunk));
          controller.enqueue(encoder.encode(chunk));
        } catch (error) {
          if (!canceled) controller.error(error);
        }
      },
      async cancel() {
        handleAbort();
        // 未开始读取的生成器不会进入 finally，取消也必须完成 final Promise。
        finalResolve(structuredClone(shell.finalResponse));
        options.signal?.removeEventListener("abort", handleAbort);
        safely(options.abort);
        await iterator.return(undefined);
      },
    }, { highWaterMark: 0 });
    return {
      response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } }),
      final,
    };
  }
  for await (const value of frames()) safely(() => options.onChunk?.(JSON.stringify(value)));
  const failed = shell.finalResponse?.status === "failed";
  return {
    response: Response.json(shell.finalResponse ?? shell.snapshot("failed"), { status: failed || canceled ? 502 : 200 }),
    final,
  };
}
export async function createChatCompletionsClientOutput(events: AsyncIterable<BridgeStreamEvent>, options: ClientOutputOptions): Promise<ClientOutputResult> {
  const id = randomId("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);
  let finalResolve!: (value: Json | undefined) => void;
  const final = new Promise<Json | undefined>((resolve) => {
    finalResolve = resolve;
  });
  let canceled = false;
  const usageHolder: { usage?: Json } = {};
  const message: Json = { role: "assistant", content: "" };
  const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];
  const toolIndex = new Map<string, number>();
  let refusal = "";
  let finishReason: string | undefined;
  const model = options.model;
  let error: { message: string; code?: string } | undefined;

  const chunkBase = (): Json => ({ id, object: "chat.completion.chunk", created, model });
  const completionSnapshot = (): Json => ({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          ...(message.content === "" && toolCalls.length > 0 ? { content: null } : { content: message.content }),
          ...(refusal ? { refusal } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: call.function })) } : {}),
        },
        finish_reason: finishReason ?? "stop",
      },
    ],
    ...(usageHolder.usage ? { usage: usageHolder.usage } : {}),
  });
  let settled = false;
  let completion: Json | undefined;
  const settleFinal = (): void => {
    if (settled) return;
    settled = true;
    if (!canceled && !error) {
      completion = completionSnapshot();
      safely(() => options.onComplete?.(structuredClone(completion!)));
    }
    finalResolve(structuredClone(completion));
  };
  const handleAbort = (): void => {
    if (settled) return;
    canceled = true;
    settleFinal();
    safely(options.abort);
  };
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  if (options.signal?.aborted) handleAbort();

  async function* frames(): AsyncGenerator<Json | "[DONE]" | { __error: { message: string; code?: string } }> {
    try {
      if (canceled) return;
      yield { ...chunkBase(), choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };
      const source = options.transform ? options.transform(events) : events;
      for await (const event of source) {
        if (canceled) return;
        switch (event.type) {
          case "message_start": {
            // 客户端始终看到请求的展示模型；上游真实模型由插件在日志/审计侧记录。
            break;
          }
          case "content_delta": {
            if (event.delta.text) {
              message.content = `${message.content}${event.delta.text}`;
              yield { ...chunkBase(), choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] };
            }
            if (event.delta.thinking && options.chatReasoningField) {
              yield { ...chunkBase(), choices: [{ index: 0, delta: { [options.chatReasoningField]: event.delta.thinking }, finish_reason: null }] };
            }
            if (event.delta.refusal) {
              refusal += event.delta.refusal;
              yield { ...chunkBase(), choices: [{ index: 0, delta: { refusal: event.delta.refusal }, finish_reason: null }] };
            }
            break;
          }
          case "tool_call_start": {
            const identity = options.toolIdentities?.get(event.tool_call.name);
            if (options.toolIdentities !== undefined && identity === undefined) {
              throw new Error(`上游返回了未声明的工具：${event.tool_call.name}`);
            }
            const index = toolCalls.length;
            toolIndex.set(event.tool_call.id, index);
            const name = identity?.name ?? event.tool_call.name;
            toolCalls.push({ id: event.tool_call.id, function: { name, arguments: "" } });
            yield { ...chunkBase(), choices: [{ index: 0, delta: { tool_calls: [{ index, id: event.tool_call.id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] };
            break;
          }
          case "tool_call_delta": {
            const index = toolIndex.get(event.tool_call.id);
            if (index === undefined) break;
            toolCalls[index]!.function.arguments += event.tool_call.arguments_delta;
            yield { ...chunkBase(), choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.tool_call.arguments_delta } }] }, finish_reason: null }] };
            break;
          }
          case "message_end": {
            if (event.stop_reason === "other" && options.unknownStopReason !== "stop") {
              throw new Error(`上游返回了不支持的结束原因：${event.raw_stop_reason ?? "unknown"}`);
            }
            finishReason = event.stop_reason === "tool_calls" || event.stop_reason === "length" || event.stop_reason === "content_filter"
              ? (event.stop_reason === "tool_calls" ? "tool_calls" : event.stop_reason === "length" ? "length" : "content_filter")
              : "stop";
            const usage = bridgeUsageToJson(event.usage) ?? undefined;
            if (usage) usageHolder.usage = usage;
            break;
          }
          case "error": {
            error = { message: event.error.message, code: event.error.code ?? "upstream_error" };
            yield { __error: error };
            return;
          }
        }
      }
      if (canceled) return;
      yield { ...chunkBase(), choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }] };
      if (usageHolder.usage) {
        // include_usage 形状：usage 单独一帧，choices 为空数组，最后 [DONE]。
        yield { ...chunkBase(), choices: [], usage: usageHolder.usage };
      }
      yield "[DONE]";
    } catch ( upstreamError) {
      error = { message: upstreamError instanceof Error ? upstreamError.message : String(upstreamError), code: "upstream_protocol_error" };
      if (!canceled) yield { __error: error };
    } finally {
      settleFinal();
      options.signal?.removeEventListener("abort", handleAbort);
      safely(options.abort);
    }
  }

  if (options.stream) {
    const iterator = frames();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const value = next.value;
        if (value === "[DONE]") {
          const chunk = "data: [DONE]\n\n";
          safely(() => options.onChunk?.(chunk));
          controller.enqueue(encoder.encode(chunk));
          return;
        }
        if (typeof value === "object" && value !== null && "__error" in value) {
          const sanitized = options.sanitizeError ? options.sanitizeError(value.__error as Json) : (value.__error as Json);
          const payload = { error: { message: sanitized.message, code: sanitized.code ?? "upstream_error", type: "upstream_error" } };
          const chunk = `data: ${JSON.stringify(payload)}\n\n`;
          safely(() => options.onChunk?.(chunk));
          controller.enqueue(encoder.encode(chunk));
          return;
        }
        const chunk = `data: ${JSON.stringify(value)}\n\n`;
        safely(() => options.onChunk?.(chunk));
        controller.enqueue(encoder.encode(chunk));
      },
      async cancel() {
        handleAbort();
        options.signal?.removeEventListener("abort", handleAbort);
        safely(options.abort);
        await iterator.return(undefined);
      },
    }, { highWaterMark: 0 });
    return {
      response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } }),
      final,
    };
  }
  for await (const frame of frames()) {
    if (typeof frame === "string") safely(() => options.onChunk?.(`${frame}\n`));
    else safely(() => options.onChunk?.(JSON.stringify(frame)));
  }
  if (error) {
    const sanitized = options.sanitizeError ? options.sanitizeError(error as Json) : (error as Json);
    return {
      response: Response.json({ error: { message: sanitized.message, code: sanitized.code ?? "upstream_error", type: "upstream_error" } }, { status: 502 }),
      final,
    };
  }
  if (canceled) return { response: Response.json({ error: { message: "响应已取消", code: "response_cancelled", type: "upstream_error" } }, { status: 502 }), final };
  return { response: Response.json(completion), final };
}

/** anthropic Messages 客户端输出。 */
export async function createAnthropicClientOutput(events: AsyncIterable<BridgeStreamEvent>, options: ClientOutputOptions): Promise<ClientOutputResult> {
  const id = randomId("msg_");
  let finalResolve!: (value: Json | undefined) => void;
  const final = new Promise<Json | undefined>((resolve) => {
    finalResolve = resolve;
  });
  let canceled = false;
  interface OpenBlock {
    index: number;
    type: "text" | "thinking" | "tool_use";
    text: string;
    thinking: string;
    signature: string;
    arguments: string;
    toolId: string;
    toolName: string;
    stopped: boolean;
  }
  const blocks: OpenBlock[] = [];
  const toolIndex = new Map<string, number>();
  const model = options.model;
  const usage: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number; billing?: Json } = {};
  let stopReason: string | undefined;
  let sawToolUse = false;
  let aggregatedError: string | undefined;

  const ensureTextBlock = (): OpenBlock => {
    const last = blocks.at(-1);
    if (last?.type === "text" && !last.stopped) return last;
    const block: OpenBlock = { index: blocks.length, type: "text", text: "", thinking: "", signature: "", arguments: "", toolId: "", toolName: "", stopped: false };
    blocks.push(block);
    return block;
  };

  const messageSnapshot = (): Json => {
    const content: Json[] = [];
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        content.push({ type: "thinking", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) });
      } else if (block.type === "tool_use") {
        let input: Json = {};
        try {
          const parsed: unknown = JSON.parse(block.arguments || "{}");
          if (isRecord(parsed)) input = parsed;
        } catch {
          /* 未完成的参数按空对象聚合，与流式语义一致。 */
        }
        content.push({ type: "tool_use", id: block.toolId, name: block.toolName, input });
      }
    }
    return {
      id,
      type: "message",
      role: "assistant",
      model,
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      stop_reason: stopReason ?? (sawToolUse ? "tool_use" : "end_turn"),
      stop_sequence: null,
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        ...(usage.cacheRead !== undefined ? { cache_read_input_tokens: usage.cacheRead } : {}),
        ...(usage.cacheCreation !== undefined ? { cache_creation_input_tokens: usage.cacheCreation } : {}),
        ...(usage.billing ?? {}),
      },
    };
  };
  let settled = false;
  let message: Json | undefined;
  const settleFinal = (): void => {
    if (settled) return;
    settled = true;
    if (!canceled && aggregatedError === undefined) {
      message = messageSnapshot();
      safely(() => options.onComplete?.(structuredClone(message!)));
    }
    finalResolve(structuredClone(message));
  };
  const handleAbort = (): void => {
    if (settled) return;
    canceled = true;
    settleFinal();
    safely(options.abort);
  };
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  if (options.signal?.aborted) handleAbort();

  async function* frames(): AsyncGenerator<string | Json> {
    try {
      if (canceled) return;
      yield `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model: options.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`;
      yield "event: ping\ndata: {\"type\": \"ping\"}\n\n";
      const source = options.transform ? options.transform(events) : events;
      for await (const event of source) {
        if (canceled) return;
        switch (event.type) {
          case "message_start": {
            break;
          }
          case "content_delta": {
            if (event.delta.text) {
              const block = ensureTextBlock();
              if (block.text === "") {
                yield `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: block.index, content_block: { type: "text", text: "" } })}\n\n`;
              }
              block.text += event.delta.text;
              yield `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: block.index, delta: { type: "text_delta", text: event.delta.text } })}\n\n`;
            }
            if (event.delta.refusal) {
              const block = ensureTextBlock();
              if (block.text === "") {
                yield `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: block.index, content_block: { type: "text", text: "" } })}\n\n`;
              }
              block.text += event.delta.refusal;
              yield `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: block.index, delta: { type: "text_delta", text: event.delta.refusal } })}\n\n`;
            }
            if (event.delta.thinking) {
              let block = blocks.at(-1);
              if (!block || block.type !== "thinking" || block.stopped) {
                block = { index: blocks.length, type: "thinking", text: "", thinking: "", signature: "", arguments: "", toolId: "", toolName: "", stopped: false };
                blocks.push(block);
                yield `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: block.index, content_block: { type: "thinking", thinking: "" } })}\n\n`;
              }
              block.thinking += event.delta.thinking;
              yield `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: block.index, delta: { type: "thinking_delta", thinking: event.delta.thinking } })}\n\n`;
            }
            break;
          }
          case "thinking_signature": {
            const block = blocks.at(-1);
            if (block?.type === "thinking" && !block.stopped) {
              block.signature += event.signature;
              yield `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: event.signature } })}\n\n`;
            }
            break;
          }
          case "tool_call_start": {
            const identity = options.toolIdentities?.get(event.tool_call.name);
            if (options.toolIdentities !== undefined && identity === undefined) {
              throw new Error(`上游返回了未声明的工具：${event.tool_call.name}`);
            }
            const index = blocks.length;
            toolIndex.set(event.tool_call.id, index);
            blocks.push({ index, type: "tool_use", text: "", thinking: "", signature: "", arguments: "", toolId: event.tool_call.id, toolName: identity?.name ?? event.tool_call.name, stopped: false });
            sawToolUse = true;
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "tool_use", id: event.tool_call.id, name: identity?.name ?? event.tool_call.name, input: {} } })}\n\n`;
            break;
          }
          case "tool_call_delta": {
            const index = toolIndex.get(event.tool_call.id);
            const block = index === undefined ? undefined : blocks[index];
            if (block?.type === "tool_use") {
              block.arguments += event.tool_call.arguments_delta;
              yield `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: event.tool_call.arguments_delta } })}\n\n`;
            }
            break;
          }
          case "tool_call_end": {
            const index = toolIndex.get(event.tool_call.id);
            const block = index === undefined ? undefined : blocks[index];
            if (block?.type === "tool_use" && !block.stopped) {
              block.stopped = true;
              yield `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`;
            }
            break;
          }
          case "message_end": {
            if (event.stop_reason === "other" && options.unknownStopReason !== "stop") {
              throw new Error(`上游返回了不支持的结束原因：${event.raw_stop_reason ?? "unknown"}`);
            }
            if (event.usage) {
              usage.input = event.usage.inputTokens ?? usage.input;
              usage.output = event.usage.outputTokens ?? usage.output;
              usage.cacheRead = event.usage.cachedInputTokens ?? usage.cacheRead;
              usage.cacheCreation = event.usage.cacheCreationInputTokens ?? usage.cacheCreation;
              if (event.usage.billing) usage.billing = event.usage.billing;
            }
            stopReason = event.stop_reason === "tool_calls"
              ? "tool_use"
              : event.stop_reason === "length"
                ? "max_tokens"
                : event.stop_reason === "content_filter"
                  ? "refusal"
                  : "end_turn";
            break;
          }
          case "error": {
            aggregatedError = event.error.message;
            yield `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "upstream_error", message: event.error.message } })}\n\n`;
            return;
          }
        }
      }
      if (canceled) return;
      for (const block of blocks) {
        if (block.stopped) continue;
        block.stopped = true;
        yield `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: block.index })}\n\n`;
      }
      yield `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason ?? (sawToolUse ? "tool_use" : "end_turn"), stop_sequence: null }, usage: { output_tokens: usage.output ?? 0, ...(usage.input !== undefined ? { input_tokens: usage.input } : {}), ...(usage.billing ?? {}) } })}\n\n`;
      yield "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n";
    } catch ( upstreamError) {
      aggregatedError = upstreamError instanceof Error ? upstreamError.message : String(upstreamError);
      if (!canceled) yield `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "upstream_error", message: aggregatedError } })}\n\n`;
    } finally {
      settleFinal();
      options.signal?.removeEventListener("abort", handleAbort);
      safely(options.abort);
    }
  }

  if (options.stream) {
    const iterator = frames();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const chunk = typeof next.value === "string" ? next.value : `data: ${JSON.stringify(next.value)}\n\n`;
        safely(() => options.onChunk?.(chunk));
        controller.enqueue(encoder.encode(chunk));
      },
      async cancel() {
        handleAbort();
        options.signal?.removeEventListener("abort", handleAbort);
        safely(options.abort);
        await iterator.return(undefined);
      },
    }, { highWaterMark: 0 });
    return {
      response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } }),
      final,
    };
  }
  for await (const frame of frames()) {
    if (typeof frame === "string") safely(() => options.onChunk?.(frame));
  }
  if (aggregatedError !== undefined) {
    return {
      response: Response.json({ type: "error", error: { type: "upstream_error", message: aggregatedError } }, { status: 502 }),
      final,
    };
  }
  if (canceled) return { response: Response.json({ type: "error", error: { type: "upstream_error", message: "响应已取消" } }, { status: 502 }), final };
  return { response: Response.json(message), final };
}

/* =============================== 高层组合入口 =============================== */

export interface CreateClientResponseOptions extends ClientOutputOptions {
  /** 上游协议（决定解析器）。 */
  upstreamProtocol: BridgeProtocol;
}

/** 上游响应 → 解析 → 数据变换 → 客户端协议输出。 */
export async function createClientResponse(
  clientProtocol: ClientBridgeProtocol,
  upstream: Response,
  options: CreateClientResponseOptions,
): Promise<ClientOutputResult> {
  const { upstreamProtocol, ...outputOptions } = options;
  const events = parseUpstreamEvents(upstreamProtocol, upstream, options.model);
  if (clientProtocol === "responses") return createResponsesClientOutput(events, outputOptions);
  if (clientProtocol === "chat-completions") return createChatCompletionsClientOutput(events, outputOptions);
  return createAnthropicClientOutput(events, outputOptions);
}
