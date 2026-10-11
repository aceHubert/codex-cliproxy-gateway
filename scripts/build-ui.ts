import path from "node:path";
import { build } from "vite";

/**
 * 构建 Web UI：将 apps/gateway/src/ui/ 打成单个自包含 HTML，
 * 发布产物写入 apps/gateway/dist/ui/index.html。
 *
 * 运行：bun run build:ui（bun run build 会先跑这一步）。
 */

const DIST_DIR = path.resolve(import.meta.dir, "../apps/gateway/dist/ui");

await build({
  configFile: path.resolve(import.meta.dir, "../vite.config.ts"),
});

const htmlSize = Bun.file(path.join(DIST_DIR, "index.html")).size;
console.log(`Web UI built: ${Math.round(htmlSize / 1024)} KB inline HTML -> apps/gateway/dist/ui/`);
