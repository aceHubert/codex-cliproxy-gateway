export type ThreadRouteKind = "official" | "cliproxy";

/** 父路由未就绪或父链无效时要求客户端重试，避免裸模型意外消耗官方额度。 */
export class ThreadRoutingError extends Error {}

/** 根会话独立选路，子线程只保存父关系，在每次请求时读取最新根路由。 */
export class ThreadRoutingState {
  private readonly roots = new Map<string, ThreadRouteKind>();
  private readonly parents = new Map<string, string>();

  constructor(initialCpaThreads: Iterable<string> = []) {
    for (const threadId of initialCpaThreads) this.roots.set(threadId, "cliproxy");
  }

  get(threadId: string): ThreadRouteKind | undefined {
    const visited = new Set<string>();
    let current = threadId;
    while (true) {
      if (visited.has(current)) throw new ThreadRoutingError("线程父链存在循环，请重新建立会话。");
      visited.add(current);
      const parent = this.parents.get(current);
      if (!parent) return this.roots.get(current);
      current = parent;
    }
  }

  resolve(
    threadId: string | undefined,
    parentThreadId: string | undefined,
    modelRoute: ThreadRouteKind | undefined,
    confirmed: boolean,
  ): ThreadRouteKind | undefined {
    if (!threadId) {
      if (!parentThreadId) return modelRoute;
      const inherited = this.get(parentThreadId);
      if (!inherited) throw new ThreadRoutingError("父会话路由尚未就绪，请在主会话开始后重试。");
      return inherited;
    }
    if (parentThreadId) {
      const existing = this.parents.get(threadId);
      if (existing && existing !== parentThreadId) throw new ThreadRoutingError("线程父关系发生冲突，请重新建立会话。");
      // 验证新关系再写入，避免无效请求损坏已知父链。
      let current: string | undefined = parentThreadId;
      const visited = new Set<string>([threadId]);
      while (current) {
        if (visited.has(current)) throw new ThreadRoutingError("线程父链存在循环，请重新建立会话。");
        visited.add(current);
        current = this.parents.get(current);
      }
      this.parents.set(threadId, parentThreadId);
      this.roots.delete(threadId);
    }
    if (this.parents.has(threadId)) {
      const inherited = this.get(threadId);
      if (!inherited) throw new ThreadRoutingError("父会话路由尚未就绪，请在主会话开始后重试。");
      return inherited;
    }
    const existing = this.roots.get(threadId);
    // 握手只初始化未知根。真实模型帧/HTTP 请求才能覆盖已有决定。
    if (modelRoute && (confirmed || !existing)) {
      this.roots.set(threadId, modelRoute);
    }
    return this.roots.get(threadId);
  }
}
