import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGatewayHandler } from "../src/gateway.ts";
import { runCli } from "../src/cli.ts";
import { resolvePaths } from "../src/paths.ts";
import { readRootTomlString } from "../src/toml.ts";
import {
  clearModelsCacheEntries,
  fetchCliProxyCatalog,
  invalidateModelsCache,
} from "../src/catalog.ts";
import type { GatewayConfig } from "../src/types.ts";

test("dynamic /models refreshes official catalog and merges only CLIProxy rows", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-models-response-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [
    { slug: "test-model", context_window: 100000 },
  ] }));
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "https://example.invalid",
    catalogPath,
  };
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let captured: { url: string; headers: Headers } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    fetchCount += 1;
    captured = { url: String(url), headers: new Headers(options?.headers) };
    return Response.json({ models: [{ slug: "gpt-fresh", context_window: 300000, priority: 7 }] });
  }) as unknown as typeof fetch;
  try {
    const clientVersionFile = path.join(directory, "models-cache.json");
    const handler = createGatewayHandler(config, "test-key", "invalid", new Set<string>(), new Set<string>(), clientVersionFile);
    const codex = await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=1.2.3", {
      headers: {
        authorization: "Bearer oauth-token",
        "chatgpt-account-id": "account-1",
        "if-none-match": "official-etag",
      },
    }));
    assert.equal(codex.status, 200);
    assert.deepEqual(await codex.json(), { models: [
      { slug: "gpt-fresh", context_window: 300000, priority: 7 },
      { slug: "cliproxy/test-model", display_name: "test-model", context_window: 100000, priority: 107 },
    ] });
    assert.equal(captured?.url, "https://official.example/codex/models?client_version=1.2.3");
    assert.equal(captured?.headers.get("authorization"), "Bearer oauth-token");
    assert.equal(captured?.headers.get("chatgpt-account-id"), "account-1");
    assert.equal(captured?.headers.get("if-none-match"), null);
    // 网关记下客户端自报的版本，并把上游返回的 models 原样全部写入 last-good 缓存。
    const recorded = JSON.parse(fs.readFileSync(clientVersionFile, "utf8"));
    assert.equal(recorded.client_version, "1.2.3");
    assert.deepEqual(recorded.models, [{ slug: "gpt-fresh", context_window: 300000, priority: 7 }]);
    const openai = await handler(new Request("http://127.0.0.1:8320/v1/models"));
    assert.deepEqual(await openai.json(), {
      object: "list",
      data: [
        { id: "gpt-fresh", object: "model", owned_by: "openai" },
        { id: "cliproxy/test-model", object: "model", owned_by: "cliproxy" },
      ],
    });
    assert.equal(fetchCount, 2);
    // 不带 client_version 的请求（OpenAI list 形态）不覆盖已记录的版本。
    assert.equal(JSON.parse(fs.readFileSync(clientVersionFile, "utf8")).client_version, "1.2.3");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("dynamic /models returns 502 when official refresh fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-models-fallback-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "test-model" }] }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://official.example/codex",
      upstreamBaseUrl: "https://proxy.example/v1",
      catalogPath,
    }, "test-key");
    const response = await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=1.2.3"));
    assert.equal(response.status, 502);
    assert.match(await response.text(), /official \/models returned HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("official refresh failure serves the last-good cached catalog and preserves models", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-models-last-good-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "test-model" }] }));
  const clientVersionFile = path.join(directory, "models-cache.json");
  fs.writeFileSync(clientVersionFile, JSON.stringify({
    fetched_at: "2026-08-27T07:10:28.566Z",
    client_version: "0.149.0",
    models: [{ slug: "gpt-cached", context_window: 200000 }],
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://official.example/codex",
      upstreamBaseUrl: "https://proxy.example/v1",
      catalogPath,
    }, "test-key", "invalid", new Set<string>(), new Set<string>(), clientVersionFile);
    const response = await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=2.0.0"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { models: [
      { slug: "gpt-cached", context_window: 200000 },
      { slug: "cliproxy/test-model", display_name: "test-model", priority: 100 },
    ] });
    // 失败路径只更新版本与时间戳，已缓存的 models 原样保留。
    const recorded = JSON.parse(fs.readFileSync(clientVersionFile, "utf8"));
    assert.equal(recorded.client_version, "2.0.0");
    assert.notEqual(recorded.fetched_at, "2026-08-27T07:10:28.566Z");
    assert.deepEqual(recorded.models, [{ slug: "gpt-cached", context_window: 200000 }]);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("upstream-only /models 只消费合成静态目录，不访问官方", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-only-models-response-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [
    { slug: "raw-model-must-not-be-returned" },
  ] }));
  fs.writeFileSync(path.join(directory, "codex-catalog.json"), JSON.stringify({ models: [
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
  ] }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("official must not be contacted in upstream-only mode");
  }) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://official.example/codex",
      upstreamBaseUrl: "https://proxy.example/v1",
      catalogPath,
      upstreamOnly: true,
      selectedModels: ["gpt-5.6-sol"],
    }, "test-key");
    const response = await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=1.2.3"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
    ] });
    const openai = await handler(new Request("http://127.0.0.1:8320/v1/models"));
    assert.deepEqual(await openai.json(), {
      object: "list",
      data: [{ id: "gpt-5.6-sol", object: "model", owned_by: "cliproxy" }],
    });
    assert.deepEqual(await (await handler(new Request("http://127.0.0.1:8320/healthz"))).json(), {
      ok: true,
      upstreamOnly: true,
      prefix: "cliproxy/",
      port: 8320,
    });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("缺失或损坏静态目录明确失败，动态模式仍回退官方目录", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-catalog-official-fallback-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  const baseConfig: GatewayConfig = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "https://proxy.example/v1",
    catalogPath,
    upstreamOnly: true,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ models: [{ slug: "gpt-official" }] })) as unknown as typeof fetch;
  try {
    const missing = createGatewayHandler(baseConfig, "test-key", "invalid");
    const upstreamOnly = await missing(new Request("http://127.0.0.1:8320/v1/models"));
    assert.equal(upstreamOnly.status, 502);
    assert.match(await upstreamOnly.text(), /Unable to load static model catalog.*models --sync/);
    const upstreamOnlyCodex = await missing(new Request("http://127.0.0.1:8320/v1/models?client_version=1"));
    assert.equal(upstreamOnlyCodex.status, 502);

    fs.writeFileSync(path.join(directory, "codex-catalog.json"), "{invalid\n");
    const corrupted = await missing(new Request("http://127.0.0.1:8320/v1/models?client_version=1"));
    assert.equal(corrupted.status, 502);

    fs.writeFileSync(catalogPath, "{invalid\n");
    const split = createGatewayHandler({ ...baseConfig, upstreamOnly: false }, "test-key", "invalid");
    const invalid = await split(new Request("http://127.0.0.1:8320/v1/models?client_version=1"));
    assert.equal(invalid.status, 200);
    assert.deepEqual(await invalid.json(), { models: [{ slug: "gpt-official" }] });

    fs.writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "cliproxy/legacy-model" }] }));
    const legacy = await split(new Request("http://127.0.0.1:8320/v1/models?client_version=3"));
    assert.deepEqual(await legacy.json(), { models: [{ slug: "gpt-official" }] });

    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const unavailable = await split(new Request("http://127.0.0.1:8320/v1/models?client_version=2"));
    assert.equal(unavailable.status, 502);
    assert.match(await unavailable.text(), /official \/models returned HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("models cache invalidation preserves models and resets freshness fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "models-cache-invalid-"));
  const cacheFile = path.join(directory, "models_cache.json");
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({
      fetched_at: "2026-08-18T00:00:00Z",
      client_version: "1.2.3",
      models: [{ slug: "gpt-current" }],
      etag: "keep",
    }));
    invalidateModelsCache(cacheFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")), {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: [{ slug: "gpt-current" }],
      etag: "keep",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clearModelsCacheEntries removes only matching slugs and expires freshness", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "models-cache-clear-"));
  const cacheFile = path.join(directory, "models_cache.json");
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({
      fetched_at: "2026-08-18T00:00:00Z",
      client_version: "1.2.3",
      models: [{ slug: "gpt-keep" }, { slug: "zcode/glm-5.3" }, { slug: "zcode/glm-5.3-flash" }],
      etag: "keep",
    }));
    const changed = clearModelsCacheEntries(cacheFile, (slug) => slug === "zcode/glm-5.3");
    assert.equal(changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")), {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: [{ slug: "gpt-keep" }, { slug: "zcode/glm-5.3-flash" }],
      etag: "keep",
    });
    // 没有命中时不得改写文件，避免每次 /models 都触发无谓写盘。
    const before = fs.readFileSync(cacheFile, "utf8");
    assert.equal(clearModelsCacheEntries(cacheFile, (slug) => slug === "absent"), false);
    assert.equal(fs.readFileSync(cacheFile, "utf8"), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("config 切换模式，models --sync 保持模式并更新独立静态目录", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "models-cpa-only-mode-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousClientVersion = process.env.CODEX_CLIPROXY_CLIENT_VERSION;
  const previousUser = process.env.USER;
  const originalFetch = globalThis.fetch;
  process.env.HOME = home;
  process.env.USER = "ccp-model-mode-test";
  delete process.env.CODEX_HOME;
  // CLIProxy 目录内容随 client_version 变化（版本过低会丢掉 max/ultra reasoning 等级），
  // 固定探测结果，断言真实版本而不是 0.0.0 被送到上游。
  process.env.CODEX_CLIPROXY_CLIENT_VERSION = "1.2.3";
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: [],
  }));
  fs.writeFileSync(paths.configToml, 'model = "gpt-native"\n');
  const clientVersions: string[] = [];
  let fetchCount = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/healthz")) throw Object.assign(new Error("测试网关未启动"), { code: "ECONNREFUSED" });
    fetchCount += 1;
    clientVersions.push(new URL(target).searchParams.get("client_version") ?? "");
    // models.json 下载（releases URL）返回空覆盖表；其余按 CLIProxy catalog 应答。
    if (target.includes("releases/latest/download/models.json")) {
      return Response.json({});
    }
    return Response.json({ models: [
      { slug: "proxy-model", context_window: 100000 },
      { slug: "hidden-model", visibility: "hide" },
    ] });
  }) as unknown as typeof fetch;

  const auditEntries = (): string => fs.readFileSync(paths.stdoutLog, "utf8");

  try {
    // 先填充原始目录，再由 config 唯一负责切换模式；后续 sync 不改变模式。
    await runCli(["models", "--sync", "--select", "all"]);
    await runCli(["config", "--upstream-only", "on"]);
    await runCli(["models", "--sync", "--select", "all"]);
    const staticFile = path.join(paths.runtimeHome, "codex-catalog.json");
    const cpaCatalog = JSON.parse(fs.readFileSync(paths.catalogFile, "utf8"));
    assert.deepEqual(cpaCatalog.models.map((model: { slug: string }) => model.slug), ["proxy-model"]);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), staticFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(staticFile, "utf8")).models, cpaCatalog.models);
    const cpaConfig = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(cpaConfig.catalogPath, paths.catalogFile);
    assert.deepEqual(cpaConfig.selectedModels, ["proxy-model"]);
    assert.equal(cpaConfig.upstreamOnly, true);
    assert.equal(cpaConfig.websocket, undefined);
    assert.match(auditEntries(), /config changed by `models --sync`/);
    assert.match(auditEntries(), /upstreamOnly: false -> true/);
    assert.match(auditEntries(), /selectedModels: \[\] -> \["proxy-model"\]/);
    assert.match(auditEntries(), /model_catalog_json \(config.toml\): null -> /);
    assert.deepEqual(clientVersions, ["1.2.3", "1.2.3"]);

    // 即使显式传入 ID，隐藏条目也不能重新同步到目录或配置。
    await assert.rejects(
      runCli(["models", "--sync", "--select", "hidden-model"]),
      /Unknown model ID: hidden-model/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).selectedModels, ["proxy-model"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.catalogFile, "utf8")).models.map(
      (model: { slug: string }) => model.slug,
    ), ["proxy-model"]);

    // 静态模式不能发布空目录：失败时保留已有配置、上游目录、静态文件与 TOML。
    const fetchesBeforeNone = fetchCount;
    const beforeNone = [paths.gatewayConfig, paths.catalogFile, staticFile, paths.configToml].map((file) => fs.readFileSync(file, "utf8"));
    await assert.rejects(runCli(["models", "--sync", "--select", "none"]), /静态模型目录为空/);
    assert.equal(fetchCount, fetchesBeforeNone, "--select none 不得访问上游目录");
    assert.deepEqual([paths.gatewayConfig, paths.catalogFile, staticFile, paths.configToml].map((file) => fs.readFileSync(file, "utf8")), beforeNone);
    await assert.rejects(
      runCli(["models", "--sync", "--select", "pass"]),
      /Unknown model ID: pass/,
    );

    fs.writeFileSync(paths.modelsCacheFile, JSON.stringify({
      fetched_at: "2026-08-18T00:00:00Z",
      client_version: "9.9.9",
      models: [{ slug: "gpt-visible" }],
    }));
    // config off 切回动态模式：删除受管键；普通 sync 仅保持保存的模式并失效缓存。
    await runCli(["config", "--upstream-only", "off"]);
    await runCli(["models", "--sync", "--select", "all"]);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.catalogFile, "utf8")).models.map(
      (model: { slug: string }) => model.slug,
    ), ["proxy-model"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.modelsCacheFile, "utf8")), {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: [{ slug: "gpt-visible" }],
    });
    const splitConfig = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(splitConfig.upstreamOnly, false);
    assert.equal(splitConfig.catalogPath, paths.catalogFile);
    assert.match(auditEntries(), /upstreamOnly: true -> false/);
    assert.match(auditEntries(), /model_catalog_json \(config.toml\): .+ -> null/);

    // 动态模式仍允许空选择：不访问上游目录，不生成静态目录指向，也不改变模式。
    const fetchesBeforeDynamicNone = fetchCount;
    await runCli(["models", "--sync", "--select", "none"]);
    assert.equal(fetchCount, fetchesBeforeDynamicNone);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.catalogFile, "utf8")).models, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).selectedModels, []);
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).upstreamOnly, false);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), undefined);
    await runCli(["models", "--sync", "--select", "all"]);

    // 单引号是合法 TOML literal string：非受管路径必须被识别并拒绝覆盖。
    fs.writeFileSync(paths.configToml, "model_catalog_json = '/tmp/user-catalog.json'\n");
    await assert.rejects(
      runCli(["config", "--upstream-only", "on"]),
      /Refusing to replace unmanaged model_catalog_json: \/tmp\/user-catalog\.json/,
    );
    await assert.rejects(
      runCli(["models", "--sync", "--select", "proxy-model"]),
      /Refusing to replace unmanaged model_catalog_json: \/tmp\/user-catalog\.json/,
    );

    // 单引号的受管路径同样被识别，可正常 patch 回双引号形式。
    fs.writeFileSync(paths.configToml, `model_catalog_json = '${paths.catalogFile}'\n`);
    await runCli(["config", "--upstream-only", "on"]);
    await runCli(["models", "--sync", "--select", "proxy-model"]);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), staticFile);

    // model_merge_json 带 token 的 URL 在审计中脱敏为 origin+path?…。
    await runCli([
      "models", "--sync", "--select", "proxy-model",
      "--model-merge-json", "https://github.com/owner/repo?token=super-secret",
    ]);
    assert.equal(
      JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).model_merge_json,
      "https://github.com/owner/repo?token=super-secret",
    );
    assert.match(auditEntries(), /model_merge_json: null -> "https:\/\/github\.com\/owner\/repo\?…"/);
    assert.equal(auditEntries().includes("super-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousClientVersion === undefined) delete process.env.CODEX_CLIPROXY_CLIENT_VERSION;
    else process.env.CODEX_CLIPROXY_CLIENT_VERSION = previousClientVersion;
    if (previousUser === undefined) delete process.env.USER;
    else process.env.USER = previousUser;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
