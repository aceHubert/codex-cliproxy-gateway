# Repository Guidelines

## 项目结构与模块组织

本项目是跨平台的 Bun/TypeScript CLI 网关；基于 launchd/LaunchAgent 的自动安装与服务管理仍仅适用于 macOS。业务源码位于 `src/`：`cli.ts` 负责命令编排，`gateway.ts` 处理路由与转发，`zcode/` 封装 ZCode 配置缓存、目录、协议转换与网关适配，`codebuddy/` 封装 CodeBuddy/WorkBuddy 的 `.info` 凭据只读消费（profile 双源判定 + 官方端点白名单 + mtime 热更新，绝不刷新 token）、`/v3/config` 目录拉取（serves∩picker 交集 + 双指纹缓存 + 倍率并入 display_name）与 Responses ↔ OpenAI Chat 双向协议转换（`codebuddy/`、`workbuddy/` 前缀族，`codebuddy` 开关默认关闭，凭据与错误正文按 accessToken/refreshToken 双 token 脱敏），`catalog.ts` 和 `models.ts` 管理模型目录，`upstream-catalog.ts` 封装「按 config.json 拉取上游目录 + 重建已选目录」的 CLI/Web UI 共享路径（webui 的依赖树不得反向引用 cli.ts，共享逻辑独立成模块），`keychain.ts` 封装上游 API key 的平台分派存储（darwin → macOS Keychain，其余平台 → `credentials-store.ts` 的 `~/.codex-cliproxy-gateway/credentials.json` 文件后端，0600、原子写），`launchd.ts`、`toml.ts` 封装其余系统集成；`webui.ts` 实现内建 Web 配置界面（`/ui`，React 源码在 `src/ui/`，hash 路由，由 `scripts/build-ui.ts` 通过 Vite 构建为 `dist/ui/index.html`，正式 UI 运行时直接读取该文件，改动 UI 后须重跑 `bun run build:ui`）；`config-update.ts` 是 CLI `config` 命令与 Web UI 共享的配置解析/写入/审计路径。测试集中在 `test/`。`scripts/` 存放独立辅助脚本，`models.json` 提供模型元数据覆盖，`dist/` 是构建产物，不应手工编辑。

## 构建、测试与开发命令

- `bun install`：按 `bun.lock` 安装开发依赖。
- `bun run dev <command>`：直接从 `src/index.ts` 运行 CLI，例如 `bun run dev status`。
- `bun run dev:ui`：先复用 `web` 启动网关和 UI API（不打开生产页面），再启动默认绑定 `127.0.0.1:8322` 的 Vite HMR 服务并自动打开开发页面；正式 `web` 行为不变。开发端口可用 `CODEX_CLIPROXY_UI_DEV_PORT` 覆盖，非默认 UI 后端端口用 `CODEX_CLIPROXY_UI_BACKEND_PORT` 指定。
- `bun test`：执行全部 `node:test` 测试。
- `bun run typecheck`：以严格模式运行 TypeScript 类型检查。
- `bun run build`：先跑 `build:ui`（`src/ui/` → `dist/ui/index.html`），再生成 CLI 入口 `dist/index.js`。
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

## 模型目录合成与匹配规则

CLI/Web 的上游模型选择入口 `fetchUpstreamCatalog` 统一排除 `visibility: "hide"` 的条目，覆盖 `models --sync`、安装时选模及 Web 拉取/保存；未声明 visibility 或其他值保持原语义。过滤仅针对上游可选目录，不得裁剪官方目录或其 last-good 缓存。全部条目隐藏时 Web 返回空列表，CLI 同步沿用无可用模型错误并保留现有配置。Web 保存选择与 `models --sync` 一致，按最新上游目录取交集：上游已下线的旧 ID 静默剔除，不得因旧选择阻塞保存；upstream-only 模式过滤后为空仍须拒绝，避免写出空目录。

模型目录数据在 `models/`：`vendor_models.json`（厂商预设，按 `z.ai`/`deepseek`/`moonshotai` 分组，与根目录 `models.json` 同构）与 `codex_client_models.json`（OpenAI Codex 目录快照），二者在构建期通过静态 import 内联进 `dist/index.js`；`models.json`（仓库根，随包发布；运行期优先读 `~/.codex-cliproxy-gateway/models.json` 缓存，缺失时回退内联的仓库根版本）提供分组覆盖规则。new-api/CLIProxy 合成 Codex 目录条目时按以下优先级，修改 `catalog.ts` 或重建 `models/` 资产时必须保持：

