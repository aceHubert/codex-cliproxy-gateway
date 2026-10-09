import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { compileModelFilter, filterExcludedModels } from "../src/catalog.ts";
import {
  applyWebUiConfigPatch,
  excludedModelGroupsFor,
  expandExcludedModelGroups,
  isLocalAdapterExclusionPattern,
  isLocalAdapterModel,
  normalizeExcludedModels,
  parseExcludedModels,
  splitExcludedModelsByGroup,
} from "../src/config-update.ts";
import { joinExcludedLines, splitExcludedLines } from "../src/ui/excluded-models-field.ts";
import { collectCompatibleModels, excludeModels, runCli, type ExcludeModelsDependencies } from "../src/cli.ts";
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
  // 产品级家族通配：一条规则覆盖该产品的全部现行地域前缀，不越界到其他产品；
  // 裸旧前缀（codebuddy/）已不再产出目录，glob 不命中亦无实际影响（拆分归一仍识别它）。
  const product = compileModelFilter(["codebuddy-*/gpt-4o"]);
  assert.equal(product.isExcluded("codebuddy-intl/gpt-4o"), true);
  assert.equal(product.isExcluded("codebuddy-cn/gpt-4o"), true);
  assert.equal(product.isExcluded("codebuddy/gpt-4o"), false);
  assert.equal(product.isExcluded("workbuddy-intl/gpt-4o"), false);
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

test("parseExcludedModels trims, drops blanks, dedupes case-insensitively, and rejects family-wide or out-of-scope forms", () => {
  assert.deepEqual(
    parseExcludedModels([" codebuddy-intl/gpt-4o ", "", "agy/gemini-2.5-flash", "AGY/Gemini-2.5-Flash", "  "]),
    ["codebuddy-intl/gpt-4o", "agy/gemini-2.5-flash"],
  );
  assert.deepEqual(parseExcludedModels([]), []);
  assert.deepEqual(parseExcludedModels([
    "qoder-cn/qoder-*", "zcode/glm*", "zcode*/glm-5.3",
    "codebuddy-*/gpt-4o", "workbuddy-*/gpt-4o", "qoder-*/qwen-3.8-flash",
  ]), [
    "qoder-cn/qoder-*", "zcode/glm*", "zcode*/glm-5.3",
    "codebuddy-*/gpt-4o", "workbuddy-*/gpt-4o", "qoder-*/qwen-3.8-flash",
  ]);
  assert.throws(() => parseExcludedModels(["*"]), /would exclude every model/);
  assert.throws(() => parseExcludedModels(["agy/x", "***"]), /would exclude every model/);
  assert.throws(() => parseExcludedModels(["qoder-cn/"]), /whole qoder-cn\/ family; turn that compatibility endpoint off/);
  assert.throws(() => parseExcludedModels(["qoder-cn/*"]), /whole qoder-cn\/ family; turn that compatibility endpoint off/);
  // 作用域外（上游由 selectedModels 管理、官方不可排除）、无前缀与不完整前缀一律拒绝；
  // 旧前缀（codebuddy/、qoder/）与 zcode 动态 provider 前缀属于确定前缀，接受。
  assert.deepEqual(parseExcludedModels(["codebuddy/gpt-4o", "zcode-myprovider/glm"]), ["codebuddy/gpt-4o", "zcode-myprovider/glm"]);
  assert.throws(() => parseExcludedModels(["cliproxy/alpha"]), /must start with a full local adapter prefix/);
  assert.throws(() => parseExcludedModels(["gpt-native"]), /must start with a full local adapter prefix/);
  assert.throws(() => parseExcludedModels(["*flash"]), /must start with a full local adapter prefix/);
  assert.throws(() => parseExcludedModels(["zcode-*"]), /must start with a full local adapter prefix/);
  // 家族通配必须有具体模型：整族形态仍被拒。
  assert.throws(() => parseExcludedModels(["zcode*/"]), /whole zcode\*\/ family/);
  assert.throws(() => parseExcludedModels(["codebuddy-*/"]), /whole codebuddy-\*\/ family/);
  assert.throws(() => parseExcludedModels("agy/x"), /expects an array/);
  assert.throws(() => parseExcludedModels([42]), /expects an array/);
});

test("normalizeExcludedModels tolerates legacy family and out-of-scope rules while trimming and deduping", () => {
  assert.deepEqual(
    normalizeExcludedModels([" qoder-cn/ ", "QODER-CN/", "qoder-intl/*", "", "cliproxy/gamma", "gpt-native"]),
    ["qoder-cn/", "qoder-intl/*", "cliproxy/gamma", "gpt-native"],
  );
});

