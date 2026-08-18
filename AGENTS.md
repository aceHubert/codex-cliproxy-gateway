# Repository Guidelines

## 项目结构与模块组织

本项目是面向 macOS 的 Bun/TypeScript CLI 网关。业务源码位于 `src/`：`cli.ts` 负责命令编排，`gateway.ts` 处理路由与转发，`catalog.ts` 和 `models.ts` 管理模型目录，`keychain.ts`、`launchd.ts`、`toml.ts` 封装系统集成。测试集中在 `test/gateway.test.ts`。`scripts/` 存放独立辅助脚本，`models.json` 提供模型元数据覆盖，`dist/index.js` 是构建产物，不应手工编辑。

## 构建、测试与开发命令

- `bun install`：按 `bun.lock` 安装开发依赖。
- `bun run dev <command>`：直接从 `src/index.ts` 运行 CLI，例如 `bun run dev status`。
- `bun test`：执行全部 `node:test` 测试。
- `bun run typecheck`：以严格模式运行 TypeScript 类型检查。
- `bun run build`：生成单文件 `dist/index.js`。
- `bun run check`：依次执行类型检查、测试和构建；提交前必须通过。

## 编码风格与命名约定

沿用现有 TypeScript 风格：两个空格缩进、双引号、分号、ES 模块及显式 `.ts` 导入后缀。函数和变量使用 `camelCase`，类型与接口使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。优先使用 Bun、Node 标准库及现有模块；避免引入仅服务单一调用点的抽象或依赖。公共边界应保持严格类型，错误信息应说明可执行的修复方式。

## 测试指南

使用 `node:test` 与 `node:assert/strict`，由 `bun test` 运行。新增行为应在 `test/` 中添加以结果为导向的测试，名称采用描述性句子，例如 `test("remote URLs require authentication", ...)`。涉及文件系统时使用临时目录并在 `finally` 中清理。项目暂无覆盖率门槛；重点覆盖路由、认证、配置恢复及数据安全边界。

## 提交与拉取请求

历史提交采用 Conventional Commits，例如 `feat(gateway): 支持请求日志`、`refactor(catalog): ...`。使用简短祈使句，并为范围明确的改动添加 scope。拉取请求应说明动机、行为变化和验证命令，关联相关 issue；CLI 输出或交互变化请附终端记录，视觉变化才需要截图。保持提交聚焦，不混入生成文件或无关重构。

## Execution Plans & Histories

长周期任务和已完成的代码改动必须记录在仓库中，不能只保留在聊天记录里。

- **执行计划**（`docs/exec-plans/`）：跨会话、存在架构风险或需要分阶段验证的任务必须创建计划。进行中的计划放在 `active/`，完成后移至 `completed/`，从 `templates/execution-plan.md` 开始填写，并将明确推迟的债务记录到 `tech-debt-tracker.md`。完整规范见 `docs/PLANS_GUIDE.md`。
- **历史记录**（`docs/histories/`）：实际修改仓库的任务应按 `YYYY-MM/YYYYMMDD-HHmm-task-slug.md` 命名。使用 `template.md`，如实填写 Git 用户，并通过 `git diff --shortstat` 与 `git diff --numstat` 记录本次任务的变更统计。完整规范见 `docs/HISTORY_GUIDE.md`。
- 纯问答或调研无需历史记录；仅新增或更新调研、评估、报告、执行计划及其模板，也不要求额外生成历史记录。

## 安全与配置提示

不得提交 API 密钥、OAuth 令牌、Keychain 内容或本机 `~/.codex` 配置。转发到 CLIProxy 前必须移除 ChatGPT OAuth；修改日志时继续遮蔽敏感请求头。安装、卸载及配置写入逻辑必须保留备份、原子写入和“只修改受管字段”的行为。

修改 `~/.codex-cliproxy-gateway/config.json` 的字段、默认值、类型或校验规则时，必须同步更新 `schemas/gateway-config.schema.json`，并补充或调整对应测试；不得让运行时配置与 JSON Schema 脱节。
