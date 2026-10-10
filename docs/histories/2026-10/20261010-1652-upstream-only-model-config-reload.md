## [2026-10-10 16:52] | Task: 实施 upstream-only 请求边界与模型配置热加载

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`（会话未提供具体模型后缀）
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/upstream-only-config`

### 📥 User Query
> 保留 install --upstream-only，安装后的模式修改归 config --upstream-only on|off，并支持可选 --restart-codex。models --sync、--exclude 仅读取模式，更新后热加载网关配置，依据 upstreamOnly 和已保存的 manual-codex-config 管理状态更新 Codex 静态目录与配置。agent 请求逻辑独立于命令管理，upstream-only 仅作用于 default，不禁用已开启 agent。开始实施。

### 🛠 Changes Overview
**Scope:** CLI、共享目录管理、agent 目录生命周期、网关请求路由与热加载、Web UI、Schema、测试及执行计划。

**Key Actions:**
- **[命令职责]**: 保留安装布尔参数；config 使用 on/off 并可请求 Codex 重载；models 移除模式参数，旧命令在写入前给出迁移指引，同步不再切回动态模式。
- **[模型热加载]**: CLI/Web UI 发布本地权限 0600 的修订通知，网关按当前实例加载选择、排除规则与 agent 元数据，不关闭服务、连接或定时器。独立通知队列防止并发覆盖，最近 64 条回执避免重启重复处理及结果丢失。
- **[目录生命周期]**: 五类 agent 提供显式刷新与纯磁盘重载；保留启动刷新，静态模式关闭后续模型心跳和隐式 TTL 更新。凭据、签名和必要客户端指纹维护保留。
- **[静态目录]**: 原始上游目录不变，合并目录写入 codex-catalog.json；保留 agent 前缀与元数据，仅过滤本地兼容族。最终静态目录为空或来源真实失败时拒绝发布并恢复旧文件。
- **[Codex 管理]**: 按 state.json 的管理状态处理 TOML，手动模式仅输出设置指引；目录与配置就绪后再执行可选客户端重载。配置与目录失败回滚，保留备份、受管键守卫与安装哈希规则。
- **[请求边界]**: agent 开关不再因 upstream-only 失效；环回与前缀校验仍生效，HTTP-only WS 请求在本地拒绝。default 读取模式选择上游/官方，不把插件错误重试到默认上游。
- **[Web UI]**: upstream-only 模式只读展示，编辑与 API 写入均禁止，修改走 CLI config；解除 agent 禁用展示，组合保存先收敛最终配置与模型选择；排除变化热加载，结构变化保留网关重启，全部就绪后才重载 Codex。
- **[审查修复]**: 普通 default 推理不等待无关 agent 初始化；模型 reload 重新发布当前规则快照，避免异步启动覆盖新静态文件；多实例缓存归属从运行主目录派生；修复三引号 TOML 首行误识别。
- **[文档]**: 更新 README，分别完成并归档命令热加载计划和请求路由计划。本轮继续使用现有分派顺序，register/setDefault 注册器提取仍由进行中的协议拆分计划负责。

### 🧠 Design Intent (Why)
模式配置、模型更新与请求处理分别管理。目录变化仅发布模型状态，避免为更新列表中断正在进行的推理；静态模式保留可控更新与客户端重载，动态模式保留既有刷新机制。上游原始目录与合并快照分离，避免切换模式时污染模型 ID。手动 Codex 配置保持用户所有权。

### 🧪 Validation
- `bun run check` 通过：严格类型检查、**886 项测试（0 失败）**、UI 与 CLI 构建。
- 后台测试每轮由 60 秒外层超时保护；Web 模式只读调整后的全量测试耗时 22.84 秒。
- 关键覆盖：模式参数迁移、手动/托管四组合、静态空目录回滚、纯磁盘元数据更新、实例隔离、通知并发/重启回执、普通推理不等待其它 agent 启动、HTTP/WS 安全边界及 Web UI 就绪顺序。
- 整合阶段保留并发任务的上游显示名标签改动，将 UI 显示名断言对齐后再次运行完整 check，仍为 885 项通过。
- 后续按要求禁止 Web 编辑 upstreamOnly，覆盖 GET 只读分组、所有类型的提交拒绝和混合请求无副作用；CLI 模式配置保持原入口。
- `git diff --check` 通过。未修改真实安装、运行服务或凭据，未提交或部署。

