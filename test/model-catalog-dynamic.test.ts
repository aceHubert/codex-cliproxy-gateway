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
    cliproxyBaseUrl: "https://example.invalid",
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
    const handler = createGatewayHandler(config, "test-key", "invalid");
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
    const openai = await handler(new Request("http://127.0.0.1:8320/v1/models"));
    assert.deepEqual(await openai.json(), {
      object: "list",
      data: [
        { id: "gpt-fresh", object: "model", owned_by: "openai" },
        { id: "cliproxy/test-model", object: "model", owned_by: "cliproxy" },
      ],
    });
    assert.equal(fetchCount, 2);
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
      cliproxyBaseUrl: "https://proxy.example/v1",
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

test("CPA-only /models uses the local CPA catalog without contacting official", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-only-models-response-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
  ] }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("official must not be contacted in CPA-only mode");
  }) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://official.example/codex",
      cliproxyBaseUrl: "https://proxy.example/v1",
      catalogPath,
      cpaOnly: true,
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
      cpaOnly: true,
      prefix: "cliproxy/",
      port: 8320,
    });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("missing or invalid CPA catalog falls back to the official catalog", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-catalog-official-fallback-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  const baseConfig: GatewayConfig = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    cliproxyBaseUrl: "https://proxy.example/v1",
    catalogPath,
    cpaOnly: true,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ models: [{ slug: "gpt-official" }] })) as unknown as typeof fetch;
  try {
    const missing = createGatewayHandler(baseConfig, "test-key", "invalid");
    const cpaOnly = await missing(new Request("http://127.0.0.1:8320/v1/models"));
    assert.equal(cpaOnly.status, 200);
    assert.deepEqual(await cpaOnly.json(), {
      object: "list",
      data: [{ id: "gpt-official", object: "model", owned_by: "openai" }],
    });
    const cpaOnlyCodex = await missing(new Request("http://127.0.0.1:8320/v1/models?client_version=1"));
    assert.deepEqual(await cpaOnlyCodex.json(), { models: [{ slug: "gpt-official" }] });

    fs.writeFileSync(catalogPath, "{invalid\n");
    const split = createGatewayHandler({ ...baseConfig, cpaOnly: false }, "test-key", "invalid");
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

test("models --sync --cpa-only switches mode and plain sync restores dynamic split mode", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "models-cpa-only-mode-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const originalFetch = globalThis.fetch;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: [],
  }));
  fs.writeFileSync(paths.configToml, 'model = "gpt-native"\n');
  const clientVersions: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    clientVersions.push(new URL(target).searchParams.get("client_version") ?? "");
    // models.json 下载（releases URL）返回空覆盖表；其余按 CLIProxy catalog 应答。
    if (target.includes("releases/latest/download/models.json")) {
      return Response.json({});
    }
    return Response.json({ models: [{ slug: "proxy-model", context_window: 100000 }] });
  }) as unknown as typeof fetch;

  const auditEntries = (): string => fs.readFileSync(paths.stdoutLog, "utf8");

  try {
    // --cpa-only 切换模式并同步：cpaOnly、目录与 config.toml 三处一致，websocket 键不存在。
    await runCli(["models", "--sync", "--cpa-only", "--select", "proxy-model"]);
    const cpaCatalog = JSON.parse(fs.readFileSync(paths.catalogFile, "utf8"));
    assert.deepEqual(cpaCatalog.models.map((model: { slug: string }) => model.slug), ["proxy-model"]);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), paths.catalogFile);
    const cpaConfig = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(cpaConfig.catalogPath, paths.catalogFile);
    assert.deepEqual(cpaConfig.selectedModels, ["proxy-model"]);
    assert.equal(cpaConfig.cpaOnly, true);
    assert.equal(cpaConfig.websocket, undefined);
    assert.match(auditEntries(), /config changed by `models --sync`/);
    assert.match(auditEntries(), /cpaOnly: false -> true/);
    assert.match(auditEntries(), /selectedModels: \[\] -> \["proxy-model"\]/);
    assert.match(auditEntries(), /model_catalog_json \(config.toml\): null -> /);
    assert.deepEqual(clientVersions, ["0.0.0"]);

    // CPA-only 模式要求非空选择；"pass" 不再是特殊值，按普通模型 ID 解析报未知。
    await assert.rejects(
      runCli(["models", "--sync", "--cpa-only", "--select", "none"]),
      /Select at least one CLIProxy model/,
    );
    await assert.rejects(
      runCli(["models", "--sync", "--cpa-only", "--select", "pass"]),
      /Unknown model ID: pass/,
    );

    fs.writeFileSync(paths.modelsCacheFile, JSON.stringify({
      fetched_at: "2026-08-18T00:00:00Z",
      client_version: "9.9.9",
      models: [{ slug: "gpt-visible" }],
    }));
    // 普通 sync 切回 split：删除受管 model_catalog_json 并失效 Codex 模型缓存。
    await runCli(["models", "--sync", "--select", "proxy-model"]);
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
    assert.equal(splitConfig.cpaOnly, false);
    assert.equal(splitConfig.catalogPath, paths.catalogFile);
    assert.match(auditEntries(), /cpaOnly: true -> false/);
    assert.match(auditEntries(), /model_catalog_json \(config.toml\): .+ -> null/);

    // 单引号是合法 TOML literal string：非受管路径必须被识别并拒绝覆盖。
    fs.writeFileSync(paths.configToml, "model_catalog_json = '/tmp/user-catalog.json'\n");
    await assert.rejects(
      runCli(["models", "--sync", "--cpa-only", "--select", "proxy-model"]),
      /Refusing to replace unmanaged model_catalog_json: \/tmp\/user-catalog\.json/,
    );
    await assert.rejects(
      runCli(["models", "--sync", "--select", "proxy-model"]),
      /Refusing to replace unmanaged model_catalog_json: \/tmp\/user-catalog\.json/,
    );

    // 单引号的受管路径同样被识别，可正常 patch 回双引号形式。
    fs.writeFileSync(paths.configToml, `model_catalog_json = '${paths.catalogFile}'\n`);
    await runCli(["models", "--sync", "--cpa-only", "--select", "proxy-model"]);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), paths.catalogFile);

    // model_merge_json 带 token 的 URL 在审计中脱敏为 origin+path?…。
    await runCli([
      "models", "--sync", "--cpa-only", "--select", "proxy-model",
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
    fs.rmSync(home, { recursive: true, force: true });
  }
});
