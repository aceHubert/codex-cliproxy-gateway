import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 边界静态检查：AGY 的请求/响应转换在自身包内独立封装，不得依赖或调用
 * @agent-proxy/llm-bridge；四类标准桥接 agent 的请求一律走公共 convertRequest；
 * 已停更的 npm llm-bridge 不再进入任何依赖；只有 llm-bridge 包允许依赖
 * @ai-sdk/*（协议引擎）。
 */

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) yield full;
  }
}

test("AGY 包不依赖、不调用 llm-bridge", () => {
  for (const file of walk("packages/agy/src")) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("llm-bridge"), `${file} 引用了 llm-bridge`);
    assert.ok(!text.includes("convertRequest"), `${file} 引用了桥接 convertRequest`);
  }
});

test("四类标准桥接 agent 的请求层调用公共 convertRequest", () => {
  for (const [pkg, file] of [
    ["zcode", "packages/zcode/src/request.ts"],
    ["codebuddy", "packages/codebuddy/src/request.ts"],
    ["qoder", "packages/qoder/src/request.ts"],
    ["opencode-zen", "packages/opencode-zen/src/convert.ts"],
  ] as const) {
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("convertRequest"), `${pkg} 请求层未调用公共 convertRequest`);
  }
});

test("任何包都不再依赖已停更的 npm llm-bridge；只有 llm-bridge 依赖 @ai-sdk/*", () => {
  for (const pkg of readdirSync("packages").filter((entry) => statSync(join("packages", entry)).isDirectory())) {
    const manifest = JSON.parse(readFileSync(`packages/${pkg}/package.json`, "utf8")) as { dependencies?: Record<string, string> };
    const deps = Object.keys(manifest.dependencies ?? {});
    assert.ok(!deps.includes("llm-bridge"), `${pkg} 不得依赖已停更的 npm llm-bridge`);
    const engineDeps = deps.filter((name) => name === "ai" || name.startsWith("@ai-sdk/"));
    if (pkg === "llm-bridge") {
      assert.ok(engineDeps.length > 0, "llm-bridge 封装包必须以 @ai-sdk/* 为协议引擎");
    } else {
      assert.deepEqual(engineDeps, [], `${pkg} 不得直接依赖 @ai-sdk/*（一律经桥接包）`);
    }
  }
  const gateway = JSON.parse(readFileSync("apps/gateway/package.json", "utf8")) as { dependencies?: Record<string, string> };
  assert.ok(!Object.keys(gateway.dependencies ?? {}).includes("llm-bridge"), "gateway 不得依赖 npm llm-bridge");
});

test("桥接包只依赖 plugin-api 契约包，不依赖 gateway 或 agent 包", () => {
  const manifest = JSON.parse(readFileSync("packages/llm-bridge/package.json", "utf8")) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name === "@agent-proxy/plugin-api") continue; // 协议类型单一来源，仅类型引用。
    assert.ok(!name.startsWith("@agent-proxy/"), `llm-bridge 不得依赖 workspace 包 ${name}`);
  }
});

test("桥接包源码不包含工具执行、排队、重试或 fetch 注入点", () => {
  for (const file of walk("packages/llm-bridge/src")) {
    const text = readFileSync(file, "utf8");
    for (const banned of ["nextUpstream", "executeTool", "queueInfer", "fetchUpstream", "retryAfterSeconds("]) {
      assert.ok(!text.includes(banned), `${file} 出现执行/调度语义 ${banned}`);
    }
  }
});
