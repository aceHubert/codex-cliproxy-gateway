import { createHash } from "node:crypto";
import type { ZcodeFamily } from "./config.ts";
import { decryptZcodeCredential } from "./credential-cipher.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const LOCATION_PREFIX = "project-key-location:v1:";
/** 指针元数据里 Coding Plan 场景的固定序号（客户端 di.CODING_PLAN）。 */
const CODING_PLAN_SCENE = 1;
const NON_TEAM_SELECTION = "non-team";
const API_KEY_TYPE = 2;

/** 项目令牌签发失败；消息面向用户，可直接透传为配置错误。 */
export class ZcodeProjectTokenError extends Error {}

export interface ZcodeIndividualProjectLocation {
  organizationId: string;
  projectId: string;
  apiKeyId: string;
}

export interface ZcodeIndividualTokenInputs {
  accessToken: string;
  identity: string;
  fingerprint: string;
}

export interface ZcodeIndividualTokenDependencies {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  now?: () => number;
}

export interface ZcodeIndividualApiKey {
  apiKey: string;
  expiresAt: number;
}

function invalid(message: string): never {
  throw new ZcodeProjectTokenError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function host(family: ZcodeFamily): string {
  return family === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
}

/**
 * ZCode 3.16 起个人套餐业务 Key 不再落盘，credentials.json 只保留指向
 * `organization/project/apiKey` 的指针（按账号隔离）。这里按当前账号身份与
 * 渠道解析同账号、非团队、Coding Plan 场景的指针；无法解密或形状不符按缺失
 * 处理，交给发现流程重建，与官方客户端的可恢复语义一致。
 */
export function readZcodeIndividualProjectLocation(
  credentials: Record<string, unknown>,
  family: ZcodeFamily,
  identity: string,
  env: NodeJS.ProcessEnv = process.env,
): ZcodeIndividualProjectLocation | undefined {
  if (!identity) return undefined;
  const expected = host(family);
  for (const key of Object.keys(credentials)) {
    if (!key.startsWith(LOCATION_PREFIX)) continue;
    let meta: unknown;
    try { meta = JSON.parse(decodeURIComponent(key.slice(LOCATION_PREFIX.length))); }
    catch { continue; }
    if (!Array.isArray(meta) || meta.length !== 6) continue;
    const [origin, metaFamily, accountId, team, scene, selection] = meta;
    if (origin !== expected || metaFamily !== family || accountId !== identity) continue;
    if (team !== null || scene !== CODING_PLAN_SCENE || selection !== NON_TEAM_SELECTION) continue;
    const value = credentials[key];
    if (typeof value !== "string" || !value.trim()) continue;
    let decoded: unknown;
    try { decoded = JSON.parse(decryptZcodeCredential(value, env)); }
    catch { continue; }
    if (!isRecord(decoded)) continue;
    const organizationId = typeof decoded.organizationId === "string" ? decoded.organizationId.trim() : "";
    const projectId = typeof decoded.projectId === "string" ? decoded.projectId.trim() : "";
    const apiKeyId = typeof decoded.apiKeyId === "string" ? decoded.apiKeyId.trim() : "";
    if (organizationId && projectId && apiKeyId) return { organizationId, projectId, apiKeyId };
  }
  return undefined;
}

/** 令牌签发输入的指纹：OAuth、账号身份或指针任一变化都需要重新签发。 */
export function zcodeIndividualTokenFingerprint(
  accessToken: string,
  identity: string,
  location: ZcodeIndividualProjectLocation | undefined,
): string {
  return createHash("sha256").update(JSON.stringify([accessToken, identity, location ?? null])).digest("hex");
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error("无法访问 ZCode 个人套餐令牌接口");
  }
  if (!response.ok) throw new Error("ZCode 个人套餐令牌接口请求失败");
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error("ZCode 个人套餐令牌接口响应无效"); }
  if (!isRecord(value)) throw new Error("ZCode 个人套餐令牌接口响应无效");
  return value;
}

