import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "..");
interface Manifest { name: string; private?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; }
const manifests = new Map<string, { directory: string; manifest: Manifest }>();
for (const group of ["apps", "packages"]) {
  for (const entry of fs.readdirSync(path.join(root, group))) {
    const directory = path.join(root, group, entry);
    const file = path.join(directory, "package.json");
    if (!fs.existsSync(file)) continue;
    const manifest: Manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    assert(!manifests.has(manifest.name), `重复 workspace 包名：${manifest.name}`);
    manifests.set(manifest.name, { directory, manifest });
  }
}
assert.equal(manifests.size, 9, "必须包含八个公开产品包与一个私有模型包");
assert.equal([...manifests.values()].filter(({ manifest }) => !manifest.private).length, 8, "只发布八个产品包");
assert.equal(manifests.get("@agent-proxy/models")?.manifest.private, true, "共享模型包必须保持私有");
assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).private, true);

function imports(file: string, runtimeOnly = false): string[] {
  const source = fs.readFileSync(file, "utf8");
  // 核心链路只检查实际运行时依赖；类型增强不会把插件载入模型流量进程。
  const code = runtimeOnly ? ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
  }).outputText : source;
  return ts.preProcessFile(code, true, true).importedFiles.map((entry) => entry.fileName);
}

for (const [name, { directory, manifest }] of manifests) {
  for (const file of new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: directory, absolute: true })) {
    for (const specifier of imports(file)) {
      if (specifier === "llm-bridge" || specifier.startsWith("llm-bridge/")) {
        assert.equal(name, "@agent-proxy/llm-bridge", `外部转换库越界：${file}`);
      }
      if (specifier.startsWith("@agent-proxy/")) {
        const dependency = specifier.split("/").slice(0, 2).join("/");
        assert(manifests.has(dependency), `不存在 workspace 包：${name} → ${dependency}`);
        assert(manifest.dependencies?.[dependency] || manifest.devDependencies?.[dependency], `未声明跨包依赖：${name} → ${dependency}`);
        assert(dependency !== "@agent-proxy/gateway", `库反向依赖应用：${file}`);
        if (dependency === "@agent-proxy/models") {
          assert(!manifest.dependencies?.[dependency], `私有模型包不得成为运行时依赖：${name}`);
        }
      }
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        assert(target.startsWith(`${directory}${path.sep}`), `跨包源码或资源相对引用：${file} → ${specifier}`);
      }
    }
  }
}

function visitPackage(name: string, visiting = new Set<string>(), visited = new Set<string>()): void {
  assert(!visiting.has(name), `workspace 依赖循环：${[...visiting, name].join(" → ")}`);
  if (visited.has(name)) return;
  visiting.add(name);
  const manifest = manifests.get(name)!.manifest;
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (manifests.has(dependency)) visitPackage(dependency, visiting, visited);
  }
  visiting.delete(name);
  visited.add(name);
}
for (const name of manifests.keys()) visitPackage(name);

/** 检查传递依赖，防止通过配置读取或 UI 工具函数重新带入 agent。 */
function inspectCore(file: string, seen = new Set<string>()): void {
  if (seen.has(file)) return;
  seen.add(file);
  for (const specifier of imports(file, true)) {
    assert(!specifier.startsWith("@agent-proxy/") || specifier === "@agent-proxy/plugin-api" || specifier === "@agent-proxy/models",
      `网关核心依赖业务插件或转换包：${file} → ${specifier}`);
    assert(specifier !== "llm-bridge", `default 链路依赖转换库：${file}`);
    if (specifier.startsWith(".") && /\.[cm]?tsx?$/.test(specifier)) {
      inspectCore(path.resolve(path.dirname(file), specifier), seen);
    }
  }
}
for (const entry of ["gateway.ts", "model-state.ts", "realtime.ts"]) {
  inspectCore(path.join(root, "apps/gateway/src", entry));
}
console.log("九个 workspace、八个公开产品包、源码边界及 default 核心传递依赖检查通过。");
