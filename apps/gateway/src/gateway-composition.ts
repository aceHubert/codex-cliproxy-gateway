import { PluginRegistry, compileModelPattern } from "@agent-proxy/plugin-api";
import type { GatewayPlugin, HttpRequestContext } from "@agent-proxy/plugin-api";
import path from "node:path";
import { createZcodePlugin, ZCODE_MODEL_PATTERNS, ZCODE_RUNTIME_ARTIFACTS, type ZcodeDependencies } from "@agent-proxy/zcode";
import { createCodebuddyPlugin, CODEBUDDY_MODEL_PATTERNS, CODEBUDDY_RUNTIME_ARTIFACTS, type CodebuddyDependencies } from "@agent-proxy/codebuddy";
import { createQoderPlugin, QODER_MODEL_PATTERNS, QODER_RUNTIME_ARTIFACTS, type QoderDependencies } from "@agent-proxy/qoder";
import { createAgyPlugin, AGY_MODEL_PATTERNS, AGY_RUNTIME_ARTIFACTS, type AgyDependencies } from "@agent-proxy/agy";
import { createOpencodeZenPlugin, OPENCODE_ZEN_MODEL_PATTERNS, OPENCODE_ZEN_RUNTIME_ARTIFACTS, type OpencodeZenDependencies } from "@agent-proxy/opencode-zen";
import { agentConfigEnabled } from "./config.ts";
import { createGatewayHostServices } from "./host-services.ts";
import {
  buildCompactionRequest, compactV1Output, compactionError, hasCompactionTrigger,
  isCompletedCompactionPayload, noCompactionSummaryError, responseText,
  rewriteCompactionHistory, syntheticCompactionResponse,
  createPluginGatewayHandler, startPluginGateway,
} from "./gateway.ts";
import { readApiKey } from "./keychain.ts";
import { managedCatalogFiles, resolvePaths } from "./paths.ts";
import type { RealtimeProviderMode } from "./realtime.ts";
import type { GatewayConfig, ProcessLogTarget, ResolvedPaths } from "./types.ts";

export { decideRoute, isLoopbackUrl, joinUpstreamUrl, responsesWebSocketTarget } from "./gateway.ts";

export interface ModelCatalogDependencies {
  zcode?: ZcodeDependencies;
  codebuddy?: CodebuddyDependencies;
  qoder?: QoderDependencies;
  agy?: AgyDependencies;
  opencodeZen?: OpencodeZenDependencies;
}

const installedPatterns = [
  ...ZCODE_MODEL_PATTERNS, ...CODEBUDDY_MODEL_PATTERNS, ...QODER_MODEL_PATTERNS,
  ...AGY_MODEL_PATTERNS, ...OPENCODE_ZEN_MODEL_PATTERNS,
].map(compileModelPattern);

/** 禁用插件仍属于本地命名空间，排除规则不得因开关变化失效。 */
export function isInstalledPluginModel(model: string): boolean {
  return installedPatterns.some((pattern) => Boolean(pattern.match(model)));
}

/** 已装配插件自声明的运行主目录落盘产物；文件名由各插件包导出，业务侧只聚合拼接，不自行维护清单。 */
export function installedPluginArtifactFiles(runtimePaths: ResolvedPaths = resolvePaths()): string[] {
  return [
    ...ZCODE_RUNTIME_ARTIFACTS, ...CODEBUDDY_RUNTIME_ARTIFACTS, ...QODER_RUNTIME_ARTIFACTS,
    ...AGY_RUNTIME_ARTIFACTS, ...OPENCODE_ZEN_RUNTIME_ARTIFACTS,
  ].map((name) => path.join(runtimePaths.runtimeHome, name));
}

/** 卸载清理与 config.toml 受管值守卫共用的目录文件全集：网关自有文件加已装配插件产物。 */
export function managedRuntimeCatalogFiles(runtimePaths: ResolvedPaths = resolvePaths()): string[] {
  return [...managedCatalogFiles(runtimePaths), ...installedPluginArtifactFiles(runtimePaths)];
}

/** 业务装配显式列出已安装插件，核心注册表不探测或下载插件。 */
export function createConfiguredPluginRegistry(
  config: GatewayConfig,
  dependencies: ModelCatalogDependencies = {},
  processLog?: ProcessLogTarget,
  runtimePaths = resolvePaths(),
  apiKey?: string,
  catalogMode: "manual" | "dynamic" = config.upstreamOnly === true ? "manual" : "dynamic",
): PluginRegistry {
  // 构造前固定运行态快照，调用方后续修改配置不会影响既有插件。
  config = { ...config };
  const host = createGatewayHostServices(config, processLog, runtimePaths, apiKey);
  const factories: Array<() => GatewayPlugin> = [];
  if (agentConfigEnabled(config, "zcode")) factories.push(() => createZcodePlugin(host, { ...dependencies.zcode, processLog, catalogMode }));
  if (agentConfigEnabled(config, "codebuddy")) factories.push(() => createCodebuddyPlugin(host, { ...dependencies.codebuddy, processLog, catalogMode }));
  if (agentConfigEnabled(config, "qoder")) factories.push(() => createQoderPlugin(host, { ...dependencies.qoder, processLog, catalogMode }));
  if (agentConfigEnabled(config, "agy")) factories.push(() => createAgyPlugin(host, { ...dependencies.agy, processLog, catalogMode }));
  if (agentConfigEnabled(config, "opencodeZen")) factories.push(() => createOpencodeZenPlugin(host, { ...dependencies.opencodeZen, processLog, catalogMode }));
  const plugins: GatewayPlugin[] = [];
  try {
    for (const factory of factories) plugins.push(withCodexCompaction(factory()));
    return new PluginRegistry(plugins);
  } catch (error) {
    // 后一家初始化失败也释放已初始化插件持有的 watch 与计时器。
    for (const plugin of plugins) {
      try { void Promise.resolve(plugin.close()).catch(() => {}); }
      catch { /* 继续释放其它已初始化插件，保留原始构造错误。 */ }
    }
    throw error;
  }
}

