import { createHash, randomUUID } from "node:crypto";
import type { QoderCredentials, QoderRegion } from "./credentials.ts";

export type { QoderRegion } from "./credentials.ts";

export interface QoderRegionProfile {
  region: QoderRegion;
  label: string;
  inferEndpoint: string;
}

/** 官方 CLI 的推理端点：国际版 api2.qoder.sh，国内版 gateway.qoder.com.cn。 */
export const QODER_REGIONS: Record<QoderRegion, QoderRegionProfile> = {
  intl: { region: "intl", label: "国际版", inferEndpoint: "https://api2.qoder.sh" },
  cn: { region: "cn", label: "国内版", inferEndpoint: "https://gateway.qoder.com.cn" },
};

export const QODER_INTL_INFER_ENDPOINT = QODER_REGIONS.intl.inferEndpoint;
export const QODER_CN_INFER_ENDPOINT = QODER_REGIONS.cn.inferEndpoint;
export const QODER_PROTOCOL_VERSION = "1.1.65";
const CATALOG_PATH = "/api/v2/model/list";
const INFER_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
const ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export class QoderTransportError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

function swapThirds(value: string): string {
  const length = Math.floor(value.length / 3);
  return value.slice(value.length - length) + value.slice(length, value.length - length) + value.slice(0, length);
}

/** Qoder Encode=1 的线格式；签名必须覆盖编码后的原始字符串。 */
export function encodeQoderBody(value: string): string {
  const standard = Buffer.from(value, "utf8").toString("base64");
  return swapThirds([...standard].map((char) => char === "=" ? "$" : ALPHABET[BASE64.indexOf(char)]).join(""));
}

export function decodeQoderBody(value: string): string {
  if (!value || /[\r\n]/.test(value)) throw new QoderTransportError("Qoder 返回了无效的编码数据");
  const standard = [...swapThirds(value)].map((char) => char === "$" ? "=" : BASE64[ALPHABET.indexOf(char)] ?? "?").join("");
  const bytes = Buffer.from(standard, "base64");
  const raw = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  if (encodeQoderBody(raw) !== value) throw new QoderTransportError("Qoder 返回了无效的编码数据");
  return raw;
}

export interface QoderInferPayload {
  body: Record<string, unknown>;
  modelKey: string;
  modelSource?: string;
  modelConfig?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
}

/** 凭据来源客户端对应的上游产品标识；实测算法网关两种标识均接受 COSY 签名。 */
const QODER_CLIENT_PROFILES: Record<QoderCredentials["clientProfile"], { product: string; clientType: string; sessionType: string }> = {
  cli: { product: "cli", clientType: "5", sessionType: "qodercli" },
  desktop: { product: "app", clientType: "10", sessionType: "app" },
};

export type QoderFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export interface QoderTransportOptions {
  fetch?: QoderFetch;
  /** 地域决定默认端点与错误文案。 */
  region?: QoderRegion;
  /** 仅供隔离测试注入；生产门面使用固定官方端点。 */
  inferEndpoint?: string;
  version?: string;
  now?: () => number;
  requestId?: () => string;
}

function signedHeaders(credential: QoderCredentials, path: string, body: string, version: string, now: number, requestId: string): Headers {
  const date = String(Math.floor(now / 1000));
  const profile = QODER_CLIENT_PROFILES[credential.clientProfile];
  const payload = Buffer.from(JSON.stringify({ version: "v1", requestId, info: credential.encryptUserInfo,
    cosyVersion: version, ideVersion: "" }), "utf8").toString("base64");
  const signature = createHash("md5").update([payload, credential.key, date, body, path].join("\n")).digest("hex");
  const headers = new Headers({
    Authorization: `Bearer COSY.${payload}.${signature}`,
    "Content-Type": "application/json", "Cosy-Business-Product": profile.product, "Cosy-Business-Type": "agent",
    "Cosy-ClientType": profile.clientType, "Cosy-Scene": "assistant", "Cosy-Version": version,
    "Cosy-Date": date, "Cosy-Key": credential.key, "Cosy-User": credential.accountUid,
    "Cosy-MachineId": credential.machineId, "Cosy-MachineToken": credential.machineId,
    "Cosy-MachineType": "5", "Cosy-Data-Policy": credential.dataPolicyAgreed ? "agree" : "disagree",
    "Login-Version": "v2",
  });
  if (credential.organizationId) headers.set("Cosy-Organization-Id", credential.organizationId);
  if (credential.organizationTags.length) headers.set("Cosy-Organization-Tags", credential.organizationTags.join(","));
  return headers;
}

