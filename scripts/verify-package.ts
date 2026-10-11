import { access, constants, stat } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? process.cwd());
const manifest = await Bun.file(path.join(directory, "package.json")).json() as {
  name: string; private?: boolean; exports?: unknown; bin?: Record<string, string>;
  files?: string[]; publishConfig?: { access?: string };
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
};
if (manifest.private) throw new Error(`${manifest.name} 不属于发布产品包。`);
if (manifest.publishConfig?.access !== "public") throw new Error(`${manifest.name} 缺少 public 发布权限声明。`);
if (!(await Bun.file(path.join(directory, "README.md")).text()).trim()) throw new Error(`${manifest.name} 缺少非空的包介绍 README.md。`);
for (const dependencies of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
  if (dependencies?.["@agent-proxy/models"]) throw new Error(`${manifest.name} 发布包含私有模型运行时依赖。`);
}
for (const file of new Bun.Glob("dist/**/*.{js,mjs,cjs,ts}").scanSync({ cwd: directory, absolute: true })) {
  if (/(["'])@agent-proxy\/models(?:\/[^"']*)?\1/.test(await Bun.file(file).text())) {
    throw new Error(`${manifest.name} 发布代码或声明仍引用私有模型包：${path.relative(directory, file)}`);
  }
}
async function verifyExports(value: unknown): Promise<void> {
  if (typeof value === "string" && !value.includes("*")) await access(path.resolve(directory, value));
  else if (value && typeof value === "object") for (const entry of Object.values(value)) await verifyExports(entry);
}
await verifyExports(manifest.exports);
for (const target of Object.values(manifest.bin ?? {})) {
  const file = path.resolve(directory, target);
  await access(file, constants.X_OK);
  if (!(await Bun.file(file).text()).startsWith("#!")) throw new Error(`${manifest.name} CLI 缺少 shebang。`);
}
for (const resource of manifest.files ?? []) if (!resource.includes("*")) await stat(path.resolve(directory, resource));
console.log(`${manifest.name} 发布入口与资源检查通过。`);