function bodyWithJson(context: HttpRequestContext, json: Record<string, unknown>): HttpRequestContext {
  return { ...context, body: {
    json: async () => json,
    bytes: async () => new TextEncoder().encode(JSON.stringify(json)),
  } };
}

/** Codex 上下文压缩属于业务层，插件保留各自既有协议转换与上游能力。 */
function withCodexCompaction(plugin: GatewayPlugin): GatewayPlugin {
  const handleHttp = plugin.handleHttp.bind(plugin);
  return { ...plugin, async handleHttp(context) {
    // Responses 压缩触发器只对 Responses 请求有意义；chat-completions / anthropic
    // 请求不经过 Codex 压缩包装，直接交给插件。
    if (context.from !== "responses") return handleHttp(context);
    const payload = await context.body.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ error: { message: "Responses 请求必须是 JSON 对象" } }, { status: 400 });
    }
    const input = { ...payload, model: context.model } as Record<string, unknown>;
    if (plugin.id === "opencode-zen") {
      if (context.operation === "compact") return Response.json({ error: { message: "OpenCode Zen 不支持 Responses compact" } }, { status: 400 });
      return handleHttp(bodyWithJson(context, input));
    }
    if (context.operation === "compact" || hasCompactionTrigger(input.input)) {
      const response = await handleHttp(bodyWithJson(context, buildCompactionRequest(input, context.model)));
      if (!response.ok) return response;
      let result: unknown;
      try { result = await response.json(); }
      catch { return compactionError("插件上游压缩响应不是有效 JSON"); }
      if (!isCompletedCompactionPayload(result)) return compactionError("插件上游未完成上下文压缩");
      const summary = responseText(result);
      if (!summary) return compactionError(noCompactionSummaryError("插件上游没有返回压缩摘要", result));
      return context.operation === "compact"
        ? Response.json({ output: compactV1Output(input.input, summary) })
        : syntheticCompactionResponse(result, context.model, summary, input.stream === true);
    }
    input.input = rewriteCompactionHistory(input.input);
    return handleHttp(bodyWithJson(context, input));
  } };
}

export function createGatewayHandler(
  config: GatewayConfig,
  apiKey = readApiKey(),
  realtimeProviderMode: RealtimeProviderMode = "invalid",
  cpaThreads = new Set<string>(),
  cpaTurns = new Set<string>(),
  clientVersionFile?: string,
  zcodeDependencies?: ZcodeDependencies,
  processLog?: ProcessLogTarget,
  codebuddyDependencies?: CodebuddyDependencies,
  qoderDependencies?: QoderDependencies,
  agyDependencies?: AgyDependencies,
  opencodeZenDependencies?: OpencodeZenDependencies,
  runtimePaths?: ResolvedPaths,
) {
  const registry = createConfiguredPluginRegistry(config, {
    zcode: zcodeDependencies, codebuddy: codebuddyDependencies, qoder: qoderDependencies,
    agy: agyDependencies, opencodeZen: opencodeZenDependencies,
  }, processLog, runtimePaths, apiKey);
  return createPluginGatewayHandler(config, registry, apiKey, realtimeProviderMode, cpaThreads,
    cpaTurns, clientVersionFile, processLog, runtimePaths, isInstalledPluginModel);
}

export function startGateway(
  config: GatewayConfig,
  realtimeProviderMode: RealtimeProviderMode = "invalid",
  clientVersionFile?: string,
  zcodeDependencies?: ZcodeDependencies,
  processLog?: ProcessLogTarget,
  codebuddyDependencies?: CodebuddyDependencies,
  qoderDependencies?: QoderDependencies,
  agyDependencies?: AgyDependencies,
  opencodeZenDependencies?: OpencodeZenDependencies,
) {
  const registry = createConfiguredPluginRegistry(config, {
    zcode: zcodeDependencies, codebuddy: codebuddyDependencies, qoder: qoderDependencies,
    agy: agyDependencies, opencodeZen: opencodeZenDependencies,
  }, processLog);
  return startPluginGateway(config, registry, realtimeProviderMode, clientVersionFile, processLog, isInstalledPluginModel);
}
