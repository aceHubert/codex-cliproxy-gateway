import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";
import { runCli } from "../apps/gateway/src/cli.ts";
import { codexCatalogFile } from "../apps/gateway/src/model-state.ts";
import { resolvePaths, runWithInstancePaths } from "../apps/gateway/src/paths.ts";

for (const upstreamOnly of [false, true]) {
  test(`models --sync 在插件目录失败时仍保存${upstreamOnly ? "静态" : "动态"}模型选择`, { timeout: 60_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "models-sync-plugin-failure-"));
    const paths = resolvePaths({ HOME: home, CODEX_HOME: path.join(home, "codex") }, path.join(home, "runtime"));
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.mkdirSync(paths.codexHome, { recursive: true });
    fs.mkdirSync(path.join(home, ".zcode"), { recursive: true });
    // 损坏的插件配置稳定触发目录失败，无需读取本机登录或访问插件上游。
    fs.writeFileSync(path.join(home, ".zcode", "setting.json"), "invalid-json");
    fs.writeFileSync(path.join(home, ".zcode", "config.json"), "{}");
    const config = {
      zcode: true, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
      host: "127.0.0.1", port: 8320, upstreamOnly,
      upstreamBaseUrl: "http://127.0.0.1:8317/v1", selectedModels: ["old-model"],
    };
    fs.writeFileSync(paths.gatewayConfig, JSON.stringify(config));
    fs.writeFileSync(paths.stateFile, JSON.stringify({ config, codexConfigManaged: false }));
    fs.writeFileSync(paths.catalogFile, JSON.stringify({ models: [{ slug: "old-model" }] }));
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) throw Object.assign(new Error("测试网关未启动"), { code: "ECONNREFUSED" });
      assert.equal(new URL(String(input)).pathname, "/v1/models");
      return Response.json({ models: [{ slug: "old-model" }, { slug: "new-model" }] });
    }) as typeof fetch;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      await runWithInstancePaths(paths, () => runCli(["models", "--sync", "--select", "new-model"]));
      assert.deepEqual(JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")).selectedModels, ["new-model"]);
      assert.deepEqual(JSON.parse(fs.readFileSync(paths.stateFile, "utf8")).config.selectedModels, ["new-model"]);
      assert.deepEqual(JSON.parse(fs.readFileSync(paths.catalogFile, "utf8")).models.map((model: { slug: string }) => model.slug), ["new-model"]);
      assert.ok(warnings.some((warning) => warning.includes("ZCode 模型目录不可用")));
      assert.match(fs.readFileSync(paths.stdoutLog, "utf8"), /selectedModels: \["old-model"\] -> \["new-model"\]/);
      if (upstreamOnly) {
        assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogFile(paths), "utf8")).models.map((model: { slug: string }) => model.slug), ["new-model"]);
      }
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