const GROUP_TEST_CONFIG: GatewayConfig = {
  host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
  officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "http://127.0.0.1:8317/v1",
  catalogPath: "/tmp/catalog.json",
};

test("the exclusion scope follows the authoritative adapter prefixes", () => {
  assert.equal(isLocalAdapterModel("zcode/glm-5.3"), true);
  assert.equal(isLocalAdapterModel("zcode-team-coding-plan/glm-5.3"), true);
  assert.equal(isLocalAdapterModel("zcode-myprovider/glm.3"), true);
  assert.equal(isLocalAdapterModel("codebuddy-intl/gpt-4o"), true);
  assert.equal(isLocalAdapterModel("codebuddy/gpt-4o"), true);
  assert.equal(isLocalAdapterModel("qoder-cn/qoder-code"), true);
  assert.equal(isLocalAdapterModel("qoder/qoder-code"), true);
  assert.equal(isLocalAdapterModel("agy/gemini-2.5-flash"), true);
  assert.equal(isLocalAdapterModel("cliproxy/gamma"), false);
  assert.equal(isLocalAdapterModel("gpt-native"), false);
  // 规则必须带完整前缀：固定前缀按权威清单，zcode 家族通配（zcode*/）与动态 provider
  // 前缀（zcode-<id>/）同属确定形态。
  assert.equal(isLocalAdapterExclusionPattern("zcode*/glm-5.3"), true);
  assert.equal(isLocalAdapterExclusionPattern("codebuddy-*/gpt-4o"), true);
  assert.equal(isLocalAdapterExclusionPattern("workbuddy-*/gpt-4o"), true);
  assert.equal(isLocalAdapterExclusionPattern("qoder-*/qwen-3.8-flash"), true);
  assert.equal(isLocalAdapterExclusionPattern("zcode/glm*"), true);
  assert.equal(isLocalAdapterExclusionPattern("zcode-team-coding-plan/glm"), true);
  assert.equal(isLocalAdapterExclusionPattern("zcode-myprovider/glm"), true);
  assert.equal(isLocalAdapterExclusionPattern("codebuddy/gpt-4o"), true);
  assert.equal(isLocalAdapterExclusionPattern("agy/gemini-2.5-flash"), true);
  assert.equal(isLocalAdapterExclusionPattern("qoder-cn/qoder-*"), true);
  assert.equal(isLocalAdapterExclusionPattern("zcode-*"), false);
  assert.equal(isLocalAdapterExclusionPattern("cliproxy/alpha"), false);
  assert.equal(isLocalAdapterExclusionPattern("gpt-*"), false);
  assert.equal(isLocalAdapterExclusionPattern("*flash"), false);
});

test("excluded model groups normalize to one box per user-visible product", () => {
  const groups = excludedModelGroupsFor(GROUP_TEST_CONFIG);
  assert.equal(groups.length, 5);
  // 每组一个产品级家族通配；回显识别该产品的全部前缀（套餐档、cn/intl 地域、旧前缀）。
  assert.deepEqual(groups[0], {
    key: "zcode", endpoint: "zcode", prefix: "zcode*/",
    matchPrefixes: ["zcode/", "zcode-individual-coding-plan/", "zcode-team-coding-plan/", "zcode-start-plan/", "zcode*/"],
  });
  assert.deepEqual(groups[1], {
    key: "codebuddy", endpoint: "codebuddy", prefix: "codebuddy-*/",
    matchPrefixes: ["codebuddy-intl/", "codebuddy-cn/", "codebuddy/", "codebuddy-*/"],
  });
  assert.deepEqual(groups[2], {
    key: "workbuddy", endpoint: "codebuddy", prefix: "workbuddy-*/",
    matchPrefixes: ["workbuddy-intl/", "workbuddy-cn/", "workbuddy/", "workbuddy-*/"],
  });
  assert.deepEqual(groups[3], {
    key: "qoder", endpoint: "qoder", prefix: "qoder-*/",
    matchPrefixes: ["qoder-intl/", "qoder-cn/", "qoder/", "qoder-*/"],
  });
  assert.deepEqual(groups.at(-1), { key: "agy", endpoint: "agy", prefix: "agy/" });
  assert.ok(groups.every((group) => !group.key.includes("upstream") && !group.key.startsWith("cliproxy")));
  // upstream-only 模式同样只有适配器分组（排除在该模式下天然不生效）。
  assert.deepEqual(excludedModelGroupsFor({ ...GROUP_TEST_CONFIG, upstreamOnly: true }), groups);
});

