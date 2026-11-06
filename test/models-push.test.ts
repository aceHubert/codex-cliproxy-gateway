import test from "./host-test.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { pushModelsToTargets, type ModelPushTarget } from "../apps/gateway/src/models-push.ts";
import { runCli, runModelsPush, type PushModelsDependencies } from "../apps/gateway/src/cli.ts";
import { resolvePaths, runWithInstancePaths } from "../apps/gateway/src/paths.ts";
import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION, gatewayConfigWarnings } from "../apps/gateway/src/config.ts";
import type { GatewayConfig, ModelEntry, ResolvedPaths } from "../apps/gateway/src/types.ts";

function silenceConsole(): () => string[] {
  const lines: string[] = [];
  const previous = console.log;
  console.log = (line?: unknown, ...rest: unknown[]) => {
    lines.push([line, ...rest].map(String).join(" "));
  };
  return () => {
    console.log = previous;
    return lines;
  };
}

const baseConfig: GatewayConfig = {
  host: "127.0.0.1",
  port: 8320,
  upstreamBaseUrl: "http://127.0.0.1:8317/v1",
};

interface StubTarget extends ModelPushTarget {
  seen: ModelEntry[];
}

function stubTarget(id: string, behavior: { installed?: () => void; push?: (models: readonly ModelEntry[]) => void } = {}): StubTarget {
  return {
    id,
    seen: [],
    assertInstalled() {
      behavior.installed?.();
    },
    push(models) {
      this.seen.push(...models);
      behavior.push?.(models);
      return { summary: `${id}: pushed ${models.length} models`, notes: [] };
    },
  };
}

test("pushModelsToTargets 推送清单不受 excludedModels 影响", async () => {
  const restore = silenceConsole();
  try {
    const target = stubTarget("stub");
    await pushModelsToTargets({
      entries: [
        { slug: "agy/gamma" },
        { slug: "qoder-cn/qoder-code" },
        { slug: "zcode/glm-5.3" },
      ],
      failures: [],
      config: { ...baseConfig, excludedModels: ["agy/gamma", "cliproxy/alpha"] },
      targets: [target],
    });
    assert.deepEqual(target.seen.map((model) => model.slug), ["agy/gamma", "qoder-cn/qoder-code", "zcode/glm-5.3"]);
  } finally {
    restore();
  }
});

test("pushModelsToTargets 最终清单只减去 latestPushExcludedModels", async () => {
  const restore = silenceConsole();
  try {
    const target = stubTarget("stub");
    const config = { ...baseConfig, excludedModels: ["agy/global-*"], latestPushExcludedModels: ["agy/push-only"] };
    await pushModelsToTargets({
      entries: [{ slug: "agy/global-hidden" }, { slug: "agy/push-only" }, { slug: "agy/available" }],
      failures: [], config, targets: [target],
    });
    assert.deepEqual(target.seen.map((model) => model.slug), ["agy/global-hidden", "agy/available"]);
    await assert.rejects(pushModelsToTargets({
      entries: [{ slug: "agy/push-only" }],
      failures: [], config, targets: [target],
    }), /no local adapter models to push/);
    assert.deepEqual(target.seen.map((model) => model.slug), ["agy/global-hidden", "agy/available"], "排除后为空时不得再调用目标");
  } finally {
    restore();
  }
});

test("pushModelsToTargets warns on failed catalog sources and aborts only on an empty list", async () => {
  const restore = silenceConsole();
  try {
    const target = stubTarget("stub");
    // 来源失败降级为警告：与 models 无参视图口径一致（不可用插件的模型本就调不通）。
    await pushModelsToTargets({ entries: [{ slug: "agy/gamma" }], failures: ["Antigravity 模型目录不可用"], config: baseConfig, targets: [target] });
    assert.deepEqual(target.seen.map((model) => model.slug), ["agy/gamma"]);
    const lines = restore();
    assert.ok(lines.some((line) => line.includes("WARNING: Antigravity 模型目录不可用; its models are not included in this push")));
  } finally {
    restore();
  }
  const restore2 = silenceConsole();
  try {
    const target = stubTarget("stub");
    await assert.rejects(
      pushModelsToTargets({
        entries: [{ slug: "agy/gamma" }],
        failures: [],
        config: { ...baseConfig, latestPushExcludedModels: ["agy/gamma"] },
        targets: [target],
      }),
      /model push aborted; no local adapter models to push/,
    );
    assert.deepEqual(target.seen, []);
  } finally {
    restore2();
  }
});

