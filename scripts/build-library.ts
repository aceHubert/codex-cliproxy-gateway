import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const directory = process.cwd();
const root = path.resolve(import.meta.dir, "..");
const source = path.join(directory, "src");
const destination = path.join(directory, "dist");
const entrypoints = [...new Bun.Glob("**/*.ts").scanSync({ cwd: source })];
const modelPackage = "@agent-proxy/models";
let modelsCompiled = false;
if (!entrypoints.length) throw new Error(`库包没有入口：${directory}`);
// 清理旧输出，避免已迁走的模型资源继续残留在发布包中。
await rm(destination, { recursive: true, force: true });

// 保留每个模块的唯一实例，避免多入口打包重复主机上下文或错误类。
// TypeScript 的扩展名改写将源码 .ts 导入变为发布产物 .js 导入。
for (const entry of entrypoints) {
  const sourceFile = path.join(source, entry);
  let code = await Bun.file(sourceFile).text();
  if (ts.preProcessFile(code, true, true).importedFiles.some(entry => entry.fileName === modelPackage)) {
    const localModels = path.join(destination, "resources/models.js");
    if (!modelsCompiled) {
      // 只内联私有静态模型包，公共模块仍保留唯一的主机上下文实例。
      const result = await Bun.build({
        entrypoints: [path.join(root, "packages/models/src/index.ts")],
        target: "bun", format: "esm", outdir: path.dirname(localModels), naming: "models.js",
      });
      if (!result.success) throw new AggregateError(result.logs, "私有模型资源构建失败。");
      modelsCompiled = true;
    }
    const emittedFile = path.join(destination, entry.replace(/\.ts$/, ".js"));
    let publishedSpecifier = path.relative(path.dirname(emittedFile), localModels).split(path.sep).join("/");
    if (!publishedSpecifier.startsWith(".")) publishedSpecifier = `./${publishedSpecifier}`;
    code = code.replace(/(["'])@agent-proxy\/models\1/g, (_, quote: string) => `${quote}${publishedSpecifier}${quote}`);
  }
  const resources = [...code.matchAll(/(?:from\s+|import\s*)(["'])([^"']+\.json)\1/g)];
  for (const match of resources) {
    const specifier = match[2]!;
    const resource = path.resolve(path.dirname(sourceFile), specifier);
    const relative = path.relative(source, resource);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) continue;
    const localResource = path.join(destination, "resources/json", path.basename(resource).replace(/\.json$/, ".js"));
    await mkdir(path.dirname(localResource), { recursive: true });
    // 共享 JSON 编译为模块，发布包独立使用，不再生成同名 JSON 副本。
    await Bun.write(localResource, `export default ${JSON.stringify(await Bun.file(resource).json())};\n`);
    const emittedFile = path.join(destination, entry.replace(/\.ts$/, ".js"));
    let publishedSpecifier = path.relative(path.dirname(emittedFile), localResource).split(path.sep).join("/");
    if (!publishedSpecifier.startsWith(".")) publishedSpecifier = `./${publishedSpecifier}`;
    code = code.replaceAll(`${match[1]}${specifier}${match[1]}`, `${match[1]}${publishedSpecifier}${match[1]}`);
  }
  const output = ts.transpileModule(code, {
    fileName: sourceFile,
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
  });
  const target = path.join(destination, entry.replace(/\.ts$/, ".js"));
  await mkdir(path.dirname(target), { recursive: true });
  await Bun.write(target, output.outputText);
}
const declarations = Bun.spawn([process.execPath, path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: directory, stdout: "inherit", stderr: "inherit" });
if (await declarations.exited !== 0) throw new Error(`类型声明生成失败：${directory}`);
// 测试与业务允许读取公开的静态指纹数据，运行时无需仓库源码。
for (const resource of new Bun.Glob("**/*.json").scanSync({ cwd: source })) {
  const target = path.join(destination, resource);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(source, resource), target);
}