test("excluded model groups split full rules into prefix-free entries and keep the rest verbatim", () => {
  const groups = excludedModelGroupsFor(GROUP_TEST_CONFIG);
  assert.deepEqual(splitExcludedModelsByGroup([
    "zcode/glm-5.3",
    "zcode-team-coding-plan/glm-5.3",
    "zcode*/glm-5.3",
    "codebuddy-cn/gpt-4o",
    "codebuddy/gpt-4o",
    "workbuddy-intl/gpt-4o",
    "qoder-cn/qoder-code-x",
    "qoder-intl/qoder-*",
    "qoder/qoder-code",
    "cliproxy/alpha",
    "gpt-native",
    "qoder-cn/",
    "zcode-myprovider/glm.3",
  ], groups), {
    entries: {
      zcode: ["glm-5.3", "glm-5.3", "glm-5.3"],
      codebuddy: ["gpt-4o", "gpt-4o"],
      workbuddy: ["gpt-4o"],
      qoder: ["qoder-code-x", "qoder-*", "qoder-code"],
      agy: [],
    },
    other: ["cliproxy/alpha", "gpt-native", "qoder-cn/", "zcode-myprovider/glm.3"],
  });
});

test("excluded model groups expand prefix-free entries back into full rules", () => {
  const groups = excludedModelGroupsFor(GROUP_TEST_CONFIG);
  // 每组保存为产品级家族通配：一条规则覆盖该产品的全部前缀（套餐档、cn/intl、旧前缀）。
  assert.deepEqual(expandExcludedModelGroups(
    { zcode: ["glm-5.3", "  "], codebuddy: ["gpt-4o"], qoder: ["qwen-3.8-flash"] },
    groups,
  ), ["zcode*/glm-5.3", "codebuddy-*/gpt-4o", "qoder-*/qwen-3.8-flash"]);
  // 地域/套餐前缀分组已不存在：按未知分组拒绝。
  assert.throws(() => expandExcludedModelGroups({ "zcode-team-coding-plan": ["glm-5.3"] }, groups),
    /Unknown excluded model group/);
  assert.throws(() => expandExcludedModelGroups({ "qoder-cn": ["qoder-code-x"] }, groups),
    /Unknown excluded model group/);
});