test("pushModelsToTargets rejects unknown targets and selects subsets case-insensitively", async () => {
  const restore = silenceConsole();
  try {
    const zcode = stubTarget("zcode");
    const dsh = stubTarget("dsh");
    await assert.rejects(
      pushModelsToTargets({ entries: [{ slug: "alpha" }], failures: [], config: baseConfig, targetOption: "bogus", targets: [zcode, dsh] }),
      /unknown --push target "bogus"; available targets: zcode, dsh/,
    );
    await pushModelsToTargets({ entries: [{ slug: "alpha" }], failures: [], config: baseConfig, targetOption: " DSH ,zcode", targets: [zcode, dsh] });
    assert.deepEqual(dsh.seen.map((model) => model.slug), ["alpha"]);
    assert.deepEqual(zcode.seen.map((model) => model.slug), ["alpha"]);
  } finally {
    restore();
  }
});

test("pushModelsToTargets isolates failing targets and exits non-zero after reporting them", async () => {
  const restore = silenceConsole();
  let lines: string[] = [];
  try {
    const broken = stubTarget("broken", { push: () => {
      throw new Error("provider config unreadable");
    } });
    const healthy = stubTarget("healthy");
    await assert.rejects(
      pushModelsToTargets({ entries: [{ slug: "alpha" }], failures: [], config: baseConfig, targets: [broken, healthy] }),
      /model push failed for: broken/,
    );
    // 单目标失败不影响其余目标。
    assert.deepEqual(healthy.seen.map((model) => model.slug), ["alpha"]);

    const uninstalled = stubTarget("uninstalled", { installed: () => {
      throw new Error("not installed");
    } });
    await assert.rejects(
      pushModelsToTargets({ entries: [{ slug: "alpha" }], failures: [], config: baseConfig, targets: [uninstalled, healthy] }),
      /model push failed for: uninstalled/,
    );
    lines = restore();
    assert.ok(lines.some((line) => line.includes("WARNING: broken push failed: provider config unreadable")));
    assert.ok(lines.some((line) => line.includes("WARNING: uninstalled push failed: not installed")));
  } finally {
    restore();
  }
});

interface CliFixture {
  paths: ResolvedPaths;
  config: GatewayConfig;
  home: string;
  cleanup: () => void;
}

/** 与 model-exclude.test.ts 同款 CLI 夹具：装好的网关 + zen 离线目录缓存（插件模型源）。 */
function makeCliFixture(): CliFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-push-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousZcodeHome = process.env.ZCODE_HOME;
  const previousDshHome = process.env.DSH_HOME;
  const previousLog = console.log;
  const originalFetch = globalThis.fetch;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  // 真机目标一律指到临时目录，CLI 集成路径绝不触碰 ~/.zcode / ~/.dsh。
  process.env.ZCODE_HOME = path.join(home, "zcode-home");
  process.env.DSH_HOME = path.join(home, "dsh-home");
  console.log = () => {};
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/healthz")) throw Object.assign(new Error("测试网关未启动"), { code: "ECONNREFUSED" });
    throw new Error(`未模拟的模型请求：${String(input)}`);
  }) as unknown as typeof fetch;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  // push 恒走 reloadCatalog（纯缓存、零网络、与 upstreamOnly 无关）：落盘 zen 目录
  // 缓存即可提供插件模型，fetch 模拟保证任何网络刷新都会失败而非静默成功。
  const config: GatewayConfig = {
    zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: true,
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: "0.0.0-test",
    host: "127.0.0.1",
    port: 8320,
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: ["alpha"],
  };
  fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(paths.catalogFile, JSON.stringify({
    models: [{ slug: "alpha", display_name: "Alpha", context_window: 123456 }],
  }));
  // zen 离线目录缓存：content_hash 是 ids 的 sha256(JSON) 摘要（readDisk 校验），
  // fetch 模拟保证任何网络刷新都会失败而非静默成功。
  const zenIds = ["grok-code-free"];
  fs.writeFileSync(path.join(paths.runtimeHome, "opencode-zen-catalog.json"), JSON.stringify({
    fetched_at: Date.now(),
    ids: zenIds,
    content_hash: createHash("sha256").update(JSON.stringify(zenIds)).digest("hex"),
  }));
  return {
    paths, config, home,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousZcodeHome === undefined) delete process.env.ZCODE_HOME;
      else process.env.ZCODE_HOME = previousZcodeHome;
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
      globalThis.fetch = originalFetch;
      console.log = previousLog;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 临时 ZCode 配置（最小 cliproxy provider 形态，与真实 ~/.zcode/v2 同构）。 */
