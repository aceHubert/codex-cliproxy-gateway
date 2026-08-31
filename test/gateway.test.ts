import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import type { ReadStream, WriteStream } from "node:tty";
import { createGatewayHandler, decideRoute, isLoopbackUrl, joinUpstreamUrl, responsesWebSocketTarget } from "../src/gateway.ts";
import {
  GATEWAY_CONFIG_SCHEMA_URL,
  GATEWAY_CONFIG_VERSION,
  gatewayConfigWarnings,
  mergeMissingConfig,
} from "../src/config.ts";
import { patchRootToml, restoreRootTomlKeys } from "../src/toml.ts";
import { httpLogFile, websocketLogFile } from "../src/request-log.ts";
import { resolvePaths } from "../src/paths.ts";
import {
  fetchCliProxyCatalog,
  loadModelOverrides,
  mergeCatalog,
  resolveModelMergeJson,
  syncCatalog,
} from "../src/catalog.ts";
import {
  applyRoutingMode,
  formatErrorLog,
  removeManagedRuntimeFiles,
  syncGatewayConfigFile,
} from "../src/cli.ts";
import {
  applyModelPickerKey,
  chooseModels,
  modelPickerEntries,
  parseModelSelection,
  selectedModelsFromCatalog,
} from "../src/models.ts";

test("error logs include a timestamp separator and omit blank lines", () => {
  assert.equal(
    formatErrorLog(new Error("first\n\n  \nsecond"), new Date("2026-08-18T02:30:00.000Z")),
    "--2026-08-18T02:30:00.000Z--\nError: first\nsecond",
  );
});

test("error logs keep the error class name and optional label and stack", () => {
  const failure = new TypeError("null is not an object");
  failure.stack = "TypeError: null is not an object\n    at readableStream (:1:20)";
  assert.equal(
    formatErrorLog(failure, new Date("2026-08-19T04:00:00.000Z"), { label: "uncaughtException", stack: true }),
    [
      "--2026-08-19T04:00:00.000Z--",
      "uncaughtException: TypeError: null is not an object",
      "    at readableStream (:1:20)",
    ].join("\n"),
  );
  assert.equal(
    formatErrorLog("plain failure", new Date("2026-08-19T04:00:00.000Z")),
    "--2026-08-19T04:00:00.000Z--\nError: plain failure",
  );
});

test("only cliproxy prefix is routed away from official", () => {
  assert.deepEqual(decideRoute("cliproxy/claude-opus-4-6"), {
    kind: "cliproxy",
    upstreamModel: "claude-opus-4-6",
  });
  assert.deepEqual(decideRoute("codex-auto-review"), {
    kind: "official",
    upstreamModel: "codex-auto-review",
  });
  assert.deepEqual(decideRoute("gpt-5.6-sol"), {
    kind: "official",
    upstreamModel: "gpt-5.6-sol",
  });
});

test("only loopback CLIProxy URLs may omit authentication", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8317/v1"), true);
  assert.equal(isLoopbackUrl("http://localhost:8317/v1"), true);
  assert.equal(isLoopbackUrl("http://[::1]:8317/v1"), true);
  assert.equal(isLoopbackUrl("https://cliproxy.example/v1"), false);
});

test("upstream URL removes the local /v1 mount", () => {
  assert.equal(
    joinUpstreamUrl("https://chatgpt.com/backend-api/codex", "http://127.0.0.1:8320/v1/responses?x=1"),
    "https://chatgpt.com/backend-api/codex/responses?x=1",
  );
  assert.equal(
    joinUpstreamUrl("http://127.0.0.1:8317/v1", "http://127.0.0.1:8320/v1/responses"),
    "http://127.0.0.1:8317/v1/responses",
  );
});

