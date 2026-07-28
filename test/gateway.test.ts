import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import { decideRoute, isLoopbackUrl, joinUpstreamUrl } from "../src/gateway.ts";
import { patchRootToml, restoreRootTomlKeys } from "../src/toml.ts";
import { resolvePaths } from "../src/paths.ts";
import { fetchCliProxyCatalog, mergeCatalog, loadNativeCatalog } from "../src/catalog.ts";
import {
  applyModelPickerKey,
  parseModelSelection,
  selectedModelsFromCatalog,
} from "../src/models.ts";

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
    model_catalog_json: "/Users/test/.codex/cliproxy-catalog.json",
  });
  assert.match(result, /model = "gpt-5.6-sol" # keep/);
  assert.match(result, /\[features\]\nfast_mode = true/);
  assert.match(result, /openai_base_url = "http:\/\/127\.0\.0\.1:8320\/v1"/);
});

test("paths keep Codex files separate from gateway runtime files", () => {
  const paths = resolvePaths({ HOME: "/Users/test" });
  assert.equal(paths.catalogFile, "/Users/test/.codex/cliproxy-catalog.json");
  assert.equal(paths.gatewayConfig, "/Users/test/.codex-cliproxy-gateway/config.json");
  assert.equal(paths.stateFile, "/Users/test/.codex-cliproxy-gateway/state.json");
  assert.equal(paths.stdoutLog, "/Users/test/.codex-cliproxy-gateway/gateway.log");
});

test("TOML uninstall restores only managed keys after manual edits", () => {
  const backup = 'openai_base_url = "https://old.example/v1" # original\nmodel = "gpt-old"\n';
  const current = 'openai_base_url = "http://127.0.0.1:8320/v1"\nmodel_catalog_json = "/Users/test/.codex/cliproxy-catalog.json"\nmodel = "gpt-new"\n';
  assert.equal(
    restoreRootTomlKeys(current, backup, ["openai_base_url", "model_catalog_json"]),
    'openai_base_url = "https://old.example/v1" # original\nmodel = "gpt-new"\n',
  );
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

import { createGatewayHandler } from "../src/gateway.ts";

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


test("native catalog preserves an existing configured catalog", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-source-test-"));
  const catalogFile = path.join(codexHome, "custom-catalog.json");
  fs.writeFileSync(catalogFile, JSON.stringify({
    models: [{ slug: "gpt-5.4", display_name: "GPT-5.4" }],
  }));
  try {
    assert.equal(loadNativeCatalog(catalogFile).models[0]?.slug, "gpt-5.4");
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("native catalog falls back to the Codex bundled catalog command", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bundled-model-test-"));
  const fakeCodex = path.join(tempDir, "codex");
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nprintf \'%s\\n\' \'{"models":[{"slug":"gpt-bundled"}]}\'\n');
  fs.chmodSync(fakeCodex, 0o755);
  try {
    assert.equal(loadNativeCatalog(path.join(tempDir, "missing.json"), fakeCodex).models[0]?.slug, "gpt-bundled");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("unauthenticated local CLIProxy catalog is fetched once without an auth header", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url, options) => {
    calls += 1;
    const value = new URL(String(url));
    assert.equal(value.searchParams.get("client_version"), "codex-cliproxy");
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    return Response.json({ models: [{ slug: "claude-opus", display_name: "Claude Opus" }] });
  }) as typeof fetch;
  try {
    const catalog = await fetchCliProxyCatalog("http://127.0.0.1:8317/v1", "");
    assert.equal(catalog.models[0]?.display_name, "Claude Opus");
    assert.equal(calls, 1);
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
