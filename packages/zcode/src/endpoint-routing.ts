/** ZCode 端点动态重映射 — 复刻桌面客户端 3.7+ 的 ProviderEndpointRoutingService。 */
import { parseClientSigningCredential } from "./client-signing.ts";
import { ZcodeConfigError } from "./config.ts";
import { ZcodeCredentialError } from "./credential-cipher.ts";
import { buildZcodeSourceHeaders, type ZcodeIdentity } from "./request-context.ts";

const DEFAULT_ORIGIN = "https://zcode.z.ai";
const CONFIG_PATH = "/api/v1/agent/configs";
const SUCCESS_TTL_MS = 300_000;
const FAILURE_COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_MAPPING_ENTRIES = 256;

export interface ZcodeEndpointRoutingOptions {
  identity: ZcodeIdentity;
  origin?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  successTtlMs?: number;
  failureCooldownMs?: number;
  requestTimeoutMs?: number;
  /** 仅在受信任的同源 Ultra 映射命中时读取业务登录态。 */
  readZcodeJwt?: () => string | undefined | Promise<string | undefined>;
}

export interface RoutedUrl {
  routed: boolean;
  url: string;
  headers?: Record<string, string>;
}

interface RoutingSnapshot {
  expiresAt: number;
  mapping: Map<string, { url: string; includeZcodeAuthorization: boolean }>;
}

function isPrivateIPv4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return host === "0.0.0.0" || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0 || a >= 224;
}

function isPrivateIPv6(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80");
}

/** 重映射目标只允许官方域名的公网 https 地址；防 SSRF 与协议降级。 */
function assertRemapTarget(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const official = ["z.ai", "bigmodel.cn"].some((domain) => host === domain || host.endsWith(`.${domain}`));
  const local = host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".arpa");
  if (!official || local || isPrivateIPv4(host) || isPrivateIPv6(host)) {
    throw new Error(`重映射目标不是官方公网地址：${host}`);
  }
}

function normalizePath(pathname: string): string {
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/u, "") || "/";
}

