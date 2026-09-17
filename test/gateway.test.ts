import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import type { ReadStream, WriteStream } from "node:tty";
import { createGatewayHandler, decideRoute, isLoopbackUrl, joinUpstreamUrl, responsesWebSocketTarget } from "../src/gateway.ts";
import { isRequestLogName, pruneLogDir, retainLogFile } from "../src/request-log.ts";
import {
  GATEWAY_CONFIG_SCHEMA_URL,
  GATEWAY_CONFIG_VERSION,
  gatewayConfigWarnings,
  mergeMissingConfig,
} from "../src/config.ts";
import { patchRootToml, readRootTomlString, restoreRootTomlKeys } from "../src/toml.ts";
import { capGatewayLog } from "../src/process-log.ts";
import { httpLogFile, websocketLogFile } from "../src/request-log.ts";
import { LEGACY_STDERR_LOG, resolvePaths } from "../src/paths.ts";
import type { GatewayConfig } from "../src/types.ts";
import {
  compileModelOverrides,
  fetchCliProxyCatalog,
  fetchUpstreamCatalog,
  loadModelOverrides,
  mergeCatalog,
  parseCodexCatalog,
  resolveModelMergeJson,
  synthesizeModelEntry,
  syncCatalog,
} from "../src/catalog.ts";
import {
  applyModelCatalogToml,
  applyRoutingMode,
  formatErrorLog,
  parseMaxLogSize,
  parseMaxRequestLogs,
  parseUpstreamTypeOption,
  removeManagedRuntimeFiles,
  runCli,
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
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: "/tmp/catalog.json",
    logDir: "",
    selectedModels: ["one", "one"],
    upstreamOnly: "yes",
    removed_option: true,
  });
  assert.deepEqual(warnings, [
    "$.port should be integer",
    "$.mountPath has an invalid format",
    "$.officialBaseUrl should be a valid URI",
    "$.selectedModels should not contain duplicates",
    "$.logDir should not be empty",
    "$.upstreamOnly should be boolean",
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
    upstreamBaseUrl: "https://proxy.example/v1",
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
    // 旧配置缺 upstreamType 时按 DEFAULTS 补 cliproxy，不改变用户其余配置。
    assert.equal(config.upstreamType, "cliproxy");
    // 遗留的 websocket 开关被清除，不再作为默认值写回。
    assert.equal(config.websocket, undefined);
    assert.equal(config.removed_option, "keep");

    // preflight 写盘也要留审计：记录版本迁移、补齐字段与 websocket 清理。
    const auditText = fs.readFileSync(paths.stdoutLog, "utf8");
    assert.equal(auditText.split("=== config changed by").length - 1, 1);
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
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    upstreamOnly: true,
  };
  applyRoutingMode(config, paths, false);
  assert.equal(config.upstreamOnly, false);
  assert.equal(config.catalogPath, paths.catalogFile);
});

test("routing mode targets a per-upstream catalog file", () => {
  const paths = resolvePaths({ HOME: "/Users/test" });
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
  };
  applyRoutingMode(config, paths, true);
  assert.equal(config.catalogPath, paths.catalogFile);
  // 未识别的值与缺省都按 cliproxy 处理，老安装的目录路径保持不变。
  config.upstreamType = "newapi";
  applyRoutingMode(config, paths, true);
  assert.equal(config.catalogPath, path.join(paths.runtimeHome, "newapi-catalog.json"));
  config.upstreamType = "cliproxy";
  applyRoutingMode(config, paths, true);
  assert.equal(config.catalogPath, paths.catalogFile);
});

test("model catalog toml accepts any managed catalog file and repoints to the active one", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-toml-test-"));
  const paths = resolvePaths({ HOME: home });
  const newapiCatalog = path.join(paths.runtimeHome, "newapi-catalog.json");
  try {
    // 从 newapi 切回 cliproxy：config.toml 指向的 newapi-catalog.json 也是受管值，允许改写指向。
    const source = `model_catalog_json = "${newapiCatalog}"\n`;
    const { patchedToml, previousCatalog } = applyModelCatalogToml(source, true, paths, paths.catalogFile);
    assert.equal(previousCatalog, newapiCatalog);
    assert.equal(readRootTomlString(patchedToml, "model_catalog_json"), paths.catalogFile);

    assert.throws(
      () => applyModelCatalogToml('model_catalog_json = "/Users/test/my-catalog.json"\n', true, paths, paths.catalogFile),
      /Refusing to replace unmanaged model_catalog_json/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
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
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
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

test("legacy cliproxyBaseUrl is normalized at load and migrated on preflight sync", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-legacy-upstream-url-"));
  const paths = resolvePaths({ HOME: home });
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    cliproxyBaseUrl: "https://old-proxy.example/v1",
    cpaOnly: true,
    upstream_type: "newapi",
    catalogPath: paths.catalogFile,
  }));
  try {
    syncGatewayConfigFile(paths);
    const config = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    // 旧键值迁入新键，旧键从文件中移除。
    assert.equal(config.upstreamBaseUrl, "https://old-proxy.example/v1");
    assert.equal(config.cliproxyBaseUrl, undefined);
    assert.equal(config.upstreamOnly, true);
    assert.equal(config.cpaOnly, undefined);
    assert.equal(config.upstreamType, "newapi");
    assert.equal(config.upstream_type, undefined);

    const auditText = fs.readFileSync(paths.stdoutLog, "utf8");
    assert.match(auditText, /cliproxyBaseUrl -> upstreamBaseUrl/);
    assert.match(auditText, /cpaOnly -> upstreamOnly/);
    assert.match(auditText, /upstream_type -> upstreamType/);
    assert.match(auditText, /"https:\/\/old-proxy\.example\/v1"/);
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
    path.join(paths.runtimeHome, "newapi-catalog.json"),
    path.join(paths.runtimeHome, "catalog-metadata.json"),
    paths.modelMergeFile,
    paths.stdoutLog,
    // 旧安装的独立 stderr 日志也属于受管文件：卸载清理必须把残留一并删掉。
    path.join(paths.runtimeHome, LEGACY_STDERR_LOG),
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
    assert.equal(fs.existsSync(path.join(paths.runtimeHome, "newapi-catalog.json")), false);
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
      upstreamBaseUrl: "http://127.0.0.1:8317/v1",
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
      upstreamBaseUrl: "http://127.0.0.1:8317/v1",
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

test("non-boolean upstreamOnly never enables CPA routing", async () => {
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
      upstreamBaseUrl: "https://proxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
      upstreamOnly: "false" as unknown as boolean,
    }, "");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol" }),
    }));
    assert.equal(upstreamUrl, "https://official.example/codex/responses");
    assert.equal((await (await handler(new Request("http://127.0.0.1:8320/healthz"))).json()).upstreamOnly, false);
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
      upstreamBaseUrl: "https://cliproxy.example/v1",
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
      upstreamBaseUrl: "http://127.0.0.1:8317/v1",
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
      upstreamBaseUrl: "https://cliproxy.example/v1",
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
    upstreamBaseUrl: "https://cliproxy.example/v1",
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
      upstreamBaseUrl: "https://cliproxy.example/v1",
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

