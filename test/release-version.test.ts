import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "./host-test.ts";
import { changedSinceFixedTag, releaseVersionArgs } from "../scripts/release-version.ts";

test("共享产品构建与资源变更强制纳入八包，保留 Lerna 用户参数", () => {
  for (const file of ["scripts/build-library.ts", "LICENSE", ".github/workflows/deploy.yml", "packages/models/src/index.ts", "packages/models/vendor_models.json", "packages/models/codex_client_models.json", "packages/models/package.json"]) {
    assert.deepEqual(releaseVersionArgs(["--yes", "--no-push"], [file]), ["version", "--yes", "--no-push", "--force-publish"]);
  }
  assert.deepEqual(releaseVersionArgs(["--force-publish=@agent-proxy/gateway"], ["scripts/build-ui.ts"]), ["version", "--force-publish=@agent-proxy/gateway"]);
});

test("纯文档测试不强制版本，包内变更交由 Lerna 原生判定", () => {
  for (const file of ["docs/requirements/change.md", "README.md", "CHANGELOG.md", "test/new.test.ts", "scripts/run-tests.ts", "apps/gateway/src/cli.ts", "apps/gateway/models.json", "apps/gateway/schemas/gateway-config.schema.json", "packages/zcode/src/index.ts"]) {
    assert.deepEqual(releaseVersionArgs(["--yes"], [file]), ["version", "--yes"]);
  }
});

test("隔离 Git fixture 对 root scripts-only、docs-only 与包内差异分别判定", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-proxy-release-inputs-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  };
  const commit = () => { git("add", "."); git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fix: fixture"); };
  try {
    git("init", "--quiet");
    git("config", "user.name", "Agent Proxy Fixture");
    git("config", "user.email", "fixture@example.invalid");
    await writeFile(path.join(directory, "initial.txt"), "fixture\n");
    commit();
    assert.deepEqual(changedSinceFixedTag(directory), []);
    git("tag", "v0.10.0");
    await mkdir(path.join(directory, "scripts"));
    await writeFile(path.join(directory, "scripts/build-library.ts"), "// 共享构建变更\n");
    commit();
    assert.deepEqual(releaseVersionArgs([], changedSinceFixedTag(directory)), ["version", "--force-publish"]);
    git("tag", "v0.10.1");
    await mkdir(path.join(directory, "docs"));
    await writeFile(path.join(directory, "docs/change.md"), "纯文档\n");
    commit();
    assert.deepEqual(releaseVersionArgs([], changedSinceFixedTag(directory)), ["version"]);
    git("tag", "v0.10.2");
    await mkdir(path.join(directory, "packages/zcode/src"), { recursive: true });
    await writeFile(path.join(directory, "packages/zcode/src/index.ts"), "export {};\n");
    commit();
    assert.deepEqual(releaseVersionArgs([], changedSinceFixedTag(directory)), ["version"]);
    git("tag", "v0.10.3");
    await mkdir(path.join(directory, "packages/models"), { recursive: true });
    await writeFile(path.join(directory, "packages/models/vendor_models.json"), "{}\n");
    commit();
    assert.deepEqual(releaseVersionArgs([], changedSinceFixedTag(directory)), ["version", "--force-publish"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
