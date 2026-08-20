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

test("dynamic /models refreshes official cache and merges only CLIProxy rows", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-models-response-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  const cachePath = path.join(directory, "runtime", "models-cache.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [
    { slug: "gpt-stale", context_window: 200000 },
    { slug: "cliproxy/test-model", context_window: 100000 },
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
  let captured: { url: string; headers: Headers } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    captured = { url: String(url), headers: new Headers(options?.headers) };
    return Response.json({ models: [{ slug: "gpt-fresh", context_window: 300000, priority: 7 }] });
  }) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(config, "test-key", "invalid", cachePath);
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
      { slug: "cliproxy/test-model", context_window: 100000, priority: 107 },
    ] });
    assert.equal(captured?.url, "https://official.example/codex/models?client_version=1.2.3");
    assert.equal(captured?.headers.get("authorization"), "Bearer oauth-token");
    assert.equal(captured?.headers.get("chatgpt-account-id"), "account-1");
    assert.equal(captured?.headers.get("if-none-match"), null);
    const writtenCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.match(writtenCache.fetched_at, /^2026-/);
    assert.deepEqual(writtenCache, {
      fetched_at: writtenCache.fetched_at,
      client_version: "1.2.3",
      models: [{ slug: "gpt-fresh", context_window: 300000, priority: 7 }],
    });

    const openai = await handler(new Request("http://127.0.0.1:8320/v1/models"));
    assert.deepEqual(await openai.json(), {
      object: "list",
      data: [
        { id: "gpt-fresh", object: "model", owned_by: "openai" },
        { id: "cliproxy/test-model", object: "model", owned_by: "cliproxy" },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("dynamic /models keeps last-good cache when official refresh fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-models-fallback-"));
  const catalogPath = path.join(directory, "cliproxy-catalog.json");
  const cachePath = path.join(directory, "models-cache.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "cliproxy/test-model" }] }));
  const cached = {
    fetched_at: "2026-08-18T00:00:00Z",
    client_version: "1.2.2",
    models: [{ slug: "gpt-last-good" }],
  };
  fs.writeFileSync(cachePath, JSON.stringify(cached));
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
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { models: [
      { slug: "gpt-last-good" },
      { slug: "cliproxy/test-model", priority: 100 },
    ] });
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), cached);

    fs.rmSync(cachePath);
    const unavailable = await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=1.2.3"));
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

test("static sync requires official cache and switches back to dynamic mode", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "models-static-mode-"));
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
  let fetchCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls += 1;
    assert.equal(new URL(String(url)).searchParams.get("client_version"), "9.9.9");
    return Response.json({ models: [{ slug: "proxy-model", context_window: 100000 }] });
  }) as unknown as typeof fetch;

  try {
    await assert.rejects(
      runCli(["models", "--sync", "--static", "--select", "proxy-model"]),
      /Official models cache not found/,
    );
    assert.equal(fetchCalls, 0);

    fs.writeFileSync(paths.upstreamModelsCacheFile, JSON.stringify({
      fetched_at: "2026-08-18T00:00:00Z",
      client_version: "9.9.9",
      models: [{ slug: "gpt-official", context_window: 300000 }],
    }));
    await runCli(["models", "--sync", "--static", "--select", "proxy-model"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.staticCatalogFile, "utf8")).models.map(
      (model: { slug: string }) => model.slug,
    ), ["gpt-official", "cliproxy/proxy-model"]);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), paths.staticCatalogFile);

    fs.writeFileSync(paths.modelsCacheFile, JSON.stringify({
      fetched_at: "2026-08-18T00:00:00Z",
      client_version: "9.9.9",
      models: [{ slug: "gpt-visible" }],
    }));
    await runCli(["models", "--sync", "--select", "proxy-model"]);
    assert.equal(readRootTomlString(fs.readFileSync(paths.configToml, "utf8"), "model_catalog_json"), undefined);
    assert.equal(fs.existsSync(paths.staticCatalogFile), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.catalogFile, "utf8")).models.map(
      (model: { slug: string }) => model.slug,
    ), ["cliproxy/proxy-model"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.modelsCacheFile, "utf8")), {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: [{ slug: "gpt-visible" }],
    });

    fs.writeFileSync(paths.configToml, 'model_catalog_json = "/tmp/user-catalog.json"\n');
    const callsBeforeRefusal = fetchCalls;
    await assert.rejects(
      runCli(["models", "--sync", "--select", "proxy-model"]),
      /Refusing to replace unmanaged model_catalog_json/,
    );
    assert.equal(fetchCalls, callsBeforeRefusal);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