test("TOML patch preserves comments, tables, and unrelated formatting", () => {
  const source = '# header\nmodel = "gpt-5.6-sol" # keep\n\n[features]\nfast_mode = true\n';
  const result = patchRootToml(source, {
    openai_base_url: "http://127.0.0.1:8320/v1",
    model_catalog_json: "/Users/test/.codex-cliproxy-gateway/cliproxy-catalog.json",
  });
  assert.match(result, /model = "gpt-5.6-sol" # keep/);
  assert.match(result, /\[features\]\nfast_mode = true/);
  assert.match(result, /openai_base_url = "http:\/\/127\.0\.0\.1:8320\/v1"/);
});

test("paths keep Codex files separate from gateway runtime files", () => {
  const paths = resolvePaths({ HOME: "/Users/test" });
  assert.equal(paths.catalogFile, "/Users/test/.codex-cliproxy-gateway/cliproxy-catalog.json");
  assert.equal(paths.modelMergeFile, "/Users/test/.codex-cliproxy-gateway/models.json");
  assert.equal(paths.modelsCacheFile, "/Users/test/.codex/models_cache.json");
  assert.equal(paths.gatewayConfig, "/Users/test/.codex-cliproxy-gateway/config.json");
  assert.equal(paths.stateFile, "/Users/test/.codex-cliproxy-gateway/state.json");
  assert.equal(paths.stdoutLog, "/Users/test/.codex-cliproxy-gateway/gateway.log");
  assert.equal(paths.logDir, "/Users/test/.codex-cliproxy-gateway/logs");
});

test("TOML uninstall restores only managed keys after manual edits", () => {
  const backup = 'openai_base_url = "https://old.example/v1" # original\nmodel = "gpt-old"\n';
  const current = 'openai_base_url = "http://127.0.0.1:8320/v1"\nmodel_catalog_json = "/Users/test/.codex-cliproxy-gateway/cliproxy-catalog.json"\nmodel = "gpt-new"\n';
  assert.equal(
    restoreRootTomlKeys(current, backup, ["openai_base_url", "model_catalog_json"]),
    'openai_base_url = "https://old.example/v1" # original\nmodel = "gpt-new"\n',
  );
});

test("gateway config sync only adds missing values", () => {
  const current = {
    host: "user-host",
    removed_option: true,
    nested: { userValue: 1 },
  };
  const { config, added } = mergeMissingConfig(current, {
    host: "127.0.0.1",
    port: 8320,
    nested: { userValue: 0, newValue: 2 },
  });
  assert.deepEqual(config, {
    host: "user-host",
    port: 8320,
    removed_option: true,
    nested: { userValue: 1, newValue: 2 },
  });
  assert.deepEqual(added, ["port", "nested.newValue"]);
  assert.deepEqual(current, {
    host: "user-host",
    removed_option: true,
    nested: { userValue: 1 },
  });
});

test("gateway JSON Schema warns without rejecting obsolete config", () => {
  const warnings = gatewayConfigWarnings({
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: "8320",
    mountPath: "v1",
    prefix: "cliproxy/",
    officialBaseUrl: "not a URL",
    cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: "/tmp/catalog.json",
    logDir: "",
    selectedModels: ["one", "one"],
    cpaOnly: "yes",
    removed_option: true,
  });
  assert.deepEqual(warnings, [
    "$.port should be integer",
    "$.mountPath has an invalid format",
    "$.officialBaseUrl should be a valid URI",
    "$.selectedModels should not contain duplicates",
    "$.logDir should not be empty",
    "$.cpaOnly should be boolean",
  ]);
});

test("command preflight syncs package version and only adds config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-sync-test-"));
  const paths = resolvePaths({ HOME: home });
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    configVersion: "0.1.0",
    host: "user-host",
    port: 9000,
    mountPath: "/custom",
    prefix: "user/",
    officialBaseUrl: "https://official.example/v1",
    cliproxyBaseUrl: "https://proxy.example/v1",
    catalogPath: "/user/catalog.json",
    removed_option: "keep",
    websocket: true,
  }));
  try {
    syncGatewayConfigFile(paths);
    const config = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(config.configVersion, GATEWAY_CONFIG_VERSION);
    assert.equal(config.$schema, GATEWAY_CONFIG_SCHEMA_URL);
    assert.equal(config.host, "user-host");
    assert.equal(config.port, 9000);
    assert.equal(config.catalogPath, "/user/catalog.json");
    assert.equal(config.requestLogging, false);
    assert.equal(config.logDir, paths.logDir);
    // 遗留的 websocket 开关被清除，不再作为默认值写回。
    assert.equal(config.websocket, undefined);
    assert.equal(config.removed_option, "keep");

    // preflight 写盘也要留审计：记录版本迁移、补齐字段与 websocket 清理。
    const auditDir = paths.logDir;
    const auditFiles = fs.readdirSync(auditDir).filter((name) => name.startsWith("cliproxy-config-"));
    assert.equal(auditFiles.length, 1);
    const auditText = fs.readFileSync(path.join(auditDir, auditFiles[0]), "utf8");
    assert.match(auditText, /config changed by `config sync`/);
    assert.match(auditText, /configVersion: "0\.1\.0" -> /);
    assert.match(auditText, /websocket \(removed\): true -> null/);
    assert.match(auditText, /requestLogging: null -> false/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("routing mode reset makes reinstall use dynamic split configuration", () => {
  const paths = resolvePaths({ HOME: "/Users/test" });
  const config = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    cpaOnly: true,
  };
  applyRoutingMode(config, paths, false);
  assert.equal(config.cpaOnly, false);
  assert.equal(config.catalogPath, paths.catalogFile);
});

test("command preflight migrates only the managed legacy catalog path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-legacy-catalog-path-"));
  const paths = resolvePaths({ HOME: home });
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const legacyCatalogFile = path.join(paths.codexHome, "cliproxy-catalog.json");
  fs.writeFileSync(legacyCatalogFile, "keep\n");
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: legacyCatalogFile,
  }));
  try {
    syncGatewayConfigFile(paths);
    const config = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(config.catalogPath, paths.catalogFile);
    assert.equal(fs.readFileSync(legacyCatalogFile, "utf8"), "keep\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("catalog prefixes CLIProxy models and preserves their metadata", () => {
  const native = {
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      supports_reasoning_summaries: false,
    }],
  };
  const merged = mergeCatalog(native, { models: [
    {
      slug: "claude-opus-4-6",
      display_name: "Claude Opus 4.6 (Thinking)",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "xhigh", description: "Extra high" }],
      supports_reasoning_summaries: true,
    },
    { slug: "gemini-3.1-pro", display_name: "Gemini 3.1 Pro" },
  ] });
  assert.equal(merged.models[0].slug, "gpt-5.6-sol");
  assert.equal(merged.models[1].slug, "cliproxy/claude-opus-4-6");
  assert.equal(merged.models[2].slug, "cliproxy/gemini-3.1-pro");
  assert.equal(merged.models[1].display_name, "Claude Opus 4.6 (Thinking)");
  assert.equal(merged.models[2].display_name, "Gemini 3.1 Pro");
  assert.equal(merged.models[1].default_reasoning_level, "medium");
  assert.deepEqual(merged.models[1].supported_reasoning_levels, [
    { effort: "xhigh", description: "Extra high" },
  ]);
  assert.equal(merged.models[1].supports_reasoning_summaries, true);
});

