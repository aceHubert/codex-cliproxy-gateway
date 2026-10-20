import { BridgeConversionError } from "./types.ts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolKey(tool: Json): string {
  // function/custom 的调用身份只有名称；旧信封不能覆盖顶层已更改的工具类型。
  const type = tool.type === "function" || tool.type === "custom" ? "callable" : tool.type;
  return JSON.stringify([type, tool.namespace ?? null, tool.name ?? null]);
}

/** 同身份声明保留先到者；同名 namespace 合并成员，避免顶层声明遮蔽增补工具。 */
function mergeTools(groups: unknown[][], inNamespace = false): Json[] {
  const result: Json[] = [];
  const indices = new Map<string, number>();
  const namespaces = new Map<string, unknown[][]>();
  for (const tools of groups) {
    for (const value of tools) {
      if (!isRecord(value) || typeof value.type !== "string" || !value.type) {
        throw new BridgeConversionError("additional_tools.tools 包含无效工具声明");
      }
      if (["function", "custom", "namespace"].includes(value.type)
        && (typeof value.name !== "string" || !value.name)) {
        throw new BridgeConversionError("additional_tools 工具 name 必须是非空字符串");
      }
      if (value.type === "function" && !isRecord(value.parameters)) {
        throw new BridgeConversionError(`additional_tools function 工具 ${String(value.name)} 缺少对象 parameters`);
      }
      if (value.type === "namespace") {
        if (inNamespace || !Array.isArray(value.tools)) {
          throw new BridgeConversionError("additional_tools namespace.tools 必须是工具数组且不得嵌套 namespace");
        }
      }
      const key = toolKey(value);
      const existingIndex = indices.get(key);
      if (existingIndex === undefined) {
        indices.set(key, result.length);
        result.push(value);
      }
      if (value.type === "namespace") {
        const members = namespaces.get(key) ?? [];
        members.push(value.tools as unknown[]);
        namespaces.set(key, members);
      }
    }
  }
  // 同一命名空间的所有批次一次合并，避免逐批重建成员导致平方复杂度。
  return result.map((tool) => tool.type === "namespace"
    ? { ...tool, tools: mergeTools(namespaces.get(toolKey(tool))!, true) }
    : tool);
}

/**
 * Codex 增补工具信封不是消息：先提升声明，再移除信封。顶层声明优先，多个信封
 * 按输入顺序合并。原生 Responses 仅将该视图用于身份注册，出站保留原始信封位置。
 */
export function normalizeResponsesToolDeclarations(body: Json): Json {
  if (!Array.isArray(body.input)) return body;
  const envelopes = body.input.filter((item): item is Json => isRecord(item) && item.type === "additional_tools");
  if (envelopes.length === 0) return body;
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new BridgeConversionError("tools 必须是数组");
  }
  const groups: unknown[][] = [(body.tools as unknown[] | undefined) ?? []];
  for (const envelope of envelopes) {
    if (!Array.isArray(envelope.tools)) {
      throw new BridgeConversionError("additional_tools.tools 必须是数组");
    }
    groups.push(envelope.tools);
  }
  return {
    ...body,
    tools: mergeTools(groups),
    input: body.input.filter((item) => !isRecord(item) || item.type !== "additional_tools"),
  };
}
