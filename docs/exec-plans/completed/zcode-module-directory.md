# ZCode 模块独立目录重构

## 目标

将 `src/` 根目录下的 `zcode-*` 模块与 `zcode.ts` 入口收拢到独立的 `src/zcode/` 目录，保持公开行为、类型边界、静态 JSON 资产内联和测试结果不变。

## 范围

- 包含：迁移 ZCode 源码和视觉执行模板，更新源码/测试/当前文档引用，执行类型检查、ZCode 定向测试与完整检查。
- 不包含：修改 ZCode 协议、模型目录、请求/响应转换行为，或改写已完成的执行计划与历史记录。

## 背景

- 相关文档：`AGENTS.md`、`docs/PLANS_GUIDE.md`。
- 相关代码路径：`src/zcode/*.ts`、`src/zcode/vision-template.json`、`test/zcode-*.test.ts`。
- 已知约束：工作区已有大量用户改动；只调整本任务相关路径和 import，不回退或覆盖其他变更。

## 风险

- 风险：相对 import 层级变化造成编译或运行时找不到模块；JSON 模板路径遗漏；跨模块类型循环在移动后暴露。
- 缓解方式：先建立完整依赖清单，再一次性迁移并更新 import；使用 `rg` 扫描残留旧路径，运行 `bun run check` 验证。

## 里程碑

1. 并行梳理源码、测试和文档/构建依赖。
2. 迁移模块并更新所有当前引用。
3. 执行定向测试和完整检查，完成历史记录并将计划归档。

## 验证方式

- 命令：`bun run typecheck`、`bun test test/zcode-*.test.ts`、`bun run check`、`git diff --check`。
- 手工检查：`rg` 确认当前源码、测试与规范文档均使用 `src/zcode/` 新路径。
- 观测检查：构建仍能把 `vision-template.json` 内联到单文件 CLI 产物。

## 进度记录

- [x] 建立执行计划并启动依赖梳理。
- [x] 完成 ZCode 模块迁移与引用更新。
- [x] 完成验证、历史记录与计划归档。

## 决策记录

- 2026-09-14：目录使用去前缀的文件名（例如 `zcode-request.ts` → `zcode/request.ts`），`zcode.ts` 转为 `zcode/index.ts`，使目录本身承担命名空间，避免重复前缀。
- 2026-09-14：测试保留在 `test/` 根目录并只更新导入；运行时 `zcode-catalog.json`、协议前缀与请求头均不属于源码封装范围，保持不变。
- 2026-09-14：定向 ZCode 测试 136 通过、1 因宿主 `fs.watch` EMFILE 跳过；在允许回环监听的环境重跑 `bun run check`，315 项测试全部通过，类型检查和构建成功。
