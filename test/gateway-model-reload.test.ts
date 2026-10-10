import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayHandler, responsesWebSocketTarget, startGateway } from "../src/gateway.ts";
import { codexCatalogFile } from "../src/model-state.ts";
import { requestModelReload } from "../src/model-reload.ts";
import { resolvePaths, runWithInstancePaths } from "../src/paths.ts";
import type { GatewayConfig } from "../src/types.ts";
import type { ZcodeProviderSnapshot } from "../src/zcode/config.ts";

const TIMEOUT = { timeout: 60_000 };

function fixture(): { directory: string; config: GatewayConfig; paths: ReturnType<typeof resolvePaths> } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-model-reload-gateway-"));
  const paths = resolvePaths({ HOME: directory, CODEX_HOME: path.join(directory, "codex") }, path.join(directory, "runtime"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 0, mountPath: "/v1", prefix: "cliproxy/",
    upstreamBaseUrl: "http://127.0.0.1:9/v1", officialBaseUrl: "http://127.0.0.1:9/official",
    catalogPath: paths.catalogFile,
  };
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [{ slug: "upstream-model" }] }));
  return { directory, config, paths };
}

function request(model: string): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "测试" }),
  });
}

function snapshot(model: string): ZcodeProviderSnapshot {
  return { family: "zai", providerID: "test-zai", plan: "api-key", apiKey: "fake-key",
    baseURL: "https://api.z.ai/api/anthropic", modelIds: [model] };
}