test("catalog, health, ui and favicon probes are excluded from request logs", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-skip-log-"));
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/healthz"));
    await handler(new Request("http://127.0.0.1:8320/v1/models"));
    // /ui 与 /favicon.ico 是浏览器打开 Web UI 时的页面与图标请求，不是模型调用。
    await handler(new Request("http://127.0.0.1:8320/ui"));
    await handler(new Request("http://127.0.0.1:8320/favicon.ico"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fs.existsSync(logDir) ? fs.readdirSync(logDir) : [], []);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("requests outside the mount path get a local 404 and never reach the upstream or logs", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-outside-mount-"));
  let forwarded = 0;
  globalThis.fetch = (async () => {
    forwarded += 1;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    // /.well-known/appspecific/* 是 Chrome DevTools 对页面 origin 的自动探测：它曾
    // 被拼进上游 URL 转发并写进请求日志，是收紧边界的直接动因，必须锁死。
    for (const pathname of [
      "/.well-known/appspecific/com.chrome.devtools.json",
      "/favicon.ico",
      "/robots.txt",
      "/backend-api/codex/responses",
    ]) {
      const response = await handler(new Request(`http://127.0.0.1:8320${pathname}`));
      assert.equal(response.status, 404, pathname);
      const payload = await response.json() as { error?: { message?: string } };
      assert.match(payload.error?.message ?? "", /outside the API mount \/v1/);
    }
    assert.equal(forwarded, 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fs.existsSync(logDir) ? fs.readdirSync(logDir) : [], []);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("web ui paths on the model port stay local and point at the ui port", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-ui-port-"));
  let forwarded = 0;
  globalThis.fetch = (async () => {
    forwarded += 1;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(logTestConfig(logDir), "proxy-key");
    const response = await handler(new Request("http://127.0.0.1:8320/ui"));
    assert.equal(response.status, 404);
    const payload = await response.json() as { error?: { hint?: string } };
    assert.match(payload.error?.hint ?? "", /http:\/\/127\.0\.0\.1:8321\/ui/);
    // UI 在独立端口上运行：模型端口对 /ui 没有任何上游转发路径。
    assert.equal(forwarded, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("failed requests keep the full exchange in the route log and the digest in the process log", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-error-log-"));
  const processLog = path.join(logDir, "gateway.log");
  globalThis.fetch = (async () => {
    throw new Error("upstream exploded");
  }) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(
      logTestConfig(logDir),
      "proxy-key",
      "invalid",
      new Set<string>(),
      undefined,
      undefined,
      undefined,
      { file: processLog, maxBytes: 0 },
    );
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "hi" }),
    }));
    assert.equal(response.status, 502);

    // 摘要只有一份，在进程日志里；请求日志目录不再产生 *-error-* 文件。
    const routeLog = await waitForLogFile(logDir, /^cliproxy-v1-responses-http-\d{14}\.log$/);
    assert.deepEqual(
      fs.readdirSync(logDir).filter((name) => name.includes("-error-")),
      [],
    );

    const digest = fs.readFileSync(processLog, "utf8");
    assert.match(digest, /!!! POST \/v1\/responses -> 502 !!!/);
    assert.match(digest, /message: Gateway upstream request failed/);
    assert.match(digest, /upstream: https:\/\/cliproxy\.example\/v1\/responses/);
    assert.match(digest, /duration: \d+ms/);

    // 完整 exchange 仍留在请求日志里，便于回溯请求上下文。
    assert.match(fs.readFileSync(path.join(logDir, routeLog), "utf8"), /--- response status: 502/);
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

test("maxRequestLogs keeps the newest files across the whole directory", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-log-cap-"));
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    // 三个文件分属两个"路由分组"，但保留计数是全局的：只按时间，路径不参与。
    const seeded: Array<[string, string]> = [
      ["cliproxy-v1-live-http-20260101000001.log", "2026-01-01T00:00:01Z"],
      ["cliproxy-v1-responses-http-20260101000002.log", "2026-01-01T00:00:02Z"],
      ["cliproxy-v1-responses-http-20260101000003.log", "2026-01-01T00:00:03Z"],
    ];
    for (const [name, at] of seeded) {
      fs.writeFileSync(path.join(logDir, name), "old\n");
      fs.utimesSync(path.join(logDir, name), new Date(at), new Date(at));
    }
    const before = new Set(fs.readdirSync(logDir));

    const handler = createGatewayHandler(logTestConfig(logDir, 2), "proxy-key");
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "hi" }),
    }));
    const current = await waitForNewLogFile(logDir, before, "cliproxy-v1-responses-http-");

    // 刚写入的文件最新，加上次新的 20260101000003；最旧的 live 分组文件被全局裁剪掉。
    assert.deepEqual(
      fs.readdirSync(logDir).sort(),
      ["cliproxy-v1-responses-http-20260101000003.log", current].sort(),
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("successful requests get one process-log line naming the upstream, without the body", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-summary-"));
  const processLog = path.join(logDir, "gateway.log");
  globalThis.fetch = (async () => new Response("SECRET-UPSTREAM-BODY", { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(
      logTestConfig(logDir),
      "proxy-key",
      "invalid",
      new Set<string>(),
      undefined,
      undefined,
      undefined,
      { file: processLog, maxBytes: 0 },
    );
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses?trace=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "hi" }),
    }));
    assert.equal(response.status, 200);

    // 等到请求日志出现：摘要与它在同一次同步写入里，此时进程日志已可读。
    await waitForLogFile(logDir, /^cliproxy-v1-responses-http-\d{14}\.log$/);
    const summary = fs.readFileSync(processLog, "utf8");
    assert.match(summary, /--\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}-- POST \/v1\/responses\?trace=1 -> 200 \(\d+ms\) upstream: https:\/\/cliproxy\.example\/v1\/responses\?trace=1/);
    // 进程日志只放摘要，响应正文留在请求日志里。
    assert.doesNotMatch(summary, /SECRET-UPSTREAM-BODY/);
    const routeLog = fs.readdirSync(logDir).find((name) => name.startsWith("cliproxy-v1-responses-http-"))!;
    assert.match(fs.readFileSync(path.join(logDir, routeLog), "utf8"), /SECRET-UPSTREAM-BODY/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("request summaries respect the process log size cap", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-summary-cap-"));
  const processLog = path.join(logDir, "gateway.log");
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(
      logTestConfig(logDir),
      "proxy-key",
      "invalid",
      new Set<string>(),
      undefined,
      undefined,
      undefined,
      { file: processLog, maxBytes: 256 },
    );
    for (let i = 0; i < 6; i += 1) {
      await handler(new Request("http://127.0.0.1:8320/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: `turn-${i}` }),
      }));
    }
    // 运行期也受同一上限约束：超出 256 字节时滚动备份并原地清空，活跃文件不会无限增长。
    const text = fs.readFileSync(processLog, "utf8");
    assert.ok(Buffer.byteLength(text) <= 256, `process log grew past the cap: ${Buffer.byteLength(text)}`);
    assert.equal(
      fs.readdirSync(logDir).filter((name) => /^gateway-\d{17}\.log$/.test(name)).length > 0,
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("isRequestLogName recognizes request logs and spares process logs", () => {
  assert.equal(isRequestLogName("cliproxy-v1-alpha-http-20260101000001.log"), true);
  assert.equal(isRequestLogName("cliproxy-v1-responses-ws-01a01960-3a52.log"), true);
  assert.equal(isRequestLogName("cliproxy-error-20260101000001.log"), true);
  assert.equal(isRequestLogName("zai-error-20260101000001.log"), true);
  // 进程日志由 launchd 持有句柄，历史审计文件只有一份，都不能被保留计数删掉。
  assert.equal(isRequestLogName("gateway.log"), false);
  assert.equal(isRequestLogName("gateway.error.log"), false);
  assert.equal(isRequestLogName("cliproxy-config-20260101000001.log"), false);
});

test("maxRequestLogs is applied at startup without waiting for new writes", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-log-sweep-"));
  try {
    // 上限调小后这些分组都不再有请求：启动不扫描就会一直停在旧上限之上。
    const seeded: Array<[string, string]> = [
      ["cliproxy-v1-alpha-http-20260831094909.log", "2026-08-31T09:49:09Z"],
      ["cliproxy-v1-alpha-http-20260901160800.log", "2026-09-01T16:08:00Z"],
      ["cliproxy-v1-responses-ws-bbb.log", "2026-09-02T10:00:00Z"],
      ["cliproxy-error-20260903090000.log", "2026-09-03T09:00:00Z"],
      ["cliproxy-v1-responses-http-20260904090000.log", "2026-09-04T09:00:00Z"],
    ];
    for (const [name, at] of seeded) {
      fs.writeFileSync(path.join(logDir, name), "old\n");
      fs.utimesSync(path.join(logDir, name), new Date(at), new Date(at));
    }
    fs.writeFileSync(path.join(logDir, "cliproxy-config-20260101000001.log"), "audit\n");
    fs.writeFileSync(path.join(logDir, "gateway.log"), "process\n");

    createGatewayHandler(logTestConfig(logDir, 2), "proxy-key");

    assert.deepEqual(fs.readdirSync(logDir).sort(), [
      "cliproxy-config-20260101000001.log",
      "cliproxy-error-20260903090000.log",
      "cliproxy-v1-responses-http-20260904090000.log",
      "gateway.log",
    ]);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("maxRequestLogs never deletes a log file that is still being written", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-log-active-"));
  const active = "cliproxy-v1-responses-ws-live-session.log";
  try {
    // 未结束的 WS 会话文件恰好是最旧的：按时间它是第一个该删的，但会话还在追加它。
    const seeded: Array<[string, string]> = [
      [active, "2026-01-01T00:00:01Z"],
      ["cliproxy-v1-responses-http-20260101000002.log", "2026-01-01T00:00:02Z"],
      ["cliproxy-v1-responses-http-20260101000003.log", "2026-01-01T00:00:03Z"],
    ];
    for (const [name, at] of seeded) {
      fs.writeFileSync(path.join(logDir, name), "old\n");
      fs.utimesSync(path.join(logDir, name), new Date(at), new Date(at));
    }
    const release = retainLogFile(logDir, { name: active });

    createGatewayHandler(logTestConfig(logDir, 1), "proxy-key");

    // 保留计数只落在可裁剪的候选上：会话文件被跳过，候选是两个 http 文件，留最新的那个。
    assert.deepEqual(fs.readdirSync(logDir).sort(), [
      "cliproxy-v1-responses-http-20260101000003.log",
      active,
    ]);

    // 会话结束后文件重新参与计数：此时它最旧，被裁掉。
    release();
    pruneLogDir(logDir, 1);
    assert.deepEqual(fs.readdirSync(logDir), ["cliproxy-v1-responses-http-20260101000003.log"]);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("a log file shared by several websocket sessions stays active until the last one releases", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-log-shared-"));
  const shared = "cliproxy-v1-responses-ws-live-session.log";
  try {
    // 两个连接共享同一 session-id（同一日志文件）：任一连接关闭只递减引用计数，
    // 只有最后一个连接释放后才允许裁剪删除，否则会静默丢掉仍在写入的会话历史。
    const seeded: Array<[string, string]> = [
      [shared, "2026-01-01T00:00:01Z"],
      ["cliproxy-v1-responses-http-20260101000002.log", "2026-01-01T00:00:02Z"],
    ];
    for (const [name, at] of seeded) {
      fs.writeFileSync(path.join(logDir, name), "old\n");
      fs.utimesSync(path.join(logDir, name), new Date(at), new Date(at));
    }
    const first = retainLogFile(logDir, { name: shared });
    const second = retainLogFile(logDir, { name: shared });

    first();
    pruneLogDir(logDir, 1);
    assert.ok(fs.existsSync(path.join(logDir, shared)), "second connection still writes the file");

    second();
    pruneLogDir(logDir, 1);
    assert.ok(!fs.existsSync(path.join(logDir, shared)), "pruned after the last release");
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("request logs are unaffected by the gateway log size cap", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-reqcap-"));
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    // --max-log-size 只约束 gateway.log；请求日志完整写入，不因极小的上限被截断或滚动。
    const config: GatewayConfig = logTestConfig(logDir);
    config.maxGatewayLogBytes = 1;
    const handler = createGatewayHandler(config, "proxy-key");
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cliproxy/claude-opus-4-6", input: "hi" }),
    }));
    assert.equal(response.status, 200);
    const text = fs.readdirSync(logDir)
      .filter((name) => name.startsWith("cliproxy-"))
      .map((name) => fs.readFileSync(path.join(logDir, name), "utf8"))
      .join("");
    assert.match(text, /=== POST \/v1\/responses ===/);
    assert.match(text, /--- response body ---/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("--max-request-logs rejects negative, fractional, and non-numeric input", () => {  assert.equal(parseMaxRequestLogs("0"), 0);
  assert.equal(parseMaxRequestLogs("42"), 42);
  assert.throws(() => parseMaxRequestLogs("-1"), /--max-request-logs/);
  assert.throws(() => parseMaxRequestLogs("1.5"), /--max-request-logs/);
  assert.throws(() => parseMaxRequestLogs("all"), /--max-request-logs/);
  assert.throws(() => parseMaxRequestLogs("99999999999999999999"), /--max-request-logs/);
});

test("--max-log-size parses byte sizes and rejects negative, invalid, and overflowing input", () => {
  assert.equal(parseMaxLogSize("0"), 0);
  assert.equal(parseMaxLogSize("8B"), 8);
  assert.equal(parseMaxLogSize("512KB"), 524288);
  assert.equal(parseMaxLogSize("10MB"), 10485760);
  assert.equal(parseMaxLogSize("1M"), 1048576);
  assert.equal(parseMaxLogSize("2k"), 2048);
  assert.equal(parseMaxLogSize("1 MB"), 1048576);
  assert.equal(parseMaxLogSize("1 G"), 1073741824);
  assert.throws(() => parseMaxLogSize("-1MB"), /--max-log-size/);
  assert.throws(() => parseMaxLogSize("wat"), /--max-log-size/);
  assert.throws(() => parseMaxLogSize("99999999999999999999GB"), /--max-log-size/);
  // bytes 包会把 "1MiB" 静默解析成 1 字节，必须显式拒绝而非错误设限。
  assert.throws(() => parseMaxLogSize("1MiB"), /--max-log-size/);
  assert.throws(() => parseMaxLogSize("1mbb"), /--max-log-size/);
});

test("capGatewayLog copies oversized content into timestamped backups and truncates in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-rotate-"));
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-rotate-keep-"));
  try {
    const logFile = path.join(dir, "gateway.log");
    const oversized = `${"old gateway output ".repeat(80)}\n`;
    fs.writeFileSync(logFile, oversized);

    capGatewayLog(logFile, 1024);

    // 原内容完整进入毫秒时间戳备份；原文件保持存在、被原地清空，进程持有的 fd 不受影响。
    const backups = fs.readdirSync(dir).filter((name) => /^gateway-\d{17}\.log$/.test(name));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), oversized);
    assert.equal(fs.statSync(logFile).size, 0);

    // 未超限（含即将写入的预留字节）时不滚动。
    fs.writeFileSync(logFile, "fresh\n");
    capGatewayLog(logFile, 1024, 10);
    assert.equal(fs.readFileSync(logFile, "utf8"), "fresh\n");

    // 备份只保留最新的 5 个，最旧先删。
    const keepLog = path.join(keepDir, "gateway.log");
    fs.writeFileSync(keepLog, "x");
    for (let index = 0; index < 7; index += 1) {
      fs.writeFileSync(
        path.join(keepDir, `gateway-${"20200101000000" + String(index).padStart(3, "0")}.log`),
        `b${index}`,
      );
    }
    capGatewayLog(keepLog, 4, 10);
    const remaining = fs.readdirSync(keepDir)
      .filter((name) => /^gateway-\d{17}\.log$/.test(name))
      .sort();
    assert.equal(remaining.length, 5);
    assert.equal(remaining[0], "gateway-20200101000000003.log");
    assert.equal(fs.statSync(keepLog).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(keepDir, { recursive: true, force: true });
  }
});

test("capGatewayLog prunes gateway.error.log backups by the derived file name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-rotate-err-"));
  try {
    const errorLog = path.join(dir, "gateway.error.log");
    const oversized = `${"unhandledRejection stack\n".repeat(80)}\n`;
    fs.writeFileSync(errorLog, oversized);
    for (let index = 0; index < 7; index += 1) {
      fs.writeFileSync(
        path.join(dir, `gateway.error-${"20200101000000" + String(index).padStart(3, "0")}.log`),
        `b${index}`,
      );
    }

    capGatewayLog(errorLog, 1024);

    // 裁剪必须按 gateway.error- 前缀匹配：写死 gateway- 会让这批备份一个不删。
    const remaining = fs.readdirSync(dir)
      .filter((name) => /^gateway\.error-\d{17}\.log$/.test(name))
      .sort();
    assert.equal(remaining.length, 5);
    assert.equal(remaining[0], "gateway.error-20200101000000003.log");
    assert.equal(fs.statSync(errorLog).size, 0);
    assert.equal(fs.readFileSync(path.join(dir, remaining[4]), "utf8"), oversized);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("consecutive capGatewayLog rotations do not overwrite each other's backups", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-rotate-ms-"));
  try {
    const logFile = path.join(dir, "gateway.log");
    fs.writeFileSync(logFile, "first\n");
    capGatewayLog(logFile, 2);
    fs.writeFileSync(logFile, "second\n");
    // 连续两次滚动即使落在同一秒，毫秒时间戳也保证备份名不同、内容不丢。
    await new Promise((resolve) => setTimeout(resolve, 3));
    capGatewayLog(logFile, 2);

    const backups = fs.readdirSync(dir).filter((name) => /^gateway-\d{17}\.log$/.test(name)).sort();
    assert.equal(backups.length, 2);
    const contents = backups.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).sort();
    assert.deepEqual(contents, ["first\n", "second\n"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capGatewayLog truncates in place so open fds keep writing the live log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-cap-fd-"));
  try {
    // 模拟 launchd 持有的进程日志 fd（O_APPEND）：滚动必须保持活跃文件的 inode 不变，
    // 否则该 fd 的后续写入会全部落进备份文件。rename 方案在这条用例下必然失败。
    const logFile = path.join(dir, "gateway.error.log");
    fs.writeFileSync(logFile, `${"ERR-1 ".repeat(400)}\n`);
    const fd = fs.openSync(logFile, "a");
    try {
      fs.writeSync(fd, "fd-holds\n");
      capGatewayLog(logFile, 1024);
      fs.writeSync(fd, "after-rotate\n");

      const active = fs.readFileSync(logFile, "utf8");
      assert.match(active, /after-rotate/);
      assert.equal(active.includes("ERR-1"), false);
      const backups = fs.readdirSync(dir)
        .filter((name) => /^gateway\.error-\d{17}\.log$/.test(name));
      assert.equal(backups.length, 1);
      const backupText = fs.readFileSync(path.join(dir, backups[0]), "utf8");
      assert.match(backupText, /ERR-1/);
      assert.match(backupText, /fd-holds/);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config --max-request-logs persists, audits, and validates input", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-config-log-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    configVersion: GATEWAY_CONFIG_VERSION,
    requestLogging: true,
    logDir: paths.logDir,
    maxRequestLogs: 3,
  }));
  const auditEntries = (): string => fs.readFileSync(paths.stdoutLog, "utf8");
  const originalLog = console.log;
  const printed: string[] = [];
  console.log = (line?: unknown) => { printed.push(String(line)); };
  try {
    await runCli(["config", "--max-request-logs", "20"]);
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).maxRequestLogs, 20);
    assert.match(auditEntries(), /maxRequestLogs: 3 -> 20/);

    await runCli(["config"]);
    assert.match(printed.join("\n"), /"maxRequestLogs": 20/);

    await assert.rejects(runCli(["config", "--max-request-logs", "-1"]), /--max-request-logs/);
    // 解析失败发生在写盘之前，配置不被破坏。
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).maxRequestLogs, 20);
  } finally {
    console.log = originalLog;
    process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("config --max-log-size persists, audits, and caps the gateway log", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-config-logsize-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    configVersion: GATEWAY_CONFIG_VERSION,
    requestLogging: false,
    logDir: paths.logDir,
  }));
  // 预置超过 1KB 的旧日志：审计写入前先滚动备份，旧内容完整进入 gateway-<时间戳>.log，
  // 新审计条目写进新建的 gateway.log。
  fs.writeFileSync(paths.stdoutLog, `--2020-01-01 00:00:00.000--\n${"old gateway output ".repeat(80)}\n`);
  const originalLog = console.log;
  const printed: string[] = [];
  console.log = (line?: unknown) => { printed.push(String(line)); };
  try {
    await runCli(["config", "--max-log-size", "1KB"]);
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).maxGatewayLogBytes, 1024);
    const text = fs.readFileSync(paths.stdoutLog, "utf8");
    assert.match(text, /maxGatewayLogBytes: null -> 1024/);
    assert.equal(text.startsWith("--"), true);
    assert.equal(text.includes("old gateway output"), false);
    assert.ok(Buffer.byteLength(text) <= 1024);
    const backups = fs.readdirSync(paths.runtimeHome)
      .filter((name) => /^gateway-\d{17}\.log$/.test(name));
    assert.equal(backups.length, 1);
    assert.match(
      fs.readFileSync(path.join(paths.runtimeHome, backups[0]), "utf8"),
      /old gateway output/,
    );
    assert.match(printed.join("\n"), /Gateway log size cap set to 1KB\./);

    await runCli(["config"]);
    assert.match(printed.join("\n"), /"maxGatewayLogBytes": 1024/);

    await assert.rejects(runCli(["config", "--max-log-size", "-1MB"]), /--max-log-size/);
    // 解析失败发生在写盘之前，配置不被破坏。
    assert.equal(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).maxGatewayLogBytes, 1024);
  } finally {
    console.log = originalLog;
    process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("config audit appends to the gateway log without standalone log files", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-audit-keep-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    configVersion: GATEWAY_CONFIG_VERSION,
    requestLogging: false,
    logDir: paths.logDir,
    maxRequestLogs: 2,
  }));

  const originalLog = console.log;
  console.log = (line?: unknown) => {};
  try {
    await runCli(["config", "--log", "on"]);

    // 审计条目进 gateway.log 单文件，不依赖 requestLogging，也不受 maxRequestLogs 影响。
    assert.match(fs.readFileSync(paths.stdoutLog, "utf8"), /requestLogging: false -> true/);
    const stray = fs.readdirSync(paths.logDir).filter((name) => name.startsWith("cliproxy-config-"));
    assert.deepEqual(stray, []);
  } finally {
    console.log = originalLog;
    process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("protocol negotiation 426 is logged but kept out of the error digest", async () => {
  const originalFetch = globalThis.fetch;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-426-log-"));
  const processLog = path.join(logDir, "gateway.log");
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    const handler = createGatewayHandler(
      logTestConfig(logDir),
      "proxy-key",
      "invalid",
      new Set<string>(),
      undefined,
      undefined,
      undefined,
      { file: processLog, maxBytes: 0 },
    );
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

    // 426 仍是一次完成的请求：走摘要行，不进错误摘要。摘要与请求日志在同一次同步写入里，
    // 因此等到请求日志出现即可读到。
    assert.match(fs.readFileSync(processLog, "utf8"), /-> 426 \(\d+ms\)/);
    assert.doesNotMatch(fs.readFileSync(processLog, "utf8"), /!!!/);
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
    upstreamBaseUrl: "https://proxy.example/v1",
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

test("image generations inherit the cliproxy route of their triggering turn", async () => {
  const originalFetch = globalThis.fetch;
  const captured: string[] = [];
  let sent: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push(String(url instanceof Request ? url.url : url));
    sent = init;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const config = {
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/v1",
    upstreamBaseUrl: "https://proxy.example/v1",
    catalogPath: "/tmp/missing-catalog.json",
  };
  try {
    const cpaThreads = new Set<string>();
    const cpaTurns = new Set<string>();
    const handler = createGatewayHandler(config, "proxy-key", "invalid", cpaThreads, cpaTurns);

    // CPA 线程的 turn 请求：cliproxy 模型 + thread-id + x-codex-turn-metadata 携带 turn_id。
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "thread-id": "thread-image",
        "x-codex-routing-hint": "model=cliproxy/free/muse-spark-1.3",
        "x-codex-turn-metadata": JSON.stringify({
          session_id: "thread-image",
          thread_id: "thread-image",
          turn_id: "turn-image-1",
        }),
      },
      body: JSON.stringify({ model: "cliproxy/free/muse-spark-1.3", input: "画图标" }),
    }));
    assert.equal(captured.at(-1), "https://proxy.example/v1/responses");

    // 同一 turn 的图片请求：不带 thread-id，只有 x-codex-image-turn-id，必须继承 cliproxy
    // 路由并换 CPA key（此前会漏到官方，用本地 OAuth 被拒 403）。
    await handler(new Request("http://127.0.0.1:8320/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local-oauth",
        "x-codex-image-turn-id": "turn-image-1",
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "icon" }),
    }));
    assert.equal(captured.at(-1), "https://proxy.example/v1/images/generations");
    assert.equal(new Headers(sent?.headers).get("authorization"), "Bearer proxy-key");

    // 官方线程的 turn（无前缀模型）不进 cpaTurns：其图片请求仍走官方，不被污染。
    await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "thread-id": "thread-official-image",
        "x-codex-routing-hint": "model=gpt-5.6-luna",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-official-image", turn_id: "turn-official-1" }),
      },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "hi" }),
    }));
    assert.equal(captured.at(-1), "https://official.example/v1/responses");

    await handler(new Request("http://127.0.0.1:8320/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer official-oauth",
        "x-codex-image-turn-id": "turn-official-1",
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "icon" }),
    }));
    assert.equal(captured.at(-1), "https://official.example/v1/images/generations");
    assert.equal(new Headers(sent?.headers).get("authorization"), "Bearer official-oauth");

    // 未知 turn（网关重启丢内存表、别的客户端）回落默认官方路由，行为与粘性 miss 一致。
    await handler(new Request("http://127.0.0.1:8320/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-image-turn-id": "turn-never-seen",
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "icon" }),
    }));
    assert.equal(captured.at(-1), "https://official.example/v1/images/generations");
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
    upstreamBaseUrl: "https://cliproxy.example/v1",
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

  // split 模式 CPA 模型放行，认证域与 upstream-only 相同。
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

  // upstream-only：符合 CPA 侧约定的模型交给 CLIProxy，剥官方 OAuth 与其他 API key。
  const cpaAllowedHeaders = {
    ...probeHeaders,
    "x-codex-routing-hint": "model=gpt-5.6-luna",
  };
  const cliproxy = responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", { headers: cpaAllowedHeaders }),
    { ...config, upstreamOnly: true },
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
    { ...config, upstreamOnly: true },
    "proxy-key",
  );
  assert.ok(cpaNonGpt);
  assert.equal(cpaNonGpt.url, "wss://cliproxy.example/v1/responses");
  assert.ok(responsesWebSocketTarget(
    new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { ...probeHeaders, "x-codex-routing-hint": "model=codex-auto-review" },
    }),
    { ...config, upstreamOnly: true },
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