function writeZcodeFixture(home: string): { providerConfigFile: string; configFile: string } {
  const v2 = path.join(home, "v2");
  fs.mkdirSync(v2, { recursive: true });
  const configFile = path.join(v2, "config.json");
  const providerConfigFile = path.join(v2, "provider_config.json");
  const providerId = "11111111-1111-1111-1111-111111111111";
  fs.writeFileSync(configFile, JSON.stringify({
    provider: {
      [providerId]: {
        name: "cliproxy",
        kind: "openai-compatible",
        options: { apiKey: "test-key", apiKeyRequired: true, baseURL: "https://gateway.example/v1" },
        source: "custom",
        models: {},
      },
    },
  }, null, 2));
  fs.writeFileSync(providerConfigFile, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerOrder: [providerId],
      providerConfigRules: { providerRules: [
        { providerId, providerName: "cliproxy", config: { personalModelIds: [], modelOrder: [] } },
      ] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  }, null, 2));
  return { providerConfigFile, configFile };
}

/** 与 model-exclude.test.ts 相同的假 TTY：EventEmitter 上按 keypress 语义发按键。 */
function fakeTty(): { input: EventEmitter; output: unknown } {
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

/** 以 fake TTY 驱动 runModelsPush 的交互勾选（键序发完后等待承诺落定）。 */
async function pushWithKeys(
  targetOption: string | undefined,
  config: GatewayConfig,
  keys: Array<[string, { name: string; ctrl?: boolean }]>,
): Promise<void> {
  const { input, output } = fakeTty();
  const pushing = runModelsPush(targetOption, config, {
    input: input as unknown as PushModelsDependencies["input"],
    output: output as PushModelsDependencies["output"],
  });  // 选择器先收集目录再挂按键监听：等它挂好再发按键。
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const [ch, meta] of keys) input.emit("keypress", ch, meta);
  await pushing;
}

test("models --push 经交互勾选确认后写入（默认全选，直接回车即全量推送）", async () => {
  const fixture = makeCliFixture();
  try {
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    await pushWithKeys("zcode", fixture.config, [["", { name: "enter" }]]);
    const saved = JSON.parse(fs.readFileSync(providerConfigFile, "utf8"));
    const rule = saved.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy");
    assert.ok(rule, "应自动创建受管 agent-proxy rule");
    // 数据源只含本地 agent 插件模型：上游目录里的 alpha 不推送，zen 模型原样写入。
    assert.deepEqual(rule.config.modelOrder, ["opencode-zen/grok-code-free"]);
    assert.equal(rule.config.api.type, "anthropic-messages");
    // 用户自建 cliproxy rule 不被触碰。
    const userRule = saved.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "cliproxy");
    assert.deepEqual(userRule.config.modelOrder, []);
    assert.ok(fs.readdirSync(path.dirname(providerConfigFile)).some((name) => name.startsWith("provider_config.json.bak-agent-proxy-")));
  } finally {
    fixture.cleanup();
  }
});

