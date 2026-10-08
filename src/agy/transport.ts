import type { AgyCredentials } from "./credentials.ts";

/**
 * Antigravity 上游传输：Cloud Code Assist 内部 REST（`/v1internal:*`）。
 *
 * 本机 CLI 是 daily 通道构建（daily-cloudcode-pa.googleapis.com），网关默认指向
 * stable 通道的 cloudcode-pa.googleapis.com，两者线协议一致；端点可经依赖注入覆盖。
 * headers 只带最小集：Authorization、Content-Type、User-Agent；客户端指纹的其余
 * 部分按 CLI 形态放在请求 body（metadata / user_agent）里。
 */

/**
 * 默认端点取 daily 通道：本机 CLI 实际使用该通道，且实测该账号在 stable 通道上
 * 管理面可用但推理一律 429（2026-10-06 验证）；端点可经依赖注入覆盖。
 */
export const AGY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
/** consumer 档的哨兵配额项目；CLI 缓存文件 default_project_id.txt 即此字面量。 */
export const AGY_DEFAULT_PROJECT = "aicode-consumers";
/**
 * 指纹对齐用的客户端标识。上游鉴权只依赖 Bearer token；UA 与 body 内 userAgent
 * 字段按 MITM 抓包的真实 CLI 形态（2026-10-06，agy 1.2.17）固定。
 */
export const AGY_CLIENT_VERSION = "1.2.17";
export const AGY_USER_AGENT =
  `antigravity/cli/${AGY_CLIENT_VERSION} (aidev_client; os_type=${process.platform === "darwin" ? "darwin" : process.platform}; `
  + `arch=${process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch}; cl=993434119; auth_method=consumer)`;

export class AgyTransportError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Antigravity 上游返回 HTTP ${status}`);
    this.name = "AgyTransportError";
    this.status = status;
    this.body = body;
  }
}

/** 上游请求 headers：白名单构造，绝不透传客户端任何 header（含入站授权）。 */
export function buildAgyHeaders(credential: AgyCredentials): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${credential.accessToken}`);
  headers.set("content-type", "application/json");
  headers.set("user-agent", AGY_USER_AGENT);
  return headers;
}

export interface AgyTransportOptions {
  endpoint?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface AgyTransport {
  fetchModels(credential: AgyCredentials, signal?: AbortSignal): Promise<unknown>;
  streamInfer(credential: AgyCredentials, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
}

function endpointUrl(endpoint: string, method: string, stream: boolean): string {
  return `${endpoint.replace(/\/+$/, "")}/v1internal:${method}${stream ? "?alt=sse" : ""}`;
}

export function createAgyTransport(options: AgyTransportOptions = {}): AgyTransport {
  const endpoint = options.endpoint ?? AGY_ENDPOINT;
  const doFetch = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const post = async (credential: AgyCredentials, method: string, body: Record<string, unknown>, stream: boolean, signal?: AbortSignal): Promise<Response> => {
    const response = await doFetch(endpointUrl(endpoint, method, stream), {
      method: "POST",
      headers: buildAgyHeaders(credential),
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      // 错误正文可能回显请求内容或凭据，只保留状态码与截断文本供分类，不进入客户端。
      const text = await response.text().catch(() => "");
      throw new AgyTransportError(response.status, text.slice(0, 4_096));
    }
    return response;
  };
  return {
    async fetchModels(credential, signal) {
      // 真实 CLI 的 body 只有 project（MITM 抓包验证）。
      const response = await post(credential, "fetchAvailableModels", {
        project: AGY_DEFAULT_PROJECT,
      }, false, signal);
      try {
        return await response.json();
      } catch {
        throw new AgyTransportError(response.status, "");
      }
    },
    async streamInfer(credential, body, signal) {
      return post(credential, "streamGenerateContent", body, true, signal);
    },
  };
}
