import { createHash } from "node:crypto";
import type { ZcodeFamily, ZcodeSelection } from "./config.ts";
import { decryptZcodeCredential } from "./credential-cipher.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const TEAM_API_KEY_NAME = "zcode-team-api-key";
const TEAM_API_KEY_TYPE = 2;

export interface ZcodeTeamCredentialInputs {
  accessToken: string;
  fingerprint: string;
}

export interface ZcodeTeamCredentialDependencies {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function invalid(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credentialValue(credentials: Record<string, unknown>, key: string, env: NodeJS.ProcessEnv): string {
  const value = credentials[key];
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return decryptZcodeCredential(value, env).trim();
  } catch {
    throw new Error("团队凭据解密失败");
  }
}

export function readZcodeTeamCredentialInputs(
  credentials: Record<string, unknown>,
  family: ZcodeFamily,
  env: NodeJS.ProcessEnv = process.env,
): ZcodeTeamCredentialInputs {
  const oauthProvider = family === "zai" ? "zai" : "zhipu";
  const accessToken = credentialValue(credentials, `oauth:${oauthProvider}:access_token`, env);
  if (!accessToken) invalid("团队套餐缺少 OAuth access token");
  const zcodeJwt = credentialValue(credentials, "zcodejwttoken", env);
  if (family === "bigmodel" && zcodeJwt && zcodeJwt === accessToken) {
    invalid("团队套餐 OAuth token 已过期");
  }
  return { accessToken, fingerprint: createHash("sha256").update(JSON.stringify(credentials)).digest("hex") };
}

function host(family: ZcodeFamily): string {
  return family === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
}

function teamHeaders(authorization: string, team?: { organizationId: string; projectId: string }): HeadersInit {
  const headers: Record<string, string> = { Authorization: authorization, "Content-Type": "application/json" };
  if (team) {
    headers["bigmodel-organization"] = team.organizationId;
    headers["bigmodel-project"] = team.projectId;
  }
  return headers;
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
    throw new Error("无法访问 ZCode 团队凭据接口");
  }
  if (!response.ok) throw new Error("ZCode 团队凭据接口请求失败");
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("ZCode 团队凭据接口响应无效"); }
  if (!isRecord(value)) throw new Error("ZCode 团队凭据接口响应无效");
  return value;
}

function responseData(envelope: Record<string, unknown>): unknown {
  const code = envelope.code;
  if (envelope.success === false || (typeof code === "number" && code !== 0 && code !== 200)) {
    throw new Error("ZCode 团队凭据接口返回业务错误");
  }
  if (envelope.success !== true && !Object.hasOwn(envelope, "data")) {
    throw new Error("ZCode 团队凭据接口响应缺少数据");
  }
  return envelope.data;
}

function confirmTeamProject(value: unknown, organizationId: string, projectId: string): void {
  const organizations = isRecord(value) && Array.isArray(value.organizations) ? value.organizations : [];
  const identifier = (item: unknown, field: string): string => {
    const value = isRecord(item) ? item[field] : undefined;
    return typeof value === "string" ? value.trim() : "";
  };
  const organization = organizations.find((item) => identifier(item, "organizationId") === organizationId);
  const projects = organization && isRecord(organization) && Array.isArray(organization.projects) ? organization.projects : [];
  if (!organization || !projects.some((item) => identifier(item, "projectId") === projectId)) {
    throw new Error("ZCode 团队组织或项目不存在");
  }
}

function usableApiKey(value: unknown): { apiKey: string } | undefined {
  if (!isRecord(value) || value.name !== TEAM_API_KEY_NAME || value.keyType !== TEAM_API_KEY_TYPE) return undefined;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  return apiKey ? { apiKey } : undefined;
}

/** 复刻 ZCode 3.12.3 的团队项目 Key 读取、缺失创建和 secret 复制流程。 */
export async function resolveZcodeTeamApiKey(
  selection: ZcodeSelection,
  inputs: ZcodeTeamCredentialInputs,
  dependencies: ZcodeTeamCredentialDependencies = {},
): Promise<string> {
  if (selection.kind !== "team-coding-plan" || !selection.team) invalid("团队套餐缺少项目上下文");
  const { team, family } = selection;
  const fetchImpl = dependencies.fetch ?? fetch;
  const apiHost = host(family);
  const customer = await requestJson(`${apiHost}/api/biz/customer/getCustomerInfo`, {
    headers: teamHeaders(inputs.accessToken), method: "GET",
  }, fetchImpl);
  confirmTeamProject(responseData(customer), team.organizationId, team.projectId);

  const keysUrl = `${apiHost}/api/biz/v1/organization/${encodeURIComponent(team.organizationId)}/projects/${encodeURIComponent(team.projectId)}/api_keys`;
  const list = await requestJson(keysUrl, {
    headers: teamHeaders(inputs.accessToken, team), method: "GET",
  }, fetchImpl);
  const existing = responseData(list);
  const matching = Array.isArray(existing) ? existing.find((item) => usableApiKey(item)) : undefined;
  const current = matching === undefined ? undefined : usableApiKey(matching);
  const key = current ?? usableApiKey(responseData(await requestJson(keysUrl, {
    body: JSON.stringify({ keyType: TEAM_API_KEY_TYPE, name: TEAM_API_KEY_NAME }),
    headers: teamHeaders(inputs.accessToken, team), method: "POST",
  }, fetchImpl)));
  if (!key) throw new Error("ZCode 团队项目 API Key 缺失");

  const copied = await requestJson(`${keysUrl}/copy/${encodeURIComponent(key.apiKey)}`, {
    headers: teamHeaders(inputs.accessToken, team), method: "GET",
  }, fetchImpl);
  const secret = responseData(copied);
  const secretKey = isRecord(secret) && typeof secret.secretKey === "string" ? secret.secretKey.trim() : "";
  return secretKey ? `${key.apiKey}.${secretKey}` : key.apiKey;
}