test("models --push 交互勾选可取消个别模型后确认", async () => {
  const fixture = makeCliFixture();
  try {
    const ids = ["grok-code-free", "muse-free"];
    fs.writeFileSync(path.join(fixture.paths.runtimeHome, "opencode-zen-catalog.json"), JSON.stringify({
      fetched_at: Date.now(),
      ids,
      content_hash: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
    }));
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    // 列表第一项（grok-code-free）取消勾选后确认：只推送 muse-free。
    await pushWithKeys("zcode", fixture.config, [[" ", { name: "space" }], ["", { name: "enter" }]]);
    const saved = JSON.parse(fs.readFileSync(providerConfigFile, "utf8"));
    const rule = saved.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy");
    assert.deepEqual(rule.config.modelOrder, ["opencode-zen/muse-free"]);
  } finally {
    fixture.cleanup();
  }
});

test("models --push 保留暂时失效的排除偏好，并默认推送新模型", async () => {
  const fixture = makeCliFixture();
  try {
    const catalogFile = path.join(fixture.paths.runtimeHome, "opencode-zen-catalog.json");
    const ids = ["grok-code-free", "muse-free"];
    fs.writeFileSync(catalogFile, JSON.stringify({
      fetched_at: Date.now(), ids,
      content_hash: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
    }));
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    const configBefore = fs.readFileSync(fixture.paths.gatewayConfig, "utf8");
    await pushWithKeys("zcode", fixture.config, [[" ", { name: "space" }], ["", { name: "enter" }]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")).latestPushExcludedModels, ["opencode-zen/grok-code-free"]);

    // 暂时失效的推送排除项继续保留，网关排除规则不影响新模型默认推送。
    fixture.config.latestPushExcludedModels = ["opencode-zen/grok-code-free", "opencode-zen/removed"];
    fixture.config.excludedModels = ["opencode-zen/grok-code-free"];
    fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(fixture.config));
    ids.push("new-free");
    fs.writeFileSync(catalogFile, JSON.stringify({
      fetched_at: Date.now(), ids,
      content_hash: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
    }));
    const reloadedConfig = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    await pushWithKeys("zcode", reloadedConfig, [["", { name: "enter" }]]);
    const saved = JSON.parse(fs.readFileSync(providerConfigFile, "utf8"));
    const rule = saved.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy");
    assert.deepEqual(rule.config.modelOrder, ["opencode-zen/muse-free", "opencode-zen/new-free"]);
    const { latestPushExcludedModels, ...preservedConfig } = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"));
    assert.deepEqual(latestPushExcludedModels.sort(), ["opencode-zen/grok-code-free", "opencode-zen/removed"]);
    assert.deepEqual(preservedConfig, { ...JSON.parse(configBefore), excludedModels: ["opencode-zen/grok-code-free"] });
  } finally {
    fixture.cleanup();
  }
});

for (const rule of ["opencode-zen/grok-code-free", "OPENCODE-ZEN/GROK-*"]) {
  test(`models --push 首次使用 excludedModels 默认规则 ${rule}，确认后保持独立`, async () => {
    const fixture = makeCliFixture();
    try {
      const ids = ["grok-code-free", "muse-free"];
      fs.writeFileSync(path.join(fixture.paths.runtimeHome, "opencode-zen-catalog.json"), JSON.stringify({
        fetched_at: Date.now(), ids,
        content_hash: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
      }));
      fixture.config.excludedModels = [rule];
      fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(fixture.config));
      const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
      const before = fs.readFileSync(fixture.paths.gatewayConfig, "utf8");
      await assert.rejects(pushWithKeys("zcode", fixture.config, [["", { name: "c", ctrl: true }]]), /selection cancelled/);
      assert.equal(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"), before, "取消首次选择不初始化配置字段");

      await pushWithKeys("zcode", fixture.config, [["", { name: "enter" }]]);
      const savedConfig = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
      assert.deepEqual(savedConfig.latestPushExcludedModels, ["opencode-zen/grok-code-free"]);
      assert.deepEqual(savedConfig.excludedModels, [rule]);
      const saved = JSON.parse(fs.readFileSync(providerConfigFile, "utf8"));
      assert.deepEqual(saved.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy").config.modelOrder,
        ["opencode-zen/muse-free"]);

      // 改网关排除规则不再改变已经初始化的推送排除偏好。
      savedConfig.excludedModels = ["opencode-zen/muse-free"];
      fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(savedConfig));
      await pushWithKeys("zcode", savedConfig, [["", { name: "enter" }]]);
      const pushedAgain = JSON.parse(fs.readFileSync(providerConfigFile, "utf8"));
      assert.deepEqual(pushedAgain.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy").config.modelOrder,
        ["opencode-zen/muse-free"]);
    } finally {
      fixture.cleanup();
    }
  });
}

