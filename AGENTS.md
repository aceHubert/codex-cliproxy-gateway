# Repository Guidelines

## 项目结构与模块组织

本项目是跨平台的 Bun/TypeScript CLI 网关；基于 launchd/LaunchAgent 的自动安装与服务管理仅适用于 macOS。采用 Bun workspace monorepo，业务源码位于 `apps/gateway/src/`，独立库与 agent 插件位于 `packages/`：

- `cli.ts`：CLI 命令编排。
- `gateway.ts`：模型端口的路由与转发。
- `gateway-composition.ts`、`model-composition.ts`：显式装配已安装的 agent 插件与主机服务。
- `packages/plugin-api/src/registry.ts`：插件注册、模型归属与生命周期调度。
- `packages/plugin-api`：最小插件契约；agent 不得反向依赖业务应用。
- `packages/llm-bridge`：现有外部转换调用的等价导出，转换封装由独立计划推进。
- `packages/zcode`、`codebuddy`、`qoder`、`agy`、`opencode-zen`：各家凭据、目录、传输、请求/响应转换与插件入口。本轮目录迁移保持现有协议行为。
- `catalog.ts`、`models.ts`：模型目录。
- `upstream-catalog.ts`：CLI 与 Web UI 共享的上游目录拉取与已选目录重建（webui 的依赖树不得反向引用 `cli.ts`）。
- `keychain.ts`：上游 API key 的平台分派存储（darwin → macOS Keychain，其余平台 → 凭据文件后端）。
- `webui.ts`：内建 Web 配置界面 `/ui`（React 源码在 `apps/gateway/src/ui/`，改动 UI 后须重跑 `bun run build:ui`）。
- `config-update.ts`：CLI `config` 命令与 Web UI 共享的配置解析/写入/审计路径。
- `launchd.ts`、`toml.ts`：其余系统集成。

测试集中在 `test/`，辅助脚本在 `scripts/`；私有包 `packages/models/` 是模型目录预设的唯一来源，网关和插件直接消费并在构建时内联，该包不发布；`apps/gateway/models.json` 是网关自有的上游元数据覆盖规则，只允许网关内部使用，不向插件导出。`apps/gateway/schemas/` 是配置规范的唯一来源，随网关包发布并用于运行时校验。根 `README.md` 说明项目结构，`apps/gateway/README.md` 独立维护 CLI 使用手册。`apps/gateway/dist/` 与各 `packages/*/dist/` 是构建产物，不应手工编辑。根目录 `CHANGELOG.md` 与 `LICENSE` 不生成常驻包副本，许可证仅在发布/打包时临时提供。各模块的实现规则与边界细节见 `docs/` 对应文档（执行计划、专题文档与历史记录），不在此重复。

## 构建、测试与开发命令

- `bun install`：按 `bun.lock` 安装开发依赖。
- `bun run dev <command>`：先构建包依赖，再从 `apps/gateway/src/index.ts` 运行 CLI，例如 `bun run dev status`。
- `bun run dev:ui`：复用 `web` 启动网关与 UI API 后，另起绑定 `127.0.0.1:8322` 的 Vite HMR 开发页面；正式 `web` 行为不变。
- `bun run test`：先构建独立包，再执行全部 `node:test` 测试；测试进程超时上限 60 秒。
- `bun run typecheck`：构建依赖后，以严格模式检查业务应用、测试及各 workspace 包。
- `bun run build`：按 workspace 依赖顺序构建私有模型包及七个公开库/插件包，再构建业务应用；UI 输出为 `apps/gateway/dist/ui/index.html`，CLI 输出为 `apps/gateway/dist/index.js`。
- `bun run check`：依次构建、检查类型并运行测试；提交前必须通过。
- `bun run pack:check`：构建后打包八个产品包，并在隔离临时项目检查依赖版本、包导出和 `agent-proxy --help`；不执行真实发布。
- 根包 `agent-proxy-monorepo` 为 private；业务包是 `@agent-proxy/gateway`，CLI bin 为 `agent-proxy`。跨包导入使用包 exports，不得引用其他包的源码相对路径。

