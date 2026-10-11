import path from "node:path";

const SHARED_PRODUCT_FILES = new Set([
  "package.json", "bun.lock", "lerna.json", "nx.json", "tsconfig.json", "tsconfig.base.json", "vite.config.ts", "LICENSE",
  "scripts/build-gateway.ts", "scripts/build-library.ts", "scripts/build-ui.ts",
  "scripts/changelog.ts", "scripts/verify-package.ts", "scripts/pack-check.ts", "scripts/release-version.ts",
  ".github/workflows/deploy.yml", ".github/workflows/release-check.yml",
]);

/** 根工具包不在产品图内，影响产品的共享输入必须显式参与版本判定。 */
export function isSharedProductPath(file: string): boolean {
  return SHARED_PRODUCT_FILES.has(file) || file.startsWith("packages/models/");
}

export function releaseVersionArgs(argv: readonly string[], changedFiles: readonly string[]): string[] {
  const args = ["version", ...argv];
  const alreadyForced = argv.some(argument => argument === "--force-publish" || argument.startsWith("--force-publish="));
  if (!alreadyForced && changedFiles.some(isSharedProductPath)) args.push("--force-publish");
  return args;
}

/** 只读已提交差异；脏工作树和分支限制继续交由 Lerna 原生校验。 */
export function changedSinceFixedTag(cwd = process.cwd()): string[] {
  const repository = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd, stdout: "pipe", stderr: "pipe" });
  if (repository.exitCode !== 0) throw new Error("发布版本编排必须在 Git 仓库中运行。");
  const tag = Bun.spawnSync(["git", "describe", "--tags", "--match", "v[0-9]*", "--abbrev=0"], { cwd, stdout: "pipe", stderr: "pipe" });
  // 无历史 fixed 标签时，Lerna 会把首轮产品包统一视为变更。
  if (tag.exitCode !== 0) return [];
  const revision = new TextDecoder().decode(tag.stdout).trim();
  const diff = Bun.spawnSync(["git", "diff", "--name-only", "-z", `${revision}...HEAD`], { cwd, stdout: "pipe", stderr: "pipe" });
  if (diff.exitCode !== 0) throw new Error("无法读取上次 fixed 发布以来的变更，请检查 Git 标签与提交历史。");
  return new TextDecoder().decode(diff.stdout).split("\0").filter(Boolean);
}

if (import.meta.main) {
  const changed = changedSinceFixedTag();
  const args = releaseVersionArgs(process.argv.slice(2), changed);
  if (changed.some(isSharedProductPath)) console.log("检测到共享产品构建、资源或发布输入变更，纳入八包版本编排。");
  const binary = path.resolve(import.meta.dir, "../node_modules/.bin/lerna");
  const child = Bun.spawn([binary, ...args], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
}
