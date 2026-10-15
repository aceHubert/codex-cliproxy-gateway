import { AsyncLocalStorage } from "node:async_hooks";
import type { HostServices, AgentConfig, ModelCatalog, ModelEntry, ModelOverrideRule, RequestLogSink, ExchangeEntry, LogNamespace, ProcessLogTarget, ErrorEntry, RequestSummary } from "./types.ts";

const hosts = new AsyncLocalStorage<HostServices<AgentConfig>>();

/** 绑定一次调用及其创建的异步资源，互不覆盖其他实例。 */
export function withHostServices<T>(host: HostServices<AgentConfig>, callback: () => T): T {
  return hosts.run(host, callback);
}

/** 供入口初始化当前执行上下文；宿主实现仍由应用提供。 */
export function enterHostServices(host: HostServices<AgentConfig>): void {
  hosts.enterWith(host);
}

export function getHostServices(): HostServices<AgentConfig> {
  const host = hosts.getStore();
  if (!host) throw new Error("插件主机上下文未初始化，请通过 withHostServices 调用插件");
  return host;
}

/** 方法调用重新进入创建实例时的上下文，后台回调继承相同实例。 */
export function bindHostMethods<T extends object>(value: T, host = getHostServices()): T {
  for (const key of Object.keys(value)) {
    const method: unknown = Reflect.get(value, key);
    if (typeof method !== "function") continue;
    Reflect.set(value, key, (...args: unknown[]) => withHostServices(host, () => Reflect.apply(method, value, args)));
  }
  return value;
}

export const resolvePaths = () => getHostServices().getPaths();
export const atomicWrite = (file: string, content: string) => getHostServices().atomicWrite(file, content);
export const compileModelOverrides = (value: unknown, source?: string): ModelOverrideRule[] => getHostServices().catalog.compileModelOverrides(value, source);
export const mergeCatalog = (native: ModelCatalog, proxy: ModelCatalog, prefix?: string, overrides?: ModelOverrideRule[]): ModelCatalog => getHostServices().catalog.mergeCatalog(native, proxy, prefix, overrides);
export const synthesizeModelEntry = (id: string, priority: number, snapshot: ModelCatalog, vendors?: ModelOverrideRule[], overrides?: ModelOverrideRule[], baseSlug?: string): ModelEntry => getHostServices().catalog.synthesizeModelEntry(id, priority, snapshot, vendors, overrides, baseSlug);
export const parseCodexCatalog = (value: unknown): ModelCatalog => getHostServices().catalog.parseCodexCatalog(value);
export const withAgentSystemPrompt = (entry: ModelEntry, prompt: string): ModelEntry => getHostServices().catalog.withAgentSystemPrompt(entry, prompt);
export const invalidateModelsCache = (file: string) => getHostServices().catalog.invalidateModelsCache(file);
export const clearModelsCacheEntries = (file: string, matches: (slug: string) => boolean): boolean => getHostServices().catalog.clearModelsCacheEntries(file, matches);
export const localTime = (at?: Date) => getHostServices().requestLog.localTime(at);
export const requestLogDir = () => getHostServices().requestLog.requestLogDir();
export const logGroupFromPath = (pathname: string) => getHostServices().requestLog.logGroupFromPath(pathname);
export const logExchange = (sink: RequestLogSink | undefined, group: string, entry: ExchangeEntry, namespace?: LogNamespace) => getHostServices().requestLog.logExchange(sink, group, entry, namespace);
export const logGatewayError = (target: ProcessLogTarget | undefined, entry: ErrorEntry) => getHostServices().processLog.logGatewayError(target, entry);
export const logRequestSummary = (target: ProcessLogTarget | undefined, entry: RequestSummary) => getHostServices().processLog.logRequestSummary(target, entry);
