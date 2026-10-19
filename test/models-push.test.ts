import test from "./host-test.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { pushModelsToTargets, type ModelPushTarget } from "../apps/gateway/src/models-push.ts";
import { runCli, runModelsPush, type PushModelsDependencies } from "../apps/gateway/src/cli.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";
import { GATEWAY_CONFIG_SCHEMA_URL } from "../apps/gateway/src/config.ts";
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

test("pushModelsToTargets applies excludedModels scoped to local plugin models", async () => {
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
    assert.deepEqual(target.seen.map((model) => model.slug), ["qoder-cn/qoder-code", "zcode/glm-5.3"]);
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
        config: { ...baseConfig, excludedModels: ["agy/"] },
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
  keys: Array<[string, { name: string }]>,
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
    // 唯一的插件模型被排除 → 清单为空，推送中止；但排除规则已经落盘。
    await assert.rejects(
      runCli(["models", "--exclude", "opencode-zen/grok-code-free", "--push", "zcode"]),
      /model push aborted; no local adapter models to push/,
    );
    const savedConfig = JSON.parse(fs.readFileSync(fixture.paths.gatewayConfig, "utf8"));
    assert.deepEqual(savedConfig.excludedModels, ["opencode-zen/grok-code-free"]);
    assert.equal(fs.readFileSync(providerConfigFile, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});