test("模型热加载更新本地目录和推理排除规则并保持适配器实例", TIMEOUT, async () => {
  const { directory, config } = fixture();
  const originalFetch = globalThis.fetch;
  let closed = 0;
  let reloads = 0;
  let current = snapshot("glm-5.3");
  globalThis.fetch = (async () => Response.json({ models: [{ slug: "gpt-native" }] })) as unknown as typeof fetch;
  const handler = createGatewayHandler({ ...config, zcode: true }, "fake-key", "invalid", new Set(), new Set(), undefined, {
    cacheDirectory: path.dirname(config.catalogPath), endpointRouting: null, clientSigning: null,
    configCache: { get: async () => current, reload: async () => { reloads++; return current; }, close: () => { closed++; } },
    fetch: async () => { throw new Error("被排除模型不得发送推理请求"); },
  });
  try {
    await handler.modelsReady();
    current = snapshot("glm-5.3-flash");
    await handler.reloadConfig({ ...config, zcode: false, upstreamOnly: true,
      excludedModels: ["zcode-test-zai/glm-5.3-flash"], selectedModels: ["upstream-model"] });
    assert.equal(reloads, 1);
    assert.equal(closed, 0);
    const blocked = await handler(request("zcode-test-zai/glm-5.3-flash"));
    assert.equal(blocked.status, 404);
    assert.equal(blocked.headers.get("x-codex-cliproxy-gateway"), "model-excluded");
    const response = await handler(new Request("http://127.0.0.1/v1/models?client_version=test"));
    const body = await response.json() as { models: Array<{ slug: string }> };
    assert.deepEqual(body.models.map((entry) => entry.slug).sort(), ["cliproxy/upstream-model", "gpt-native"]);
    const health = await (await handler(new Request("http://127.0.0.1/healthz"))).json() as { upstreamOnly: boolean };
    assert.equal(health.upstreamOnly, false, "热加载不能更换路由模式");
    await handler.reloadConfig({ ...config, excludedModels: [] });
    const restored = await (await handler(new Request("http://127.0.0.1/v1/models?client_version=test"))).json() as { models: Array<{ slug: string }> };
    assert.ok(restored.models.some((entry) => entry.slug === "zcode-test-zai/glm-5.3-flash"));
  } finally {
    handler.close();
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(closed, 1);
});

test("静态模式启动就绪合并 agent 且目录请求只消费已发布快照", TIMEOUT, async () => {
  const { directory, config, paths } = fixture();
  config.upstreamOnly = true;
  config.zcode = true;
  // 本地兼容端独立提供有效目录，原始上游已选目录允许为空。
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [] }));
  let current = snapshot("glm-5.3");
  let startupReads = 0;
  const handler = createGatewayHandler(config, "fake-key", "invalid", new Set(), new Set(), undefined, {
    cacheDirectory: paths.runtimeHome, endpointRouting: null, clientSigning: null,
    configCache: { get: async () => { startupReads++; return current; }, close: () => {} },
  }, undefined, undefined, undefined, undefined, undefined, paths);
  try {
    await handler.modelsReady();
    assert.equal(startupReads, 1, "启动就绪必须等待同一批刷新，不能重新创建适配器或重复读取");
    assert.deepEqual(JSON.parse(fs.readFileSync(config.catalogPath, "utf8")), { models: [] });
    const published = JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")) as { models: Array<{ slug: string }> };
    assert.deepEqual(published.models.map((entry) => entry.slug), ["zcode-test-zai/glm-5.3"]);
    current = snapshot("glm-5.3-flash");
    const response = await handler(new Request("http://127.0.0.1/v1/models?client_version=test"));
    const body = await response.json() as { models: Array<{ slug: string }> };
    assert.deepEqual(body.models.map((entry) => entry.slug), ["zcode-test-zai/glm-5.3"]);
    assert.equal(startupReads, 1, "静态目录请求不得触发目录刷新");
    // 热加载只消费命令已发布的文件，不能在请求里更新快照或访问官方 fallback。
    fs.writeFileSync(codexCatalogFile(paths), "invalid");
    assert.equal((await handler(new Request("http://127.0.0.1/v1/models"))).status, 502);
  } finally {
    handler.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("静态首次发布失败后可经显式通知恢复而无需重启网关", TIMEOUT, async () => {
  const { directory, config, paths } = fixture();
  config.upstreamOnly = true;
  fs.writeFileSync(config.catalogPath, "invalid");
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify(config));
  const server = runWithInstancePaths(paths, () => startGateway(config));
  try {
    assert.equal((await fetch(new URL("healthz", server.url))).status, 503);
    assert.equal((await fetch(new URL("ui", server.url))).status, 404);
    assert.equal((await fetch(new URL("favicon.ico", server.url), { headers: { upgrade: "websocket" } })).status, 404);
    const catalog = { models: [{ slug: "recovered-model" }] };
    fs.writeFileSync(config.catalogPath, JSON.stringify(catalog));
    fs.writeFileSync(codexCatalogFile(paths), JSON.stringify(catalog));
    requestModelReload(paths);
    assert.equal((await fetch(new URL("healthz", server.url))).status, 200);
    const response = await fetch(new URL("v1/models?client_version=test", server.url));
    assert.equal(response.status, 200);
    const body = await response.json() as { models: Array<{ slug: string }> };
    assert.deepEqual(body.models.map((entry) => entry.slug), ["recovered-model"]);
  } finally {
    server.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("运行中网关经修订通知重载配置并保持监听服务", TIMEOUT, async () => {
  const { directory, config, paths } = fixture();
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify(config));
  const server = runWithInstancePaths(paths, () => startGateway(config));
  try {
    const before = await fetch(new URL("healthz", server.url));
    assert.equal(before.status, 200);
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify({ ...config, excludedModels: ["zcode/*"] }));
    requestModelReload(paths);
    const response = await fetch(new URL("v1/responses", server.url), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zcode/glm-5.3", input: "测试" }),
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-codex-cliproxy-gateway"), "model-excluded");
    assert.equal((await fetch(new URL("healthz", server.url))).status, 200);
  } finally {
    server.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("动态网关的 default 推理不等待其它 agent 启动目录，健康和目录查询仍等待就绪", TIMEOUT, async () => {
  const { directory, config, paths } = fixture();
  let resolveCatalog!: (value: ZcodeProviderSnapshot) => void;
  const catalogReady = new Promise<ZcodeProviderSnapshot>((resolve) => { resolveCatalog = resolve; });
  let closed = 0;
  let inferenceCalls = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(incoming) {
      if (new URL(incoming.url).pathname === "/v1/models") return Response.json({ models: [{ slug: "gpt-native" }] });
      inferenceCalls++;
      const body = await incoming.json() as { model: string };
      return Response.json({ id: "default-response", model: body.model });
    },
  });
  config.zcode = true;
  config.upstreamBaseUrl = new URL("v1", upstream.url).href;
  config.officialBaseUrl = new URL("v1", upstream.url).href;
  const server = runWithInstancePaths(paths, () => startGateway(config, "invalid", undefined, {
    cacheDirectory: paths.runtimeHome, endpointRouting: null, clientSigning: null,
    configCache: { get: () => catalogReady, close: () => { closed++; } },
  }));
  let healthCompleted = false;
  let modelsCompleted = false;
  const health = fetch(new URL("healthz", server.url)).then((response) => { healthCompleted = true; return response; });
  const models = fetch(new URL("v1/models?client_version=test", server.url)).then((response) => { modelsCompleted = true; return response; });
  try {
    // 必须在未释放目录 promise 时拿到推理结果；回归时用短请求超时结束阻塞。
    const response = await fetch(new URL("v1/responses", server.url), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/upstream-model", input: "测试" }),
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "default-response", model: "upstream-model" });
    assert.equal(inferenceCalls, 1);
    assert.equal(healthCompleted, false);
    assert.equal(modelsCompleted, false);
    resolveCatalog(snapshot("glm-5.3"));
    assert.equal((await health).status, 200);
    const catalogResponse = await models;
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as { models: Array<{ slug: string }> };
    assert.ok(catalog.models.some((entry) => entry.slug === "zcode-test-zai/glm-5.3"));
  } finally {
    resolveCatalog(snapshot("glm-5.3"));
    await Promise.allSettled([health, models]);
    server.stop(true);
    upstream.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(closed, 1);
});

test("静态热加载在启动旧快照完成后重新发布当前排除规则", TIMEOUT, async () => {
  const { directory, config, paths } = fixture();
  const agentModel = "zcode-test-zai/glm-5.3";
  config.upstreamOnly = true;
  config.zcode = true;
  config.excludedModels = [agentModel];
  let resolveCatalog!: (value: ZcodeProviderSnapshot) => void;
  const catalogReady = new Promise<ZcodeProviderSnapshot>((resolve) => { resolveCatalog = resolve; });
  const handler = createGatewayHandler(config, "fake-key", "invalid", new Set(), new Set(), undefined, {
    cacheDirectory: paths.runtimeHome, endpointRouting: null, clientSigning: null,
    configCache: { get: () => catalogReady, reload: () => catalogReady, close: () => {} },
  }, undefined, undefined, undefined, undefined, undefined, paths);
  try {
    const nextConfig = { ...config, excludedModels: [] };
    // 命令已发布新文件，启动仍等待旧配置目录：重载必须修复随后到达的旧发布。
    fs.writeFileSync(codexCatalogFile(paths), JSON.stringify({ models: [{ slug: "upstream-model" }, { slug: agentModel }] }));
    const reloaded = handler.reloadConfig(nextConfig);
    resolveCatalog(snapshot("glm-5.3"));
    await reloaded;
    const published = JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")) as { models: Array<{ slug: string }> };
    assert.deepEqual(published.models.map((entry) => entry.slug).sort(), ["upstream-model", agentModel].sort());
    const response = await handler(new Request("http://127.0.0.1/v1/models?client_version=test"));
    const visible = await response.json() as { models: Array<{ slug: string }> };
    assert.ok(visible.models.some((entry) => entry.slug === agentModel));
    await handler.reloadConfig({ ...config, excludedModels: [agentModel] });
    const excluded = JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")) as { models: Array<{ slug: string }> };
    assert.deepEqual(excluded.models.map((entry) => entry.slug), ["upstream-model"]);
    assert.equal((await handler(request(agentModel))).headers.get("x-codex-cliproxy-gateway"), "model-excluded");
  } finally {
    resolveCatalog(snapshot("glm-5.3"));
    handler.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("upstream-only 的所有 HTTP-only agent 握手都不能进入 default WebSocket", () => {
  const { directory, config } = fixture();
  try {
    for (const [enabled, model] of [
      ["zcode", "zcode/glm-5.3"], ["codebuddy", "codebuddy-cn/hy4"], ["qoder", "qoder/auto"],
      ["agy", "agy/gemini-3.8-flash"], ["opencodeZen", "opencode-zen/model"],
    ] as const) {
      const ws = new Request("http://127.0.0.1/v1/responses", {
        headers: { upgrade: "websocket", "x-codex-routing-hint": `model=${model}` },
      });
      assert.equal(responsesWebSocketTarget(ws, { ...config, upstreamOnly: true, [enabled]: true }), null);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
