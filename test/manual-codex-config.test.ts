import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  resolveCodexConfigConflict,
  restoreManagedCodexToml,
  runCli,
} from "../src/cli.ts";
import { resolvePaths } from "../src/paths.ts";
import { readRootTomlString } from "../src/toml.ts";

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** 隔离 HOME/CODEX_HOME 并返回临时 paths；restore 负责还原环境与清理临时目录。 */
function withTempHome(): { paths: ReturnType<typeof resolvePaths>; restore: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-manual-codex-"));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const paths = resolvePaths();
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.mkdirSync(paths.codexHome, { recursive: true });
  return {
    paths,
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function writeManualGatewayConfig(
  paths: ReturnType<typeof resolvePaths>,
  overrides: Record<string, unknown> = {},
): void {
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    host: "127.0.0.1",
    port: 8320,
    mountPath: "/v1",
    prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/codex",
    upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile,
    selectedModels: [],
    ...overrides,
  }));
}

function writeManualState(paths: ReturnType<typeof resolvePaths>): void {
  fs.writeFileSync(paths.stateFile, JSON.stringify({
    version: 4,
    installedAt: "2026-10-02T00:00:00.000Z",
    gatewayBaseUrl: "http://127.0.0.1:8320/v1",
    config: {},
    codexConfigManaged: false,
  }));
}

/** 静默 console.log 并返回捕获的输出；restore 恢复原始实现。 */
function captureConsole(): { lines: string[]; restore: () => void } {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => { lines.push(String(line)); };
  return { lines, restore: () => { console.log = original; } };
}

test("codex config conflict defaults to manual and only an explicit yes manages config.toml", () => {
  const captured = captureConsole();
  try {
    // 非 TTY / --yes 免交互：一律取默认 N（不改写 config.toml），且不调用提问。
    assert.equal(resolveCodexConfigConflict({ skipPrompt: true }, () => {
      throw new Error("prompt must not run when --yes skips it");
    }), "manual");
    assert.equal(resolveCodexConfigConflict({ interactive: false }, () => {
      throw new Error("prompt must not run without a TTY");
    }), "manual");
    // 交互答 y → 转托管写入；答 N/其余 → 保持手动。
    assert.equal(resolveCodexConfigConflict({ interactive: true }, () => true), "managed");
    assert.equal(resolveCodexConfigConflict({ interactive: true }, () => false), "manual");
    // 每次抉择都先给出 warning，说明 upstream-only 与手动模式的冲突。
    const warnings = captured.lines.filter((line) => line.includes("WARNING"));
    assert.equal(warnings.length, 4);
  } finally {
    captured.restore();
  }
});

test("--manual-codex-config is only accepted by install", async () => {
  for (const command of ["models", "config", "uninstall", "restart", "status"]) {
    await assert.rejects(
      runCli([command, "--manual-codex-config"]),
      new RegExp(`Unknown option --manual-codex-config for command "${command}"`),
    );
  }
});

test("restoreManagedCodexToml restores the pristine file when untouched and only managed keys when hand-edited", () => {
  const { paths, restore } = withTempHome();
  try {
    const pristine = 'model = "gpt-native"\n';
    const backup = path.join(paths.codexHome, "config.toml.bak-cliproxy-gateway-20260924");
    fs.writeFileSync(backup, pristine);
    const record = { existed: true, backup };

    // 未手改：整文件还原纯净备份。
    const untouched = `${pristine}openai_base_url = "http://127.0.0.1:8320/v1"\n`;
    fs.writeFileSync(paths.configToml, untouched);
    restoreManagedCodexToml(paths, { configBackup: record, installedConfigHash: hash(untouched) }, untouched);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), pristine);

    // 手改过：仅还原受管键，用户新增内容保留。
    const handEdited = `${untouched.trimEnd()}\n\n[profiles.work]\nmodel = "gpt-5"\n`;
    fs.writeFileSync(paths.configToml, handEdited);
    restoreManagedCodexToml(paths, { configBackup: record }, handEdited);
    const afterHandEdited = fs.readFileSync(paths.configToml, "utf8");
    assert.equal(readRootTomlString(afterHandEdited, "openai_base_url"), undefined);
    assert.match(afterHandEdited, /\[profiles\.work\]/);

    // 缺备份时报出含键清单的可执行修复指引，而不是难以定位的读文件错误。
    fs.writeFileSync(paths.configToml, untouched);
    assert.throws(
      () => restoreManagedCodexToml(paths, {}, untouched),
      /no config\.toml backup; restore these keys/,
    );
  } finally {
    restore();
  }
});

