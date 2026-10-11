import { chmod } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const app = path.join(root, "apps/gateway");
const manifest = await Bun.file(path.join(app, "package.json")).json() as { dependencies?: Record<string, string> };

const ui = Bun.spawn([process.execPath, path.join(root, "scripts/build-ui.ts")], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await ui.exited !== 0) throw new Error("Web UI 构建失败。");
const result = await Bun.build({
  entrypoints: [path.join(app, "src/index.ts")],
  target: "bun",
  format: "esm",
  outdir: path.join(app, "dist"),
  naming: "index.js",
  // 私有模型包随应用内联，公开插件及其主机上下文继续由运行时解析。
  packages: "bundle",
  external: Object.keys(manifest.dependencies ?? {}),
});
if (!result.success) throw new AggregateError(result.logs, "业务包构建失败。");
await chmod(path.join(app, "dist/index.js"), 0o755);
