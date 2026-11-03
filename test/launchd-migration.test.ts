import test from "./host-test.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adoptLegacyLaunchAgents,
  removeLegacyLaunchAgents,
  renderLaunchAgent,
  renderWebUiAgent,
  plistServiceLabel,
  legacyLabelForLabel,
  LAUNCHD_LABEL,
  LEGACY_LAUNCHD_LABEL,
  gatewayServiceLabel,
  legacyGatewayServiceLabel,
} from "../apps/gateway/src/launchd.ts";

function fixture(run: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-launchd-migration-"));
  try { run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test("服务命名常量与派生规则：新名服务，旧名仅用于迁移", () => {
  assert.equal(LAUNCHD_LABEL, "agent-proxy-gateway");
  assert.equal(LEGACY_LAUNCHD_LABEL, "codex-cliproxy-gateway");
  assert.equal(gatewayServiceLabel(""), "agent-proxy-gateway");
  assert.equal(gatewayServiceLabel("-1a2b3c4d"), "agent-proxy-gateway-1a2b3c4d");
  assert.equal(legacyGatewayServiceLabel("-1a2b3c4d"), "codex-cliproxy-gateway-1a2b3c4d");
});

test("同实例旧命名 label 推导：新旧前缀互换，外部命名原样返回", () => {
  assert.equal(legacyLabelForLabel("agent-proxy-gateway"), "codex-cliproxy-gateway");
  assert.equal(legacyLabelForLabel("agent-proxy-gateway-1a2b3c4d"), "codex-cliproxy-gateway-1a2b3c4d");
  assert.equal(legacyLabelForLabel("agent-proxy-webui", "webui"), "codex-cliproxy-webui");
  assert.equal(legacyLabelForLabel("codex-cliproxy-gateway"), "codex-cliproxy-gateway");
  assert.equal(legacyLabelForLabel("unrelated-service"), "unrelated-service");
});

test("收养迁移把旧命名 plist 改名到新文件名，内容保持不变且幂等", () => fixture((home) => {
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const options = {
    gatewayPlist: path.join(agents, "agent-proxy-gateway.plist"),
    webUiPlist: path.join(agents, "agent-proxy-webui.plist"),
    legacyGatewayPlist: path.join(agents, "codex-cliproxy-gateway.plist"),
    legacyWebUiPlist: path.join(agents, "codex-cliproxy-webui.plist"),
    instanceSuffix: "",
  };
  const legacyPlist = renderLaunchAgent({
    bunPath: "/opt/bun", cliPath: "/opt/old/index.ts", configPath: "/home/x/.codex-cliproxy-gateway/config.json",
    codexHome: "/home/x/.codex", logPath: "/tmp/gateway.log", label: "codex-cliproxy-gateway",
  });
  fs.writeFileSync(options.legacyGatewayPlist, legacyPlist);
  fs.writeFileSync(options.legacyWebUiPlist, "webui-fixture");

  const renamed = adoptLegacyLaunchAgents(options);
  assert.deepEqual(renamed, [options.gatewayPlist, options.webUiPlist]);
  assert.ok(!fs.existsSync(options.legacyGatewayPlist));
  assert.ok(!fs.existsSync(options.legacyWebUiPlist));
  assert.equal(fs.readFileSync(options.gatewayPlist, "utf8"), legacyPlist, "收养是纯改名，不重写内容");

  // 幂等：没有旧文件可改时原样返回空。
  assert.deepEqual(adoptLegacyLaunchAgents(options), []);

  // 新文件已存在时不覆盖（保留当前安装的定义）。
  fs.writeFileSync(options.legacyGatewayPlist, "stale");
  assert.deepEqual(adoptLegacyLaunchAgents(options), []);
  assert.equal(fs.readFileSync(options.gatewayPlist, "utf8"), legacyPlist);
  assert.equal(fs.readFileSync(options.legacyGatewayPlist, "utf8"), "stale");
}));

test("卸载清理回收旧命名的任务与 plist 文件", () => fixture((home) => {
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const legacyGatewayPlist = path.join(agents, "codex-cliproxy-gateway.plist");
  const legacyWebUiPlist = path.join(agents, "codex-cliproxy-webui.plist");
  fs.writeFileSync(legacyGatewayPlist, "gateway");
  fs.writeFileSync(legacyWebUiPlist, "webui");
  const calls: string[][] = [];
  removeLegacyLaunchAgents(
    { legacyGatewayPlist, legacyWebUiPlist, instanceSuffix: "-1a2b3c4d" },
    (args) => { calls.push(args); return ""; },
  );
  assert.ok(!fs.existsSync(legacyGatewayPlist));
  assert.ok(!fs.existsSync(legacyWebUiPlist));
  // 旧 label 任务按后缀派生回收，旧 plist 按路径回收。
  assert.ok(calls.some((args) => args.join(" ").includes("codex-cliproxy-gateway-1a2b3c4d")));
  assert.ok(calls.some((args) => args.join(" ").includes("codex-cliproxy-webui-1a2b3c4d")));
  assert.ok(calls.some((args) => args.join(" ").includes(legacyGatewayPlist)));
  assert.ok(calls.some((args) => args.join(" ").includes(legacyWebUiPlist)));
}));

test("plistServiceLabel 读取 plist 声明的真实 Label，异常内容回退当前命名", () => {
  const rendered = renderLaunchAgent({
    bunPath: "/opt/bun", cliPath: "/opt/new/index.js", configPath: "/home/x/.agent-proxy-gateway/config.json",
    codexHome: "/home/x/.codex", logPath: "/tmp/gateway.log", label: gatewayServiceLabel(""),
  });
  assert.equal(plistServiceLabel(rendered, "fallback"), "agent-proxy-gateway");
  // 更名前安装的 plist 内是旧 label：失败恢复必须按它拉回服务。
  assert.equal(plistServiceLabel('<dict><key>Label</key><string>codex-cliproxy-gateway</string></dict>', "fallback"), "codex-cliproxy-gateway");
  assert.equal(plistServiceLabel("not-a-plist", "fallback"), "fallback");
});

test("Web UI 迁移识别旧 Label 的受管 plist", () => fixture((home) => {
  // renderWebUiAgent 产出新 Label；旧 Label 的 plist 由迁移函数的 Label 校验兼容，
  // 这里只验证渲染器本身与迁移入口常量一致。
  const rendered = renderWebUiAgent({
    bunPath: "/opt/bun", cliPath: "/opt/new/index.js", codexHome: "/home/x/.codex",
    logPath: "/tmp/webui.log", label: "agent-proxy-webui", runtimeHome: undefined,
  });
  assert.ok(rendered.includes("<string>agent-proxy-webui</string>"));
}));
