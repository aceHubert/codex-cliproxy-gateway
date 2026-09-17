import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { stopCodexAppServers } from "./app-server.ts";
import { invalidateModelsCache } from "./catalog.ts";
import { GATEWAY_CONFIG_VERSION } from "./config.ts";
import {
  applySelectedModelsPatch,
  applyWebUiConfigPatch,
  markPendingRestart,
  parseSelectedModels,
  readGatewayConfigFile,
  sanitizeUrlValue,
} from "./config-update.ts";
import { restartLaunchAgent } from "./launchd.ts";
import { realPathOrResolve, resolvePaths } from "./paths.ts";
import { isRequestLogName, safeLogPath } from "./request-log.ts";
import { atomicWrite } from "./toml.ts";
import {
  configuredUpstreamType,
  fetchConfiguredUpstreamCatalog,
  rebuildCatalog,
} from "./upstream-catalog.ts";
import type { GatewayConfig, ResolvedPaths } from "./types.ts";

/**
 * Web UI（/ui）服务端：网关的内建基础能力，运行在独立进程、独立端口（网关端口 + 1，
 * 见 webUiPort）：默认不启动，由 `codex-cliproxy web` 前台运行，或由 `web --daemon`
 * 拉起后台服务。与模型流量结构性隔离——模型端口的请求日志只含
 * 模型流量；UI 进程唯一的外呼是「拉取模型」的固定只读 GET {upstreamBaseUrl}/models
 * 与据此重建已选目录文件（经 keychain 分派取 key），不存在任意转发路径，也绝不把
 * key、URL query 写进日志或响应。
 *
 * 安全边界（缺一不可）：
 * - 独立端口只绑定 loopback；网关 host 非 loopback 时不启动 UI 服务；
 * - Host 头白名单（127.0.0.1/localhost/[::1] + UI 端口），挡 DNS rebinding；
 * - Origin 头存在且非同源即拒绝；不输出任何 CORS 头；
 * - /ui/api/* 一律要求 x-ccp-ui-token 匹配 ~/.codex-cliproxy-gateway/ui-token（0600）。
 */

const GATEWAY_LOG_TAIL_BYTES = 256 * 1024;
const REQUEST_LOG_TAIL_BYTES = 64 * 1024;
/** 请求日志目录分页：默认每页条数与上限；目录可能积累大量文件，绝不整表返回。 */
const REQUEST_LOG_DEFAULT_PAGE_SIZE = 100;
const REQUEST_LOG_MAX_PAGE_SIZE = 500;
/** 响应返回后再 kickstart，避免响应流被 SIGTERM 截断。 */
const RESTART_DELAY_MS = 400;
const UI_HTML_PATH = path.resolve(import.meta.dir, "../dist/ui/index.html");

export interface WebUiContext {
  paths: ResolvedPaths;
  /** 测试注入的 HTML 文件；生产环境固定读取 dist/ui/index.html。 */
  uiHtmlPath?: string;
  /**
   * 临时实例（`serve --config` 非默认配置）：只编辑该配置文件本身，不写默认安装的
   * state，也绝不重启 LaunchAgent——即使派生路径恰好命中默认服务也必须拒绝管理。
   */
  instanceOnly?: boolean;
  /** 测试注入用的重启调度；缺省在 RESTART_DELAY_MS 后 kickstart LaunchAgent。 */
  scheduleRestart?: (paths: ResolvedPaths) => void;
  /**
   * 模型选择功能的测试注入点：上游 key 读取与「停止 Codex app-server」。
   * 缺省分别走 keychain 分派的 readApiKey 与 stopCodexAppServers。
   */
  upstreamDeps?: {
    readKey?: (optional?: boolean) => string;
    stopCodexServers?: typeof stopCodexAppServers;
  };
}

/**
 * `serve` 的 Web UI 管理上下文：默认配置对应的生产实例全量管理；临时实例保留
 * **完整配置文件路径**（不回落到目录下的 config.json，否则默认运行目录里的
 * test.json 会改写生产配置），其余管理面文件按配置所在目录派生，并以
 * instanceOnly 显式禁止管理默认服务（$HOME 下的配置派生的 LaunchAgent 路径
 * 曾经恰好命中默认服务）。
 */
