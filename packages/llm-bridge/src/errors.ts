/**
 * 四种客户端协议的标准错误外壳。错误按客户端协议返回正确形状，不把一种协议的
 * 响应套成另一种；status/code/message 不伪装成功。
 */

import type { ClientProtocol } from "@agent-proxy/plugin-api";

export interface ClientErrorOptions {
  status?: number;
  type?: string;
}

/** HTTP status → Google API 规范 status 码（Gemini 客户端错误形状）。 */
function geminiStatusFor(status: number): string {
  if (status === 400) return "INVALID_ARGUMENT";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RESOURCE_EXHAUSTED";
  if (status >= 500) return "INTERNAL";
  return "INVALID_ARGUMENT";
}

/** 按客户端协议构造标准错误 Response（Responses/OpenAI、Anthropic、Gemini error）。 */
export function clientErrorResponse(protocol: ClientProtocol, message: string, options: ClientErrorOptions = {}): Response {
  const status = options.status ?? 400;
  if (protocol === "gemini") {
    return Response.json(
      { error: { code: status, message, status: options.type ?? geminiStatusFor(status) } },
      { status },
    );
  }
  if (protocol === "anthropic") {
    return Response.json(
      {
        type: "error",
        error: {
          type: options.type ?? (status === 400 ? "invalid_request_error" : "api_error"),
          message,
        },
      },
      { status },
    );
  }
  return Response.json(
    {
      error: {
        message,
        type: options.type ?? (status === 400 ? "invalid_request_error" : "api_error"),
        ...(status >= 500 ? { code: "upstream_error" } : {}),
      },
    },
    { status },
  );
}
