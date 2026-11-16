export type ThreadRouteKind = "official" | "cliproxy";

/** 父路由未就绪或父链无效时要求客户端重试，避免裸模型意外消耗官方额度。 */
export class ThreadRoutingError extends Error {}

export class ThreadRoutingCapacityError extends ThreadRoutingError {
  constructor() {
    super("线程路由状态已达上限，暂时无法登记线程关系。");
  }
}

// 本地合成样本中，30 万个 UUID 线程约增加 32 MiB 堆。先保守限制节点数，实际用量由实例统计观察。
const DEFAULT_MAX_THREAD_ROUTES = 65_536;
const STATS_INTERVAL_MS = 5 * 60_000;

type RootNode = { kind: "root"; route: ThreadRouteKind; confirmed: boolean }
  | { kind: "reserved" | "pending-parent" | "blocked" };
type ThreadNode = RootNode | { kind: "child"; parentThreadId: string };
const RESERVED = { kind: "reserved" } as const;
const PENDING_PARENT = { kind: "pending-parent" } as const;
const BLOCKED = { kind: "blocked" } as const;
interface ThreadRoutingStats {
  entries: number;
  limit: number;
  roots: number;
  parentEdges: number;
  pendingParents: number;
  reserved: number;
  blocked: number;
  rejected: number;
  depth: Record<"0" | "1" | "2-4" | "5-16" | "17+", number>;
}

interface ThreadRoutingOptions {
  maxEntries?: number;
  onStats?: (stats: ThreadRoutingStats) => void;
}

/** 根会话独立选路，子线程只保存父关系，在每次请求时读取最新根路由。 */
export class ThreadRoutingState {
  private readonly nodes = new Map<string, ThreadNode>();
  private readonly maxEntries: number;
  private readonly depth = { "0": 0, "1": 0, "2-4": 0, "5-16": 0, "17+": 0 };
  private rejected = 0;
  private nextReportAt = 0;
  private reportedRejection = false;

  constructor(initialCpaThreads: Iterable<string> = [], private readonly options: ThreadRoutingOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_THREAD_ROUTES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("线程路由容量必须是正整数。");
    }
    for (const threadId of initialCpaThreads) {
      if (!this.nodes.has(threadId) && this.nodes.size === this.maxEntries) this.rejectCapacity();
      this.nodes.set(threadId, { kind: "root", route: "cliproxy", confirmed: true });
    }
  }

  stats(): ThreadRoutingStats {
    const stats: ThreadRoutingStats = {
      entries: this.nodes.size, limit: this.maxEntries, roots: 0, parentEdges: 0, pendingParents: 0,
      reserved: 0, blocked: 0, rejected: this.rejected, depth: { ...this.depth },
    };
    for (const node of this.nodes.values()) {
      switch (node.kind) {
        case "child": stats.parentEdges++; break;
        case "pending-parent": stats.pendingParents++; break;
        case "reserved": stats.reserved++; break;
        case "blocked": stats.blocked++; break;
        case "root": stats.roots++; break;
      }
    }
    return stats;
  }

  private reportStats(): void {
    if (!this.options.onStats) return;
    const now = Date.now();
    if (now < this.nextReportAt && (this.reportedRejection || this.rejected === 0)) return;
    this.nextReportAt = now + STATS_INTERVAL_MS;
    this.reportedRejection ||= this.rejected > 0;
    try { this.options.onStats(this.stats()); } catch { /* 统计失败不能改变路由结果。 */ }
  }

  private rejectCapacity(): never {
    this.rejected++;
    throw new ThreadRoutingCapacityError();
  }

  private rootNode(threadId: string, newChildId?: string): RootNode | undefined {
    let current = threadId;
    let depth = newChildId === undefined ? 0 : 1;
    while (true) {
      // 关系只在通过本检查后写入，因此已有链上不会有环。
      if (current === newChildId) throw new ThreadRoutingError("线程父链存在循环，请重新建立会话。");
      const node = this.nodes.get(current);
      if (node?.kind !== "child") {
        const bucket = depth < 2 ? (depth === 0 ? "0" : "1") : depth <= 4 ? "2-4" : depth <= 16 ? "5-16" : "17+";
        this.depth[bucket]++;
        return node;
      }
      current = node.parentThreadId;
      depth++;
    }
  }

  private routeOf(node: RootNode | undefined): ThreadRouteKind | undefined {
    if (node?.kind === "blocked") this.rejectCapacity();
    return node?.kind === "root" ? node.route : undefined;
  }

  private inheritedRoute(node: RootNode | undefined): ThreadRouteKind {
    const route = this.routeOf(node);
    if (!route) throw new ThreadRoutingError("父会话路由尚未就绪，请在主会话开始后重试。");
    return route;
  }

  get(threadId: string): ThreadRouteKind | undefined {
    try { return this.routeOf(this.rootNode(threadId)); }
    finally { this.reportStats(); }
  }

  resolve(
    threadId: string | undefined,
    parentThreadId: string | undefined,
    modelRoute: ThreadRouteKind | undefined,
    confirmed: boolean,
    reserveWithoutModel = false,
  ): ThreadRouteKind | undefined {
    try {
      return this.resolveThread(threadId, parentThreadId, modelRoute, confirmed, reserveWithoutModel);
    } finally {
      this.reportStats();
    }
  }

  private resolveThread(
    threadId: string | undefined,
    parentThreadId: string | undefined,
    modelRoute: ThreadRouteKind | undefined,
    confirmed: boolean,
    reserveWithoutModel: boolean,
  ): ThreadRouteKind | undefined {
    if (!threadId) return parentThreadId ? this.inheritedRoute(this.rootNode(parentThreadId)) : modelRoute;
    const node = this.nodes.get(threadId);
    if (parentThreadId) {
      if (node?.kind === "child" && node.parentThreadId !== parentThreadId) {
        throw new ThreadRoutingError("线程父关系发生冲突，请重新建立会话。");
      }
      const root = this.rootNode(parentThreadId, threadId);
      const parent = this.nodes.get(parentThreadId);
      const newEntries = Number(node === undefined) + Number(parent === undefined);
      if (this.nodes.size + newEntries > this.maxEntries) {
        // 新父关系不能破坏已确认根与后代的有效路由。尚未确认的线程需保留拒绝标记，
        // 防止省略 parent 后被误当独立根。标记不存未接纳的父 ID。
        const establishedRoot = node?.kind === "root" && node.confirmed;
        if (!establishedRoot && (node !== undefined || this.nodes.size < this.maxEntries)) {
          this.nodes.set(threadId, BLOCKED);
        }
        this.rejectCapacity();
      }
      if (parent === undefined || parent.kind === "reserved") this.nodes.set(parentThreadId, PENDING_PARENT);
      if (node?.kind !== "child") this.nodes.set(threadId, { kind: "child", parentThreadId });
      return this.inheritedRoute(root);
    }
    if (node?.kind === "child") return this.inheritedRoute(this.rootNode(threadId));
    if (node === undefined) {
      if (this.nodes.size === this.maxEntries) this.rejectCapacity();
      // 无 hint 的 WS 握手也占一个槽，防止异步拨号期间被其它线程耗尽剩余预算。
      if (!modelRoute && reserveWithoutModel) this.nodes.set(threadId, RESERVED);
    }
    const existing = this.routeOf(node);
    // 握手只初始化未知根。真实模型帧/HTTP 请求才能覆盖已有决定。
    if (modelRoute && (confirmed || !existing)) {
      this.nodes.set(threadId, { kind: "root", route: modelRoute, confirmed });
      return modelRoute;
    }
    return existing;
  }
}