function inferBody(payload: QoderInferPayload, version: string, now: number, profile: QoderCredentials["clientProfile"]): string {
  const requestId = payload.requestId ?? randomUUID();
  const identity = QODER_CLIENT_PROFILES[profile];
  return JSON.stringify({
    ...payload.body,
    business: { product: identity.product, version, type: "agent", id: randomUUID(), name: "gateway", begin_at: now, stage: "start" },
    request_id: requestId, request_set_id: requestId, chat_record_id: requestId,
    session_id: payload.sessionId ?? randomUUID(), stream: true, chat_task: "FREE_INPUT", chat_context: {},
    is_reply: true, is_retry: false, source: 1, version: "3", agent_id: "agent_common", task_id: "common",
    session_type: identity.sessionType, aliyun_user_type: "", custom_model: null,
    model_config: { ...(payload.modelConfig ?? {}), key: payload.modelKey, source: payload.modelSource ?? "system" },
  });
}

async function checkedResponse(response: Response, label: string): Promise<Response> {
  if (response.ok) return response;
  // 上游错误正文可能含认证信息或请求回显，既不日志也不透传。
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) {
    throw new QoderTransportError(`Qoder ${label}授权不可用（HTTP ${response.status}）；请运行 qoder login 更新登录，网关不会刷新或写回 CLI 凭据。`, response.status);
  }
  throw new QoderTransportError(`Qoder ${label}请求失败（HTTP ${response.status}）；请检查账号模型权限及网络后重试。`, response.status);
}

async function request(fetcher: QoderFetch, url: string, options: RequestInit, label: string): Promise<Response> {
  try { return await checkedResponse(await fetcher(url, options), label); }
  catch (error) {
    if (error instanceof QoderTransportError) throw error;
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("请求已取消", "AbortError");
    throw new QoderTransportError(`Qoder ${label}网络请求失败；请检查网络连接后重试。`);
  }
}

export function createQoderTransport(options: QoderTransportOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const profile = QODER_REGIONS[options.region ?? "intl"];
  const endpoint = (options.inferEndpoint ?? profile.inferEndpoint).replace(/\/$/, "");
  const version = options.version ?? QODER_PROTOCOL_VERSION;
  const now = options.now ?? Date.now;
  const requestId = options.requestId ?? randomUUID;
  return {
    async fetchCatalog(credential: QoderCredentials, signal?: AbortSignal): Promise<unknown> {
      const headers = signedHeaders(credential, CATALOG_PATH, "", version, now(), requestId());
      headers.set("Accept", "application/json");
      const response = await request(fetcher, `${endpoint}/algo${CATALOG_PATH}?Encode=1`, {
        method: "GET", headers, redirect: "error", signal,
      }, profile.label);
      const raw = await response.text();
      try { return JSON.parse(raw); }
      catch {
        try { return JSON.parse(decodeQoderBody(raw)); }
        catch { throw new QoderTransportError(`Qoder ${profile.label}模型目录格式无效；请更新 Qoder CLI 后重试。`); }
      }
    },
    async infer(credential: QoderCredentials, payload: QoderInferPayload, signal?: AbortSignal): Promise<Response> {
      const time = now();
      const body = encodeQoderBody(inferBody(payload, version, time, credential.clientProfile));
      const headers = signedHeaders(credential, INFER_PATH, body, version, time, requestId());
      headers.set("Accept", "text/event-stream");
      headers.set("Cache-Control", "no-cache");
      headers.set("X-Model-Key", payload.modelKey);
      headers.set("X-Model-Source", payload.modelSource ?? "system");
      return request(fetcher, `${endpoint}/algo${INFER_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`, {
        method: "POST", headers, body, redirect: "error", signal,
      }, profile.label);
    },
  };
}
