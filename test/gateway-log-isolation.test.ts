import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginRegistry } from "@agent-proxy/plugin-api";
import { createPluginGatewayHandler } from "../apps/gateway/src/gateway.ts";
import { resolvePaths, runWithInstancePaths } from "../apps/gateway/src/paths.ts";
import type { GatewayConfig, ResolvedPaths } from "../apps/gateway/src/types.ts";

const older = "cliproxy-v1-responses-http-20000101000000.log";
const newer = "cliproxy-v1-responses-http-20000101000001.log";

function seedLogs(paths: ResolvedPaths): void {
  fs.mkdirSync(paths.logDir, { recursive: true });
  for (const [index, name] of [older, newer].entries()) {
    const file = path.join(paths.logDir, name);
    fs.writeFileSync(file, `哨兵 ${name}\n`);
    fs.utimesSync(file, index + 1, index + 1);
  }
}

function snapshot(dir: string) {
  return fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return { name, data: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs };
  });
}

test("两个网关实例只剪裁和写入自己的请求日志", { timeout: 10_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-log-isolation-"));
  const env = { HOME: path.join(directory, "user"), CODEX_HOME: path.join(directory, "codex") };
  const defaults = resolvePaths(env);
  const ambient = resolvePaths({ ...env, CODEX_CLIPROXY_HOME: path.join(directory, "ambient") });
  const instances = ["a", "b"].map((name) => resolvePaths(env, path.join(directory, name)));
  const handlers: Array<ReturnType<typeof createPluginGatewayHandler>> = [];
  try {
    for (const paths of [defaults, ambient, ...instances]) seedLogs(paths);
    const defaultBefore = snapshot(defaults.logDir);
    const ambientBefore = snapshot(ambient.logDir);
    for (const paths of instances) {
      const config: GatewayConfig = {
        host: "127.0.0.1", port: 0, upstreamBaseUrl: "https://upstream.invalid/v1",
        catalogPath: paths.catalogFile, requestLogging: true, maxRequestLogs: 1,
        logDir: defaults.logDir,
      };
      const handler = runWithInstancePaths(ambient, () => createPluginGatewayHandler(
        config, new PluginRegistry([]), "", "invalid", undefined, undefined, undefined, undefined, paths,
      ));
      handlers.push(handler);
      assert.deepEqual(fs.readdirSync(paths.logDir), [newer], "启动只剪裁显式实例的旧日志");
    }
    assert.deepEqual(snapshot(ambient.logDir), ambientBefore);

    // 让两个请求交错执行并各自触发实际异步写盘。用坏 JSON 走本地 400，测试无需上游。
    await Promise.all(handlers.map(async (handler, index) => {
      const marker = `实例-${index}`;
      const result = await runWithInstancePaths(ambient, () => handler(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, body: `{${marker}`,
      })));
      assert.equal(result.status, 400);
      await result.text();
    }));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (instances.every(({ logDir }) => fs.readdirSync(logDir).some((name) => name !== newer))) break;
      await Bun.sleep(10);
    }
    for (const [index, paths] of instances.entries()) {
      const records = snapshot(paths.logDir);
      assert.equal(records.length, 1);
      assert.match(records[0]!.data, new RegExp(`实例-${index}`));
      assert.doesNotMatch(records[0]!.data, new RegExp(`实例-${1 - index}`));
    }
    assert.deepEqual(snapshot(defaults.logDir), defaultBefore, "旧 logDir 配置不得覆写实例路径");
    assert.deepEqual(snapshot(ambient.logDir), ambientBefore);
  } finally {
    for (const handler of handlers) handler.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
