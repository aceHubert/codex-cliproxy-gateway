import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { compileModelFilter, filterExcludedModels } from "../src/catalog.ts";
import { applyWebUiConfigPatch, parseExcludedModels } from "../src/config-update.ts";
import { joinExcludedLines, splitExcludedLines } from "../src/ui/excluded-models-field.ts";
import { collectCompatibleModels, excludeModels, type ExcludeModelsDependencies } from "../src/cli.ts";
import { resolvePaths } from "../src/paths.ts";
import { GATEWAY_CONFIG_SCHEMA_URL } from "../src/config.ts";
import type { GatewayConfig, ResolvedPaths } from "../src/types.ts";

test("exclusion filter matches exact IDs, vendor prefixes, and globs case-insensitively", () => {
  const filter = compileModelFilter([
    "agy/gemini-2.5-flash",
    "codebuddy-intl/",
    "qoder-cn/*",
    "zcode*",
  ]);
  assert.equal(filter.isEmpty, false);
  assert.equal(filter.isExcluded("agy/gemini-2.5-flash"), true);
  assert.equal(filter.isExcluded("AGY/Gemini-2.5-Flash"), true);
  assert.equal(filter.isExcluded("agy/gemini-2.5-pro"), false);
  assert.equal(filter.isExcluded("codebuddy-intl/gpt-4o"), true);
  assert.equal(filter.isExcluded("codebuddy-cn/gpt-4o"), false);
  assert.equal(filter.isExcluded("qoder-cn/qoder-code-x"), true);
  assert.equal(filter.isExcluded("qoder-intl/qoder-code-x"), false);
  assert.equal(filter.isExcluded("zcode/glm-5.3"), true);
  assert.equal(filter.isExcluded("cliproxy/glm-5.3"), false);
});

test("exclusion filter ignores empty rules and bare wildcards from hand-edited configs", () => {
  const filter = compileModelFilter(["", "   ", "*"]);
  assert.equal(filter.isEmpty, true);
  assert.equal(filter.isExcluded("codebuddy-cn/gpt-4o"), false);
  const empty = compileModelFilter(undefined);
  assert.equal(empty.isEmpty, true);
});

test("prefix rules without a trailing slash only match that exact model", () => {
  const filter = compileModelFilter(["codebuddy-cn"]);
  assert.equal(filter.isExcluded("codebuddy-cn"), true);
  assert.equal(filter.isExcluded("codebuddy-cn/gpt-4o"), false);
});

test("filterExcludedModels removes matching entries and keeps the catalog untouched when empty", () => {
  const catalog = {
    models: [
      { slug: "gpt-5.5" },
      { slug: "cliproxy/glm-5.3" },
      { slug: "codebuddy-cn/gpt-4o" },
      { slug: "agy/gemini-2.5-flash" },
    ],
  };
  const filtered = filterExcludedModels(catalog, ["codebuddy-cn/", "agy/gemini-2.5-flash"]);
  assert.deepEqual(filtered.models.map((model) => model.slug), ["gpt-5.5", "cliproxy/glm-5.3"]);
  assert.equal(filterExcludedModels(catalog, []), catalog);
});

test("parseExcludedModels trims, drops blanks, dedupes case-insensitively, and rejects bare wildcards", () => {
  assert.deepEqual(
    parseExcludedModels([" codebuddy-cn/* ", "", "CB-INTL/", "cb-intl/", "  "]),
    ["codebuddy-cn/*", "CB-INTL/"],
  );
  assert.deepEqual(parseExcludedModels([]), []);
  assert.throws(() => parseExcludedModels(["*"]), /would exclude every model/);
  assert.throws(() => parseExcludedModels(["ok", "***"]), /would exclude every model/);
  assert.throws(() => parseExcludedModels("codebuddy-cn/*"), /expects an array/);
  assert.throws(() => parseExcludedModels([42]), /expects an array/);
});

