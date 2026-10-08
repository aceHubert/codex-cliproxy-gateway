import { CodebuddyRequestError, translateCodebuddyRequest, type CodebuddyToolMap } from "../codebuddy/request.ts";

export class QoderRequestError extends Error {
  constructor(message: string) { super(message); this.name = "QoderRequestError"; }
}

export interface QoderTranslatedRequest {
  /** 推理封套的消息字段；业务标识和模型配置由传输层添加。 */
  body: Record<string, unknown>;
  tools: CodebuddyToolMap;
  dropped: string[];
}

/** 复用已经验证的 Responses → OpenAI 消息转换，只在此处处理 Qoder 参数布局。 */
export function translateQoderRequest(input: Record<string, unknown>, modelKey: string, allowedEfforts?: string[]): QoderTranslatedRequest {
  const reasoning = input.reasoning;
  if (allowedEfforts && reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort === "string" && !allowedEfforts.includes(effort)) {
      throw new QoderRequestError(`Qoder 当前模型不支持推理档位 ${effort}，请从模型目录的可用档位选择`);
    }
  }
  let translated;
  try {
    translated = translateCodebuddyRequest(input, modelKey);
  } catch (error) {
    if (error instanceof CodebuddyRequestError) throw new QoderRequestError(error.message.replaceAll("CodeBuddy", "Qoder"));
    throw error;
  }
  const messages = translated.body.messages as Array<Record<string, unknown>>;
  // 通用转换在仅有 instructions 时不生成 system；Qoder 必须在消息内保留系统提示。
  if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: input.instructions ?? "" });
  const parameters: Record<string, unknown> = {};
  for (const field of ["max_tokens", "temperature", "top_p", "reasoning_effort", "tool_choice", "parallel_tool_calls"]) {
    if (translated.body[field] !== undefined) parameters[field] = translated.body[field];
  }
  return {
    body: {
      system: messages[0]!.content,
      messages,
      tools: translated.body.tools ?? [],
      parameters,
    },
    tools: translated.tools,
    dropped: translated.dropped,
  };
}
