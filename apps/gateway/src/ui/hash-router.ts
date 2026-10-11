import { useEffect, useState } from "react";

/**
 * 单文件 HTML 内建路由：hash 模型（`#/` 配置页、`#/logs` 全屏日志）。
 * 不引入 react-router——两个路由用一个 hook 足够，也避免服务端参与路由。
 */
export type HashRoute = "/" | "/logs";

function parseHash(): HashRoute {
  return window.location.hash.replace(/^#/, "") === "/logs" ? "/logs" : "/";
}

export function useHashRoute(): HashRoute {
  const [route, setRoute] = useState<HashRoute>(parseHash);
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(route: HashRoute): void {
  window.location.hash = route;
}
