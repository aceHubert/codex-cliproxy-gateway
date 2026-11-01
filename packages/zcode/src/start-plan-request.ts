/**
 * Start Plan（免费体验套餐）的请求形态与拒答分类。
 *
 * zcode.z.ai 的 zcode-plan 中继只服务「长得像官方 ZCode 客户端自己」的请求，
 * 其余一律 405 {"code":3012,"msg":"request has been blocked due to unusual
 * activity"}。2026-11-01 实测（见 docs/zcode-start-plan-research.md）：中继按
 * **当前客户端版本的 system 前缀文本**校验——ZCode 3.17.1 已改写 cli_prefix
 * （"You are ZCode, an interactive agent"）并重排段落结构，官方 3.17.1 形态
 * 实测 200，而 magpie v0.1.40 沿用的 3.14.3 文本实测 405。本模块按 3.17.1 的
 * `assembleSystemMessages` 结构重组（glm/zcode.cjs）：
 *
 * - system 恰好三段：第一段 cli_prefix（与 `agentSystemPrompt` 同一官方文本）
 *   **不带 cache_control**；第二段 stable（Agent Identity + Desktop Context，
 *   ephemeral）；第三段 "\n\n" + dynamic（Dynamic Behavior + Context
 *   Management + 网关旁白，ephemeral）。
 * - Environment / Model / Current Date 在 3.17.1 是 meta_user 附件：合并为首条
 *   user turn（cwd/git/shell 网关不可知，按官方宽容度省略）。
 * - `metadata.user_id` 携带本机设备 ID（telemetry-state.json）。
 * - 官方文本与其余指纹数据同源维护（`fingerprint-data.json` 的
 *   `startPlanPrompt` 与 `agentSystemPrompt`，各段 SHA-256 见测试）。
 */
import fingerprintData from "./fingerprint-data.json";
import { ZCODE_AGENT_SYSTEM_PROMPT } from "./request-context.ts";
import type { ZcodeIdentity, ZcodeRequestContext } from "./request-context.ts";
import type { ZcodeFamily } from "./config.ts";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

interface ZcodeStartPlanPrompt {
  identity: string;
  desktopContext: string;
  dynamicBehavior: string;
  contextManagement: string;
  environment: {
    heading: string;
    invokedLine: string;
    cwdLabel: string;
    gitLabel: string;
    platformLabel: string;
    shellLabel: string;
    osVersionLabel: string;
    untrustedNotice: string;
    poweredByTemplate: string;
    currentDateTemplate: string;
  };
}
const FINGERPRINT = fingerprintData as { startPlanPrompt: ZcodeStartPlanPrompt };
const PROMPT = FINGERPRINT.startPlanPrompt;

