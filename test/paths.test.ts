import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  instanceMarker,
  managedCatalogFiles,
  normalizeRuntimeHomeInput,
  resolvePaths,
  runWithInstancePaths,
} from "../src/paths.ts";
import { requestLogDir } from "../src/request-log.ts";

test("受管目录清单包含两个产品缓存，且遵循实例运行目录", () => {
  for (const root of [undefined, path.resolve("/tmp/ccp-catalog-instance")]) {
    const paths = resolvePaths({ HOME: "/home/tester" }, root);
    const files = managedCatalogFiles(paths);
    assert.ok(files.includes(path.join(paths.runtimeHome, "codebuddy-catalog.json")));
    assert.ok(files.includes(path.join(paths.runtimeHome, "workbuddy-catalog.json")));
    assert.ok(files.every((file) => path.dirname(file) === paths.runtimeHome));
    assert.ok(!files.some((file) => /(?:codebuddy|workbuddy)-(?:cn|intl)-catalog\.json$/.test(file)));
  }
});

test("runtimeHome override scopes instance state and the LaunchAgent to the config directory", () => {
  const env = { HOME: "/home/tester" };
  const production = resolvePaths(env);
  assert.equal(production.runtimeHome, "/home/tester/.codex-cliproxy-gateway");
  assert.equal(production.launchAgent, "/home/tester/Library/LaunchAgents/codex-cliproxy-gateway.plist");

  // `serve --config <dir>/config.json` 的临时实例：管理面文件全部落在配置同目录；
  // LaunchAgent 使用 -temp 占位名——即使配置就放在 $HOME 下，也绝不与默认服务路径相同。
  const root = path.resolve("/tmp/ccp-instance");
  const instance = resolvePaths(env, root);
  assert.equal(instance.runtimeHome, root);
  assert.equal(instance.gatewayConfig, path.join(root, "config.json"));
  assert.equal(instance.stateFile, path.join(root, "state.json"));
  assert.equal(instance.uiTokenFile, path.join(root, "ui-token"));
  assert.equal(instance.stdoutLog, path.join(root, "gateway.log"));
  assert.equal(instance.logDir, path.join(root, "logs"));
  assert.equal(
    instance.launchAgent,
    path.join(root, "Library/LaunchAgents/codex-cliproxy-gateway-temp.plist"),
  );
  // 复现 review 场景：--config $HOME/config.json 时 home 几何派生曾恰好命中默认服务。
  const homeInstance = resolvePaths(env, "/home/tester");
  assert.notEqual(homeInstance.launchAgent, production.launchAgent);
  // codexHome 仍按环境解析：实例隔离只针对网关自管的管理面文件。
  assert.equal(instance.codexHome, "/home/tester/.codex");
  assert.equal(instance.modelsCacheFile, "/home/tester/.codex/models_cache.json");
});

test("CODEX_CLIPROXY_HOME 重定向运行主目录：plist 留在 ~/Library/LaunchAgents 并加实例后缀", () => {
  const env = { HOME: "/home/tester", CODEX_CLIPROXY_HOME: "/data/ccp-home" };
  const redirected = resolvePaths(env);
  assert.equal(redirected.runtimeHome, "/data/ccp-home");
  assert.equal(redirected.gatewayConfig, "/data/ccp-home/config.json");
  assert.equal(redirected.logDir, "/data/ccp-home/logs");
  assert.equal(redirected.credentialsFile, "/data/ccp-home/credentials.json");
  assert.equal(redirected.codexHome, "/home/tester/.codex");
  // plist 必须留在用户的 ~/Library/LaunchAgents（launchd 登录只扫描该目录），
  // 非默认实例用文件名后缀区分，label/Keychain 服务名共用同一后缀。
  assert.ok(/^codex-cliproxy-gateway-[0-9a-f]{8}\.plist$/.test(path.basename(redirected.launchAgent)));
  assert.ok(/^codex-cliproxy-webui-[0-9a-f]{8}\.plist$/.test(path.basename(redirected.webUiLaunchAgent)));
  assert.equal(path.dirname(redirected.launchAgent), "/home/tester/Library/LaunchAgents");
  assert.ok(redirected.instanceSuffix.startsWith("-"), redirected.instanceSuffix);
  assert.equal(instanceMarker("/data/ccp-home"), redirected.instanceSuffix.slice(1));

  // 默认实例零迁移：标准 plist 文件名、空后缀、历史 label。
  const production = resolvePaths({ HOME: "/home/tester" });
  assert.equal(production.instanceSuffix, "");
  assert.equal(production.launchAgent, "/home/tester/Library/LaunchAgents/codex-cliproxy-gateway.plist");

  // 显式指到默认目录仍是默认实例身份。
  assert.equal(resolvePaths({ HOME: "/home/tester", CODEX_CLIPROXY_HOME: "/home/tester/.codex-cliproxy-gateway" }).instanceSuffix, "");

  // 空白值视为未设置，回落默认主目录。
  assert.equal(resolvePaths({ HOME: "/home/tester", CODEX_CLIPROXY_HOME: "   " }).runtimeHome,
    "/home/tester/.codex-cliproxy-gateway");

  // serve --config 的显式实例目录比环境变量更具体，优先生效。
  const root = path.resolve("/tmp/ccp-instance");
  assert.equal(resolvePaths(env, root).runtimeHome, root);
});

