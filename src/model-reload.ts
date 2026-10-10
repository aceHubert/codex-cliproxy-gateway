import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readGatewayConfigFile } from "./config-update.ts";
import { assertHealthyInstance, InstanceHealthError } from "./instance-health.ts";
import { instanceMarker } from "./paths.ts";
import { atomicWrite } from "./toml.ts";
import type { GatewayConfig, ResolvedPaths } from "./types.ts";

const RELOAD_FAILED = "模型配置重载失败；请检查 config.json 和模型目录后重新执行 models --sync，必要时重启网关。";
const REVISION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECEIPTS = 64;

interface ReloadReceipt {
  revision: string;
  status: "loaded" | "failed";
  error?: string;
}

function requestsDir(paths: ResolvedPaths): string {
  return path.join(paths.runtimeHome, "model-reload-requests");
}

function queuedRequestFile(paths: ResolvedPaths, revision: string): string {
  return path.join(requestsDir(paths), `${revision}.json`);
}

export function modelReloadRequestFile(paths: ResolvedPaths): string {
  return path.join(paths.runtimeHome, "model-reload-request.json");
}

export function modelReloadResultFile(paths: ResolvedPaths): string {
  return path.join(paths.runtimeHome, "model-reload-result.json");
}

/** 通知文件仅保存随机修订，不包含配置、凭据或模型请求。 */
export function requestModelReload(paths: ResolvedPaths): string {
  const revision = randomUUID();
  // 每次通知独立落盘，多个 CLI/Web UI 进程同时更新也不会覆盖彼此。
  atomicWrite(queuedRequestFile(paths, revision), `${JSON.stringify({ revision })}\n`);
  atomicWrite(modelReloadRequestFile(paths), `${JSON.stringify({ revision })}\n`);
  return revision;
}

function readNotification(file: string): Record<string, unknown> | undefined {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("无法读取模型重载通知；请检查运行目录权限后重新执行 models --sync。");
  }
  try {
    const value: unknown = JSON.parse(source);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // JSON 解析异常可能包含文件内容，不能直接向外传播。
  }
  throw new Error("模型重载通知已损坏；请重新执行 models --sync 生成通知。");
}

function readRevision(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value.revision !== "string" || !REVISION_PATTERN.test(value.revision)) {
    throw new Error("模型重载修订无效；请重新执行 models --sync 生成通知。");
  }
  return value.revision;
}

function readReceipts(value: Record<string, unknown> | undefined): ReloadReceipt[] {
  if (!value) return [];
  const entries = value.receipts === undefined ? [value] : value.receipts;
  if (!Array.isArray(entries)) throw new Error("模型重载结果无效；请重新执行 models --sync 或重启网关。");
  return entries.slice(-MAX_RECEIPTS).map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("模型重载结果无效；请重新执行 models --sync 或重启网关。");
    }
    const receipt = entry as Record<string, unknown>;
    const revision = readRevision(receipt);
    if (!revision || (receipt.status !== "loaded" && receipt.status !== "failed")) {
      throw new Error("模型重载结果无效；请重新执行 models --sync 或重启网关。");
    }
    // 即使回执文件被改写，也不转发其中任意错误内容。
    return { revision, status: receipt.status, ...(receipt.status === "failed" ? { error: RELOAD_FAILED } : {}) };
  });
}

function queuedRevisions(paths: ResolvedPaths): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(requestsDir(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("无法读取模型重载通知；请检查运行目录权限后重新执行 models --sync。");
  }
  return names.filter((name) => name.endsWith(".json") && REVISION_PATTERN.test(name.slice(0, -5)))
    .map((name) => {
      const revision = name.slice(0, -5);
      if (readRevision(readNotification(queuedRequestFile(paths, revision))) !== revision) {
        throw new Error("模型重载修订无效；请重新执行 models --sync 生成通知。");
      }
      return revision;
    });
}

function clearQueuedRequest(paths: ResolvedPaths, revision: string): void {
  try {
    fs.unlinkSync(queuedRequestFile(paths, revision));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("无法清理已确认的模型重载通知；请检查运行目录权限。");
    }
  }
}

export interface ModelReloadReceiver {
  reloadPending(): Promise<void>;
  close(): void;
}