test("catalog applies the first matching case-insensitive override before prefixing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-overrides-test-"));
  const configFile = path.join(tempDir, "models.json");
  fs.writeFileSync(configFile, JSON.stringify({
    openai: [
      { name: "gpt-5.6-sol", context_window: 373000 },
      {
        name: "GPT-5.6-*",
        context_window: 372000,
        max_context_window: 372000,
        effective_context_window_percent: 95,
      },
    ],
    "Z.AI": [{ name: "glm-5.2", context_window: 1_000_000, max_context_window: 1_000_000 }],
  }));
  const native = { models: [
    { slug: "gpt-5.6-sol", context_window: 272000 },
    { slug: "gpt-5.6-terra", context_window: 272000 },
  ] };
  const proxy = { models: [
    { slug: "GPT-5.6-TERRA", context_window: 272000 },
    { slug: "z.ai/GLM-5.2", context_window: 272000 },
  ] };

  try {
    const merged = mergeCatalog(native, proxy, "cliproxy/", loadModelOverrides(configFile));
    assert.equal(merged.models[0].context_window, 373000);
    assert.equal(merged.models[0].max_context_window, undefined);
    assert.equal(merged.models[1].context_window, 372000);
    assert.equal(merged.models[2].slug, "cliproxy/GPT-5.6-TERRA");
    assert.equal(merged.models[2].effective_context_window_percent, 95);
    assert.equal(merged.models[3].slug, "cliproxy/z.ai/GLM-5.2");
    assert.equal(merged.models[3].context_window, 1_000_000);
    assert.equal(native.models[0].context_window, 272000);
    assert.equal(proxy.models[1].context_window, 272000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("display-name [1m] has no implicit context override", () => {
  const merged = mergeCatalog({ models: [] }, { models: [{
    slug: "z.ai/glm-5.2",
    display_name: "glm-5.2[1m]",
    context_window: 272000,
  }] });
  assert.equal(merged.models[0].context_window, 272000);
});

test("model merge JSON resolves GitHub repositories and direct HTTP files", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-merge-json-test-"));
  const cacheFile = path.join(tempDir, "cache", "models.json");
  const bundledFile = path.join(tempDir, "bundled.json");
  const url = "https://github.com/example/models/";
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  let downloads = 0;
  fs.writeFileSync(bundledFile, '{"openai":[]}\n');
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    downloads += 1;
    return new Response(`{"openai":[{"name":"gpt-${downloads}"}]}`);
  }) as unknown as typeof fetch;
  try {
    assert.equal(await resolveModelMergeJson(cacheFile, bundledFile), bundledFile);
    assert.equal(await resolveModelMergeJson(cacheFile, bundledFile, url), cacheFile);
    assert.equal(downloads, 1);
    assert.equal(requestedUrls[0], `${url}releases/latest/download/models.json`);
    assert.equal(await resolveModelMergeJson(cacheFile, bundledFile, url), cacheFile);
    assert.equal(downloads, 1);
    await resolveModelMergeJson(cacheFile, bundledFile, "http://downloads.example/models.json", true);
    assert.equal(downloads, 2);
    assert.equal(requestedUrls[1], "http://downloads.example/models.json");
    assert.match(fs.readFileSync(cacheFile, "utf8"), /gpt-2/);
    globalThis.fetch = (async () => new Response("{invalid")) as unknown as typeof fetch;
    await assert.rejects(resolveModelMergeJson(cacheFile, bundledFile, url, true), /Invalid model overrides/);
    assert.match(fs.readFileSync(cacheFile, "utf8"), /gpt-2/);
    await assert.rejects(
      resolveModelMergeJson(cacheFile, bundledFile, "https://example.com/downloads/", true),
      /file name/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runtime cleanup preserves user files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-cleanup-test-"));
  const paths = resolvePaths({ HOME: home });
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  for (const file of [
    paths.gatewayConfig,
    paths.stateFile,
    paths.catalogFile,
    path.join(paths.runtimeHome, "catalog-metadata.json"),
    paths.modelMergeFile,
    paths.stdoutLog,
    paths.stderrLog,
  ]) {
    fs.writeFileSync(file, "test\n");
  }
  const userFile = path.join(paths.runtimeHome, "notes.txt");
  fs.writeFileSync(userFile, "keep\n");
  try {
    removeManagedRuntimeFiles(paths);
    assert.equal(fs.existsSync(paths.gatewayConfig), false);
    assert.equal(fs.existsSync(paths.stateFile), false);
    assert.equal(fs.existsSync(paths.catalogFile), false);
    assert.equal(fs.existsSync(path.join(paths.runtimeHome, "catalog-metadata.json")), false);
    assert.equal(fs.existsSync(paths.modelMergeFile), false);
    assert.equal(fs.existsSync(userFile), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall cleanup preserves gateway config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-config-test-"));
  const paths = resolvePaths({ HOME: home });
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, '{"custom":true}\n');
  fs.writeFileSync(paths.stateFile, "test\n");
  try {
    removeManagedRuntimeFiles(paths, { preserveGatewayConfig: true });
    assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), '{"custom":true}\n');
    assert.equal(fs.existsSync(paths.stateFile), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("invalid model overrides leave the generated catalog unchanged", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-invalid-test-"));
  const catalogFile = path.join(tempDir, "catalog.json");
  const modelsConfigFile = path.join(tempDir, "models.json");
  fs.writeFileSync(catalogFile, "keep\n");
  fs.writeFileSync(modelsConfigFile, "{invalid\n");
  try {
    await assert.rejects(syncCatalog({
      catalogFile,
      modelsConfigFile,
      proxyModels: [],
    }), /Invalid model overrides/);
    assert.equal(fs.readFileSync(catalogFile, "utf8"), "keep\n");

    fs.writeFileSync(modelsConfigFile, JSON.stringify({ openai: [{ name: "gpt*bad" }] }));
    assert.throws(() => loadModelOverrides(modelsConfigFile), /only one trailing \*/);
    fs.writeFileSync(modelsConfigFile, JSON.stringify({ openai: [{ name: "gpt", slug: "other" }] }));
    assert.throws(() => loadModelOverrides(modelsConfigFile), /may not override slug or priority/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("official Realtime routes are reserved with 426 before generic forwarding", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  }) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "proxy-key");
    const requests = [
      new Request("http://127.0.0.1:8320/v1/live"),
      new Request("http://127.0.0.1:8320/v1/live/rtc_test", { headers: { upgrade: "websocket" } }),
      new Request("http://127.0.0.1:8320/v1/realtime?model=gpt-live", { headers: { upgrade: "websocket" } }),
      new Request("http://127.0.0.1:8320/v1/realtime/calls/rtc_test", { method: "POST", body: "call" }),
    ];

    for (const request of requests) {
      const response = await handler(request);
      assert.equal(response.status, 426);
      assert.equal(response.headers.get("x-codex-cliproxy-gateway"), "official-realtime-not-implemented");
      assert.equal((await response.json() as { error: { code: string } }).error.code, "official_realtime_proxy_not_implemented");
    }
    assert.equal(fetchCalls, 0);

    const passthrough = await handler(new Request("http://127.0.0.1:8320/v1/realtime/transcription_sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(passthrough.status, 200);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("official route preserves OAuth and exact model", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; options: RequestInit } | undefined;
  globalThis.fetch = (async (url, options) => {
    captured = { url: String(url), options: options ?? {} };
    return new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-auto-review", input: "test" }),
    }));
    assert.ok(captured);
    assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(new Headers(captured.options.headers).get("authorization"), "Bearer oauth-token");
    assert.equal(JSON.parse(new TextDecoder().decode(captured.options.body as ArrayBuffer)).model, "codex-auto-review");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-boolean cpaOnly never enables CPA routing", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  globalThis.fetch = (async (url) => {
    upstreamUrl = String(url);
    return new Response("ok");
  }) as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://official.example/codex",
      cliproxyBaseUrl: "https://proxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
      cpaOnly: "false" as unknown as boolean,
    }, "");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol" }),
    }));
    assert.equal(upstreamUrl, "https://official.example/codex/responses");
    assert.equal((await (await handler(new Request("http://127.0.0.1:8320/healthz"))).json()).cpaOnly, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLIProxy route strips prefix and replaces or clears OAuth", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; options: RequestInit } | undefined;
  globalThis.fetch = (async (url, options) => {
    captured = { url: String(url), options: options ?? {} };
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "test" }),
    }));
    assert.ok(captured);
    assert.equal(captured.url, "https://cliproxy.example/v1/responses");
    assert.equal(new Headers(captured.options.headers).get("authorization"), "Bearer proxy-key");
    assert.equal(JSON.parse(captured.options.body as string).model, "claude-opus-4-6");

    const localHandler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "");
    await localHandler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "test" }),
    }));
    assert.equal(new Headers(captured.options.headers).get("authorization"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zstd CLIProxy request is decoded, routed, and rewritten", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; options: RequestInit } | undefined;
  globalThis.fetch = (async (url, options) => {
    captured = { url: String(url), options: options ?? {} };
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer oauth-token",
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: zstdCompressSync(JSON.stringify({ model: "cliproxy/gemini-3.6-flash-high", input: "test" })),
    }));
    assert.ok(captured);
    assert.equal(captured.url, "https://cliproxy.example/v1/responses");
    assert.equal(new Headers(captured.options.headers).get("authorization"), "Bearer proxy-key");
    assert.equal(new Headers(captured.options.headers).get("content-encoding"), null);
    assert.equal(JSON.parse(captured.options.body as string).model, "gemini-3.6-flash-high");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** 日志落盘改为异步（避免读流阻塞 SSE），测试需轮询等待文件出现。 */
async function waitForLogFile(dir: string, pattern: RegExp, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = fs.readdirSync(dir).find((name) => pattern.test(name));
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`no log matching ${pattern}; found: ${fs.readdirSync(dir).join(", ") || "(empty)"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 按"新出现的文件"等待，避免用当天日期写死正则——跨天就会失配。 */
async function waitForNewLogFile(
  dir: string,
  before: ReadonlySet<string>,
  prefix: string,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = fs.readdirSync(dir).find((name) => name.startsWith(prefix) && !before.has(name));
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`no new log with prefix ${prefix}; found: ${fs.readdirSync(dir).join(", ") || "(empty)"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function logTestConfig(logDir: string, maxRequestLogs = 0) {
  return {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    cliproxyBaseUrl: "https://cliproxy.example/v1",
    catalogPath: "/tmp/missing-catalog.json",
    requestLogging: true,
    logDir,
    maxRequestLogs,
  };
}

test("request logs start with an ISO request-time separator", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-log-test-"));
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
      requestLogging: true,
      logDir,
    }, "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "chatgpt-account-id": "secret-account",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "test" }),
    }));

    const logFile = await waitForLogFile(logDir, /^cliproxy-v1-responses-http-\d{14}\.log$/);
    const [separator, header] = fs.readFileSync(path.join(logDir, logFile), "utf8").split("\n");
    assert.match(separator, /^--\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}--$/);
    assert.equal(header, "=== POST /v1/responses ===");
    const log = fs.readFileSync(path.join(logDir, logFile), "utf8");
    assert.doesNotMatch(log, /secret-token|secret-account/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("official and live traffic land in their own route log files", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-route-log-"));
  globalThis.fetch = (async () => new Response("sdp-answer", {
    status: 201,
    headers: { location: "/v1/realtime/calls/rtc_test" },
  })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key", "builtin");

    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer official-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi" }),
    }));
    await handler(new Request("http://127.0.0.1:8320/v1/live", {
      method: "POST",
      headers: {
        authorization: "Bearer live-token",
        "chatgpt-account-id": "live-account",
        "x-oai-attestation": "attestation-secret-value",
        "content-type": "application/sdp",
      },
      body: "v=0\r\n",
    }));

    const officialLog = await waitForLogFile(logDir, /^cliproxy-v1-responses-http-\d{14}\.log$/);
    assert.match(fs.readFileSync(path.join(logDir, officialLog), "utf8"), /=== POST \/v1\/responses ===/);

    const liveLog = await waitForLogFile(logDir, /^cliproxy-v1-live-http-\d{14}\.log$/);
    const live = fs.readFileSync(path.join(logDir, liveLog), "utf8");
    assert.match(live, /=== POST \/v1\/live ===/);
    // 上游实际去向只有 realtime 层知道，wrapper 看不到，必须由 call-create 事件补记。
    assert.match(live, /\[realtime\] call-create https:\/\/chatgpt\.com\/backend-api\/codex\/realtime\/calls/);
    assert.match(live, /"status":201/);
    // attestation 是凭据，必须遮蔽。
    assert.doesNotMatch(live, /attestation-secret-value/);
    assert.match(live, /x-oai-attestation: \*\*\*/);

    assert.equal(fs.readdirSync(logDir).some((name) => name.startsWith("cliproxy-cliproxy-")), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("catalog and health probes are excluded from request logs", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-skip-log-"));
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/healthz"));
    await handler(new Request("http://127.0.0.1:8320/v1/models"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fs.existsSync(logDir) ? fs.readdirSync(logDir) : [], []);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("failed requests are written to both the route log and the error digest", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-error-log-"));
  globalThis.fetch = (async () => {
    throw new Error("upstream exploded");
  }) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "hi" }),
    }));
    assert.equal(response.status, 502);

    const errorLog = await waitForLogFile(logDir, /^cliproxy-error-\d{14}\.log$/);
    const digest = fs.readFileSync(path.join(logDir, errorLog), "utf8");
    assert.match(digest, /!!! POST \/v1\/responses -> 502 !!!/);
    assert.match(digest, /message: Gateway upstream request failed/);
    assert.match(digest, /duration: \d+ms/);

    // 同一条错误也保留在路由日志里，便于回溯完整请求上下文。
    const routeLog = await waitForLogFile(logDir, /^cliproxy-v1-responses-http-\d{14}\.log$/);
    assert.match(fs.readFileSync(path.join(logDir, routeLog), "utf8"), /-> 502 !!!/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("logging does not buffer streaming responses", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-stream-log-"));
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      await gate;
      controller.enqueue(new TextEncoder().encode("data: done\n\n"));
      controller.close();
    },
  }), { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    const response = await Promise.race([
      handler(new Request("http://127.0.0.1:8320/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", stream: true }),
      })),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("handler blocked until the response stream finished")),
        1000,
      )),
    ]);
    assert.equal(response.status, 200);
    release();
    assert.match(await response.text(), /data: done/);
  } finally {
    release();
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("maxRequestLogs keeps only the newest files per group", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-log-cap-"));
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    for (const stamp of ["20260101000001", "20260101000002", "20260101000003", "20260101000004"]) {
      fs.writeFileSync(path.join(logDir, `cliproxy-v1-responses-http-${stamp}.log`), "old\n");
    }
    // 其它分组独立计数，不应被挤掉。
    fs.writeFileSync(path.join(logDir, "cliproxy-v1-live-http-20260101000001.log"), "keep\n");
    const seeded = new Set(fs.readdirSync(logDir));

    const handler = createGatewayHandler(logTestConfig(logDir, 2), "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "hi" }),
    }));
    const current = await waitForNewLogFile(logDir, seeded, "cliproxy-v1-responses-http-");

    const remaining = fs.readdirSync(logDir).filter((name) => name.startsWith("cliproxy-v1-responses-http-")).sort();
    assert.deepEqual(remaining, ["cliproxy-v1-responses-http-20260101000004.log", current].sort());
    assert.equal(fs.existsSync(path.join(logDir, "cliproxy-v1-live-http-20260101000001.log")), true);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("protocol negotiation 426 is logged but kept out of the error digest", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-426-log-"));
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    // Codex Desktop 每次会话都会先试探 Responses over WebSocket，被拒后降级到 HTTPS/SSE。
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "openai-beta": "responses_websockets=2026-02-06",
      },
    }));
    assert.equal(response.status, 426);

    const routeLog = await waitForLogFile(logDir, /^cliproxy-v1-responses-http-\d{14}\.log$/);
    // 请求本身仍要留痕，只是不该被当成故障。
    assert.match(fs.readFileSync(path.join(logDir, routeLog), "utf8"), /response status: 426/);
    assert.equal(fs.readdirSync(logDir).some((name) => name.startsWith("cliproxy-error-")), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("routing hint decides the upstream and lets official traffic skip body decoding", async () => {
  const originalFetch = globalThis.fetch;
  const captured: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    captured.push(String(url instanceof Request ? url.url : url));
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const config = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/v1",
    cliproxyBaseUrl: "https://proxy.example/v1",
    catalogPath: "/tmp/missing-catalog.json",
  };
  try {
    const cpaThreads = new Set<string>();
    const handler = createGatewayHandler(config, "proxy-key", "invalid", cpaThreads);

    // hint 指向 cliproxy：即便 payload 无前缀也要走 CLIProxy，并把 model 改写成去前缀的名字。
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push(String(url instanceof Request ? url.url : url));
      sent = init;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "thread-id": "thread-cpa",
        "x-codex-routing-hint": "model=cliproxy/claude-opus-4-6;tier=ultrafast",
      },
      body: JSON.stringify({ model: "claude-opus-4-6", input: "hi" }),
    }));
    assert.equal(captured.at(-1), "https://proxy.example/v1/responses");
    assert.equal(
      new Headers(sent?.headers).get("x-codex-routing-hint"),
      "model=claude-opus-4-6;tier=ultrafast",
    );
    assert.equal(JSON.parse(String(sent?.body)).model, "claude-opus-4-6");

    // 同一 thread 首次出现 cliproxy/ 后，无前缀 Luna 标题请求也固定走 CPA。
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "thread-id": "thread-cpa",
        "x-codex-routing-hint": "model=gpt-5.6-luna",
      },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "generate title" }),
    }));
    assert.equal(captured.at(-1), "https://proxy.example/v1/responses");
    assert.equal(new Headers(sent?.headers).get("authorization"), "Bearer proxy-key");
    assert.equal(JSON.parse(String(sent?.body)).model, "gpt-5.6-luna");

    // 子智能体使用独立 thread/WS，但父 thread 已固定 CPA 时必须继承同一上游。
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "thread-id": "thread-guardian",
        "x-codex-parent-thread-id": "thread-cpa",
        "x-codex-routing-hint": "model=codex-auto-review",
      },
      body: JSON.stringify({ model: "codex-auto-review", input: "review" }),
    }));
    assert.equal(captured.at(-1), "https://proxy.example/v1/responses");
    assert.equal(cpaThreads.has("thread-guardian"), true);

    // 另一个没有 cliproxy 信号的 thread 仍走官方，不能被同 session 的 CPA thread 污染。
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer official-oauth",
        "content-type": "application/json",
        "thread-id": "thread-official",
        "x-codex-routing-hint": "model=gpt-5.6-luna",
      },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "generate title" }),
    }));
    assert.equal(captured.at(-1), "https://official.example/v1/responses");
    assert.equal(new Headers(sent?.headers).get("authorization"), "Bearer official-oauth");

    // hint 指向官方：body 是无法解压的垃圾字节，仍应原样透传而不是 400。
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "x-codex-routing-hint": "model=gpt-5.6-luna",
      },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    }));
    assert.equal(response.status, 200);
    assert.equal(captured.at(-1), "https://official.example/v1/responses");

    // 无 hint 时回落到 payload。
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "hi" }),
    }));
    assert.equal(captured.at(-1), "https://proxy.example/v1/responses");

    // 两者皆无时归官方。
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    }));
    assert.equal(captured.at(-1), "https://official.example/v1/responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responses WebSocket target routes by hint and swaps auth for cliproxy", () => {
  const config = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    cliproxyBaseUrl: "https://cliproxy.example/v1",
    catalogPath: "/tmp/missing-catalog.json",
  };
  const probeHeaders = {
    upgrade: "websocket",
    authorization: "Bearer original-oauth",
    "chatgpt-account-id": "acct-1",
    "x-api-key": "openai-key",
    "x-goog-api-key": "google-key",
    "openai-beta": "responses_websockets=2026-02-06",
    "sec-websocket-key": "handshake-material",
    "x-codex-routing-hint": "model=cliproxy/claude-opus-4-6",
  };

  // split 模式同样直接桥接 CPA WebSocket：没有网关侧开关，由上游按请求决定传输。
  const splitNonGpt = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", { headers: probeHeaders }),
    config,
    "proxy-key",
  );
  assert.ok(splitNonGpt);
  assert.equal(splitNonGpt.url, "wss://cliproxy.example/v1/responses");

  // split 模式 CPA 模型放行，认证域与 CPA-only 相同。
  const splitCpa = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: {
        ...probeHeaders,
        "x-codex-routing-hint": "model=cliproxy/gpt-5.6-luna;tier=ultrafast",
      },
    }),
    config,
    "proxy-key",
  );
  assert.ok(splitCpa);
  assert.equal(splitCpa.url, "wss://cliproxy.example/v1/responses");
  assert.equal(splitCpa.headers["x-codex-routing-hint"], "model=gpt-5.6-luna;tier=ultrafast");
  assert.equal(splitCpa.headers.authorization, "Bearer proxy-key");
  assert.equal(splitCpa.headers["chatgpt-account-id"], undefined);
  assert.equal(splitCpa.headers["x-api-key"], undefined);
  assert.equal(splitCpa.headers["x-goog-api-key"], undefined);
  assert.ok(responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { ...probeHeaders, "x-codex-routing-hint": "model=cliproxy/codex-auto-review" },
    }),
    config,
    "proxy-key",
  ));

  const cpaThreads = new Set<string>();
  const stickyHeaders = { ...probeHeaders, "thread-id": "thread-cpa" };
  assert.ok(responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { ...stickyHeaders, "x-codex-routing-hint": "model=cliproxy/claude-opus-4-6" },
    }),
    config,
    "proxy-key",
    cpaThreads,
  ));
  const stickyTitle = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { ...stickyHeaders, "x-codex-routing-hint": "model=gpt-5.6-luna" },
    }),
    config,
    "proxy-key",
    cpaThreads,
  );
  assert.equal(stickyTitle?.url, "wss://cliproxy.example/v1/responses");
  assert.equal(stickyTitle?.headers.authorization, "Bearer proxy-key");
  const stickyGuardian = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: {
        ...probeHeaders,
        "thread-id": "thread-guardian",
        "x-codex-parent-thread-id": "thread-cpa",
        "x-codex-routing-hint": "model=codex-auto-review",
      },
    }),
    config,
    "proxy-key",
    cpaThreads,
  );
  assert.equal(stickyGuardian?.url, "wss://cliproxy.example/v1/responses");
  assert.equal(stickyGuardian?.headers.authorization, "Bearer proxy-key");
  assert.equal(cpaThreads.has("thread-guardian"), true);
  const isolatedOfficial = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { ...probeHeaders, "thread-id": "thread-official", "x-codex-routing-hint": "model=gpt-5.6-luna" },
    }),
    config,
    "proxy-key",
    cpaThreads,
  );
  assert.equal(isolatedOfficial?.url, "wss://chatgpt.com/backend-api/codex/responses");
  assert.equal(isolatedOfficial?.headers.authorization, "Bearer original-oauth");

  // CPA-only：符合 CPA 侧约定的模型交给 CLIProxy，剥官方 OAuth 与其他 API key。
  const cpaAllowedHeaders = {
    ...probeHeaders,
    "x-codex-routing-hint": "model=gpt-5.6-luna",
  };
  const cliproxy = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", { headers: cpaAllowedHeaders }),
    { ...config, cpaOnly: true },
    "proxy-key",
  );
  assert.ok(cliproxy);
  assert.equal(cliproxy.url, "wss://cliproxy.example/v1/responses");
  assert.equal(cliproxy.headers.authorization, "Bearer proxy-key");
  assert.equal(cliproxy.headers["chatgpt-account-id"], undefined);
  assert.equal(cliproxy.headers["x-api-key"], undefined);
  assert.equal(cliproxy.headers["x-goog-api-key"], undefined);
  assert.equal(cliproxy.headers["openai-beta"], "responses_websockets=2026-02-06");
  assert.equal(cliproxy.headers["sec-websocket-key"], undefined);
  // 第三方模型同样拨号 CLIProxy WebSocket，由 CPA 按请求决定上游传输。
  const cpaNonGpt = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { ...probeHeaders, "x-codex-routing-hint": "model=free/glm-5.3-flash" },
    }),
    { ...config, cpaOnly: true },
    "proxy-key",
  );
  assert.ok(cpaNonGpt);
  assert.equal(cpaNonGpt.url, "wss://cliproxy.example/v1/responses");
  assert.ok(responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { ...probeHeaders, "x-codex-routing-hint": "model=codex-auto-review" },
    }),
    { ...config, cpaOnly: true },
    "proxy-key",
  ));

  // 官方 hint：OAuth 原样透传。
  const official = responsesWebSocketTarget(new Request("http://127.0.0.1:8320/v1/responses", {
    headers: { ...probeHeaders, "x-codex-routing-hint": "model=gpt-5.6-luna" },
  }), config);
  assert.ok(official);
  assert.equal(official.url, "wss://chatgpt.com/backend-api/codex/responses");
  assert.equal(official.headers.authorization, "Bearer original-oauth");
  assert.equal(official.headers["chatgpt-account-id"], "acct-1");

  // 无 hint 回落官方（与 HTTP 路由一致）。
  const { ["x-codex-routing-hint"]: _hint, ...noHint } = probeHeaders;
  const fallback = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", { headers: noHint }),
    config,
  );
  assert.equal(fallback?.url, "wss://chatgpt.com/backend-api/codex/responses");

  // 官方路由不受任何网关侧开关影响，始终放行。
  assert.ok(responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { ...probeHeaders, "x-codex-routing-hint": "model=gpt-5.6-luna" },
    }),
    config,
  ), "official WebSocket must stay on regardless of any switch");

  // realtime 保留路径、非 upgrade 请求：一律不转发，维持 426 行为。
  assert.equal(responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/live/rtc_x", { headers: probeHeaders }),
    config,
  ), null);
  assert.equal(responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { authorization: "Bearer original-oauth" },
    }),
    config,
  ), null);
});

