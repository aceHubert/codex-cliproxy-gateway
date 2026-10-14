/**
 * 三种客户端协议的标准错误外壳。错误按客户端协议返回正确形状，不把一种协议的
 * 响应套成另一种；status/code/message 不伪装成功。
 */

import type { ClientBridgeProtocol } from "./types.ts";

export interface ClientErrorOptions {
  status?: number;
  type?: string;
}

/** 按客户端协议构造标准错误 Response（Responses/OpenAI error、Anthropic error）。 */
export function clientErrorResponse(protocol: ClientBridgeProtocol, message: string, options: ClientErrorOptions = {}): Response {
  const status = options.status ?? 400;
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