1. **`models/vendor_models.json` 预设命中** — GLM、Kimi、DeepSeek 等官方 Codex 支持预设，来自各厂商自己的 Codex 接入指南（[Kimi](https://www.kimi.com/code/docs/en/third-party-tools/codex.html)、[DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)）。命中的规则以“干净基础 + 厂商字段”构建条目，非 GPT 模型不得继承 GPT 专属设置。
2. **`models/codex_client_models.json` 快照精确命中** — 刷新方式：先把 Codex CLI 升级到最新版，再执行 `codex debug models --bundled > models/codex_client_models.json`（输出本身即 `{"models":[...]}` 形状）。精确命中沿用真实条目（上下文窗口、reasoning 等级、instructions）。
3. **`models.json` 覆盖规则命中** — 干净最小基础 + 规则字段，不继承 GPT 专属设置。
4. **兜底** — 克隆 `gpt-5.5` 条目，仅替换 `slug`/`display_name`/`description` 并解除其最低客户端版本限制（对应 CLIProxyAPI 行为）。

规则匹配语义：`models.json` 规则在合成后叠加于每条条目上，任意分组的规则同时匹配 `vendor/model` 与裸 ID——`z.ai` 组的 `glm-5.3` 规则同样细化来自 new-api 的裸 `glm-5.3`；只有组级 `*` 规则限定在本组 `vendor/` 前缀内，不能吞掉其他分组的模型。重构合成或匹配逻辑时不得破坏上述语义。

拉取 CLIProxy 目录时必须发送真实客户端版本（`codex-version.ts` 解析，`--sync`/`install` 共用）：CLIProxy 按 `client_version` 决定目录内容，低于约 `0.145` 会静默过滤掉 `max`/`ultra` reasoning 等级，写成固定值（历史上的 `"0.0.0"`）会让多数模型失去 `max`。版本来源优先级为 网关 `models-cache.json`（`/models` 请求记录客户端自报版本；`writeModelsCache` 在官方刷新成功时把上游返回的完整 `models` 原样写入作 last-good 缓存，刷新失败时只更新 `fetched_at`/`client_version` 并保留已有 `models`——绝不清空目录；`/models` 在官方刷新失败时回退该缓存而不是返回 502）> `codex --version` 探测 > `0.0.0`，可用 `CODEX_CLIPROXY_CLIENT_VERSION` 覆盖；该参数对 newapi 无意义——new-api 只返回 OpenAI 裸列表，目录在本地合成。

覆盖规则由开发者编写并随包/发布物分发，不是终端用户配置项：`--model-merge-json` 的 GitHub 仓库 URL 解析为 `releases/latest/download/models.json`，用于刷新上述运行期缓存。规则文件形状示例：

```json
{
  "my-vendor": [
    { "name": "my-model-*", "context_window": 200000, "description": "…" }
  ]
}
```

## 安全与配置提示

不得提交 API 密钥、OAuth 令牌、Keychain 内容、`credentials.json` 或本机 `~/.codex` 配置；上游 API key 的存取必须走 `keychain.ts` 的分派（不得绕过它直接读 Keychain 或凭据文件），损坏的 credentials.json 要报带路径与重建指引的错误、不静默当作缺失。禁止在日志、Web UI 或任何 API 响应中读取、展示或外发凭据——URL 的 query 可能携带 token，对外展示（审计与 `/ui/api/*` 响应）一律按 `sanitizeUrlValue` 只保留 origin 与路径，Keychain/credentials.json 中的 API key、OAuth 与 ui-token 本身绝不出现在任何响应里。转发到 CLIProxy 前必须移除 ChatGPT OAuth；修改日志时继续遮蔽敏感请求头。安装、卸载及配置写入逻辑必须保留备份、原子写入和“只修改受管字段”的行为。Web UI（`/ui`）是网关内建能力、零配置，但运行在**独立端口、独立进程**上（`webui.ts` 的 `webUiPort`＝网关端口 + 1，`startWebUiServer` 单独 `Bun.serve`、只绑定 loopback），与模型流量结构性隔离——模型端口的请求日志只含模型流量。UI 进程唯一的外呼是「拉取模型」：`upstream-catalog.ts` 的 `fetchConfiguredUpstreamCatalog`（CLI `install`/`models --sync` 共用）只发一次固定只读的 `GET {upstreamBaseUrl}/models`（key 经 keychain 分派读取，只进请求头；错误消息先经 `sanitizeUpstreamMessage` 折叠 URL query 再进响应），保存选择（`POST /ui/api/upstream/models`）据此重建 `catalogPath` 目录并走 `applySelectedModelsPatch` 同步 config/state/审计——`selectedModels` 不进通用配置补丁白名单，目录文件与配置字段必须同一次保存一起变更；upstream-only 模式由 Codex 静态加载目录（保存后由用户确认触发 `POST /ui/api/codex/restart` 停止 app-server），动态路由则重置官方目录缓存、Codex 约 5 分钟内自动刷新，均不重启网关。除上述固定拉取外，UI 侧不存在任何转发路径，也不可能把请求转发到上游。UI 对 provider 侧只有本地存在性探测：`GET /ui/api/config` 的 `detected` 分组由 `zcodeConfigPresent`（`~/.zcode` 下 `setting.json` 与 `config.json` 是否齐备，home/v2 布局按 `readPreferred` 回退顺序判定）与 `codebuddyCredentialsPresent`（平台默认 `.info` 是否存在）产出，只 `fs.existsSync`、不打开不解析凭据、响应里只有布尔值；`ConfigPage` 据此显隐 zcode/codebuddy 开关（开关已开启时仍显示，便于在 UI 里关回，并提示「未检测到本机配置」）。**UI 默认不启动**：`serve` 绝不起 UI；`codex-cliproxy web` 默认（`--start` 同义）前台启动——检查网关（未运行则启动）后前台运行 UI 服务并打开浏览器，Ctrl-C 停止；`web --daemon` 后台启动——经 LaunchAgent（`codex-cliproxy-webui`，RunAtLoad/KeepAlive 均为 false，重启登录后保持关闭）拉起后打开浏览器；`--status/--stop/--restart` 子选项只作用于后台 UI 服务、不动网关；LaunchAgent 复用 `web` 命令并设置内部标记 `CODEX_CLIPROXY_UI_SERVICE=1`（仅前台运行同一 UI 服务，始终绑定默认安装配置，不检查网关、不打开浏览器，优先于 dev 模式）；已移除 `webui` 命令及其旧 `--config` 兼容入口，后台启动或重启时重写 plist；dev:ui（`CODEX_CLIPROXY_UI_DEV=1`）复用 web 时强制走后台路径；`stop`/`uninstall` 会一并回收 UI agent。`/ui/api/*` 必须校验 `x-ccp-ui-token`（`~/.codex-cliproxy-gateway/ui-token`）与按 UI 端口计算的 Host/Origin 白名单；UI 服务每个请求重读 config.json，CLI 侧配置变更无需重启 UI 进程。模型端口对 `/ui` 前缀一律本地 404 并提示 UI 端口（`gateway.ts` handleCore 前部与 startGateway fetch 层各有一道，fetch 层那道必须先于 WebSocket 桥接分流，防止带 Upgrade 头的 `/ui` 被桥接转发上游）；模型端口只转发 `mountPath` 子树内的 API 请求（`isUnderMountPath`），子树外任何路径（`/.well-known/*`、favicon、根路径等浏览器噪声）一律本地 404、绝不转发上游、也不进请求日志；请求日志只记录 mountPath 子树内的模型流量（`/v1/models` 目录请求除外）。改动路由时不得破坏这些边界。

修改 `~/.codex-cliproxy-gateway/config.json` 的字段、默认值、类型或校验规则时，必须同步更新 `schemas/gateway-config.schema.json`，并补充或调整对应测试；不得让运行时配置与 JSON Schema 脱节。

## README 文档边界（强制）

- `README.md` 是面向终端用户的使用手册，只保留安装、配置、命令用法、必要的使用限制与常见问题。
- **严禁把代码解读写入 `README.md`**：不得追加源码结构、函数调用链、协议转换、请求头构造、缓存机制、内部路由算法、实现推导或开发过程记录。
- 新增命令时，仅补充简短的用途说明、必要参数和最小使用示例；现有用法发生变化时，仅修正对应说明，不借机扩写实现细节。
- 开发约束写入 `AGENTS.md`，技术设计、实现说明、开发发布流程及变更记录写入 `docs/` 对应文档，不得堆入用户手册。