test("group expansion rejects bare wildcards, pasted prefixes, slashed entries, and unknown groups", () => {
  const groups = excludedModelGroupsFor(GROUP_TEST_CONFIG);
  assert.throws(() => expandExcludedModelGroups({ agy: ["*"] }, groups), /would exclude every model of this group/);
  assert.throws(() => expandExcludedModelGroups({ agy: ["agy/gemini-2.5-flash"] }, groups), /already carries the agy prefix/);
  assert.throws(() => expandExcludedModelGroups({ zcode: ["glm/x"] }, groups), /must be a bare model name without/);
  assert.throws(() => expandExcludedModelGroups({ upstream: ["alpha"] }, groups), /Unknown excluded model group/);
  assert.throws(() => expandExcludedModelGroups({ unknown: ["x"] }, groups), /Unknown excluded model group/);
  assert.throws(() => expandExcludedModelGroups({ agy: "gemini-2.5-flash" }, groups), /expects an array/);
  assert.throws(() => expandExcludedModelGroups("*", groups), /expects an object/);
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

test("collectCompatibleModels can skip upstream models for the exclusion picker", async () => {
  const fixture = makeCliFixture();
  try {
    const snapshot = await collectCompatibleModels(fixture.config, {}, { includeUpstream: false });
    assert.deepEqual(snapshot.entries, []);
    assert.deepEqual(snapshot.failures, []);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude with patterns appends rules, persists config, audits, and invalidates the codex cache", async () => {
  const fixture = makeCliFixture(["agy/gemini-2.5-flash"]);
  try {
    await excludeModels(fixture.paths, fixture.config, "codebuddy-intl/gpt-4o  qoder-cn/qoder-code");
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, [
      "agy/gemini-2.5-flash",
      "codebuddy-intl/gpt-4o",
      "qoder-cn/qoder-code",
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

test("models --exclude rejects family-wide and out-of-scope patterns but tolerates them in the saved config", async () => {
  const fixture = makeCliFixture(["qoder-cn/", "qoder-intl/*"]);
  try {
    await assert.rejects(excludeModels(fixture.paths, fixture.config, "qoder-cn/*"), /whole qoder-cn\/ family/);
    await assert.rejects(excludeModels(fixture.paths, fixture.config, "qoder-cn/"), /whole qoder-cn\/ family/);
    await assert.rejects(excludeModels(fixture.paths, fixture.config, "cliproxy/alpha"), /must start with a full local adapter prefix/);
    await assert.rejects(excludeModels(fixture.paths, fixture.config, "gpt-native"), /must start with a full local adapter prefix/);
    await assert.rejects(excludeModels(fixture.paths, fixture.config, "zcode-*"), /must start with a full local adapter prefix/);
    // 存量整族/作用域外规则不阻塞新规则的追加，也不在合并时丢失。
    await excludeModels(fixture.paths, fixture.config, "agy/gemini-2.5-flash");
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, ["qoder-cn/", "qoder-intl/*", "agy/gemini-2.5-flash"]);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude none clears the exclusion list", async () => {
  const fixture = makeCliFixture(["codebuddy-cn/gpt-4o"]);
  try {
    await excludeModels(fixture.paths, fixture.config, "none");
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, []);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude with unchanged rules does not rewrite the config", async () => {
  const fixture = makeCliFixture(["agy/gemini-2.5-flash"]);
  try {
    const before = fs.statSync(fixture.paths.gatewayConfig).mtimeMs;
    await excludeModels(fixture.paths, fixture.config, "agy/gemini-2.5-flash");
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, ["agy/gemini-2.5-flash"]);
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

test("interactive models --exclude lists only local adapter models with legacy rules preserved", async () => {
  const fixture = makeCliFixture(["agy/gemini-3.8-flash", "qoder-cn/"]);
  try {
    const config = { ...fixture.config, agy: true };
    const agyDeps: ExcludeModelsDependencies["agy"] = {
      cacheDirectory: path.join(fixture.home, "agy-cache"),
      refreshCatalogOnStart: false,
      credentials: async () => ({
        accessToken: "ya29.fake-agy-token",
        expiryMs: Date.now() + 3_600_000,
        identity: "identity-test",
        authMethod: "consumer",
      }),
      fetch: (async (input: string | URL | Request) => {
        const target = String(input);
        if (target.includes(":fetchAvailableModels")) {
          return Response.json({ models: {
            "gemini-3.5-flash": { displayName: "Gemini 3.5 Flash", supportsThinking: true, maxTokens: 1_000_000 },
            "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash", supportsThinking: true, maxTokens: 1_000_000 },
          } });
        }
        throw new Error(`未模拟的 agy 上游调用：${target}`);
      }) as typeof fetch,
    };
    const { input, output } = fakeTty();
    const selection = excludeModels(fixture.paths, config, true, false, {
      agy: agyDeps,
      input: input as unknown as ExcludeModelsDependencies["input"],
      output: output as unknown as ExcludeModelsDependencies["output"],
    });
    // excludeModels 先收集目录再挂按键监听：等它挂好再发按键。
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 勾选列表只含本地适配器模型（上游 cliproxy/* 不出现），已排序：
    // agy/gemini-3.5-flash、agy/gemini-3.8-flash（后者来自存量精确规则，预勾选）。
    (input as EventEmitter).emit("keypress", " ", { name: "space" }); // 勾选排除 gemini-3.5-flash
    (input as EventEmitter).emit("keypress", "", { name: "down" });
    (input as EventEmitter).emit("keypress", " ", { name: "space" }); // 取消勾选 gemini-3.8-flash
    (input as EventEmitter).emit("keypress", "", { name: "enter" });
    await selection;
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    // 精确规则由勾选结果替换；qoder-cn/ 无法用勾选表达，原样保留。
    assert.deepEqual(saved.excludedModels, ["qoder-cn/", "agy/gemini-3.5-flash"]);
  } finally {
    fixture.cleanup();
  }
});

test("interactive models --exclude without local adapter models explains the prerequisite", async () => {
  const fixture = makeCliFixture();
  try {
    const { input, output } = fakeTty();
    await assert.rejects(
      excludeModels(fixture.paths, fixture.config, true, false, {
        input: input as unknown as ExcludeModelsDependencies["input"],
        output: output as unknown as ExcludeModelsDependencies["output"],
      }),
      /No local compatibility models to list/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("config 无参回显包含当前排除规则", async () => {
  const fixture = makeCliFixture(["qoder-cn/*", "agy/gemini-2.5-flash"]);
  const originalLog = console.log;
  const printed: string[] = [];
  console.log = (line?: unknown) => { printed.push(String(line)); };
  try {
    await runCli(["config"]);
  } finally {
    console.log = originalLog;
    fixture.cleanup();
  }
  const output = printed.join("\n");
  const summary = JSON.parse(output.slice(output.indexOf("{"))) as { excludedModels: string[] };
  assert.deepEqual(summary.excludedModels, ["qoder-cn/*", "agy/gemini-2.5-flash"]);
});

test("models --exclude 拒绝与选择类参数组合，不静默忽略", async () => {
  const fixture = makeCliFixture();
  try {
    await assert.rejects(
      runCli(["models", "--exclude", "agy/x", "--select", "all"]),
      /--select cannot be combined with --exclude/,
    );
    await assert.rejects(
      runCli(["models", "--exclude", "agy/x", "--sync"]),
      /--exclude cannot be combined with --sync/,
    );
    await assert.rejects(
      runCli(["models", "--exclude", "agy/x", "--upstream-only"]),
      /--upstream-only.*only supported by install or models --sync/,
    );
    await assert.rejects(
      runCli(["models", "--exclude", "agy/x", "--model-merge-json", "https://example.com/models.json"]),
      /--model-merge-json requires models --sync/,
    );
    // 全部在写盘前被拒：配置保持原样。
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.equal(saved.excludedModels, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("web ui config patch expands excluded model groups into prefixed rules", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-exclude-patch-"));
  try {
    const paths = makeCliPaths(home);
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
      configVersion: "0.0.0-test",
      host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
      officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "http://127.0.0.1:8317/v1",
      catalogPath: paths.catalogFile, excludedModels: ["agy/gemini-2.5-flash", "zcode-team-coding-plan/glm-5.3"],
    }));
    // 分组条目补前缀后整组替换；zcode 组保存为家族通配（一条覆盖全部套餐前缀）。
    const { applied } = applyWebUiConfigPatch(paths, {
      excludedModelGroups: { agy: ["gemini-2.5-flash", "  "], qoder: ["qoder-code-x"], zcode: ["glm-5.3"] },
    }, false);
    assert.deepEqual(applied, [{
      field: "excludedModels",
      before: ["agy/gemini-2.5-flash", "zcode-team-coding-plan/glm-5.3"],
      after: ["agy/gemini-2.5-flash", "qoder-*/qoder-code-x", "zcode*/glm-5.3"],
    }]);
    const saved = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(saved.excludedModels, applied[0].after);

    // 值未变化时不写盘也不落审计。
    const before = fs.statSync(paths.gatewayConfig).mtimeMs;
    const again = applyWebUiConfigPatch(paths, {
      excludedModelGroups: { agy: ["gemini-2.5-flash"], qoder: ["qoder-code-x"], zcode: ["glm-5.3"] },
    }, false);
    assert.deepEqual(again.applied, []);
    assert.equal(fs.statSync(paths.gatewayConfig).mtimeMs, before);

    // 非法输入一律拒绝且不落盘。
    assert.throws(() => applyWebUiConfigPatch(paths, { excludedModelGroups: { agy: ["*"] } }, false),
      /would exclude every model of this group/);
    assert.throws(() => applyWebUiConfigPatch(paths, { excludedModelGroups: { agy: ["agy/x"] } }, false),
      /already carries the agy prefix/);
    assert.throws(() => applyWebUiConfigPatch(paths, { excludedModelGroups: { zcode: ["glm/x"] } }, false),
      /must be a bare model name without/);
    assert.throws(() => applyWebUiConfigPatch(paths, { excludedModelGroups: { upstream: ["alpha"] } }, false),
      /Unknown excluded model group/);
    assert.throws(() => applyWebUiConfigPatch(paths, {
      excludedModels: ["agy/x"],
      excludedModelGroups: { agy: ["x"] },
    }, false), /not both/);
    assert.throws(() => applyWebUiConfigPatch(paths, { excludedModels: ["qoder-cn/*"] }, false),
      /whole qoder-cn\/ family/);
    assert.throws(() => applyWebUiConfigPatch(paths, { excludedModels: ["cliproxy/x"] }, false),
      /must start with a full local adapter prefix/);
    const after = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(after.excludedModels, applied[0].after);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
