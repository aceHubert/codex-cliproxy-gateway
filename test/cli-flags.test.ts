import assert from "node:assert/strict";
import test from "./host-test.ts";
import { runCli } from "../apps/gateway/src/cli.ts";
import { GATEWAY_CONFIG_VERSION } from "../apps/gateway/src/config.ts";

async function captureRuns(argGroups: string[][]): Promise<string[]> {
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (value: unknown) => { printed.push(String(value)); };
  try {
    for (const args of argGroups) await runCli(args);
  } finally {
    console.log = originalLog;
  }
  return printed;
}

test("--version and -v print the gateway version for global invocations only", async () => {
  // 版本短路发生在路径快照与安装状态检查之前：未隔离 HOME 也能安全执行。
  const printed = await captureRuns([["--version"], ["-v"], ["-v", "--help"]]);
  assert.deepEqual(printed, [GATEWAY_CONFIG_VERSION, GATEWAY_CONFIG_VERSION, GATEWAY_CONFIG_VERSION]);
});

test("-v/--version attached to a command is rejected by the option whitelist", async () => {
  // 版本只服务根命令：子命令上的 -v/--version 按未知选项报错，与帮助旗标口径一致。
  await assert.rejects(() => runCli(["status", "-v"]), /Unknown option --version for command "status"/);
  await assert.rejects(() => runCli(["models", "--version"]), /Unknown option --version for command "models"/);
});

test("-v consumed as an option value does not trigger the version shortcut", async () => {
  // 取值阶段 -v 原样作为 --port 的值收下；若被误判为版本旗标，这里会打印版本并正常返回而非报错。
  await assert.rejects(() => runCli(["status", "--port", "-v"]), /Unknown option --port for command "status"/);
});

test("-h mirrors --help and prints usage for global invocations", async () => {
  const printed = await captureRuns([["-h"], ["--help"], ["help"]]);
  assert.equal(printed.length, 3);
  for (const text of printed) {
    assert.match(text, /^agent-proxy - Bun gateway for Codex Desktop and CLI\n\nUsage:/);
    assert.match(text, /agent-proxy -v \| --version/);
  }
});

test("-h/--help attached to a command is rejected by the option whitelist", async () => {
  // 帮助只服务全局调用：子命令上的 -h/--help 按未知选项报错，与拼写错误同等对待。
  await assert.rejects(() => runCli(["status", "-h"]), /Unknown option --help for command "status"/);
  await assert.rejects(() => runCli(["install", "--help"]), /Unknown option --help for command "install"/);
});

test("-v wins over -h when both are requested", async () => {
  // 版本检查先于帮助：组合旗标时输出唯一版本号而非整页 usage。
  const printed = await captureRuns([["-h", "-v"]]);
  assert.deepEqual(printed, [GATEWAY_CONFIG_VERSION]);
});

test("-h consumed as an option value does not trigger the usage shortcut", async () => {
  await assert.rejects(() => runCli(["status", "--port", "-h"]), /Unknown option --port for command "status"/);
});