function routingKey(url: URL): string {
  const port = url.port || "443";
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}${normalizePath(url.pathname)}`;
}

function parseMappingUrl(value: unknown, field: "from" | "to"): URL {
  if (typeof value !== "string") throw new Error(`mapping.${field} 必须是字符串`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`mapping.${field} 不是纯 https URL`);
  }
  if (field === "to") assertRemapTarget(parsed);
  return parsed;
}

export class ZcodeEndpointRouting {
  private readonly configUrl: string;
  private readonly identity: ZcodeIdentity;
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly successTtlMs: number;
  private readonly failureCooldownMs: number;
  private readonly requestTimeoutMs: number;
  private readonly readZcodeJwt: ZcodeEndpointRoutingOptions["readZcodeJwt"];
  private snapshot: RoutingSnapshot | undefined;
  private retryAfter = 0;
  private refreshPromise: Promise<void> | undefined;

  constructor(options: ZcodeEndpointRoutingOptions) {
    this.configUrl = `${(options.origin?.trim() || DEFAULT_ORIGIN).replace(/\/+$/u, "")}${CONFIG_PATH}`;
    this.identity = options.identity;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.successTtlMs = options.successTtlMs ?? SUCCESS_TTL_MS;
    this.failureCooldownMs = options.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.readZcodeJwt = options.readZcodeJwt;
  }

  hasSnapshot(): boolean {
    return this.snapshot !== undefined;
  }

  /** 目录刷新失败沿用原路由；已命中映射要求的本地鉴权失败必须明确上报。 */
  async resolve(url: string, credential?: string): Promise<RoutedUrl> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { routed: false, url };
    }
    try {
      await this.ensureFresh(credential);
    } catch {
      // fail-open：无快照或刷新失败都按原 URL 继续。
    }
    const target = this.snapshot?.mapping.get(routingKey(parsed));
    if (!target) return { routed: false, url };
    const rewritten = new URL(target.url);
    rewritten.search = parsed.search;
    let authorization: string | undefined;
    if (target.includeZcodeAuthorization) {
      try {
        const token = (await this.readZcodeJwt?.())?.trim();
        if (!token) throw new ZcodeConfigError("ZCode Ultra 中继缺少必需的业务 JWT；请在 ZCode 中重新登录并重启网关");
        authorization = /^Bearer\s/iu.test(token) ? token : `Bearer ${token}`;
      } catch (error) {
        if (error instanceof ZcodeConfigError) throw error;
        if (error instanceof ZcodeCredentialError) throw new ZcodeConfigError(error.message);
        throw new ZcodeConfigError("ZCode Ultra 中继业务 JWT 读取失败；请检查本地凭据与系统密钥后重启网关");
      }
    }
    return { routed: true, url: rewritten.href, ...(authorization ? { headers: { "X-ZCode-Authorization": authorization } } : {}) };
  }

  private async ensureFresh(credential?: string): Promise<void> {
    const now = this.now();
    if ((this.snapshot && this.snapshot.expiresAt > now) || this.retryAfter > now) return;
    const pending = this.refreshPromise ?? this.beginRefresh(credential);
    await pending;
  }

  private beginRefresh(credential?: string): Promise<void> {
    const promise = this.refresh(credential).finally(() => {
      if (this.refreshPromise === promise) this.refreshPromise = undefined;
    });
    this.refreshPromise = promise;
    return promise;
  }

  private async refresh(credential?: string): Promise<void> {
    // 3.18 的目录请求只带项目 Key ID，完整凭据仅供模型请求与签名握手使用。
    const headers = buildZcodeSourceHeaders(this.identity);
    headers.delete("x-zcode-agent");
    headers.set("accept", "application/json");
    const apiKeyId = credential ? parseClientSigningCredential(credential)?.apiKeyId : undefined;
    if (apiKeyId) headers.set("x-api-key-id", apiKeyId);
    try {
      const response = await this.fetchImpl(this.configUrl, {
        method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`agent_configs_http_${response.status}`);
      const parsed: unknown = await response.json();
      const envelope = parsed as { code?: unknown; data?: unknown } | null;
      if (!envelope || typeof envelope !== "object" || envelope.code !== 0) throw new Error("agent_configs_nonzero_code");
      const data = envelope.data as { proxyEndpoint?: { mapping?: unknown } } | undefined;
      const list = Array.isArray(data?.proxyEndpoint?.mapping) ? data!.proxyEndpoint!.mapping : [];
      if (list.length > MAX_MAPPING_ENTRIES) throw new Error("agent_configs_too_many_mappings");
      const mapping: RoutingSnapshot["mapping"] = new Map();
      for (const entry of list) {
        const raw = entry as { from?: unknown; to?: unknown; zcodeAuthorizationHeader?: unknown };
        const from = parseMappingUrl(raw.from, "from");
        const to = parseMappingUrl(raw.to, "to");
        if (raw.zcodeAuthorizationHeader !== undefined && typeof raw.zcodeAuthorizationHeader !== "string") {
          throw new Error("agent_configs_invalid_zcode_authorization_header");
        }
        const authorizationHeader = raw.zcodeAuthorizationHeader?.trim();
        const includeZcodeAuthorization = !!authorizationHeader;
        if (includeZcodeAuthorization && (authorizationHeader.toLowerCase() !== "x-zcode-authorization"
          || to.origin !== new URL(this.configUrl).origin
          || !["/api/v1/ultra", "/api/v1/ultra-zai"].some((prefix) => to.pathname === prefix || to.pathname.startsWith(`${prefix}/`)))) {
          throw new Error("agent_configs_unsafe_zcode_authorization_target");
        }
        const key = routingKey(from);
        if (mapping.has(key)) throw new Error("agent_configs_duplicate_from");
        mapping.set(key, { url: to.href, includeZcodeAuthorization });
      }
      this.snapshot = { expiresAt: this.now() + this.successTtlMs, mapping };
      this.retryAfter = 0;
    } catch {
      this.retryAfter = this.now() + this.failureCooldownMs;
    }
  }
}