### 📊 Change Stats
> 以本任务文件路径为范围，已跟踪文件来自 `git diff --shortstat` 与 `git diff --numstat`：43 files changed, 1806 insertions(+), 843 deletions(-)。新增文件另用 `git diff --no-index --numstat /dev/null <file>` 计入。合计包含源码、测试及两份计划，不含本历史自身与并发任务的 catalog 显示名实现、对应 gateway 测试修改。已包含 Web upstreamOnly 只读的后续调整。

- **Files changed:** 50
- **Insertions:** +3340
- **Deletions:** -843

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +41 | -264 |
| `schemas/gateway-config.schema.json` | +6 | -6 |
| `src/agy/catalog.ts` | +42 | -5 |
| `src/agy/index.ts` | +40 | -13 |
| `src/cli.ts` | +135 | -181 |
| `src/codebuddy/catalog.ts` | +30 | -14 |
| `src/codebuddy/index.ts` | +35 | -15 |
| `src/config-update.ts` | +3 | -0 |
| `src/gateway.ts` | +98 | -20 |
| `src/opencode/catalog.ts` | +30 | -14 |
| `src/opencode/index.ts` | +20 | -3 |
| `src/paths.ts` | +1 | -0 |
| `src/qoder/catalog.ts` | +21 | -2 |
| `src/qoder/index.ts` | +27 | -4 |
| `src/toml.ts` | +2 | -0 |
| `src/types.ts` | +4 | -5 |
| `src/ui/ConfigPage.tsx` | +35 | -61 |
| `src/ui/api.ts` | +2 | -0 |
| `src/ui/i18n/locales/en/config.ts` | +5 | -10 |
| `src/ui/i18n/locales/zh/config.ts` | +5 | -10 |
| `src/ui/styles.css` | +0 | -8 |
| `src/webui.ts` | +168 | -47 |
| `src/zcode/config.ts` | +53 | -15 |
| `src/zcode/index.ts` | +93 | -42 |
| `test/agy-catalog.test.ts` | +36 | -0 |
| `test/agy-gateway.test.ts` | +77 | -3 |
| `test/app-server.test.ts` | +15 | -6 |
| `test/codebuddy-catalog.test.ts` | +36 | -0 |
| `test/codebuddy-gateway.test.ts` | +85 | -12 |
| `test/instance-regressions.test.ts` | +4 | -1 |
| `test/manual-codex-config.test.ts` | +21 | -7 |
| `test/model-catalog-dynamic.test.ts` | +48 | -35 |
| `test/model-exclude-gateway.test.ts` | +8 | -4 |
| `test/model-exclude.test.ts` | +71 | -1 |
| `test/opencode-zen-catalog.test.ts` | +34 | -0 |
| `test/opencode-zen-gateway.test.ts` | +38 | -3 |
| `test/qoder-catalog.test.ts` | +35 | -0 |
| `test/qoder-config.test.ts` | +2 | -2 |
| `test/qoder-gateway.test.ts` | +34 | -5 |
| `test/webui.test.ts` | +227 | -10 |
| `test/zcode-cache.test.ts` | +26 | -0 |
| `test/zcode-cli.test.ts` | +7 | -5 |
| `test/zcode-gateway.test.ts` | +106 | -10 |
| `docs/exec-plans/completed/model-config-reload-and-cli-ownership.md` | +188 | -0 |
| `docs/exec-plans/completed/upstream-only-agent-adapters.md` | +106 | -0 |
| `src/model-reload.ts` | +238 | -0 |
| `src/model-state.ts` | +201 | -0 |
| `test/gateway-model-reload.test.ts` | +261 | -0 |
| `test/model-reload.test.ts` | +318 | -0 |
| `test/model-state.test.ts` | +222 | -0 |

### 📁 Files Modified
- 核心命令与目录管理：`src/cli.ts`、`src/model-state.ts`、`src/model-reload.ts`。
- 网关与各 agent：`src/gateway.ts`、`src/{zcode,codebuddy,qoder,agy,opencode}/`。
- UI 与配置：`src/webui.ts`、`src/config-update.ts`、`src/ui/`、`schemas/gateway-config.schema.json`。
- 测试与实施记录：`test/`、`README.md`、`docs/exec-plans/completed/`。
