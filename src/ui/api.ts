/**
 * Web UI API 客户端。
 *
 * 令牌流转：`codex-cliproxy web` 打开的地址带 `?token=…`；首次加载时把它转存
 * sessionStorage 并从地址栏清除（history.replaceState），此后所有请求通过
 * `x-ccp-ui-token` 头携带；401 时展示粘贴令牌的输入框。
 */

const TOKEN_STORAGE_KEY = "ccp-ui-token";

export interface UiStatus {
  ok: boolean;
  version: string;
  host: string;
  port: number;
  prefix: string;
  upstreamType: "cliproxy" | "newapi";
  upstreamOnly: boolean;
  routing: string[];
}

export interface UiConfig {
  editable: {
    zcode: boolean;
    codebuddy: boolean;
    requestLogging: boolean;
    logDir: string;
    maxRequestLogs: number;
    maxGatewayLogBytes: number;
    selectedModels: string[];
  };
  /** 本机 provider 配置的存在性探测结果：决定对应开关是否显示。 */
  detected: {
    zcode: boolean;
    codebuddy: boolean;
  };
  readonly: {
    upstreamBaseUrl: string;
    upstreamType: string;
    upstreamOnly: boolean;
    /** 路由模式：由 upstreamOnly 取反导出（false -> dynamic），直接展示模式名而非布尔值。 */
    routerMode: "dynamic" | "upstream-only";
    host: string;
    port: number;
    mountPath: string;
    prefix: string;
    officialBaseUrl: string;
    catalogPath: string;
  };
  configVersion: string;
}

/** UI 表单提交子集：日志上限用数字 0 或带单位字符串，其余数值字段保持字符串。 */
export interface UiConfigChanges {
  zcode?: boolean;
  codebuddy?: boolean;
  requestLogging?: boolean;
  maxRequestLogs?: string;
  maxGatewayLogBytes?: 0 | string;
}

export interface RequestLogFile {
  name: string;
  size: number;
  mtimeMs: number;
  type: "http" | "ws";
}

/** 请求日志目录分页结果：total 为目录全部条数，供前端计算页数；
 * logging 标记请求日志是否开启（未开启时前端提示去配置页打开）。 */
export interface RequestLogPage {
  files: RequestLogFile[];
  total: number;
  offset: number;
  limit: number;
  logging: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function captureTokenFromUrl(): void {
  const token = new URLSearchParams(window.location.search).get("token");
  if (token) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    const clean = new URL(window.location.href);
    clean.searchParams.delete("token");
    window.history.replaceState(null, "", clean);
  }
}

export function uiToken(): string | null {
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setUiToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = uiToken();
  if (token) headers.set("x-ccp-ui-token", token);
  let body: BodyInit | undefined;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const response = await fetch(path, { ...init, headers, body });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json() as { error?: { message?: string } };
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      // 非 JSON 错误体按状态码展示。
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export const getUiStatus = (): Promise<UiStatus> => api<UiStatus>("/ui/api/status");
export const getUiConfig = (): Promise<UiConfig> => api<UiConfig>("/ui/api/config");
export const postUiConfig = (changes: UiConfigChanges): Promise<{ restarting: boolean }> =>
  api<{ restarting: boolean }>("/ui/api/config", { method: "POST", json: changes });

/** 上游模型条目：slug 是模型 ID，displayName 供列表展示。 */
export interface UpstreamModel {
  slug: string;
  displayName: string;
}

/** 拉取模型：从上游 /models 取完整目录，供勾选（不改变当前选择）。 */
export const fetchUpstreamModels = (): Promise<{ upstreamType: string; models: UpstreamModel[] }> =>
  api<{ upstreamType: string; models: UpstreamModel[] }>("/ui/api/upstream/models");

/** 保存模型选择：服务端重建目录文件并写入 selectedModels。 */
export const applyUpstreamModels = (selectedModels: string[]): Promise<{
  applied: string[];
  selected: string[];
  count: number;
  upstreamOnly: boolean;
}> => api("/ui/api/upstream/models", { method: "POST", json: { selectedModels } });

export interface CodexStopResult {
  pid: number;
  status: "stopped" | "surviving" | "failed";
}

/** 停止当前用户的 Codex app-server；Codex 重新拉起后加载新目录。 */
export const restartCodexAppServers = (): Promise<{ results: CodexStopResult[] }> =>
  api<{ results: CodexStopResult[] }>("/ui/api/codex/restart", { method: "POST" });
export const getGatewayLogTail = (): Promise<{ text: string; truncated: boolean }> =>
  api<{ text: string; truncated: boolean }>("/ui/api/logs/gateway");
export const listRequestLogs = (offset: number, limit: number): Promise<RequestLogPage> =>
  api<RequestLogPage>(`/ui/api/logs/requests?offset=${offset}&limit=${limit}`);
export const getRequestLog = (name: string): Promise<{ name: string; text: string; truncated: boolean }> =>
  api<{ name: string; text: string; truncated: boolean }>(
    `/ui/api/logs/requests/${encodeURIComponent(name)}`);
