import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedPluginArtifactFiles } from "../apps/gateway/src/gateway-composition.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";
import test from "./host-test.ts";
import type { ResolvedPaths } from "../apps/gateway/src/types.ts";

function seedRuntimeCanary(paths: ResolvedPaths): void {
  const files = [
    ...installedPluginArtifactFiles(paths),
    paths.catalogFile,
    paths.gatewayConfig,
    paths.stdoutLog,
    path.join(paths.logDir, "cliproxy-v1-responses-http-20260101000000.log"),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "测试哨兵，任何测试都不应访问这个实例\n");
  }
}

function snapshotFiles(directory: string) {
  const entries = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).sort();
  return entries.map((entry) => {
    const file = path.join(directory, entry);
    const stat = fs.statSync(file);
    return { entry, mtimeMs: stat.mtimeMs, content: stat.isFile() ? fs.readFileSync(file, "utf8") : null };
  });
}

test("五家网关测试不会修改继承的运行目录或默认实例", { timeout: 60_000 }, () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-fixture-canary-")));
  const simulatedUser = path.join(directory, "user");
  const simulatedOverride = path.join(directory, "inherited-runtime");
  const simulatedCodex = path.join(simulatedUser, ".codex");
  const fixtures = ["zcode", "codebuddy", "qoder", "agy", "opencode-zen"]
    .map((agent) => `test/${agent}-gateway.test.ts`);
  try {
    seedRuntimeCanary(resolvePaths({ HOME: simulatedUser }));
    seedRuntimeCanary(resolvePaths({ HOME: simulatedUser }, simulatedOverride));
    fs.mkdirSync(simulatedCodex);
    fs.writeFileSync(path.join(simulatedCodex, "models_cache.json"), "测试哨兵\n");
    const protectedDirectories = [path.join(simulatedUser, ".agent-proxy-gateway"), simulatedOverride, simulatedCodex];
    const before = protectedDirectories.map(snapshotFiles);
    const child = Bun.spawnSync([process.execPath, "test", ...fixtures, "test/zcode-signing.test.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: simulatedUser,
        CODEX_HOME: undefined,
        CODEX_CLIPROXY_HOME: simulatedOverride,
      },
      timeout: 45_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(child.exitCode, 0, child.stderr.toString());
    assert.deepEqual(protectedDirectories.map(snapshotFiles), before, "默认目录、覆盖目录和 Codex 缓存必须保持原样");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