/** start-plan 请求的形态输入；identity 提供平台信息与设备 ID，context 提供会话归因。 */
export interface ZcodeStartPlanDressOptions {
  family: ZcodeFamily;
  upstreamModel: string;
  identity: ZcodeIdentity;
  context: ZcodeRequestContext;
  now?: () => Date;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function today(now: () => Date): string {
  const date = now();
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** 官方 meta_user 环境段：平台与系统版本来自网关指纹；cwd/git/shell 网关不可知，省略。 */
function environmentSection(family: ZcodeFamily, upstreamModel: string, identity: ZcodeIdentity): string {
  const texts = PROMPT.environment;
  const osVersion = `${identity.platform} ${identity.osVersion} ${identity.arch}`;
  const lines = [
    texts.heading,
    texts.invokedLine,
    // 官方 hSo 的条目行首带一个空格，逐字节保留。
    ` - ${texts.platformLabel}: ${identity.platform}`,
    ` - ${texts.osVersionLabel}: ${osVersion}`,
    ` - ${texts.untrustedNotice}`,
  ];
  return lines.join("\n");
}

/**
 * 官方 meta_user 首条 user turn：环境段、模型行与当日日期合并（3.17.1 的
 * env_info/model/current_date 附件公告形态）。
 */
function contextUserContent(options: ZcodeStartPlanDressOptions): string {
  const texts = PROMPT.environment;
  return [
    environmentSection(options.family, options.upstreamModel, options.identity),
    texts.poweredByTemplate.replace("{provider}", options.family === "bigmodel" ? "bigmodel-api" : "zai-api").replace("{model}", options.upstreamModel),
    texts.currentDateTemplate.replace("{date}", today(options.now ?? (() => new Date()))),
  ].join("\n\n");
}

export interface ZcodeStartPlanSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * 把请求转换层产出的单段 system（ZCode 官方提示词基底 + 网关旁白，见
 * request.ts）重整为官方 3.17.1 三段块：前两段为官方 stable 文本，第三段以
 * 官方 dynamic 区开头、现有 system 剥离基底句后的剩余（网关旁白）并入末尾。
 * 第一段即官方 cli_prefix——与 `agentSystemPrompt` 同一文本（zcode.cjs uBa），
 * 按 `assembleSystemMessages` 不带 cache_control。
 */
export function zcodeStartPlanSystemBlocks(options: Pick<ZcodeStartPlanDressOptions, "family" | "upstreamModel" | "identity">, system: string): ZcodeStartPlanSystemBlock[] {
  const own = system.startsWith(ZCODE_AGENT_SYSTEM_PROMPT)
    ? system.slice(ZCODE_AGENT_SYSTEM_PROMPT.length).replace(/^\n+/, "")
    : system;
  const dynamic = [PROMPT.dynamicBehavior, PROMPT.contextManagement];
  if (own.trim()) dynamic.push(own);
  return [
    { type: "text", text: ZCODE_AGENT_SYSTEM_PROMPT },
    { type: "text", text: [PROMPT.identity, PROMPT.desktopContext].join("\n\n"), cache_control: { type: "ephemeral" } },
    { type: "text", text: `\n\n${dynamic.join("\n\n")}`, cache_control: { type: "ephemeral" } },
  ];
}

/**
 * start-plan 请求的正文重整。入参为 `decorateZcodeBody` 的产物（消息级
 * cache_control 已收敛到末块），本函数只替换 system 为三段块、在消息首插入
 * 官方 meta_user 上下文 turn、补全 `metadata.user_id` 的设备 ID。
 */
export function dressZcodeStartPlanBody(body: Record<string, unknown>, options: ZcodeStartPlanDressOptions): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const metadata = record(body.metadata) ? { ...body.metadata } : {};
  metadata.user_id = JSON.stringify({
    ...(options.identity.deviceId ? { device_id: options.identity.deviceId } : {}),
    account_uuid: "",
    session_id: options.context.sessionId,
  });
  return {
    ...body,
    system: zcodeStartPlanSystemBlocks(options, typeof body.system === "string" ? body.system : ""),
    messages: [{ role: "user", content: [{ type: "text", text: contextUserContent(options) }] }, ...messages],
    metadata,
  };
}

/** start-plan 的中继不接受 query（官方客户端裸打 /v1/messages）；剥掉调用方附加的参数。 */
export function startPlanUpstreamUrl(url: string): string {
  const index = url.indexOf("?");
  return index < 0 ? url : url.slice(0, index);
}

const START_REFUSED = /unusual activity|request has been blocked|"code"\s*:\s*"?3012\b/i;
const EDGE_PAGE = /errors\.aliyun\.com|<html/i;

/**
 * start-plan 上游 4xx/5xx 的中文归因：阿里云边缘封锁页指向网络地址；405 或
 * 3012 语义是请求形态不像官方客户端或账号已被风控封禁（官方 App 同账号同样
 * 失败，只能联系 ZCode 支持解除）。其余错误返回 undefined，维持原有透传。
 */
export function zcodeStartPlanRefusalHint(status: number, text: string): string | undefined {
  if (status < 400) return undefined;
  if (EDGE_PAGE.test(text)) return "ZCode 边缘防火墙封锁了当前网络地址；请稍后重试，或更换网络/代理。";
  if (status === 405 || START_REFUSED.test(text)) {
    return "ZCode 风控拒绝了该 Start Plan 请求（code 3012）：请求形态不像官方客户端，或该账号已被封禁（官方 ZCode App 同账号也会失败，只能联系 ZCode 支持解除）。";
  }
  return undefined;
}

function requestHeadersOf(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value.replaceAll("\n", " ");
  });
  return headers;
}

/**
 * start-plan 专用的 HTTP 传输：`node:https` 恒走 HTTP/1.1。官方 ZCode 客户端
 * 跑在 Node 运行时（undici，HTTP/1.1），zcode-plan 中继按协议画像拒绝 Bun
 * fetch 的 HTTP/2 流量（2026-11-01 实测：同头同正文，HTTP/1.1 200、h2 405/3012，
 * 见 docs/zcode-start-plan-research.md）。响应以 Web Response 返回，SSE 流式
 * 语义与 fetch 一致；redirect 不跟随（等价 redirect: "manual"）。
 */
export function createStartPlanFetch(): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) => new Promise<Response>((resolve, reject) => {
    let request: http.ClientRequest | undefined;
    const abort = () => request?.destroy(new Error("ZCode 请求已取消"));
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) {
      reject(new Error("ZCode 请求已取消"));
      return;
    }
    try {
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error(`不支持的传输协议：${target.protocol}`);
      const transport = target.protocol === "https:" ? https : http;
      request = transport.request(target, { method: init.method ?? "GET", headers: requestHeadersOf(init) }, (incoming) => {
        init.signal?.removeEventListener("abort", abort);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          const values = Array.isArray(value) ? value : [value];
          for (const item of values) {
            if (item != null) headers.append(name, item);
          }
        }
        resolve(new Response(Readable.toWeb(incoming) as unknown as ReadableStream, {
          status: incoming.statusCode ?? 502,
          statusText: incoming.statusMessage ?? "",
          headers,
        }));
      });
      request.on("error", (error) => {
        init.signal?.removeEventListener("abort", abort);
        reject(init.signal?.aborted ? new Error("ZCode 请求已取消") : error);
      });
      request.end(init.body === undefined ? undefined : String(init.body));
    } catch (error) {
      init.signal?.removeEventListener("abort", abort);
      reject(error);
    }
  });
}