export function webUiContextForInstance(configPath: string, defaultPaths: ResolvedPaths): WebUiContext {
  // 真实路径比较：文件/目录符号链接指向默认 config.json 时必须判为生产实例，
  // 否则写入会落到默认安装却被当成临时实例。
  const resolved = realPathOrResolve(configPath);
  if (resolved === realPathOrResolve(defaultPaths.gatewayConfig)) return { paths: defaultPaths };
  return {
    paths: { ...resolvePaths(process.env, path.dirname(resolved)), gatewayConfig: resolved },
    instanceOnly: true,
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** 读取（缺失时生成）Web UI 访问令牌；文件 0600，仅随 `codex-cliproxy web` 输出。 */
export function ensureUiToken(file: string): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // 文件缺失时落到生成路径。
  }
  const token = `ccp_${randomBytes(24).toString("hex")}`;
  atomicWrite(file, `${token}\n`);
  return token;
}

function readUiToken(file: string): string | null {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function notFound(): Response {
  return Response.json({ error: { message: "Not found" } }, { status: 404 });
}

function badRequest(message: string): Response {
  return Response.json({ error: { message } }, { status: 400 });
}

/** 末尾窗口只含一条超长行时向后扩窗的上限；再长则退回半行，避免读爆内存。 */
const TAIL_EXPAND_CAP_BYTES = 1024 * 1024;

/**
 * 读取文件末尾 maxBytes；截断时丢弃首行不完整内容，保证从整行开始。
 * 末行本身超过窗口时会翻倍扩窗，直到拿到至少一条有实质内容的完整行——
 * 否则 `slice(firstNewline + 1)` 会在「窗口内唯一的 \\n 是超长行行尾」时
 * 切出空串，或只切出 SSE 帧尾的空白行（`text: "\\n\\n\\n\\n\\n"`）。
 */
function tailFile(file: string, maxBytes: number): { text: string; truncated: boolean } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  try {
    if (stat.size <= maxBytes) {
      return { text: fs.readFileSync(file, "utf8"), truncated: false };
    }
    const fd = fs.openSync(file, "r");
    try {
      let window = maxBytes;
      for (;;) {
        const start = Math.max(0, stat.size - window);
        const length = stat.size - start;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        const text = buffer.toString("utf8");
        const firstNewline = text.indexOf("\n");
        if (start === 0) {
          return { text, truncated: false };
        }
        if (firstNewline >= 0) {
          const rest = text.slice(firstNewline + 1);
          // rest 可能只有帧分隔换行；trim 后为空说明本窗口没有可用正文，继续扩窗。
          if (rest.trim() !== "") return { text: rest, truncated: true };
        }
        if (window >= Math.min(stat.size, TAIL_EXPAND_CAP_BYTES)) {
          if (firstNewline >= 0) {
            const rest = text.slice(firstNewline + 1);
            // 顶到扩窗上限仍只有空白时，退回超长行本身，避免预览变成空行。
            return { text: rest.trim() !== "" ? rest : text.slice(0, firstNewline), truncated: true };
          }
          return { text, truncated: true };
        }
        window = Math.min(stat.size, window * 2);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function requestLogDir(config: GatewayConfig): string {
  return config.logDir || path.join(path.dirname(config.catalogPath), "logs");
}

function defaultScheduleRestart(paths: ResolvedPaths): void {
  setTimeout(() => {
    try {
      restartLaunchAgent(paths.launchAgent);
    } catch {
      // kickstart 失败时 pendingRestart 仍置位，下一次 CLI 命令会补重启。
    }
  }, RESTART_DELAY_MS);
}

function allowedHosts(port: number): string[] {
  return ["127.0.0.1", "localhost", "[::1]"].map((host) => `${host}:${port}`);
}

/**
 * Web UI 的独立监听端口：模型网关端口 + 1。UI 与模型流量物理隔离——UI 处理器没有
 * 上游 URL、API key 与转发路径，结构上不可能把请求发给上游；模型端口的请求日志
 * 也因此只包含模型流量。
 */
export function webUiPort(config: GatewayConfig): number {
  return config.port + 1;
}

/**
 * 在独立端口上启动 Web UI 服务：只绑定 loopback，fetch 直接进入 handleWebUiRequest，
 * 不经过模型网关的任何路由、转发与日志包装。端口被占用时由 Bun.serve 抛错，
 * 调用方决定降级行为；网关 host 非 loopback 时返回 undefined（不提供远程面板）。
 *
 * 默认不随 `serve` 启动：由 `codex-cliproxy web`（包括其后台服务模式）调用。
 * 每个请求都从盘上重读配置（读失败回落启动快照），CLI 侧的 config 写入无需重启本进程。
 */
export function startWebUiServer(config: GatewayConfig, ctx: WebUiContext): Bun.Server<undefined> | undefined {
  if (!isLoopbackHost(config.host)) return undefined;
  const port = webUiPort(config);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => {
      let live = config;
      try {
        live = readGatewayConfigFile(ctx.paths.gatewayConfig);
      } catch {
        // 配置暂时不可读（重启窗口等）时用启动快照继续服务。
      }
      return handleWebUiRequest(request, live, ctx, port);
    },
  });
}

function uiHtmlResponse(ctx: WebUiContext): Response {
  const uiHtmlPath = ctx.uiHtmlPath ?? UI_HTML_PATH;
  let html: string;
  try {
    html = fs.readFileSync(uiHtmlPath, "utf8");
  } catch {
    return Response.json({
      error: {
        message: `Web UI asset is unavailable at ${uiHtmlPath}`,
        hint: "Run `bun run build:ui` or reinstall the package.",
      },
    }, { status: 500 });
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // 单文件内联应用：script/style 必须开 unsafe-inline；connect 只允许同源 API；
      // img-src 'self' 放行浏览器随页面自动请求的同源 /favicon.ico。
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** 内联 SVG 站点图标：深色圆角底 + 主题绿的转发箭标，配色与 UI 一致。 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
  + `<rect width="64" height="64" rx="14" fill="#111419"/>`
  + `<path d="M15 21l11 11-11 11" fill="none" stroke="#10b981" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`
  + `<path d="M35 21l11 11-11 11" fill="none" stroke="#10b981" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`
  + `</svg>`;

function faviconResponse(): Response {
  return new Response(FAVICON_SVG, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function statusResponse(config: GatewayConfig): Response {
  const upstreamOnly = config.upstreamOnly === true;
  // URL query 可能携带 token：对外展示与审计同规则，只保留 origin 与路径。
  const upstreamBase = sanitizeUrlValue(config.upstreamBaseUrl);
  const officialBase = sanitizeUrlValue(config.officialBaseUrl);
  return Response.json({
    ok: true,
    version: GATEWAY_CONFIG_VERSION,
    host: config.host,
    port: config.port,
    prefix: config.prefix || "cliproxy/",
    upstreamType: config.upstreamType === "newapi" ? "newapi" : "cliproxy",
    upstreamOnly,
    routing: upstreamOnly
      ? [`all models -> ${upstreamBase}`]
      : [
        `native models -> ${officialBase}`,
        `${config.prefix || "cliproxy/"}* -> ${upstreamBase}`,
      ],
  });
}

function configResponse(paths: ResolvedPaths): Response {
  const live = readGatewayConfigFile(paths.gatewayConfig);
  return Response.json({
    editable: {
      zcode: live.zcode === true,
      requestLogging: live.requestLogging === true,
      logDir: live.logDir || path.join(path.dirname(live.catalogPath), "logs"),
      maxRequestLogs: live.maxRequestLogs ?? 0,
      maxGatewayLogBytes: live.maxGatewayLogBytes ?? 0,
      selectedModels: Array.isArray(live.selectedModels) ? live.selectedModels : [],
    },
    readonly: {
      upstreamBaseUrl: sanitizeUrlValue(live.upstreamBaseUrl),
      upstreamType: live.upstreamType === "newapi" ? "newapi" : "cliproxy",
      upstreamOnly: live.upstreamOnly === true,
      host: live.host,
      port: live.port,
      mountPath: live.mountPath,
      prefix: live.prefix,
      officialBaseUrl: sanitizeUrlValue(live.officialBaseUrl),
      catalogPath: live.catalogPath,
    },
    configVersion: live.configVersion ?? GATEWAY_CONFIG_VERSION,
  });
}

/**
 * 上游拉取错误对外展示前的脱敏：配置的 upstreamBaseUrl 与拼出的 /models URL 的 query
 * 都可能携带 token，消息里出现的任何绝对 URL 一律按 sanitizeUrlValue 折叠为 origin+路径。
 */
function sanitizeUpstreamMessage(config: GatewayConfig, message: string): string {
  let text = message;
  if (config.upstreamBaseUrl) {
    text = text.split(config.upstreamBaseUrl).join(String(sanitizeUrlValue(config.upstreamBaseUrl)));
  }
  return text.replace(/https?:\/\/[!-~]+/g, (raw) => {
    const url = raw.replace(/[.,;:!?)\]}'">]+$/, "");
    return `${sanitizeUrlValue(url)}${raw.slice(url.length)}`;
  });
}

function upstreamFailure(config: GatewayConfig, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: { message: sanitizeUpstreamMessage(config, message) } }, { status: 502 });
}

function gatewayLogResponse(paths: ResolvedPaths): Response {
  const tail = tailFile(paths.stdoutLog, GATEWAY_LOG_TAIL_BYTES);
  return Response.json(tail ?? { text: "", truncated: false });
}

/** 请求日志目录：mtime 倒序（最新在前）+ 分页（offset/limit），返回 total 供前端算页数。
 * requestLogging 关闭时不列目录（前端只显示「未开启」提示）——历史文件不再被浏览，
 * 避免给出「日志还在记录」的误导。 */
function requestLogsResponse(config: GatewayConfig, url: URL): Response {
  const logging = config.requestLogging === true;
  const empty = Response.json({
    files: [],
    total: 0,
    offset: 0,
    limit: REQUEST_LOG_DEFAULT_PAGE_SIZE,
    logging,
  });
  if (!logging) return empty;
  const dir = requestLogDir(config);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return Response.json({ files: [], total: 0, offset: 0, limit: REQUEST_LOG_DEFAULT_PAGE_SIZE, logging });
  }
  const all = names
    .filter((name) => isRequestLogName(name))
    .flatMap((name) => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return [{
          name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          type: name.includes("-ws-") ? "ws" as const : "http" as const,
        }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const limitParam = Number(url.searchParams.get("limit"));
  const offsetParam = Number(url.searchParams.get("offset"));
  const limit = Number.isInteger(limitParam) && limitParam > 0
    ? Math.min(limitParam, REQUEST_LOG_MAX_PAGE_SIZE)
    : REQUEST_LOG_DEFAULT_PAGE_SIZE;
  const offset = Number.isInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;
  return Response.json({
    files: all.slice(offset, offset + limit),
    total: all.length,
    offset,
    limit,
    logging,
  });
}

function requestLogContentResponse(config: GatewayConfig, name: string): Response {
  if (!name || !isRequestLogName(name)) return notFound();
  const target = safeLogPath(requestLogDir(config), name);
  if (!target) return badRequest("Invalid log file name");
  const tail = tailFile(target, REQUEST_LOG_TAIL_BYTES);
  if (!tail) return notFound();
  return Response.json({ name, text: tail.text, truncated: tail.truncated });
}

/** 处理 UI 端口上的 /ui、/ui/* 与浏览器随 /ui 自动请求的 /favicon.ico；port 是 UI
 * 服务自己的监听端口（Host 头白名单按它校验）。任何情况下都返回 Response。 */
export async function handleWebUiRequest(request: Request, config: GatewayConfig, ctx: WebUiContext, port: number): Promise<Response> {
  // 网关被配置到非回环地址时不提供 UI——它是本机管理入口，不是远程面板。
  if (!isLoopbackHost(config.host)) return notFound();
  // HTTP/1.1 必带 Host；直接构造 Request 调用 handler（测试）时缺失，回退用 URL host。
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  if (!allowedHosts(port).includes(host)) return notFound();
  const origin = request.headers.get("origin");
  if (origin && origin.toLowerCase() !== `http://${host}`) return notFound();

  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && (pathname === "/ui" || pathname === "/ui/")) {
    return uiHtmlResponse(ctx);
  }
  // 浏览器打开 /ui 时会自动请求站点图标：就地返回内联 SVG，绝不转发上游。
  if (request.method === "GET" && pathname === "/favicon.ico") return faviconResponse();
  if (!pathname.startsWith("/ui/api/")) return notFound();

  const token = readUiToken(ctx.paths.uiTokenFile) ?? ensureUiToken(ctx.paths.uiTokenFile);
  if (request.headers.get("x-ccp-ui-token") !== token) {
    return Response.json({ error: { message: "Web UI token required" } }, { status: 401 });
  }
  const route = pathname.slice("/ui/api/".length);

  if (route === "status" && request.method === "GET") return statusResponse(config);

  if (route === "config" && request.method === "GET") {
    try {
      return configResponse(ctx.paths);
    } catch (error) {
      return Response.json(
        { error: { message: error instanceof Error ? error.message : String(error) } },
        { status: 404 },
      );
    }
  }

  if (route === "config" && request.method === "POST") {
    let patch: unknown;
    try {
      patch = await request.json();
    } catch {
      return badRequest("Request body must be JSON");
    }
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return badRequest("Request body must be a JSON object");
    }
    try {
      const managesService = ctx.instanceOnly !== true;
      const { applied } = applyWebUiConfigPatch(ctx.paths, patch as Record<string, unknown>, managesService);
      const restarting = managesService && fs.existsSync(ctx.paths.launchAgent);
      if (restarting) {
        markPendingRestart(ctx.paths.stateFile);
        (ctx.scheduleRestart ?? defaultScheduleRestart)(ctx.paths);
      }
      return Response.json({ restarting, applied: applied.map((change) => change.field) });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : String(error));
    }
  }

  if (route === "upstream/models" && request.method === "GET") {
    try {
      const { catalog } = await fetchConfiguredUpstreamCatalog(ctx.paths, config, ctx.upstreamDeps);
      return Response.json({
        upstreamType: configuredUpstreamType(config),
        models: catalog.models.map((model) => ({
          slug: model.slug,
          displayName: model.display_name || model.slug,
        })),
      });
    } catch (error) {
      return upstreamFailure(config, error);
    }
  }

  if (route === "upstream/models" && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("Request body must be JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return badRequest("Request body must be a JSON object");
    }
    let selected: string[];
    try {
      selected = parseSelectedModels((body as { selectedModels?: unknown }).selectedModels);
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : String(error));
    }
    if (config.upstreamOnly === true && selected.length === 0) {
      return badRequest("Upstream-only mode requires at least one selected model; the catalog would be empty");
    }
    // 目录重建与配置写入必须是同一次保存：先按上游全量目录过滤出已选条目重建
    // catalogPath，再走 selectedModels 的持久化路径，最后在动态路由模式下重置官方
    // 目录缓存（Codex 约在 5 分钟内自动刷新 /models，无需重启）；upstream-only 模式
    // 由 Codex 静态加载目录文件，需要用户确认后重启 Codex app-server。
    let fetched: Awaited<ReturnType<typeof fetchConfiguredUpstreamCatalog>>;
    try {
      fetched = await fetchConfiguredUpstreamCatalog(ctx.paths, config, ctx.upstreamDeps);
    } catch (error) {
      return upstreamFailure(config, error);
    }
    const { catalog, modelsConfigFile } = fetched;
    const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));
    const unknownId = selected.find((slug) => !bySlug.has(slug));
    if (unknownId) return badRequest(`Unknown model ID: ${unknownId}`);
    const ordered = catalog.models
      .map((model) => model.slug)
      .filter((slug) => selected.includes(slug));
    try {
      await rebuildCatalog(ctx.paths, config, ordered.map((slug) => bySlug.get(slug)!), modelsConfigFile);
      applySelectedModelsPatch(ctx.paths, ordered, ctx.instanceOnly !== true);
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : String(error));
    }
    if (config.upstreamOnly !== true) {
      // 重置官方目录缓存让网关下一次 /models 就反映新选择（Codex 约在 5 分钟内自动
      // 刷新）；写失败不回滚已保存的选择，与网关侧缓存写失败静默忽略同策略。
      try {
        invalidateModelsCache(ctx.paths.modelsCacheFile);
      } catch {}
    }
    return Response.json({
      applied: ["selectedModels"],
      selected: ordered,
      count: ordered.length,
      upstreamOnly: config.upstreamOnly === true,
    });
  }

  if (route === "codex/restart" && request.method === "POST") {
    // 停止当前用户的 Codex app-server；Codex 会自行拉起新进程并重读目录。
    const stopCodexServers = ctx.upstreamDeps?.stopCodexServers ?? stopCodexAppServers;
    const result = await stopCodexServers();
    if (result.scan === "unknown") {
      return Response.json(
        { error: { message: `Codex app-server state is unknown: ${result.error}` } },
        { status: 500 },
      );
    }
    return Response.json({ results: result.results });
  }

  if (route === "logs/gateway" && request.method === "GET") return gatewayLogResponse(ctx.paths);
  if (route === "logs/requests" && request.method === "GET") {
    return requestLogsResponse(config, new URL(request.url));
  }
  if (route.startsWith("logs/requests/") && request.method === "GET") {
    const name = decodeURIComponent(route.slice("logs/requests/".length));
    return requestLogContentResponse(config, name);
  }
  return notFound();
}