function envelopeCode(envelope: Record<string, unknown>): number | undefined {
  const code = envelope.code;
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

function responseData(envelope: Record<string, unknown>): unknown {
  const code = envelopeCode(envelope);
  if (envelope.success === false || (code !== undefined && code !== 0 && code !== 200)) {
    const message = typeof envelope.msg === "string" && envelope.msg.trim() ? `：${envelope.msg.trim().slice(0, 120)}` : "";
    throw new ZcodeProjectTokenError(`ZCode 个人套餐令牌接口返回业务错误（code ${code ?? "unknown"}）${message}`);
  }
  if (envelope.success !== true && !Object.hasOwn(envelope, "data")) {
    throw new Error("ZCode 个人套餐令牌接口响应缺少数据");
  }
  return envelope.data;
}

async function mintProjectToken(
  family: ZcodeFamily,
  inputs: ZcodeIndividualTokenInputs,
  location: ZcodeIndividualProjectLocation,
  dependencies: ZcodeIndividualTokenDependencies,
): Promise<ZcodeIndividualApiKey> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const url = `${host(family)}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}`
    + `/projects/${encodeURIComponent(location.projectId)}`
    + `/api_keys/${encodeURIComponent(location.apiKeyId)}/access_tokens`;
  const envelope = await requestJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${inputs.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientType: "zcode", clientVersion: dependencies.clientVersion ?? "unknown" }),
  }, fetchImpl);
  if (envelopeCode(envelope) === 404) invalid("ZCODE_PROJECT_KEY_UNAVAILABLE");
  const data = responseData(envelope);
  // 与官方客户端一致：data 缺省 enable 字段时按已启用处理，显式 false 才是停用。
  if (!isRecord(data) || data.enable === false) throw new Error("ZCode 个人套餐项目令牌未启用");
  const token = typeof data.accessToken === "string" ? data.accessToken.trim() : "";
  if (!token) throw new Error("ZCode 个人套餐项目令牌响应缺少 accessToken");
  const nowMs = now();
  const relative = typeof data.expiresIn === "number" && Number.isFinite(data.expiresIn) && data.expiresIn > 0
    ? nowMs + data.expiresIn * 1000 : undefined;
  const absolute = typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) ? data.expiresAt * 1000 : undefined;
  const expiresAt = [relative, absolute].filter((value): value is number => value !== undefined)
    .reduce((left, right) => Math.min(left, right), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) throw new Error("ZCode 个人套餐项目令牌过期时间无效");
  return { apiKey: token, expiresAt };
}

async function discoverProjectLocation(
  family: ZcodeFamily,
  accessToken: string,
  dependencies: ZcodeIndividualTokenDependencies,
): Promise<ZcodeIndividualProjectLocation> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const apiHost = host(family);
  const customer = await requestJson(`${apiHost}/api/biz/customer/getCustomerInfo`, {
    method: "GET",
    headers: { Authorization: accessToken, "Content-Type": "application/json" },
  }, fetchImpl);
  const data = responseData(customer);
  const organizations = isRecord(data) && Array.isArray(data.organizations) ? data.organizations : [];
  const projectIdOf = (item: unknown): string =>
    isRecord(item) && typeof item.projectId === "string" ? item.projectId.trim() : "";
  // 个人（非团队）场景：与客户端一致取默认机构下第一个业务类型项目，无类型标注时取首个项目。
  const project = organizations.flatMap((organization): { organizationId: string; projectId: string }[] => {
    if (!isRecord(organization)) return [];
    const organizationId = typeof organization.organizationId === "string" ? organization.organizationId.trim() : "";
    const projects = Array.isArray(organization.projects) ? organization.projects.filter(isRecord) : [];
    const selected = projects.find((item) => projectIdOf(item) && String(item.projectType ?? "").trim())
      ?? projects.find((item) => projectIdOf(item));
    const projectId = selected ? projectIdOf(selected) : "";
    return organizationId && projectId ? [{ organizationId, projectId }] : [];
  })[0];
  if (!project) invalid("ZCode 个人套餐缺少可用的默认项目；请在 ZCode 中打开一次个人套餐");
  const list = await requestJson(`${apiHost}/api/biz/v1/organization/${encodeURIComponent(project.organizationId)}`
    + `/projects/${encodeURIComponent(project.projectId)}/api_keys`, {
    method: "GET",
    headers: { Authorization: accessToken, "Content-Type": "application/json" },
  }, fetchImpl);
  const keys = responseData(list);
  const entries = Array.isArray(keys) ? keys.filter(isRecord) : [];
  const keyEntry = entries.find((item) => item.keyType === API_KEY_TYPE
    && typeof item.apiKey === "string" && item.apiKey.trim());
  const apiKeyId = typeof keyEntry?.apiKey === "string" ? keyEntry.apiKey.trim() : "";
  if (!apiKeyId) invalid("ZCode 个人套餐项目缺少可用的 API Key；请在 ZCode 中打开一次个人套餐重建");
  return { ...project, apiKeyId };
}

/**
 * 复刻 ZCode 3.16 客户端的个人套餐项目令牌签发：优先按 credentials.json 的
 * 指针签发短时令牌；指针缺失或失效（404）时经 getCustomerInfo → 项目 API Key
 * 列表发现兜底。签发全程不落盘，结果由调用方缓存并按过期时间重签。
 */
export async function resolveZcodeIndividualApiKey(
  family: ZcodeFamily,
  inputs: ZcodeIndividualTokenInputs,
  location: ZcodeIndividualProjectLocation | undefined,
  dependencies: ZcodeIndividualTokenDependencies = {},
): Promise<ZcodeIndividualApiKey> {
  if (location) {
    try {
      return await mintProjectToken(family, inputs, location, dependencies);
    } catch (error) {
      if (error instanceof ZcodeProjectTokenError && error.message === "ZCODE_PROJECT_KEY_UNAVAILABLE") {
        // 指针已失效（服务端 404）：与客户端一致转入发现流程重建。
      } else {
        throw error;
      }
    }
  }
  const discovered = await discoverProjectLocation(family, inputs.accessToken, dependencies);
  return mintProjectToken(family, inputs, discovered, dependencies);
}