test("CPA-only mode forwards HTTP and WebSocket models without prefix routing", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; options: RequestInit } | undefined;
  globalThis.fetch = (async (url, options) => {
    captured = { url: String(url), options: options ?? {} };
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const config = {
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
      cpaOnly: true,
    };
    const handler = createGatewayHandler(config, "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer oauth-token",
        "chatgpt-account-id": "acct-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "test" }),
    }));
    assert.ok(captured);
    assert.equal(captured.url, "https://cliproxy.example/v1/responses");
    assert.equal(new Headers(captured.options.headers).get("authorization"), "Bearer proxy-key");
    assert.equal(new Headers(captured.options.headers).get("chatgpt-account-id"), null);
    assert.equal((await new Response(captured.options.body).json() as { model: string }).model, "gpt-5.6-sol");

    const target = responsesWebSocketTarget(new Request("http://127.0.0.1:8320/v1/responses", {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer oauth-token",
        "x-codex-routing-hint": "model=gpt-5.6-sol",
      },
    }), config, "proxy-key");
    assert.equal(target?.url, "wss://cliproxy.example/v1/responses");
    assert.equal(target?.routeKind, "cliproxy");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("log groups come from the request path and stay filesystem-safe", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-group-log-"));
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    // 同一路径下的两种上游必须落进同一个文件——按上游命名会因 fallback 而误导。
    for (const model of ["gpt-5.6-luna", "cliproxy/claude-opus-4-6"]) {
      await handler(new Request("http://127.0.0.1:8320/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "hi" }),
      }));
    }
    const grouped = await waitForLogFile(logDir, /^cliproxy-v1-responses-http-\d{14}\.log$/);
    const text = fs.readFileSync(path.join(logDir, grouped), "utf8");
    assert.equal(text.match(/=== POST \/v1\/responses ===/g)?.length, 2);
    // 本地时间，不带时区后缀。
    assert.match(text.split("\n")[0], /^--\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}--$/);

    // 路径里的危险字符不得进入文件名。
    await handler(new Request("http://127.0.0.1:8320/v1/..%2Fetc/passwd", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const name of fs.readdirSync(logDir)) {
      assert.doesNotMatch(name, /[/\\]|\.\./, `unsafe log file name: ${name}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("responses WebSocket forwards every end-to-end header, dropping only handshake plumbing", () => {
  const config = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    cliproxyBaseUrl: "https://proxy.example/v1",
    catalogPath: "/tmp/missing-catalog.json",
  };
  // 取自真实 Codex Desktop 试探请求：白名单方案会静默丢掉后面这批 x-codex-* 元数据头。
  const target = responsesWebSocketTarget(new Request("http://127.0.0.1:8320/v1/responses", {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      host: "127.0.0.1:8320",
      "sec-websocket-key": "client-generated",
      "sec-websocket-version": "13",
      "sec-websocket-extensions": "permessage-deflate",
      authorization: "Bearer official-oauth",
      "chatgpt-account-id": "account",
      "openai-beta": "responses_websockets=2026-02-06",
      originator: "Codex Desktop",
      version: "0.148.0-alpha.15",
      "x-codex-routing-hint": "model=gpt-5.6-luna",
      "x-codex-turn-metadata": '{"turn_id":"t1"}',
      "x-codex-beta-features": "remote_compaction_v2",
      "x-codex-window-id": "w1:0",
      "x-client-request-id": "req-1",
      "x-openai-internal-codex-responses-lite": "true",
      "x-some-header-openai-adds-next-year": "future",
    },
  }), config)!;

  assert.ok(target, "expected the responses WebSocket to be routed");
  // 握手与逐跳头必须剥掉，否则上游握手会失败。
  for (const dropped of [
    "upgrade", "connection", "host",
    "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
  ]) {
    assert.equal(target.headers[dropped], undefined, `${dropped} must not be forwarded`);
  }
  // 其余一律透传，包括今天还不认识的头。
  for (const [name, value] of Object.entries({
    authorization: "Bearer official-oauth",
    "chatgpt-account-id": "account",
    "openai-beta": "responses_websockets=2026-02-06",
    version: "0.148.0-alpha.15",
    "x-codex-turn-metadata": '{"turn_id":"t1"}',
    "x-codex-beta-features": "remote_compaction_v2",
    "x-codex-window-id": "w1:0",
    "x-client-request-id": "req-1",
    "x-openai-internal-codex-responses-lite": "true",
    "x-some-header-openai-adds-next-year": "future",
  })) {
    assert.equal(target.headers[name], value, `${name} must be forwarded verbatim`);
  }
});

test("log file names carry the transport, and one WebSocket session maps to one file", () => {
  // HTTP 保持按秒滚动。
  const a = httpLogFile("v1-responses", "20260820131423");
  assert.equal(a.name, "cliproxy-v1-responses-http-20260820131423.log");
  assert.equal(a.prefix, "cliproxy-v1-responses-http-");

  // 同一 session 的多条连接（含 subagent 派生的 thread）必须落到同一个文件，
  // 否则每秒一个文件会把一次会话拆成几十个碎片。
  const session = "01a01960-3a52-7311-9258-f9144ad58b65";
  const first = websocketLogFile("v1-responses", session);
  const second = websocketLogFile("v1-responses", session);
  assert.equal(first.name, `cliproxy-v1-responses-ws-${session}.log`);
  assert.equal(second.name, first.name, "same session must reuse one file");

  // 传输段不同 ⇒ 裁剪分组独立，HTTP 日志不会把 WebSocket 会话挤掉。
  assert.notEqual(first.prefix, a.prefix);

  // session-id 缺失时回落到建连时刻，仍是单文件。
  assert.match(websocketLogFile("v1-live").name, /^cliproxy-v1-live-ws-\d{14}\.log$/);

  // 不可信输入不得逃逸出日志目录。
  const unsafe = websocketLogFile("v1-live", "../../etc/passwd");
  assert.doesNotMatch(unsafe.name, /[/\\]|\.\./);
});

test("request logs keep bodies intact for post-mortem analysis", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-nolimit-log-"));
  // 真实 Codex 请求体实测约 108KB；此前 50KB 截断会把 instructions 和 input 切掉。
  const marker = "TAIL-MARKER-MUST-SURVIVE";
  const bigInput = "x".repeat(120_000);
  const bigReply = `${"y".repeat(120_000)}${marker}`;
  globalThis.fetch = (async () => new Response(bigReply, { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: `${bigInput}${marker}` }),
    }));

    const file = await waitForLogFile(logDir, /^cliproxy-v1-responses-http-\d{14}\.log$/);
    const log = fs.readFileSync(path.join(logDir, file), "utf8");
    assert.doesNotMatch(log, /\[truncated \d+ chars\]/, "bodies must not be truncated");
    assert.equal(log.match(new RegExp(marker, "g"))?.length, 2, "both request and response tails must survive");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("non-GPT remote compaction v2 is summarized, wrapped once, and replayed as text", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { url: string; options: RequestInit }[] = [];
  globalThis.fetch = (async (url, options) => {
    captured.push({ url: String(url), options: options ?? {} });
    if (captured.length === 1) {
      return Response.json({
        id: "resp_summary",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "保留这份交接摘要" }] }],
      });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "proxy-key");
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "cliproxy/deepseek-v4",
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: "function", name: "read_file" }],
        text: { format: { type: "json_schema" } },
        input: [
          { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] },
          { type: "compaction_trigger" },
        ],
      }),
    }));

    assert.equal(captured[0].url, "https://cliproxy.example/v1/responses");
    assert.equal(new Headers(captured[0].options.headers).get("accept"), "application/json");
    const summaryRequest = JSON.parse(captured[0].options.body as string);
    assert.equal(summaryRequest.model, "deepseek-v4");
    assert.equal(summaryRequest.stream, false);
    assert.equal(summaryRequest.stream_options, undefined);
    assert.equal(summaryRequest.tools, undefined);
    assert.equal(summaryRequest.text, undefined);
    assert.deepEqual(summaryRequest.input.map((item: { type: string }) => item.type), ["message", "message"]);
    assert.deepEqual(summaryRequest.input[0].content[0], {
      type: "input_text",
      text: "[image omitted for compaction]",
    });

    const frames = (await response.text())
      .split("\n\n")
      .map((frame) => frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
      .filter((data): data is string => Boolean(data) && data !== "[DONE]")
      .map((data) => JSON.parse(data));
    const done = frames.find((event) => event.type === "response.output_item.done");
    const completed = frames.find((event) => event.type === "response.completed");
    assert.equal(done.item.type, "compaction");
    assert.equal(completed.response.output.length, 1);
    assert.equal(completed.response.output[0].id, done.item.id);
    assert.equal(
      Buffer.from(done.item.encrypted_content.slice("ocx1:".length), "base64").toString("utf8"),
      "保留这份交接摘要",
    );

    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/deepseek-v4", input: [done.item] }),
    }));
    const replay = JSON.parse(captured[1].options.body as string);
    assert.equal(replay.input[0].type, "message");
    assert.match(replay.input[0].content[0].text, /保留这份交接摘要/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cliproxy GPT models keep native v2 and v1 compaction untouched", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { url: string; options: RequestInit }[] = [];
  globalThis.fetch = (async (url, options) => {
    captured.push({ url: String(url), options: options ?? {} });
    return new Response("passthrough", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "proxy-key");
    const input = [{ type: "compaction_trigger" }];
    const v2 = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/GPT-5.6-sol", stream: true, input }),
    }));
    await handler(new Request("http://127.0.0.1:8320/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/gpt-5.6-sol", input: [] }),
    }));

    assert.equal(await v2.text(), "passthrough");
    assert.equal(captured[0].url, "https://cliproxy.example/v1/responses");
    assert.deepEqual(JSON.parse(captured[0].options.body as string).input, input);
    assert.equal(captured[1].url, "https://cliproxy.example/v1/responses/compact");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-GPT /responses/compact returns replacement history", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { url: string; options: RequestInit }[] = [];
  globalThis.fetch = (async (url, options) => {
    captured.push({ url: String(url), options: options ?? {} });
    return Response.json({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: captured.length === 1 ? "v1 摘要" : "v1 新摘要" }],
      }],
    });
  }) as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "proxy-key");
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cliproxy/claude-opus-4-6",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "最近的问题" }] }],
      }),
    }));

    assert.equal(captured[0].url, "https://cliproxy.example/v1/responses");
    assert.equal(JSON.parse(captured[0].options.body as string).stream, false);
    const output = (await response.json() as { output: Array<{ content: Array<{ text: string }> }> }).output;
    assert.equal(output.length, 2);
    assert.equal(output[0].content[0].text, "最近的问题");
    assert.match(output[1].content[0].text, /v1 摘要/);

    const second = await handler(new Request("http://127.0.0.1:8320/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cliproxy/claude-opus-4-6",
        input: [
          ...output,
          { type: "message", role: "user", content: [{ type: "input_text", text: "后续问题" }] },
        ],
      }),
    }));
    const secondOutput = (await second.json() as { output: Array<{ content: Array<{ text: string }> }> }).output;
    assert.equal(secondOutput.length, 3);
    assert.deepEqual(secondOutput.slice(0, 2).map((item) => item.content[0].text), ["最近的问题", "后续问题"]);
    assert.match(secondOutput[2].content[0].text, /v1 新摘要/);
    assert.doesNotMatch(secondOutput[2].content[0].text, /v1 摘要$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incomplete non-GPT compaction never emits a replacement item", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    status: "incomplete",
    output: [{ type: "message", content: [{ type: "output_text", text: "截断摘要" }] }],
  })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler({
      host: "127.0.0.1",
      port: 8320,
      mountPath: "/v1",
      prefix: "cliproxy/",
      officialBaseUrl: "https://chatgpt.com/backend-api/codex",
      cliproxyBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
    }, "proxy-key");
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cliproxy/deepseek-v4",
        input: [{ type: "compaction_trigger" }],
      }),
    }));
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /encrypted_content/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("CLIProxy catalog uses the supplied client version", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url, options) => {
    calls += 1;
    const value = new URL(String(url));
    assert.equal(value.searchParams.get("client_version"), "2.0.0");
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    return Response.json({ models: [{ slug: "claude-opus", display_name: "Claude Opus" }] });
  }) as typeof fetch;
  try {
    const catalog = await fetchCliProxyCatalog("http://127.0.0.1:8317/v1", "", "2.0.0");
    assert.equal(catalog.models[0]?.display_name, "Claude Opus");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLIProxy catalog falls back to client_version 0.0.0", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    assert.equal(new URL(String(url)).searchParams.get("client_version"), "0.0.0");
    return Response.json({ models: [{ slug: "fallback-model" }] });
  }) as typeof fetch;
  try {
    await fetchCliProxyCatalog("http://127.0.0.1:8317/v1", "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("model selection supports indexes, ranges, IDs, all, and none", () => {
  const models = ["alpha", "beta", "gamma", "delta"];
  assert.deepEqual(parseModelSelection("1,3-4", models), ["alpha", "gamma", "delta"]);
  assert.deepEqual(parseModelSelection("beta,4", models), ["beta", "delta"]);
  assert.deepEqual(parseModelSelection("all", models), models);
  assert.deepEqual(parseModelSelection("none", models), []);
  assert.equal(parseModelSelection("", models), null);
});

test("model picker shows display name with model name and sorts by model name", () => {
  assert.deepEqual(modelPickerEntries([
    { slug: "z-model", display_name: "Alpha" },
    { slug: "a-model", display_name: "Zulu" },
  ]), [
    { slug: "a-model", label: "Zulu(a-model)" },
    { slug: "z-model", label: "Alpha(z-model)" },
  ]);
});

test("keyboard model picker moves and toggles the focused model", () => {
  const models = ["alpha", "beta", "gamma"];
  let state = { cursor: 0, selectedModels: [] as string[] };
  state = applyModelPickerKey(state, "down", models);
  state = applyModelPickerKey(state, "space", models);
  state = applyModelPickerKey(state, "down", models);
  state = applyModelPickerKey(state, "space", models);
  state = applyModelPickerKey(state, "up", models);
  state = applyModelPickerKey(state, "space", models);
  assert.deepEqual(state, { cursor: 1, selectedModels: ["gamma"] });
});

test("keyboard model picker redraws a bounded single-line frame in place", async () => {
  const writes: string[] = [];
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this; },
    pause() { return this; },
    resume() { return this; },
  });
  const output = {
    isTTY: true,
    rows: 24,
    columns: 40,
    write(value: string) { writes.push(value); return true; },
  };
  const models = Array.from({ length: 28 }, (_, index) => ({
    slug: `model-${String(index + 1).padStart(2, "0")}`,
    display_name: `Long display name ${index + 1}`,
  }));

  const selection = chooseModels({
    availableModels: models,
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream,
  });
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", " ", { name: "space" });
  input.emit("keypress", "", { name: "enter" });

  assert.deepEqual(await selection, ["model-02"]);
  assert.equal(writes[0], "\x1b[?25l");
  assert.deepEqual([writes[2], writes[4]], ["\x1b[13F\x1b[0J", "\x1b[13F\x1b[0J"]);
  assert.ok([writes[1], writes[3], writes[5]].every(
    (value) => value.split("\n").every((line) => line.length <= 39),
  ));
  assert.equal(writes.at(-1), "\x1b[?25h");
});

test("selected models can be recovered from an existing catalog", () => {
  const catalog = {
    models: [
      { slug: "gpt-native" },
      { slug: "cliproxy/claude-opus" },
      { slug: "cliproxy/gemini-pro" },
    ],
  };
  assert.deepEqual(selectedModelsFromCatalog(catalog), ["claude-opus", "gemini-pro"]);
});

test("catalog includes only explicitly selected CLIProxy models", () => {
  const native = {
    models: [{
      slug: "gpt-native",
      display_name: "GPT Native",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
    }],
  };
  const merged = mergeCatalog(native, { models: [{ slug: "chosen-model" }] });
  assert.deepEqual(
    merged.models.map((model) => model.slug),
    ["gpt-native", "cliproxy/chosen-model"],
  );
});
