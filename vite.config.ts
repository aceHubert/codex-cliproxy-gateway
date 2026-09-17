import path from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const UI_DIR = path.resolve(import.meta.dirname, "src/ui");
const UI_DIST_DIR = path.resolve(import.meta.dirname, "dist/ui");

function envPort(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

export default defineConfig(({ command }) => {
  const devPort = command === "serve" ? envPort("CODEX_CLIPROXY_UI_DEV_PORT", 8322) : 8322;
  const backendPort = command === "serve" ? envPort("CODEX_CLIPROXY_UI_BACKEND_PORT", 8321) : 8321;
  if (command === "serve" && devPort === backendPort) {
    throw new Error("Vite dev port and UI backend port must be different");
  }
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  return {
    root: UI_DIR,
    base: "./",
    plugins: command === "build" ? [viteSingleFile()] : [],
    build: {
      outDir: UI_DIST_DIR,
      emptyOutDir: true,
    },
    server: {
      host: "127.0.0.1",
      port: devPort,
      strictPort: true,
      open: "/",
      proxy: {
        "/ui/api": {
          target: backendOrigin,
          changeOrigin: true,
          headers: {
            origin: backendOrigin,
          },
        },
      },
    },
  };
});
