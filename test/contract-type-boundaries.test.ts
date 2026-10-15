import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 契约类型单一来源边界：plugin-api（契约包）与 llm-bridge（桥接共享资产）导出的
 * 类型名不得在其他包或网关源码中再次声明（export interface/type/class）；重复形状
 * 一律改为从单一来源 re-export 或 import/extends 引用。与 scripts/check-boundaries
 * 互补：那边只看 import 与依赖清单，看不到同形副本（2026-10-14 审查曾发现 10 处）。
 */

const SOURCE_PACKAGES = ["plugin-api", "llm-bridge"] as const;

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) yield full;
  }
}

function declaredTypeNames(files: string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/export (?:interface|type|class) ([A-Za-z0-9_]+)/g)) {
      names.set(match[1]!, file);
    }
  }
  return names;
}

test("契约类型名只在 plugin-api 与 llm-bridge 声明，其余源码不得再定义同形副本", () => {
  const sourceNames = new Map<string, string>();
  for (const pkg of SOURCE_PACKAGES) {
    for (const [name, file] of declaredTypeNames([...walk(`packages/${pkg}/src`)])) {
      sourceNames.set(name, file);
    }
  }
  assert.ok(sourceNames.size > 0, "契约类型名扫描为空，检查自身失效");

  const consumerRoots = readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !(SOURCE_PACKAGES as readonly string[]).includes(entry.name))
    .map((entry) => `packages/${entry.name}/src`)
    .filter((root) => statSync(root, { throwIfNoEntry: false })?.isDirectory());
  consumerRoots.push("apps/gateway/src");

  const offenders: string[] = [];
  for (const root of consumerRoots) {
    for (const [name, file] of declaredTypeNames([...walk(root)])) {
      const source = sourceNames.get(name);
      if (source) {
        offenders.push(`${file} 重复声明契约类型 ${name}（单一来源 ${source}）；应改为从其所属包 re-export 或 import/extends 引用`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
