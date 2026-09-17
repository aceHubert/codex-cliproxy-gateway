import path from "node:path";
import { build } from "vite";

/**
 * 构建 Web UI：用 Vite 把 src/ui/ 的 React 应用打成单个自包含 HTML，
 * 发布产物写入 dist/ui/index.html，正式 Web UI 在运行时直接读取该文件。
 *
 * 运行：bun run build:ui（bun run build 会先跑这一步）。
 */

const DIST_DIR = path.resolve(import.meta.dir, "../dist/ui");

await build({
  configFile: path.resolve(import.meta.dir, "../vite.config.ts"),
});

const htmlSize = Bun.file(path.join(DIST_DIR, "index.html")).size;
console.log(`Web UI built: ${Math.round(htmlSize / 1024)} KB inline HTML -> dist/ui/`);