test("models --sync completes the static switch in manual mode and prints the key to add", {
  skip: process.platform !== "darwin",
}, async () => {
  const { paths, restore } = withTempHome();
  const previousClientVersion = process.env.CODEX_CLIPROXY_CLIENT_VERSION;
  const originalFetch = globalThis.fetch;
  process.env.CODEX_CLIPROXY_CLIENT_VERSION = "1.2.3";
  writeManualGatewayConfig(paths);
  writeManualState(paths);
  const userToml = 'model = "gpt-native"\nopenai_base_url = "http://127.0.0.1:8320/v1"\n';
  fs.writeFileSync(paths.configToml, userToml);
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes("releases/latest/download/models.json")) return Response.json({});
    return Response.json({ models: [{ slug: "proxy-model", context_window: 100000 }] });
  }) as unknown as typeof fetch;
  const captured = captureConsole();

  try {
    await runCli(["models", "--sync", "--upstream-only", "--select", "all"]);

    // static 切换照常完成：路由、目录与选择都生效。
    const config = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
    assert.equal(config.upstreamOnly, true);
    assert.deepEqual(config.selectedModels, ["proxy-model"]);
    const catalog = JSON.parse(fs.readFileSync(paths.catalogFile, "utf8"));
    assert.deepEqual(catalog.models.map((model: { slug: string }) => model.slug), ["proxy-model"]);
    // config.toml 逐字节不变，state 保持手动且不跟踪 hash。
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), userToml);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
    assert.equal(state.codexConfigManaged, false);
    assert.equal("installedConfigHash" in state, false);
    // 需要手动添加的键以 warning + 确切值打印。
    const output = captured.lines.join("\n");
    assert.match(output, /WARNING: manual codex config mode: add this key/);
    assert.ok(output.includes(`model_catalog_json = "${paths.catalogFile}"`));

    // 模拟用户手动加键后切回 split：提示删除该键，仍不改写 config.toml。
    const userTomlWithKey = `${userToml}model_catalog_json = "${paths.catalogFile}"\n`;
    fs.writeFileSync(paths.configToml, userTomlWithKey);
    const secondRun = captureConsole();
    try {
      await runCli(["models", "--sync", "--select", "all"]);
      const secondOutput = secondRun.lines.join("\n");
      assert.match(secondOutput, /WARNING: manual codex config mode: remove model_catalog_json/);
      assert.equal(fs.readFileSync(paths.configToml, "utf8"), userTomlWithKey);
      const configAfterSplit = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8"));
      assert.equal(configAfterSplit.upstreamOnly, false);
    } finally {
      secondRun.restore();
    }
  } finally {
    captured.restore();
    globalThis.fetch = originalFetch;
    if (previousClientVersion === undefined) delete process.env.CODEX_CLIPROXY_CLIENT_VERSION;
    else process.env.CODEX_CLIPROXY_CLIENT_VERSION = previousClientVersion;
    restore();
  }
});

test("uninstall leaves config.toml untouched for manual installations", {
  skip: process.platform !== "darwin",
}, async () => {
  const { paths, restore } = withTempHome();
  // Keychain 按 $USER 定位条目：换成哨兵值，避免测试误删本机真实上游 Key。
  const previousUser = process.env.USER;
  process.env.USER = "ccp-manual-codex-test";
  writeManualGatewayConfig(paths);
  writeManualState(paths);
  const userToml = 'model = "gpt-native"\nopenai_base_url = "http://127.0.0.1:8320/v1"\n';
  fs.writeFileSync(paths.configToml, userToml);
  const captured = captureConsole();

  try {
    await runCli(["uninstall"]);
    assert.equal(fs.readFileSync(paths.configToml, "utf8"), userToml);
    assert.equal(fs.existsSync(paths.stateFile), false, "state.json should be reclaimed");
    assert.equal(fs.existsSync(paths.gatewayConfig), true, "config.json is preserved on uninstall");
    const output = captured.lines.join("\n");
    assert.match(output, /config\.toml was left untouched/);
    assert.match(output, /openai_base_url, model_catalog_json/);
  } finally {
    captured.restore();
    if (previousUser === undefined) delete process.env.USER;
    else process.env.USER = previousUser;
    restore();
  }
});

test("status reports codexConfigManaged false for manual installations", async () => {
  const { paths, restore } = withTempHome();
  writeManualGatewayConfig(paths);
  writeManualState(paths);
  const captured = captureConsole();

  try {
    await runCli(["status"]);
    // syncGatewayConfig 会先打印一行 Config synced；status 的产物是唯一以 { 开头的多行输出。
    const payload = JSON.parse(captured.lines.find((line) => line.startsWith("{"))!);
    assert.equal(payload.installed, true);
    assert.equal(payload.codexConfigManaged, false);
  } finally {
    captured.restore();
    restore();
  }
});
