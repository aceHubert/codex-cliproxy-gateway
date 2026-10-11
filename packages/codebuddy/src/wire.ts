const REASONING_PREFIX = "codebuddy-reasoning-v1:";

/** 本地不透明回传载荷，不代表 OpenAI 的加密思考格式。 */
export function encodeCodebuddyReasoning(model: string, reasoningContent: string): string {
  return REASONING_PREFIX + Buffer.from(JSON.stringify({
    model,
    reasoningContent,
  }), "utf8").toString("base64");
}

export function decodeCodebuddyReasoning(value: unknown, model: string): string | undefined {
  if (typeof value !== "string" || !value.startsWith(REASONING_PREFIX)) return undefined;
  try {
    const data: unknown = JSON.parse(Buffer.from(value.slice(REASONING_PREFIX.length), "base64").toString("utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
    const record = data as Record<string, unknown>;
    if (record.model !== model || typeof record.reasoningContent !== "string") return undefined;
    return record.reasoningContent;
  } catch {
    return undefined;
  }
}