test("upstream-only mode forwards HTTP and WebSocket models without prefix routing", async () => {
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
      upstreamBaseUrl: "https://cliproxy.example/v1",
      catalogPath: "/tmp/missing-catalog.json",
      upstreamOnly: true,
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
    upstreamBaseUrl: "https://proxy.example/v1",
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

  // 同一 session 的多条连接（含 subagent 派生的 thread）必须落到同一个文件，
  // 否则每秒一个文件会把一次会话拆成几十个碎片。
  const session = "01a01960-3a52-7311-9258-f9144ad58b65";
  const first = websocketLogFile("v1-responses", session);
  const second = websocketLogFile("v1-responses", session);
  assert.equal(first.name, `cliproxy-v1-responses-ws-${session}.log`);
  assert.equal(second.name, first.name, "same session must reuse one file");
  assert.notEqual(first.name, a.name);

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
      upstreamBaseUrl: "https://cliproxy.example/v1",
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
      upstreamBaseUrl: "https://cliproxy.example/v1",
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
      upstreamBaseUrl: "https://cliproxy.example/v1",
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
      upstreamBaseUrl: "https://cliproxy.example/v1",
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

test("upstream catalog keeps the CLIProxy Codex format for the cliproxy type", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    assert.equal(new URL(String(url)).searchParams.get("client_version"), "2.0.0");
    return Response.json({ models: [{ slug: "claude-opus", display_name: "Claude Opus" }] });
  }) as typeof fetch;
  try {
    const catalog = await fetchUpstreamCatalog("http://127.0.0.1:8317/v1", "", "cliproxy", "2.0.0");
    assert.equal(catalog.models[0]?.display_name, "Claude Opus");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("newapi upstream synthesizes catalog entries from an OpenAI model list", async () => {
  const snapshot = { models: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Proven previous-generation model.",
      visibility: "list",
      supported_in_api: true,
      context_window: 272000,
      max_context_window: 272000,
      supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
      prefer_websockets: true,
      minimal_client_version: "0.124.0",
      priority: 12,
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      description: "Frontier model.",
      visibility: "list",
      context_window: 272000,
      minimal_client_version: "0.130.0",
      priority: 3,
    },
  ] };
  // 厂商预设（models/vendor_models.json 的角色：分组覆盖表，与根目录 models.json 同构）。
  const vendors = compileModelOverrides({
    moonshotai: [{
      name: "k3",
      display_name: "Kimi K3",
      description: "Kimi K3, 1M context",
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Light reasoning" },
        { effort: "high", description: "Enhanced reasoning" },
      ],
      context_window: 1048576,
      max_context_window: 1048576,
      visibility: "list",
    }],
  }, "test");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-newapi-ladder-test-"));
  const modelsConfigFile = path.join(tempDir, "models.json");
  fs.writeFileSync(modelsConfigFile, JSON.stringify({
    "my-vendor": [{ name: "custom-*", context_window: 200000, description: "Curated vendor default" }],
  }));
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (url, options) => {
    requestedUrls.push(String(url));
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer sk-newapi");
    return Response.json({ object: "list", data: [
      { id: "K3" },
      { id: "GPT-5.5" },
      { id: "gpt-5.5" },
      { id: "gpt-5.6-sol" },
      { id: "custom-model-x" },
      { id: "unknown-model" },
      { id: "" },
      { id: "  " },
      { object: "model" },
      "not-an-object",
    ] });
  }) as typeof fetch;
  try {
    const catalog = await fetchUpstreamCatalog("https://newapi.example.com/v1", "sk-newapi", "newapi", "0.0.0", {
      snapshot,
      vendors,
      overrides: loadModelOverrides(modelsConfigFile),
    });
    assert.deepEqual(requestedUrls, ["https://newapi.example.com/v1/models"]);
    // 大小写重复的 ID 只保留一份，列表按 ID 排序，无法解析的条目被忽略。
    assert.deepEqual(
      catalog.models.map((model) => model.slug),
      ["custom-model-x", "GPT-5.5", "gpt-5.6-sol", "K3", "unknown-model"],
    );

    // 1. 厂商目录精确命中（大小写不敏感）：沿用官方完整条目，不继承 gpt-5.5 的任何字段。
    const vendorEntry = catalog.models[3];
    assert.equal(vendorEntry.display_name, "Kimi K3");
    assert.equal(vendorEntry.description, "Kimi K3, 1M context");
    assert.equal(vendorEntry.context_window, 1048576);
    assert.equal(vendorEntry.default_reasoning_level, "high");
    assert.deepEqual(
      (vendorEntry.supported_reasoning_levels as unknown[])[0],
      { effort: "low", description: "Light reasoning" },
    );
    assert.equal("prefer_websockets" in vendorEntry, false);

    // 2. 快照已知模型沿用原条目元数据，slug 保持上游提供的写法。
    const known = catalog.models[1];
    assert.equal(known.slug, "GPT-5.5");
    assert.equal(known.display_name, "GPT-5.5");
    assert.equal(known.description, "Proven previous-generation model.");
    assert.equal(known.minimal_client_version, "0.124.0");
    assert.equal(catalog.models[2].display_name, "GPT-5.6 Sol");

    // 3. models.json 规则命中：极简基底 + 规则字段，不携带 GPT 专属配置。
    const curated = catalog.models[0];
    assert.equal(curated.context_window, 200000);
    assert.equal(curated.description, "Curated vendor default");
    assert.equal("model_messages" in curated, false);
    assert.equal("prefer_websockets" in curated, false);
    assert.equal("supported_reasoning_levels" in curated, false);

    // 4. 均未命中：克隆 gpt-5.5 基底并替换标识字段、解除最小客户端版本限制。
    const fallback = catalog.models[4];
    assert.equal(fallback.display_name, "unknown-model");
    assert.match(String(fallback.description), /OpenAI-compatible model "unknown-model"/);
    assert.equal(fallback.context_window, 272000);
    assert.deepEqual(fallback.supported_reasoning_levels, [{ effort: "medium", description: "Balanced" }]);
    assert.equal(fallback.minimal_client_version, undefined);

    assert.deepEqual(catalog.models.map((model) => model.priority), [0, 1, 2, 3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bundled vendor presets fully define z.ai, moonshotai, and deepseek models", () => {
  const rules = loadModelOverrides(path.resolve(import.meta.dir, "../models/vendor_models.json"));
  const snapshot = { models: [{
    slug: "gpt-5.5",
    context_window: 272000,
    prefer_websockets: true,
    model_messages: { instructions_template: "You are GPT" },
  }] };

  // z.ai 组：官方条目，零 gpt-5.5 字段残留。
  const glm = synthesizeModelEntry("glm-5.3", 0, snapshot, rules);
  assert.equal(glm.context_window, 1048576);
  assert.equal(glm.default_reasoning_level, "max");
  assert.equal("prefer_websockets" in glm, false);
  assert.equal("model_messages" in glm, false);

  // moonshotai 组：Kimi 官方条目。
  const kimi = synthesizeModelEntry("k3-256k", 1, snapshot, rules);
  assert.equal(kimi.context_window, 262144);
  assert.equal(kimi.default_reasoning_level, "high");
  assert.deepEqual(kimi.supported_reasoning_levels, [
    { effort: "low", description: "Light reasoning" },
    { effort: "high", description: "Enhanced reasoning" },
    { effort: "max", description: "Deep reasoning" },
  ]);
  assert.deepEqual(kimi.input_modalities, ["text", "image"]);

  // deepseek 组：官方条目。
  const ds = synthesizeModelEntry("deepseek-v4-pro", 2, snapshot, rules);
  assert.equal(ds.context_window, 1048576);
  assert.equal(ds.default_reasoning_level, "high");
  assert.equal(ds.default_verbosity, "low");
  assert.deepEqual(ds.truncation_policy, { mode: "tokens", limit: 10000 });

  // V4.1 Flash 正式名称与别名均命中原生多模态厂商预设。
  const overrides = loadModelOverrides(path.resolve(import.meta.dir, "../models.json"));
  const flash = synthesizeModelEntry("deepseek-v4.1-flash", 3, snapshot, rules);
  for (const id of ["deepseek-v4.1-flash", "deepseek-flash", "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-flash"]) {
    const entry = synthesizeModelEntry(id, 3, snapshot, rules);
    assert.deepEqual(entry, { ...flash, slug: id });
    assert.equal(entry.display_name, "DeepSeek-V4.1-Flash");
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.match(String(entry.description), /native multimodal visual understanding/);
    assert.equal("model_messages" in entry, false);
    const refined = mergeCatalog({ models: [entry] }, { models: [] }, "cliproxy/", overrides).models[0];
    assert.deepEqual(refined.input_modalities, ["text", "image"]);
    assert.equal(refined.description, entry.description);
  }
});

test("newapi upstream rejects malformed or empty /models responses", async () => {
  const originalFetch = globalThis.fetch;
  const base = "https://newapi.example.com/v1";
  const snapshot = { models: [{ slug: "gpt-5.5" }] };
  try {
    globalThis.fetch = (async () => new Response("{invalid")) as unknown as typeof fetch;
    await assert.rejects(
      fetchUpstreamCatalog(base, "sk-newapi", "newapi", "0.0.0", { snapshot }),
      /did not return JSON/,
    );

    globalThis.fetch = (async () => Response.json({ models: [{ slug: "codex-style" }] })) as unknown as typeof fetch;
    await assert.rejects(
      fetchUpstreamCatalog(base, "sk-newapi", "newapi", "0.0.0", { snapshot }),
      /data array/,
    );

    globalThis.fetch = (async () => Response.json({ data: [] })) as unknown as typeof fetch;
    await assert.rejects(
      fetchUpstreamCatalog(base, "sk-newapi", "newapi", "0.0.0", { snapshot }),
      /no models/,
    );

    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(
      fetchUpstreamCatalog(base, "sk-newapi", "newapi", "0.0.0", { snapshot }),
      /HTTP 401/,
    );

    await assert.rejects(
      fetchUpstreamCatalog(base, "sk-newapi", "newapi"),
      /requires a codex_client_models snapshot/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("synthesizeModelEntry fails when the snapshot lacks the gpt-5.5 base", () => {
  assert.throws(
    () => synthesizeModelEntry("any-model", 0, { models: [{ slug: "gpt-6-astra" }] }),
    /does not contain the "gpt-5.5" base entry/,
  );
});

test("codex catalog snapshot parsing validates the shape", () => {
  assert.throws(() => parseCodexCatalog("{invalid"), /Invalid codex catalog/);
  assert.throws(() => parseCodexCatalog({}), /expected/);
  assert.throws(
    () => parseCodexCatalog({ models: [{ display_name: "no slug" }] }),
    /no models/,
  );
  assert.deepEqual(
    parseCodexCatalog({ models: [
      { slug: "gpt-5.5" },
      { slug: "gpt-5.5" },
      { slug: "gpt-6-astra" },
    ] }).models.map((model) => model.slug),
    ["gpt-5.5", "gpt-6-astra"],
  );
});

test("synthesized entries can still be refined by model overrides", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-newapi-override-test-"));
  const modelsConfigFile = path.join(tempDir, "models.json");
  fs.writeFileSync(modelsConfigFile, JSON.stringify({
    "z.ai": [{ name: "glm-5.3", context_window: 1048576, max_context_window: 1048576 }],
  }));
  try {
    await syncCatalog({
      catalogFile: path.join(tempDir, "catalog.json"),
      modelsConfigFile,
      proxyModels: [synthesizeModelEntry("glm-5.3", 0, { models: [{ slug: "gpt-5.5", context_window: 272000 }] })],
    });
    const catalog = JSON.parse(fs.readFileSync(path.join(tempDir, "catalog.json"), "utf8"));
    // 裸名别名让 z.ai 组的元数据套用到 new-api 的裸模型 ID，覆盖基底克隆值。
    assert.equal(catalog.models[0].context_window, 1048576);
    assert.equal(catalog.models[0].max_context_window, 1048576);
    assert.equal(catalog.models[0].priority, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("override rules also match bare model ids from other groups", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bare-override-test-"));
  const configFile = path.join(tempDir, "models.json");
  fs.writeFileSync(configFile, JSON.stringify({
    "z.ai": [{ name: "glm-5.3", context_window: 1048576 }],
    deepseek: [{ name: "deepseek-v4-*", context_window: 1048576 }],
  }));
  try {
    const merged = mergeCatalog({ models: [] }, { models: [
      { slug: "z.ai/glm-5.3" },
      { slug: "glm-5.3" },
      { slug: "deepseek-v4-preview" },
      { slug: "other-model" },
    ] }, "cliproxy/", loadModelOverrides(configFile));
    // CLIProxy 的 vendor/model ID 与 new-api 的裸 ID 命中同一份覆盖。
    assert.equal(merged.models[0].context_window, 1048576);
    assert.equal(merged.models[1].context_window, 1048576);
    assert.equal(merged.models[2].context_window, 1048576);
    assert.equal(merged.models[3].context_window, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("universal star rules stay scoped to their group prefix", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-star-scope-test-"));
  const configFile = path.join(tempDir, "models.json");
  fs.writeFileSync(configFile, JSON.stringify({
    "z.ai": [{ name: "*", description: "z.ai fallback" }],
  }));
  try {
    const merged = mergeCatalog({ models: [] }, { models: [
      { slug: "z.ai/glm-5.3" },
      { slug: "glm-5.3" },
      { slug: "gpt-5.2" },
    ] }, "cliproxy/", loadModelOverrides(configFile));
    assert.equal(merged.models[0].description, "z.ai fallback");
    assert.equal(merged.models[1].description, undefined);
    assert.equal(merged.models[2].description, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("--upstream-type only accepts cliproxy or newapi", () => {
  assert.equal(parseUpstreamTypeOption(undefined), undefined);
  assert.equal(parseUpstreamTypeOption("cliproxy"), "cliproxy");
  assert.equal(parseUpstreamTypeOption("newapi"), "newapi");
  assert.throws(() => parseUpstreamTypeOption("bogus"), /--upstream-type expects cliproxy or newapi/);
});

test("invalid upstreamType warns without rejecting the config", () => {
  const warnings = gatewayConfigWarnings({
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: "/tmp/catalog.json",
    upstreamType: "bogus",
  });
  assert.deepEqual(warnings, ["$.upstreamType should be one of cliproxy, newapi"]);
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
