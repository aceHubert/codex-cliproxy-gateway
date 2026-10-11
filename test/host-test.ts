import { withHostServices } from "@agent-proxy/plugin-api";
import nodeTest from "node:test";
import { createGatewayHostServices } from "../apps/gateway/src/host-services.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

// 纯模块测试仍通过真实主机能力验证目录和日志；实例路径在调用时解析临时上下文。
const config: GatewayConfig = {
  host: "127.0.0.1",
  port: 0,
  mountPath: "/v1",
  prefix: "cliproxy/",
  officialBaseUrl: "https://official.invalid",
  upstreamBaseUrl: "https://upstream.invalid",
  catalogPath: "",
  zcode: false,
  codebuddy: false,
  qoder: false,
  agy: false,
  opencodeZen: false,
};
const host = createGatewayHostServices(config);

/** Bun 为每个用例创建独立异步资源，必须在用例回调内部绑定主机上下文。 */
function bindTestContext<T extends typeof nodeTest>(runner: T): T {
  return new Proxy(runner, {
    apply(target, receiver, args: unknown[]) {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = function (this: unknown, ...parameters: unknown[]) {
          return withHostServices(host, () => Reflect.apply(callback, this, parameters));
        };
      }
      return Reflect.apply(target, receiver, args);
    },
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if ((key === "skip" || key === "only" || key === "todo") && typeof value === "function") {
        return bindTestContext(value as T);
      }
      return value;
    },
  });
}

export const test = bindTestContext(nodeTest);
export default test;
