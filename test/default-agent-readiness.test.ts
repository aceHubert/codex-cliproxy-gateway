import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginRegistry, type GatewayPlugin } from "@agent-proxy/plugin-api";
import { createConfiguredPluginRegistry, isInstalledPluginModel, type ModelCatalogDependencies } from "../apps/gateway/src/gateway-composition.ts";
import { createPluginGatewayHandler } from "../apps/gateway/src/gateway.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

const TIMEOUT = { timeout: 60_000 };

for (const upstreamOnly of [false, true]) {
  test(`五家缺省启用但无登录和可用目录时，${upstreamOnly ? "静态" : "动态"}网关保留 default 就绪和目录`, TIMEOUT, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-default-readiness-"));
    const paths = resolvePaths({ HOME: directory, CODEX_HOME: path.join(directory, "codex") }, path.join(directory, "runtime"));
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [{ slug: "default-model" }] }));
    const config: GatewayConfig = {
      host: "127.0.0.1", port: 0, mountPath: "/v1", prefix: "cliproxy/",
      upstreamOnly, upstreamBaseUrl: "http://127.0.0.1:9/v1",
      officialBaseUrl: "https://official.invalid/v1", catalogPath: paths.catalogFile,
    };
    const timers = new Set<ReturnType<typeof setInterval>>();
    const schedule = ((...args: Parameters<typeof setInterval>) => {
      const timer = setInterval(...args);
      timers.add(timer);
      return timer;
    }) as typeof setInterval;
    const cancel = ((timer: ReturnType<typeof setInterval>) => {
      timers.delete(timer);
      clearInterval(timer);
    }) as typeof clearInterval;
    let authenticatedNetworkCalls = 0;
    const denyAuthenticatedFetch = async (): Promise<Response> => {
      authenticatedNetworkCalls++;
      throw new Error("没有登录时不得发送认证上游请求");
    };
    const dependencies: ModelCatalogDependencies = {
      zcode: {
        zcodeHome: path.join(directory, "missing-zcode"),
        cacheDirectory: paths.runtimeHome, endpointRouting: null, clientSigning: null,
        fetch: denyAuthenticatedFetch,
      },
      codebuddy: {
        authDirectory: path.join(directory, "missing-codebuddy"),
        cacheDirectory: paths.runtimeHome, fetch: denyAuthenticatedFetch,
        setInterval: schedule, clearInterval: cancel,
      },
      qoder: {
        configDirs: { intl: path.join(directory, "missing-qoder-intl"), cn: path.join(directory, "missing-qoder-cn") },
        credentials: async () => null, cn: { credentials: async () => null },
        cacheDirectory: paths.runtimeHome, fetch: denyAuthenticatedFetch as unknown as typeof fetch,
        setInterval: schedule, clearInterval: cancel,
      },
      agy: {
        credentialFile: path.join(directory, "missing-agy"),
        credentials: async () => null, cacheDirectory: paths.runtimeHome, fetch: denyAuthenticatedFetch,
        setInterval: schedule, clearInterval: cancel,
      },
      opencodeZen: {
        apiKey: "public", projectId: "temporary-test-instance",
        cacheDirectory: paths.runtimeHome,
        fetch: async () => Response.json({ data: [] }),
        fetchMetadata: async () => ({ opencode: { models: {} } }),
        probeModel: async () => { throw new Error("空目录不得发起模型探测"); },
        userAgentStore: { current: () => "opencode/test/0.0.0/cli", refresh: async () => {} },
        setInterval: schedule, clearInterval: cancel,
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ models: [{ slug: "gpt-native" }] })) as unknown as typeof fetch;
    const registry = createConfiguredPluginRegistry(config, dependencies, undefined, paths, "fake-key");
    const handler = createPluginGatewayHandler(config, registry, "fake-key", "invalid",
      new Set(), new Set(), undefined, undefined, paths, isInstalledPluginModel);
    try {
      assert.deepEqual(registry.plugins.map((plugin) => plugin.id),
        ["zcode", "codebuddy", "qoder", "agy", "opencode-zen"]);
      await handler.modelsReady();
      const response = await handler(new Request("http://127.0.0.1/v1/models?client_version=test"));
      assert.equal(response.status, 200);
      const catalog = await response.json() as { models: Array<{ slug: string }> };
      assert.deepEqual(catalog.models.map((model) => model.slug).sort(),
        upstreamOnly ? ["default-model"] : ["cliproxy/default-model", "gpt-native"]);
      assert.deepEqual((await registry.getCatalog()).models, []);
      assert.equal(authenticatedNetworkCalls, 0);
    } finally {
      handler.close();
      await registry.close();
      assert.equal(timers.size, 0, "关闭网关应释放所有已装配插件计时器");
      globalThis.fetch = originalFetch;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("静态启动保留健康插件与默认目录，失败插件使用缓存或空目录且诊断不泄露原异常", TIMEOUT, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-startup-fallback-"));
  const paths = resolvePaths({ HOME: directory, CODEX_HOME: path.join(directory, "codex") }, path.join(directory, "runtime"));
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [{ slug: "default-model" }] }));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 0, mountPath: "/v1", prefix: "cliproxy/", upstreamOnly: true,
    upstreamBaseUrl: "http://127.0.0.1:9/v1", officialBaseUrl: "https://official.invalid/v1",
    catalogPath: paths.catalogFile,
  };
  const sensitiveError = "upstream auth secret=never-print-this-test-key";
  const stub = (id: string, cached: boolean, healthy: boolean): GatewayPlugin => ({
    id, modelPatterns: [`${id}/*`],
    handleHttp: () => Response.json({}),
    getCatalog: () => {
      if (!cached) throw new Error(sensitiveError);
      return { models: [{ slug: `${id}/cached-model` }] };
    },
    refreshCatalog: async () => {
      if (!healthy) throw new Error(sensitiveError);
      return { models: [{ slug: `${id}/fresh-model` }] };
    },
    reloadCatalog: async () => ({ models: [] }),
    ready: async () => {}, close: () => {},
  });
  const registry = new PluginRegistry([stub("healthy", true, true), stub("cached", true, false), stub("unavailable", false, false)]);
  const handler = createPluginGatewayHandler(config, registry, "fake-key", "invalid",
    new Set(), new Set(), undefined, { file: paths.stdoutLog, maxBytes: 0 }, paths);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("静态目录请求不得访问外网"); }) as unknown as typeof fetch;
  try {
    await handler.modelsReady();
    const response = await handler(new Request("http://127.0.0.1/v1/models?client_version=test"));
    assert.equal(response.status, 200);
    const catalog = await response.json() as { models: Array<{ slug: string }> };
    assert.deepEqual(catalog.models.map((model) => model.slug).sort(),
      ["cached/cached-model", "default-model", "healthy/fresh-model"]);
    const diagnostics = fs.readFileSync(paths.stdoutLog, "utf8");
    assert.ok(diagnostics.includes("cached"));
    assert.ok(diagnostics.includes("unavailable"));
    assert.ok(!diagnostics.includes(sensitiveError));
    assert.ok(!diagnostics.includes("never-print-this-test-key"));
    await assert.rejects(registry.refreshCatalog(), /never-print-this-test-key/,
      "显式刷新契约仍严格报错，启动容错不能覆盖命令刷新错误");
  } finally {
    handler.close(); await registry.close(); globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
