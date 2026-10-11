import { compileModelPattern, modelPatternsOverlap, type CompiledModelPattern } from "./patterns.ts";
import type { CandidateSelector, ClientProtocol, GatewayPlugin, HttpRequestContext, ModelCatalog, ModelMatch, RequestOperation, WebSocketRequestContext } from "./types.ts";

export interface PluginMatch extends ModelMatch {
  plugin: GatewayPlugin;
}

interface RegisteredPattern {
  plugin: GatewayPlugin;
  compiled: CompiledModelPattern;
}

export interface ClientEndpoint {
  from: ClientProtocol;
  operation: RequestOperation;
}

/** 严格匹配受管入口；UI、Realtime 和 mountPath 外的路径由宿主独立处理。 */
export function identifyClientEndpoint(pathname: string, mountPath = "/v1"): ClientEndpoint | undefined {
  const mount = mountPath === "/" ? "" : mountPath.replace(/\/$/, "");
  if (pathname === `${mount}/chat/completions`) return { from: "chat", operation: "generate" };
  if (pathname === `${mount}/responses`) return { from: "responses", operation: "generate" };
  if (pathname === `${mount}/responses/compact`) return { from: "responses", operation: "compact" };
  return undefined;
}

/** 注册时冻结模式表，运行期的候选筛选不修改任何注册或在途会话。 */
export class PluginRegistry {
  readonly plugins: readonly GatewayPlugin[];
  private readonly patterns: readonly RegisteredPattern[];
  private closeResult?: Promise<void>;

  constructor(plugins: readonly GatewayPlugin[]) {
    const patterns: RegisteredPattern[] = [];
    const ids = new Set<string>();
    for (const plugin of plugins) {
      if (!plugin.id || ids.has(plugin.id)) throw new Error(`插件 ID 缺失或重复：${plugin.id}`);
      ids.add(plugin.id);
      if (typeof plugin.handleHttp !== "function") throw new Error(`插件 ${plugin.id} 必须提供 handleHttp`);
      if (plugin.websocket !== undefined && typeof plugin.websocket !== "boolean") throw new Error(`插件 ${plugin.id} 的 websocket 必须为布尔值`);
      if (plugin.websocket === true && typeof plugin.handleWebSocket !== "function") throw new Error(`插件 ${plugin.id} 声明 websocket: true 时必须提供 handleWebSocket`);
      if (!plugin.modelPatterns.length) throw new Error(`插件 ${plugin.id} 必须提供 modelPatterns`);
      for (const pattern of plugin.modelPatterns) {
        const compiled = compileModelPattern(pattern);
        for (const registered of patterns) {
          if (registered.compiled.pattern === pattern) throw new Error(`重复模型模式 ${pattern}：${registered.plugin.id} / ${plugin.id}`);
          if (registered.plugin !== plugin && registered.compiled.priority === compiled.priority && modelPatternsOverlap(registered.compiled, compiled)) {
            throw new Error(`模型模式归属不明确：${registered.plugin.id} 的 ${registered.compiled.pattern} 与 ${plugin.id} 的 ${pattern}`);
          }
        }
        patterns.push({ plugin, compiled });
      }
    }
    this.plugins = Object.freeze([...plugins]);
    this.patterns = Object.freeze(patterns.sort((a, b) => b.compiled.priority - a.compiled.priority));
  }

  match(model: string): PluginMatch | undefined {
    for (const { plugin, compiled } of this.patterns) {
      const match = compiled.match(model);
      if (match) return { plugin, ...match };
    }
    return undefined;
  }

  async select(model: string, selector?: CandidateSelector): Promise<PluginMatch | undefined> {
    const skipped = new Set<GatewayPlugin>();
    for (const { plugin, compiled } of this.patterns) {
      if (skipped.has(plugin)) continue;
      const match = compiled.match(model);
      if (!match) continue;
      if (!selector || await selector(plugin, match)) return { plugin, ...match };
      // 筛选针对插件，不能因同一插件的低优先级规则再次派发。
      skipped.add(plugin);
    }
    return undefined;
  }

  async dispatchHttp(
    context: Omit<HttpRequestContext, "matchedPattern" | "matchedPrefix">,
    defaultHandler: (context: Omit<HttpRequestContext, "matchedPattern" | "matchedPrefix">) => Response | Promise<Response>,
    selector?: CandidateSelector,
  ): Promise<Response> {
    const match = await this.select(context.model, selector);
    if (!match) return defaultHandler(context);
    const response = await match.plugin.handleHttp({ ...context, matchedPattern: match.matchedPattern, matchedPrefix: match.matchedPrefix });
    if (!(response instanceof Response)) throw new Error(`插件 ${match.plugin.id} 的 handleHttp 必须返回 Response`);
    return response;
  }

  async dispatchWebSocket(
    context: Omit<WebSocketRequestContext, "matchedPattern" | "matchedPrefix">,
    defaultHandler: (context: Omit<WebSocketRequestContext, "matchedPattern" | "matchedPrefix">) => Response | undefined | Promise<Response | undefined>,
    selector?: CandidateSelector,
  ): Promise<Response | undefined> {
    const match = await this.select(context.model, selector);
    if (!match) return defaultHandler(context);
    if (match.plugin.websocket !== true) {
      return new Response(JSON.stringify({ error: { type: "unsupported_transport", message: "该模型插件不支持 WebSocket；请使用 HTTP/SSE。" } }), {
        status: 426,
        headers: {
          "content-type": "application/json", connection: "close",
          "x-codex-cliproxy-gateway": `${match.plugin.id}-http-only`,
          "x-agent-proxy-websocket": "unsupported",
        },
      });
    }
    let upgraded = false;
    const response = await match.plugin.handleWebSocket!({
      ...context,
      matchedPattern: match.matchedPattern,
      matchedPrefix: match.matchedPrefix,
      upgrade(session, options) {
        if (upgraded) throw new Error(`插件 ${match.plugin.id} 重复升级 WebSocket`);
        upgraded = context.upgrade(session, options);
        return upgraded;
      },
    });
    if (upgraded) {
      if (response !== undefined) throw new Error(`插件 ${match.plugin.id} 升级成功后不能返回 HTTP 响应`);
      return undefined;
    }
    if (!(response instanceof Response)) throw new Error(`插件 ${match.plugin.id} 未升级 WebSocket，也未返回握手拒绝响应`);
    return response;
  }

  async getCatalog(): Promise<ModelCatalog> {
    return this.collectCatalog("getCatalog");
  }

  async refreshCatalog(): Promise<ModelCatalog> {
    return this.collectCatalog("refreshCatalog");
  }

  async reloadCatalog(): Promise<ModelCatalog> {
    return this.collectCatalog("reloadCatalog");
  }

  async ready(): Promise<void> {
    await Promise.all(this.plugins.map((plugin) => plugin.ready()));
  }

  close(): Promise<void> {
    // 并发与重复 close 共用回执；一家的失败不能阻止其它插件释放资源。
    this.closeResult ??= Promise.allSettled(this.plugins.map(async (plugin) => plugin.close())).then((results) => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "插件关闭失败");
    });
    return this.closeResult;
  }

  private async collectCatalog(method: "getCatalog" | "refreshCatalog" | "reloadCatalog"): Promise<ModelCatalog> {
    const catalogs = await Promise.all(this.plugins.map((plugin) => plugin[method]()));
    return { models: catalogs.flatMap((catalog) => catalog.models) };
  }
}