test("web ui textarea helpers convert between lines and rule arrays", () => {
  assert.deepEqual(splitExcludedLines("codebuddy-cn/*\r\n\r\n  qoder-cn/* \n"), ["codebuddy-cn/*", "qoder-cn/*"]);
  assert.deepEqual(splitExcludedLines("   \n "), []);
  assert.equal(joinExcludedLines(["a", "b"]), "a\nb");
  assert.equal(joinExcludedLines(undefined), "");
});

function makeCliPaths(home: string): ResolvedPaths {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  return paths;
}

interface CliFixture {
  paths: ResolvedPaths;
  config: GatewayConfig;
  home: string;
  cleanup: () => void;
}

function makeCliFixture(excludedModels?: string[]): CliFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-exclude-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousLog = console.log;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  console.log = () => {};
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const config: GatewayConfig = {
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: "0.0.0-test",
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: ["alpha", "beta"],
    ...(excludedModels ? { excludedModels } : {}),
  };
  fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 4, installedAt: "test", gatewayBaseUrl: "http://127.0.0.1:8320/v1", config }));
  fs.writeFileSync(paths.catalogFile, JSON.stringify({
    models: [
      { slug: "alpha", display_name: "Alpha", priority: 0 },
      { slug: "beta", display_name: "Beta", priority: 1 },
      { slug: "gamma", display_name: "Gamma", priority: 2 },
    ],
  }));
  fs.writeFileSync(paths.modelsCacheFile, JSON.stringify({
    fetched_at: new Date().toISOString(), client_version: "0.150.0", models: [{ slug: "cliproxy/alpha" }],
  }));
  return {
    paths, config, home,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      console.log = previousLog;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("collectCompatibleModels lists prefixed upstream models from the synced catalog file", async () => {
  const fixture = makeCliFixture();
  try {
    const snapshot = await collectCompatibleModels(fixture.config);
    assert.deepEqual(snapshot.entries.map((model) => model.slug), ["cliproxy/alpha", "cliproxy/beta", "cliproxy/gamma"]);
    assert.deepEqual(snapshot.failures, []);
  } finally {
    fixture.cleanup();
  }
});

test("collectCompatibleModels keeps original upstream IDs in upstream-only mode", async () => {
  const fixture = makeCliFixture();
  try {
    const snapshot = await collectCompatibleModels({ ...fixture.config, upstreamOnly: true });
    assert.deepEqual(snapshot.entries.map((model) => model.slug), ["alpha", "beta", "gamma"]);
  } finally {
    fixture.cleanup();
  }
});

test("collectCompatibleModels reports a failed upstream catalog without throwing", async () => {
  const fixture = makeCliFixture();
  try {
    fs.rmSync(fixture.paths.catalogFile);
    const snapshot = await collectCompatibleModels(fixture.config);
    assert.deepEqual(snapshot.entries, []);
    assert.equal(snapshot.failures.length, 1);
    assert.match(snapshot.failures[0], /CLIProxy/);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude with patterns appends rules, persists config, audits, and invalidates the codex cache", async () => {
  const fixture = makeCliFixture(["agy/gemini-2.5-flash"]);
  try {
    await excludeModels(fixture.paths, fixture.config, "codebuddy-cn/*  cliproxy/alpha,beta-x");
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, [
      "agy/gemini-2.5-flash",
      "codebuddy-cn/*",
      "cliproxy/alpha",
      "beta-x",
    ]);
    const audit = fs.readFileSync(fixture.paths.stdoutLog, "utf8");
    assert.match(audit, /models --exclude/);
    assert.match(audit, /excludedModels/);
    const cache = JSON.parse(fs.readFileSync(fixture.paths.modelsCacheFile, "utf8")) as { fetched_at: string };
    assert.equal(cache.fetched_at, "2000-01-01T00:00:00Z");
    const state = JSON.parse(fs.readFileSync(fixture.paths.stateFile, "utf8")) as { config: GatewayConfig };
    assert.deepEqual(state.config.excludedModels, saved.excludedModels);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude none clears the exclusion list", async () => {
  const fixture = makeCliFixture(["codebuddy-cn/*"]);
  try {
    await excludeModels(fixture.paths, fixture.config, "none");
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, []);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude with unchanged rules does not rewrite the config", async () => {
  const fixture = makeCliFixture(["codebuddy-cn/*"]);
  try {
    const before = fs.statSync(fixture.paths.gatewayConfig).mtimeMs;
    await excludeModels(fixture.paths, fixture.config, "codebuddy-cn/*");
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, ["codebuddy-cn/*"]);
    assert.equal(fs.statSync(fixture.paths.gatewayConfig).mtimeMs, before);
    assert.equal(fs.existsSync(fixture.paths.stdoutLog), false);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude rejects bare wildcards before any write", async () => {
  const fixture = makeCliFixture();
  try {
    await assert.rejects(excludeModels(fixture.paths, fixture.config, "*"), /would exclude every model/);
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.equal(saved.excludedModels, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude without a terminal explains the non-interactive alternative", async () => {
  const fixture = makeCliFixture();
  try {
    await assert.rejects(
      excludeModels(fixture.paths, fixture.config, true),
      /requires an interactive terminal/,
    );
  } finally {
    fixture.cleanup();
  }
});

/** 与 gateway.test.ts 相同的假 TTY：EventEmitter 上按 keypress 语义发按键。 */
function fakeTty(): { input: unknown; output: unknown } {
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
    columns: 120,
    write() { return true; },
  };
  return { input, output };
}

test("interactive models --exclude pre-checks exact rules and preserves glob/prefix rules", async () => {
  const fixture = makeCliFixture(["cliproxy/alpha", "qoder-cn/*"]);
  try {
    const { input, output } = fakeTty();
    const selection = excludeModels(fixture.paths, fixture.config, true, false, {
      input: input as unknown as ExcludeModelsDependencies["input"],
      output: output as unknown as ExcludeModelsDependencies["output"],
    });
    // excludeModels 先收集目录再挂按键监听：等它挂好再发按键。
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 排序列表：cliproxy/alpha（已勾选）、cliproxy/beta、cliproxy/gamma。
    (input as EventEmitter).emit("keypress", " ", { name: "space" }); // 取消排除 cliproxy/alpha
    (input as EventEmitter).emit("keypress", "", { name: "down" });
    (input as EventEmitter).emit("keypress", " ", { name: "space" }); // 勾选排除 cliproxy/beta
    (input as EventEmitter).emit("keypress", "", { name: "enter" });
    await selection;
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    // 精确规则由勾选结果替换；qoder-cn/* 无法用勾选表达，原样保留。
    assert.deepEqual(saved.excludedModels, ["qoder-cn/*", "cliproxy/beta"]);
  } finally {
    fixture.cleanup();
  }
});

test("web ui config patch persists normalized excludedModels and reports the change", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-exclude-patch-"));
  try {
    const paths = makeCliPaths(home);
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
      configVersion: "0.0.0-test",
      host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
      officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "http://127.0.0.1:8317/v1",
      catalogPath: paths.catalogFile, excludedModels: [" stale "],
    }));
    const { applied } = applyWebUiConfigPatch(paths, { excludedModels: ["qoder-cn/*", "qoder-cn/*", " "] }, false);
    assert.deepEqual(applied, [{ field: "excludedModels", before: [" stale "], after: ["qoder-cn/*"] }]);
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, ["qoder-cn/*"]);

    // 值未变化时不写盘也不落审计。
    const before = fs.statSync(paths.gatewayConfig).mtimeMs;
    const again = applyWebUiConfigPatch(paths, { excludedModels: ["qoder-cn/*"] }, false);
    assert.deepEqual(again.applied, []);
    assert.equal(fs.statSync(paths.gatewayConfig).mtimeMs, before);

    assert.throws(
      () => applyWebUiConfigPatch(paths, { excludedModels: ["*"] }, false),
      /would exclude every model/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