test("models --push 首次全选也保存空数组，后续不重复继承 excludedModels", async () => {
  const fixture = makeCliFixture();
  try {
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    await pushWithKeys("zcode", fixture.config, [["", { name: "enter" }]]);
    const savedConfig = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")) as GatewayConfig;
    assert.deepEqual(savedConfig.latestPushExcludedModels, [], "显式保存 [] 标识首次选择已经确认");
    savedConfig.excludedModels = ["opencode-zen/grok-code-free"];
    fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(savedConfig));
    await pushWithKeys("zcode", savedConfig, [["", { name: "enter" }]]);
    const saved = JSON.parse(fs.readFileSync(providerConfigFile, "utf8"));
    assert.deepEqual(saved.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy").config.modelOrder,
      ["opencode-zen/grok-code-free"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")).latestPushExcludedModels, []);
  } finally {
    fixture.cleanup();
  }
});

test("models --push 从全部模型选择，excludedModels 中的模型仍可勾选并推送", async () => {
  const fixture = makeCliFixture();
  try {
    fixture.config.latestPushExcludedModels = [];
    fixture.config.excludedModels = ["opencode-zen/grok-code-free"];
    const before = JSON.stringify(fixture.config);
    fs.writeFileSync(fixture.paths.gatewayConfig, before);
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    await pushWithKeys("zcode", fixture.config, [["", { name: "enter" }]]);
    const saved = JSON.parse(fs.readFileSync(providerConfigFile, "utf8"));
    const rule = saved.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy");
    assert.deepEqual(rule.config.modelOrder, ["opencode-zen/grok-code-free"]);
    assert.equal(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});

test("models --push 取消不覆盖缓存和客户端配置", async () => {
  const fixture = makeCliFixture();
  try {
    fixture.config.latestPushExcludedModels = ["opencode-zen/grok-code-free"];
    const before = JSON.stringify(fixture.config);
    fs.writeFileSync(fixture.paths.gatewayConfig, before);
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    const clientBefore = fs.readFileSync(providerConfigFile, "utf8");
    await assert.rejects(pushWithKeys("zcode", fixture.config, [
      [" ", { name: "space" }], ["", { name: "c", ctrl: true }],
    ]), /Model selection cancelled/);
    assert.equal(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"), before);
    assert.equal(fs.readFileSync(providerConfigFile, "utf8"), clientBefore);
  } finally {
    fixture.cleanup();
  }
});

test("models --push 确认后即保存排除偏好，目标失败也可复用", async () => {
  const fixture = makeCliFixture();
  try {
    fixture.config.latestPushExcludedModels = ["opencode-zen/grok-code-free"];
    fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(fixture.config));
    await assert.rejects(pushWithKeys("zcode", fixture.config, [[" ", { name: "space" }], ["", { name: "enter" }]]), /model push failed for: zcode/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")).latestPushExcludedModels, []);
  } finally {
    fixture.cleanup();
  }
});

test("models --push 格式错误的 latestPushExcludedModels 提示后恢复首次全选", async () => {
  const fixture = makeCliFixture();
  const previousWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    writeZcodeFixture(process.env.ZCODE_HOME!);
    for (const value of [null, { selectedModels: [] }, [42], [" "]]) {
      const config = { ...fixture.config, latestPushExcludedModels: value } as unknown as GatewayConfig;
      fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(config));
      await pushWithKeys("zcode", config, [["", { name: "enter" }]]);
      assert.deepEqual(JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")).latestPushExcludedModels, []);
    }
    assert.equal(warnings.filter((line) => line.includes("Invalid latestPushExcludedModels")).length, 4);
  } finally {
    console.warn = previousWarn;
    fixture.cleanup();
  }
});

test("models --push 缓存遵循当前实例目录", async () => {
  const fixture = makeCliFixture();
  try {
    writeZcodeFixture(process.env.ZCODE_HOME!);
    const otherPaths = resolvePaths(process.env, path.join(fixture.home, "other-instance"));
    fs.mkdirSync(otherPaths.runtimeHome, { recursive: true });
    fs.copyFileSync(path.join(fixture.paths.runtimeHome, "opencode-zen-catalog.json"),
      path.join(otherPaths.runtimeHome, "opencode-zen-catalog.json"));
    const otherConfig = { ...fixture.config, latestPushExcludedModels: ["opencode-zen/grok-code-free"] };
    fs.writeFileSync(otherPaths.gatewayConfig, JSON.stringify(otherConfig));
    await runWithInstancePaths(otherPaths, () => pushWithKeys("zcode", otherConfig, [[" ", { name: "space" }], ["", { name: "enter" }]]));
    assert.equal(JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")).latestPushExcludedModels, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(otherPaths.gatewayConfig, "utf8")).latestPushExcludedModels, []);
  } finally {
    fixture.cleanup();
  }
});

test("latestPushExcludedModels 的配置规范约束数组、非空 ID 和唯一性", () => {
  const config = { ...baseConfig, configVersion: "0.0.0-test" };
  for (const latestPushExcludedModels of [undefined, [], ["agy/gamma"]]) {
    assert.deepEqual(gatewayConfigWarnings({ ...config, ...(latestPushExcludedModels === undefined ? {} : { latestPushExcludedModels }) }), []);
  }
  for (const latestPushExcludedModels of [null, "agy/gamma", [42], [""], [" "], ["agy/gamma", "agy/gamma"]]) {
    assert.ok(gatewayConfigWarnings({ ...config, latestPushExcludedModels }).some((warning) => warning.includes("latestPushExcludedModels")));
  }
});

test("models --push 复用已加载的配置，保存时备份且保留排除和扩展字段", async () => {
  const fixture = makeCliFixture();
  const readFileSync = fs.readFileSync;
  try {
    const config = { ...fixture.config, excludedModels: ["agy/unused"], latestPushExcludedModels: ["opencode-zen/grok-code-free"], customSetting: { value: "保留" } };
    const before = JSON.stringify(config);
    fs.writeFileSync(fixture.paths.gatewayConfig, before);
    writeZcodeFixture(process.env.ZCODE_HOME!);
    let configReads = 0;
    fs.readFileSync = ((file: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
      if (String(file) === fixture.paths.gatewayConfig) configReads += 1;
      return Reflect.apply(readFileSync, fs, [file, ...args]);
    }) as typeof fs.readFileSync;
    await pushWithKeys("zcode", config, [[" ", { name: "space" }], ["", { name: "enter" }]]);
    assert.equal(configReads, 0, "选择和保存应复用已加载配置，不额外读取配置或独立缓存");
    fs.readFileSync = readFileSync;
    const saved = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"));
    assert.deepEqual(saved, { ...config, latestPushExcludedModels: [] });
    const backups = fs.readdirSync(fixture.paths.runtimeHome).filter((name) => name.startsWith("config.json.bak-agent-proxy-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(fixture.paths.runtimeHome, backups[0]), "utf8"), before);
    assert.equal(fs.existsSync(path.join(fixture.paths.runtimeHome, "models-push-selection.json")), false);
    const audit = fs.readFileSync(fixture.paths.stdoutLog, "utf8");
    assert.match(audit, /latestPushExcludedModels/);
    assert.match(audit, /models --push/);

    await pushWithKeys("zcode", config, [["", { name: "enter" }]]);
    assert.deepEqual(fs.readdirSync(fixture.paths.runtimeHome).filter((name) => name.startsWith("config.json.bak-agent-proxy-")), backups,
      "选择未变化时不重复写配置和备份");
  } finally {
    fs.readFileSync = readFileSync;
    fixture.cleanup();
  }
});

test("models --push 的 CLI 保存不会写入原配置缺失的 agent 默认开关", () => {
  const fixture = makeCliFixture();
  try {
    writeZcodeFixture(process.env.ZCODE_HOME!);
    const config: GatewayConfig & { catalogPath?: string } = {
      ...fixture.config, configVersion: GATEWAY_CONFIG_VERSION, latestPushExcludedModels: ["opencode-zen/grok-code-free"],
    };
    delete config.opencodeZen;
    delete config.catalogPath;
    fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(config));
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { runCli } from "./apps/gateway/src/cli.ts";
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      process.stdin.setRawMode = () => process.stdin;
      process.stdin.resume = () => process.stdin;
      process.stdin.pause = () => process.stdin;
      process.stdout.write = () => true;
      console.log = () => {};
      // 等待真实选择器挂好监听后确认，避免固定延迟丢按键。
      const timer = setInterval(() => {
        if (process.stdin.listenerCount("keypress")) {
          process.stdin.emit("keypress", " ", { name: "space" });
          process.stdin.emit("keypress", "", { name: "enter" });
        }
      }, 5);
      try { await runCli(["models", "--push", "zcode"]); } finally { clearInterval(timer); }
    `], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, CODEX_CLIPROXY_HOME: fixture.paths.runtimeHome },
      timeout: 5_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8")), {
      ...config, latestPushExcludedModels: [],
    });
  } finally {
    fixture.cleanup();
  }
});

test("models --push 选择期间配置变化时拒绝覆盖或推送", async () => {
  const fixture = makeCliFixture();
  try {
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    const clientBefore = fs.readFileSync(providerConfigFile, "utf8");
    const { input, output } = fakeTty();
    const pushing = runModelsPush("zcode", fixture.config, {
      input: input as unknown as PushModelsDependencies["input"],
      output: output as PushModelsDependencies["output"],
    });
    const rejected = assert.rejects(pushing, /config changed during model selection.*rerun models --push/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = JSON.stringify({ ...fixture.config, excludedModels: ["agy/changed"] });
    fs.writeFileSync(fixture.paths.gatewayConfig, updated);
    input.emit("keypress", "", { name: "enter" });
    await rejected;
    assert.equal(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"), updated);
    assert.equal(fs.readFileSync(providerConfigFile, "utf8"), clientBefore);
    assert.equal(fixture.config.latestPushExcludedModels, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("models --push 配置原子替换失败时保留原文件和客户端配置", async () => {
  const fixture = makeCliFixture();
  const renameSync = fs.renameSync;
  try {
    fixture.config.latestPushExcludedModels = ["opencode-zen/grok-code-free"];
    fs.writeFileSync(fixture.paths.gatewayConfig, JSON.stringify(fixture.config));
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    const clientBefore = fs.readFileSync(providerConfigFile, "utf8");
    const before = fs.readFileSync(fixture.paths.gatewayConfig, "utf8");
    fs.renameSync = (source, destination) => {
      if (String(destination) === fixture.paths.gatewayConfig) throw new Error("模拟配置原子替换失败");
      renameSync(source, destination);
    };
    await assert.rejects(pushWithKeys("zcode", fixture.config, [[" ", { name: "space" }], ["", { name: "enter" }]]), /模拟配置原子替换失败/);
    assert.equal(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"), before);
    assert.equal(fs.readFileSync(providerConfigFile, "utf8"), clientBefore);
    assert.deepEqual(fixture.config.latestPushExcludedModels, ["opencode-zen/grok-code-free"]);
  } finally {
    fs.renameSync = renameSync;
    fixture.cleanup();
  }
});

test("models --push 空选时停留在菜单内被拦截（requireNonEmpty）", async () => {
  const fixture = makeCliFixture();
  try {
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    const { input, output } = fakeTty();
    const pushing = runModelsPush("zcode", fixture.config, {
      input: input as unknown as PushModelsDependencies["input"],
      output: output as unknown as PushModelsDependencies["output"],
    });
    // 立即挂回调记录落定状态：断言时刻读取，微任务时序不影响判断。
    let settled = false;
    void pushing.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 取消唯一模型的勾选后回车：requireNonEmpty 在菜单内拦截，承诺继续挂起；
    // 再勾选回来回车才确认推送。
    input.emit("keypress", " ", { name: "space" });
    input.emit("keypress", "", { name: "enter" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false, "空选回车应停留在菜单内，不落定也不报错");
    input.emit("keypress", " ", { name: "space" });
    input.emit("keypress", "", { name: "enter" });
    await pushing;
    const saved = JSON.parse(fs.readFileSync(providerConfigFile, "utf8"));
    const rule = saved.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy");
    assert.deepEqual(rule.config.modelOrder, ["opencode-zen/grok-code-free"]);
  } finally {
    fixture.cleanup();
  }
});

test("models --push 无终端时报可执行错误（不提供跳过勾选的路径）", async () => {
  const fixture = makeCliFixture();
  try {
    writeZcodeFixture(process.env.ZCODE_HOME!);
    await assert.rejects(
      runModelsPush("zcode", fixture.config),
      /models --push requires an interactive terminal to confirm the model list/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("models --push 不先打印只读清单，直接进入选择流程", async () => {
  const fixture = makeCliFixture();
  try {
    writeZcodeFixture(process.env.ZCODE_HOME!);
    // runCli 走完整 models() 分支（非 TTY 会在选择前报错）；捕获输出确认
    // Selected/Active/Excluded 三段只读清单不再出现。
    const lines: string[] = [];
    const previous = console.log;
    console.log = (line?: unknown, ...rest: unknown[]) => {
      lines.push([line, ...rest].map(String).join(" "));
    };
    try {
      await assert.rejects(runCli(["models", "--push", "zcode"]), /requires an interactive terminal/);
    } finally {
      console.log = previous;
    }
    assert.ok(!lines.some((line) => line.includes("Selected CLIProxy models")), JSON.stringify(lines));
    assert.ok(!lines.some((line) => line.includes("Active compatible models")), JSON.stringify(lines));
    assert.ok(!lines.some((line) => line.includes("Excluded models")), JSON.stringify(lines));
  } finally {
    fixture.cleanup();
  }
});

test("models --push 未知目标在白名单层报错且不写任何文件", async () => {
  const fixture = makeCliFixture();
  try {
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    const before = fs.readFileSync(providerConfigFile, "utf8");
    await assert.rejects(runCli(["models", "--push", "bogus"]), /unknown --push target "bogus"; available targets: zcode, dsh/);
    assert.equal(fs.readFileSync(providerConfigFile, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});

test("models --exclude 与 --push 组合时先落盘排除规则再推送（推送失败不影响已落盘结果）", async () => {
  const fixture = makeCliFixture();
  try {
    const { providerConfigFile } = writeZcodeFixture(process.env.ZCODE_HOME!);
    const before = fs.readFileSync(providerConfigFile, "utf8");
    // 网关排除规则已保存；独立推送清单仍非空，继续进入选择器（本测试无 TTY）。
    await assert.rejects(
      runCli(["models", "--exclude", "opencode-zen/grok-code-free", "--push", "zcode"]),
      /models --push requires an interactive terminal/,
    );
    const savedConfig = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"));
    assert.deepEqual(savedConfig.excludedModels, ["opencode-zen/grok-code-free"]);
    assert.equal(fs.readFileSync(providerConfigFile, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});