/** 独立 Web UI 无模型流量时也能送达；定时器不阻止进程退出。 */
export function createModelReloadReceiver(
  paths: ResolvedPaths,
  reload: (config: GatewayConfig) => Promise<void>,
  deps: { pollIntervalMs?: number } = {},
): ModelReloadReceiver {
  let pending: Promise<void> | undefined;
  let closed = false;
  const reloadPending = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      // 重载期间又写入的修订按顺序接续，所有调用等待同一条处理链。
      while (!closed) {
        const latestRevision = readRevision(readNotification(modelReloadRequestFile(paths)));
        const receipts = readReceipts(readNotification(modelReloadResultFile(paths)));
        const confirmed = new Set(receipts.map((receipt) => receipt.revision));
        const queued = queuedRevisions(paths);
        for (const revision of queued.filter((revision) => confirmed.has(revision))) clearQueuedRequest(paths, revision);
        const revisions = [...new Set([...queued, ...(latestRevision ? [latestRevision] : [])])]
          .filter((revision) => !confirmed.has(revision));
        if (revisions.length === 0) return;
        let status: ReloadReceipt["status"] = "loaded";
        try {
          await reload(readGatewayConfigFile(paths.gatewayConfig));
        } catch {
          status = "failed";
        }
        const current: ReloadReceipt[] = revisions.map((revision) => ({
          revision, status, ...(status === "failed" ? { error: RELOAD_FAILED } : {}),
        }));
        const latest = current.find((receipt) => receipt.revision === latestRevision) ?? current[current.length - 1];
        const history = [...receipts, ...current.filter((receipt) => receipt !== latest), latest].slice(-MAX_RECEIPTS);
        // 先确认再清理：重启后已成功的修订不会重复刷新或覆盖旧结果。
        atomicWrite(modelReloadResultFile(paths), `${JSON.stringify({ ...latest, receipts: history })}\n`);
        for (const revision of revisions) clearQueuedRequest(paths, revision);
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(() => { void reloadPending().catch(() => {}); }, deps.pollIntervalMs ?? 250);
  timer.unref();
  return {
    reloadPending,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

export type ModelReloadFetch = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>;

export interface ModelReloadDependencies {
  fetch?: ModelReloadFetch;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  healthTimeoutMs?: number;
}

function isConnectionRefused(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === "ECONNREFUSED" || (value.cause !== error && isConnectionRefused(value.cause));
}

/** 只探测模型端口的健康身份；未运行时保留通知，供下次启动拾取。 */
export async function reloadGatewayModels(
  paths: ResolvedPaths,
  config: GatewayConfig,
  deps: ModelReloadDependencies = {},
): Promise<{ loaded: boolean; revision: string }> {
  const revision = requestModelReload(paths);
  const fetchHealth = deps.fetch ?? globalThis.fetch;
  const wait = deps.wait ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.timeoutMs ?? 15_000);
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "[::1]" : config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host;
  while (true) {
    let modeReady: boolean;
    try {
      const response = await fetchHealth(`http://${host}:${config.port}/healthz`, {
        // healthz 同时等待启动目录就绪；慢启动不能误判为没有服务。
        signal: AbortSignal.timeout(Math.max(1, Math.min(deps.healthTimeoutMs ?? 10_000, deadline - now()))),
      });
      assertHealthyInstance(response, instanceMarker(paths.runtimeHome));
      const status: unknown = await response.json();
      modeReady = status !== null && typeof status === "object"
        && (status as Record<string, unknown>).upstreamOnly === (config.upstreamOnly === true);
    } catch (error) {
      if (error instanceof InstanceHealthError) throw error;
      if (isConnectionRefused(error)) return { loaded: false, revision };
      throw new Error("无法确认网关健康状态；配置已保存，请检查网关后重新执行 models --sync 或重启网关。");
    }
    if (modeReady) break;
    // config 重启交接期间旧进程可能响应；同一实例也必须已切到目标模式。
    if (now() >= deadline) {
      throw new Error("网关未在期限内切换到目标模型模式；请检查网关后重新执行 config 或重启网关。");
    }
    await wait(Math.min(100, Math.max(1, deadline - now())));
  }
  while (true) {
    const result = readReceipts(readNotification(modelReloadResultFile(paths)))
      .find((receipt) => receipt.revision === revision);
    if (result) {
      if (result.status === "loaded") return { loaded: true, revision };
      if (result.status === "failed") throw new Error(RELOAD_FAILED);
      throw new Error("模型重载结果无效；请重新执行 models --sync 或重启网关。");
    }
    if (now() >= deadline) {
      throw new Error("网关未在期限内确认模型重载；配置已保存，请检查网关后重新执行 models --sync 或重启网关。");
    }
    await wait(Math.min(100, Math.max(1, deadline - now())));
  }
}