## 编码风格与命名约定

沿用现有 TypeScript 风格：两个空格缩进、双引号、分号、ES 模块及显式 `.ts` 导入后缀。函数和变量使用 `camelCase`，类型与接口使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。优先使用 Bun、Node 标准库及现有模块；避免引入仅服务单一调用点的抽象或依赖。公共边界应保持严格类型，错误信息应说明可执行的修复方式。

## 测试指南

使用 `node:test` 与 `node:assert/strict`，由 `bun run test` 编排运行。新增行为应在 `test/` 中添加以结果为导向的测试，名称采用描述性句子，例如 `test("remote URLs require authentication", ...)`。涉及文件系统时使用临时目录并在 `finally` 中清理。重点覆盖路由、认证、配置恢复及数据安全边界。

## Execution Plans & Histories

长周期任务和已完成的代码改动必须记录在仓库中，不能只保留在聊天记录里。

- **执行计划**（`docs/exec-plans/`）：跨会话、存在架构风险或需要分阶段验证的任务必须创建计划。进行中的计划放在 `active/`，完成后移至 `completed/`，从 `templates/execution-plan.md` 开始填写，并将明确推迟的债务记录到 `tech-debt-tracker.md`。完整规范见 `docs/PLANS_GUIDE.md`。
- **历史记录**（`docs/histories/`）：实际修改仓库的任务应按 `YYYY-MM/YYYYMMDD-HHmm-task-slug.md` 命名。使用 `template.md`，如实填写 Git 用户，并通过 `git diff --shortstat` 与 `git diff --numstat` 记录本次任务的变更统计。完整规范见 `docs/HISTORY_GUIDE.md`。
- 纯问答或调研无需历史记录；仅新增或更新调研、评估、报告、执行计划及其模板，也不要求额外生成历史记录。

## 安全与配置红线

- 不得提交 API 密钥、OAuth 令牌、Keychain 内容、`credentials.json` 或本机 `~/.codex` 配置。
- 上游 API key 的存取必须走 `keychain.ts` 的分派，不得绕过它直接读 Keychain 或凭据文件；损坏的 credentials.json 要报带路径与重建指引的错误，不静默当作缺失。
- 禁止在日志、Web UI 或任何 API 响应中读取、展示或外发凭据；URL 的 query 可能携带 token，对外展示（审计与 `/ui/api/*` 响应）一律按 `sanitizeUrlValue` 只保留 origin 与路径；修改日志时继续遮蔽敏感请求头。
- 转发到 CLIProxy 前必须移除 ChatGPT OAuth。
- 安装、卸载及配置写入逻辑必须保留备份、原子写入和「只修改受管字段」的行为。
- 修改 `~/.agent-proxy-gateway/config.json` 的字段、默认值、类型或校验规则时，必须同步更新 `apps/gateway/schemas/gateway-config.schema.json`，并补充或调整对应测试。
- `$schema` 是程序维护的配置字段；每次 install 使用当前程序的规范地址覆盖旧值或用户自定义值，安装失败仍恢复原配置与状态。
- 默认目录为 `~/.agent-proxy-gateway`；`CODEX_CLIPROXY_HOME`、显式实例与 `serve --config` 仍优先。旧默认安装仅由 install 按受管文件/JSON 字段白名单复制合并，保留旧目录和恢复材料，不改自定义路径，不重命名环境变量或服务身份。
- 五类 agent 缺失开关按 true 合并，已有显式 false 必须保留；配置仍枚举已知 agent，插件只由业务组合入口显式装配。
- Web UI 与模型流量结构性隔离（独立端口、独立进程）；`/ui/api/*` 必须校验 ui-token 与 Host/Origin 白名单；改动路由时不得破坏模型端口对 `/ui` 前缀及 mountPath 子树外的本地 404 边界。