test("CODEX_CLIPROXY_HOME 规范化：展开 ~、拒绝相对路径", () => {
  assert.equal(resolvePaths({ HOME: "/home/tester", CODEX_CLIPROXY_HOME: "~/data/ccp" }).runtimeHome,
    "/home/tester/data/ccp");
  assert.equal(resolvePaths({ HOME: "/home/tester", CODEX_CLIPROXY_HOME: "~" }).runtimeHome,
    "/home/tester");
  // 相对路径直接报错：launchd 服务进程 cwd 是 /，静默 resolve 只会落到错误位置。
  assert.throws(() => resolvePaths({ HOME: "/home/tester", CODEX_CLIPROXY_HOME: "relative/data" }),
    /CODEX_CLIPROXY_HOME must be an absolute path/);
  assert.throws(() => normalizeRuntimeHomeInput(" relative/data ", "/home/tester"), /absolute path/);
  assert.equal(normalizeRuntimeHomeInput("   ", "/home/tester"), "");
});

test("调用级实例快照隔离运行目录，显式解析不受上下文影响", () => {
  const instance = resolvePaths({ HOME: "/home/tester" }, path.resolve("/tmp/ccp-bound"));
  const previous = resolvePaths();
  runWithInstancePaths(instance, () => {
    const bound = resolvePaths();
    assert.equal(bound.runtimeHome, "/tmp/ccp-bound");
    assert.equal(bound.gatewayConfig, "/tmp/ccp-bound/config.json");
    // 显式参数独立解析，环境与 override 不受当前实例影响。
    assert.equal(resolvePaths({ HOME: "/home/tester", CODEX_CLIPROXY_HOME: "/data/env-home" }).runtimeHome,
      "/data/env-home");
    assert.equal(resolvePaths({ HOME: "/home/tester" }, path.resolve("/tmp/ccp-override")).runtimeHome,
      "/tmp/ccp-override");
    // 运行时目录解析全部跟随上下文：serve --config 实例的日志/调试转储与缓存同根，
    // 不再按 Web UI 进程自身的 env 分裂。
    assert.equal(requestLogDir({ catalogPath: "/x/catalog.json" } as Parameters<typeof requestLogDir>[0]),
      path.resolve("/tmp/ccp-bound/logs"));
    bound.runtimeHome = "/tmp/changed-snapshot";
    assert.equal(resolvePaths().runtimeHome, instance.runtimeHome);
  });
  assert.deepEqual(resolvePaths(), previous);
});

test("软链接祖先下多级缺失目录创建前后实例标记保持稳定", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-path-marker-"));
  try {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, "dir");
    const instanceHome = path.join(link, "missing", "nested", "instance");
    const env = { HOME: root, CODEX_CLIPROXY_HOME: instanceHome };
    const before = resolvePaths(env);
    assert.equal(instanceMarker(instanceHome), instanceMarker(path.join(target, "missing", "nested", "instance")));
    fs.mkdirSync(instanceHome, { recursive: true });
    const after = resolvePaths(env);
    assert.equal(before.instanceSuffix, after.instanceSuffix);
    assert.equal(before.launchAgent, after.launchAgent);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("有效显式实例目录无需验证被覆盖的无效环境路径", () => {
  const paths = resolvePaths({ HOME: "/home/tester", CODEX_CLIPROXY_HOME: "invalid/relative" }, "/tmp/ccp-explicit");
  assert.equal(paths.runtimeHome, "/tmp/ccp-explicit");
});

test("异步实例上下文并行、嵌套与失败后不会残留目录绑定", async () => {
  const previous = resolvePaths();
  const instanceA = resolvePaths({ HOME: "/home/tester" }, "/tmp/ccp-context-a");
  const instanceB = resolvePaths({ HOME: "/home/tester" }, "/tmp/ccp-context-b");
  let releaseA!: () => void;
  const waitForB = new Promise<void>((resolve) => { releaseA = resolve; });
  await Promise.all([
    runWithInstancePaths(instanceA, async () => {
      await waitForB;
      assert.equal(resolvePaths().runtimeHome, instanceA.runtimeHome);
      await runWithInstancePaths(instanceB, async () => {
        await Promise.resolve();
        assert.equal(resolvePaths().runtimeHome, instanceB.runtimeHome);
      });
      assert.equal(resolvePaths().runtimeHome, instanceA.runtimeHome);
    }),
    runWithInstancePaths(instanceB, async () => {
      await Promise.resolve();
      assert.equal(resolvePaths().runtimeHome, instanceB.runtimeHome);
      releaseA();
    }),
  ]);
  await assert.rejects(runWithInstancePaths(instanceB, async () => {
    await Promise.resolve();
    throw new Error("实例启动失败");
  }), /实例启动失败/);
  assert.deepEqual(resolvePaths(), previous);
});
