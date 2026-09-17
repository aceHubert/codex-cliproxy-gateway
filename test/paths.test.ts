import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolvePaths } from "../src/paths.ts";

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
    path.join(root, "Library", "LaunchAgents", "codex-cliproxy-gateway-temp.plist"),
  );
  // 复现 review 场景：--config $HOME/config.json 时 home 几何派生曾恰好命中默认服务。
  const homeInstance = resolvePaths(env, "/home/tester");
  assert.notEqual(homeInstance.launchAgent, production.launchAgent);
  // codexHome 仍按环境解析：实例隔离只针对网关自管的管理面文件。
  assert.equal(instance.codexHome, "/home/tester/.codex");
  assert.equal(instance.modelsCacheFile, "/home/tester/.codex/models_cache.json");
});
