## [2026-10-11 13:50] | Task: 实施 Agent Proxy monorepo 与插件迁移

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/gateway-monorepo`

### 📥 User Query
> 在 gateway-monorepo worktree 实施 monorepo 与插件执行计划。本轮不设计协议转换，保留现有转换，验收 Responses endpoint 到各 agent 行为一致，迁移后仍可由 Codex 调用。

### 🛠 Changes Overview
**Scope:** `apps/gateway`、七个 `packages/*`、构建发布编排、配置迁移、测试与当前使用文档。

**Key Actions:**
- 建立八包 Bun workspace，根包 private，Lerna fixed 模式保持 0.10.0；真实锁定工具版本为 Lerna 10.1.0（原声明 ^10.0.1），没有降级。
- 实现 plugin-api、模式匹配与歧义检测、HTTP/WS 派发和生命周期；网关/default 核心传递依赖仅消费契约，具体工厂在组合层显式装配。
- 五家 agent 原请求、响应、SSE、compaction 及厂商实现迁入独立包；Qoder 继续显式复用 CodeBuddy 转换。bridge 当前等价导出原库 API，没有在本轮新增 convertRequest 或转换算法。
- 主机实现通过 HostServices 与异步上下文注入，保持实例隔离；静态启动单家无登录/目录不可用不阻断 default 和其它插件，显式目录同步仍严格报错。
- CLI 更名 agent-proxy；默认运行目录迁至 .agent-proxy-gateway，五家缺省启用但显式 false 保留。旧安装按受管白名单合并/迁移，保留旧目录、权限、备份、ownership 与完整失败回滚。
- Web UI 每次配置查询调用包内零参数 getActiveAccount/getActiveSources，保留字段、路径、账号选择及 UI 布局。
- 补齐产物资源、公开类型、包依赖、Nx 顺序/缓存输入、发布路径检测和 fixed changelog 版本来源；共享根构建输入不会因 root private 而漏发。
- 同步 README、AGENTS、迁移指引与插件契约；保留实施开始前已有的需求/计划编辑，不提交、不全局安装、不修改真实用户配置、不发布。

### 🧠 Design Intent (Why)
本轮将结构迁移与转换改造分开，避免通过重新实现协议来掩盖迁包回归。包边界以公开 exports 和空白消费者验证，主机能力保持在应用；模型匹配、目录、日志与关闭统一按插件归属处理，派发后的失败不能回落 default。

模式大小写敏感与末尾 /* 要求非空后缀是执行计划明确的新路由合同；大写前缀及空后缀有独立测试，标准小写 Responses 转换断言保留。四家未新增 Chat 转换，明确拒绝该输入；Zen 保留已有 Chat 能力。

### ✅ Validation
- `models.json` 内联与副本删除后：7 项专项测试通过，八包隔离打包及公开类型检查通过，编译后的 ZCode 默认数据与根文件 deepEqual 一致。重建后排除依赖与历史缓存扫描仅发现根目录 `models.json`。本轮全量 check 在类型阶段被同一工作树进行中的配置类型调整阻断（如 prefix/catalogPath 改为可选后的调用点未同步），不将此前全量通过结果当成本轮全量验收。
- 模型目录迁移及常驻许可证副本清理时的检查为 950 项通过、0 失败，70 个文件（23.98 秒）；该轮八包隔离打包验证通过，临时许可证均已清理。此结果是后续 `models.json` 内联调整前的检查时点。
- 重装密钥复用增补：`bun run check` 通过 948 项测试、0 失败，69 个文件（23.68 秒）；包含 25 项安装/回滚定向回归，构建后的 CLI 帮助已核对。
- 原始 main a20587d 基线：886 项测试通过。
- 统一 bun run check 首轮最终验证：936 项通过、0 失败，66 个测试文件；八包构建、根与包级严格类型、静态依赖检查通过。发布检测测试增补后，审核复跑完整测试为 939 项通过、0 失败，67 个测试文件（22.50 秒）。
- 发布脚本定向：7 项通过（共享输入检测与 fixed changelog），全部使用临时 Git fixture。
- 空白消费者安装八个本地 tgz：workspace 依赖变为发布版本；七库公开类型严格检查通过；模块、五家请求转换与 CodeBuddy Responses SSE、CLI help/status、default Responses/OAuth 隔离/模型剥前缀及 UI/路径外本地 404 冒烟通过。
- 隔离 Lerna fixed 模拟：八包/lerna.json/bun.lock 同步，根钩子每轮恰一次，冻结安装通过；根构建脚本单独变化能触发八包，纯文档/测试不强制版本。
- 独立插件/core 审查没有确认缺陷。安装审查发现的悬空链接、config-only 重复迁移、manual ownership 残留、新旧默认 state 归属及二进制日志回滚问题均已修复并补测试。
- 所有后台测试整轮限制 60 秒；上游和凭据验证使用模拟服务及临时实例。没有以真实 Codex 账号/上游调用替代本地回归证据。

### 📊 Change Stats
资源唯一来源后续调整（2026-10-11）：删除 apps/gateway 的 CHANGELOG/LICENSE 和七库 LICENSE 共 9 份常驻副本，移除构建复制、manifest 强制文件与 Nx 输出；根原件保留，Lerna 发布和本地 pack 检查仅临时提供许可证。根 models/ 两份 JSON 移至 apps/gateway/models/ 后移除空根目录，主机接口提供预设。随后删除 apps/gateway/models.json 并停止复制，根 models.json 静态内联到网关，库共享 JSON 编译为 JS 模块；显式缓存/远程规则的加载和校验语义保留。内联读取源码和测试先完成，构建配置及删除曾被自动审批服务错误阻断，在用户恢复写入权限后完成。下方原交付统计保持原时点，不将后续调整伪装成当时已完成。

重装交互增补（2026-10-11）：用户要求重装时跳过密钥输入并复用旧值。install 现在仅在当前实例已有配置、上游完整 URL（含 query）及类型匹配且没有显式密钥来源时读取复用；显式 API_KEY/--key-env 优先，换上游或缺少旧值仍提示，显式空值沿用仅本地允许规则。凭据快照通过 keychain 分派只读取一次，缺 state 时的失败回滚也恢复旧 key。新增纯选择/实例隔离测试及子进程隔离的 install 认证、显式覆盖、缺 state 回滚测试，更新 README 与 CLI 帮助；全程未访问真实凭据或执行真实安装。

旧名称语义复查：修正日志检查脚本的旧默认目录，改为复用网关路径解析，并修正两条实例健康错误文案为 agent-proxy。同步既有断言，124 项相关回归通过；临时目录验证默认目录、环境覆盖与显式 --dir 均正确。迁移指引补充保留名称清单，环境/服务/凭据/响应头/稳定项目 ID 和仓库插件市场身份不做单边改名。

审核补充：新增 `.nx/` 忽略规则，避免本地缓存进入提交；修正 Schema 的 logDir 默认目录文案，保持 $id/title 不变。两份旧计划在本轮实施开始前已被有意撤下，后继计划保留承接与弃用决定；按 PLANS_GUIDE 允许的“关闭、归档或清理”保留删除，不将被取代方案标为已完成。下方统计为原迁移交付时点，本次补充不回写其历史快照。

统计以 a20587d 的受影响文件快照与当前工作树快照比较，使用 `git diff --no-index --find-renames --shortstat` 与 `--numstat`。这样包含未跟踪的新包并识别源码移动；普通工作树 diff 会只看到旧 src 删除，不能代表迁移规模。范围为代码、测试、构建、README/AGENTS 和新增两份指南；排除开始前已有的需求/计划改动及本记录自身。

- **Files changed:** 224
- **Insertions:** +4980
- **Deletions:** -1144

下表中 before/after 表示迁移前后路径；0/0 的行是仅移动文件。

<details>
<summary>逐文件变更统计</summary>

| File | +Added | -Removed |
| --- | ---: | ---: |
| `.github/workflows/deploy.yml` | 0 | 3 |
| `.gitignore` | 7 | 0 |
| `AGENTS.md` | 19 | 12 |
| `README.md` | 92 | 57 |
| `apps/gateway/package.json` | 50 | 0 |
| `{before => after/apps/gateway}/src/app-server.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/catalog.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/cli.ts` | 73 | 58 |
| `{before => after/apps/gateway}/src/codex-ownership.ts` | 72 | 8 |
| `{before => after/apps/gateway}/src/codex-version.ts` | 0 | 0 |
| `apps/gateway/src/config-read.ts` | 11 | 0 |
| `{before => after/apps/gateway}/src/config-update.ts` | 12 | 18 |
| `{before => after/apps/gateway}/src/config.ts` | 18 | 0 |
| `{before => after/apps/gateway}/src/credentials-store.ts` | 0 | 0 |
| `apps/gateway/src/default-install-migration.ts` | 230 | 0 |
| `apps/gateway/src/gateway-composition.ts` | 151 | 0 |
| `{before => after/apps/gateway}/src/gateway.ts` | 163 | 294 |
| `apps/gateway/src/host-services.ts` | 34 | 0 |
| `{before => after/apps/gateway}/src/index.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/instance-health.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/keychain.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/launchd.ts` | 96 | 1 |
| `apps/gateway/src/model-composition.ts` | 73 | 0 |
| `{before => after/apps/gateway}/src/model-reload.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/model-state.ts` | 12 | 61 |
| `{before => after/apps/gateway}/src/models.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/paths.ts` | 8 | 5 |
| `{before => after/apps/gateway}/src/process-log.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/realtime.ts` | 9 | 23 |
| `{before => after/apps/gateway}/src/request-log.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/toml.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/types.ts` | 7 | 7 |
| `{before => after/apps/gateway}/src/ui/App.tsx` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/ConfigPage.tsx` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/Header.tsx` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/LogsPage.tsx` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/ModelPicker.tsx` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/TextView.tsx` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/api.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/excluded-models-field.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/hash-router.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/i18n/i18next.d.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/i18n/index.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/i18n/locales/en/common.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/i18n/locales/en/config.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/i18n/locales/en/logs.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/i18n/locales/en/models.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/i18n/locales/zh/common.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/i18n/locales/zh/config.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/i18n/locales/zh/logs.ts` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/i18n/locales/zh/models.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/index.html` | 1 | 1 |
| `{before => after/apps/gateway}/src/ui/log-size-field.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/main.tsx` | 0 | 0 |
| `{before => after/apps/gateway}/src/ui/styles.css` | 1 | 1 |
| `apps/gateway/src/ui-port.ts` | 6 | 0 |
| `{before => after/apps/gateway}/src/upstream-catalog.ts` | 0 | 0 |
| `{before => after/apps/gateway}/src/webui.ts` | 36 | 32 |
| `apps/gateway/tsconfig.json` | 7 | 0 |
| `bun.lock` | 97 | 7 |
| `docs/monorepo-migration.md` | 107 | 0 |
| `docs/plugin-contract.md` | 203 | 0 |
| `lerna.json` | 1 | 7 |
| `nx.json` | 53 | 0 |
| `package.json` | 27 | 32 |
| `packages/agy/package.json` | 39 | 0 |
| `{before/src/agy => after/packages/agy/src}/catalog.ts` | 9 | 8 |
| `{before/src/agy => after/packages/agy/src}/credentials.ts` | 0 | 0 |
| `{before/src/agy => after/packages/agy/src}/fingerprint-data.json` | 0 | 0 |
| `{before/src/agy => after/packages/agy/src}/index.ts` | 41 | 10 |
| `{before/src/agy => after/packages/agy/src}/request.ts` | 0 | 0 |
| `{before/src/agy => after/packages/agy/src}/response.ts` | 0 | 0 |
| `{before/src/agy => after/packages/agy/src}/transport.ts` | 0 | 0 |
| `packages/agy/tsconfig.build.json` | 10 | 0 |
| `packages/agy/tsconfig.json` | 6 | 0 |
| `packages/codebuddy/package.json` | 39 | 0 |
| `{before/src/codebuddy => after/packages/codebuddy/src}/catalog.ts` | 6 | 6 |
| `{before/src/codebuddy => after/packages/codebuddy/src}/credentials.ts` | 26 | 3 |
| `{before/src/codebuddy => after/packages/codebuddy/src}/fingerprint-data.json` | 0 | 0 |
| `{before/src/codebuddy => after/packages/codebuddy/src}/index.ts` | 44 | 10 |
| `{before/src/codebuddy => after/packages/codebuddy/src}/request-context.ts` | 0 | 0 |
| `{before/src/codebuddy => after/packages/codebuddy/src}/request.ts` | 0 | 0 |
| `{before/src/codebuddy => after/packages/codebuddy/src}/response.ts` | 0 | 0 |
| `{before/src/codebuddy => after/packages/codebuddy/src}/wire.ts` | 0 | 0 |
| `packages/codebuddy/tsconfig.build.json` | 10 | 0 |
| `packages/codebuddy/tsconfig.json` | 6 | 0 |
| `packages/llm-bridge/package.json` | 42 | 0 |
| `packages/llm-bridge/src/index.ts` | 3 | 0 |
| `packages/llm-bridge/tsconfig.build.json` | 10 | 0 |
| `packages/llm-bridge/tsconfig.json` | 6 | 0 |
| `packages/opencode-zen/package.json` | 40 | 0 |
| `{before/src/opencode => after/packages/opencode-zen/src}/catalog.ts` | 9 | 8 |
| `{before/src/opencode => after/packages/opencode-zen/src}/convert.ts` | 2 | 2 |
| `{before/src/opencode => after/packages/opencode-zen/src}/fingerprint-data.json` | 0 | 0 |
| `{before/src/opencode => after/packages/opencode-zen/src}/fingerprint.ts` | 0 | 0 |
| `{before/src/opencode => after/packages/opencode-zen/src}/index.ts` | 40 | 9 |
| `{before/src/opencode => after/packages/opencode-zen/src}/response.ts` | 0 | 0 |
| `{before/src/opencode => after/packages/opencode-zen/src}/session.ts` | 0 | 0 |
| `{before/src/opencode => after/packages/opencode-zen/src}/user-agent.ts` | 0 | 0 |
| `packages/opencode-zen/tsconfig.build.json` | 10 | 0 |
| `packages/opencode-zen/tsconfig.json` | 6 | 0 |
| `packages/plugin-api/package.json` | 36 | 0 |
| `packages/plugin-api/src/body.ts` | 20 | 0 |
| `packages/plugin-api/src/host.ts` | 46 | 0 |
| `packages/plugin-api/src/index.ts` | 5 | 0 |
| `packages/plugin-api/src/patterns.ts` | 93 | 0 |
| `packages/plugin-api/src/registry.ts` | 156 | 0 |
| `packages/plugin-api/src/types.ts` | 150 | 0 |
| `packages/plugin-api/tsconfig.build.json` | 10 | 0 |
| `packages/plugin-api/tsconfig.json` | 6 | 0 |
| `packages/qoder/package.json` | 40 | 0 |
| `{before/src/qoder => after/packages/qoder/src}/catalog.ts` | 5 | 5 |
| `{before/src/qoder => after/packages/qoder/src}/credentials.ts` | 22 | 0 |
| `{before/src/qoder => after/packages/qoder/src}/fingerprint-data.json` | 0 | 0 |
| `{before/src/qoder => after/packages/qoder/src}/index.ts` | 42 | 9 |
| `{before/src/qoder => after/packages/qoder/src}/queue.ts` | 0 | 0 |
| `{before/src/qoder => after/packages/qoder/src}/request.ts` | 1 | 1 |
| `{before/src/qoder => after/packages/qoder/src}/response.ts` | 1 | 1 |
| `{before/src/qoder => after/packages/qoder/src}/sse.ts` | 0 | 0 |
| `{before/src/qoder => after/packages/qoder/src}/transport.ts` | 0 | 0 |
| `packages/qoder/tsconfig.build.json` | 10 | 0 |
| `packages/qoder/tsconfig.json` | 6 | 0 |
| `packages/zcode/package.json` | 40 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/catalog.ts` | 5 | 5 |
| `{before/src/zcode => after/packages/zcode/src}/client-signing.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/config.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/credential-cipher.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/endpoint-routing.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/fingerprint-data.json` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/index.ts` | 41 | 10 |
| `{before/src/zcode => after/packages/zcode/src}/individual-credentials.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/plans.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/request-context.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/request.ts` | 1 | 1 |
| `{before/src/zcode => after/packages/zcode/src}/response.ts` | 1 | 1 |
| `{before/src/zcode => after/packages/zcode/src}/team-credentials.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/vision-template.json` | 1 | 1 |
| `{before/src/zcode => after/packages/zcode/src}/vision.ts` | 0 | 0 |
| `{before/src/zcode => after/packages/zcode/src}/wire.ts` | 0 | 0 |
| `packages/zcode/tsconfig.build.json` | 10 | 0 |
| `packages/zcode/tsconfig.json` | 6 | 0 |
| `schemas/gateway-config.schema.json` | 10 | 10 |
| `scripts/build-gateway.ts` | 19 | 0 |
| `scripts/build-library.ts` | 47 | 0 |
| `scripts/build-ui.ts` | 4 | 4 |
| `scripts/changelog.ts` | 13 | 3 |
| `scripts/check-boundaries.ts` | 73 | 0 |
| `scripts/pack-check.ts` | 138 | 0 |
| `scripts/prepare-resources.ts` | 9 | 0 |
| `scripts/release-version.ts` | 42 | 0 |
| `scripts/run-tests.ts` | 5 | 0 |
| `scripts/verify-package.ts` | 22 | 0 |
| `test/agy-catalog.test.ts` | 4 | 4 |
| `test/agy-config.test.ts` | 10 | 9 |
| `test/agy-credentials.test.ts` | 2 | 2 |
| `test/agy-gateway.test.ts` | 26 | 15 |
| `test/agy-request.test.ts` | 3 | 3 |
| `test/agy-response.test.ts` | 2 | 2 |
| `test/app-server.test.ts` | 8 | 6 |
| `test/changelog.test.ts` | 11 | 1 |
| `test/codebuddy-catalog.test.ts` | 5 | 5 |
| `test/codebuddy-credentials.test.ts` | 2 | 2 |
| `test/codebuddy-gateway.test.ts` | 24 | 14 |
| `test/codebuddy-request.test.ts` | 3 | 3 |
| `test/codebuddy-response.test.ts` | 4 | 4 |
| `test/codex-ownership.test.ts` | 17 | 3 |
| `test/codex-version.test.ts` | 2 | 2 |
| `test/credentials-store.test.ts` | 5 | 5 |
| `test/default-agent-readiness.test.ts` | 146 | 0 |
| `test/default-install-migration.test.ts` | 234 | 0 |
| `test/default-install-webui-migration.test.ts` | 95 | 0 |
| `test/gateway-model-reload.test.ts` | 11 | 8 |
| `test/gateway-plugin-integration.test.ts` | 181 | 0 |
| `test/gateway.test.ts` | 65 | 24 |
| `test/host-test.ts` | 46 | 0 |
| `test/install-rollback.test.ts` | 4 | 4 |
| `test/instance-regressions.test.ts` | 12 | 12 |
| `test/log-size-field.test.ts` | 6 | 5 |
| `test/manual-codex-config.test.ts` | 5 | 4 |
| `test/model-catalog-dynamic.test.ts` | 13 | 7 |
| `test/model-exclude-gateway.test.ts` | 11 | 7 |
| `test/model-exclude.test.ts` | 15 | 11 |
| `test/model-picker.test.ts` | 2 | 2 |
| `test/model-reload.test.ts` | 6 | 5 |
| `test/model-state.test.ts` | 8 | 6 |
| `test/opencode-zen-catalog.test.ts` | 5 | 5 |
| `test/opencode-zen-convert.test.ts` | 2 | 2 |
| `test/opencode-zen-fingerprint.test.ts` | 3 | 3 |
| `test/opencode-zen-gateway.test.ts` | 34 | 14 |
| `test/opencode-zen-session.test.ts` | 2 | 2 |
| `test/opencode-zen-user-agent.test.ts` | 4 | 4 |
| `test/paths.test.ts` | 4 | 4 |
| `test/plugin-host-context.test.ts` | 140 | 0 |
| `test/plugin-registry.test.ts` | 257 | 0 |
| `test/plugin-routing-fixture.ts` | 33 | 0 |
| `test/qoder-catalog.test.ts` | 3 | 3 |
| `test/qoder-config.test.ts` | 13 | 11 |
| `test/qoder-credentials.test.ts` | 2 | 2 |
| `test/qoder-gateway.test.ts` | 26 | 13 |
| `test/qoder-queue.test.ts` | 5 | 5 |
| `test/qoder-request.test.ts` | 2 | 2 |
| `test/qoder-response.test.ts` | 3 | 3 |
| `test/qoder-transport.test.ts` | 4 | 4 |
| `test/qoder-webui.test.ts` | 7 | 6 |
| `test/realtime.test.ts` | 43 | 40 |
| `test/release-version.test.ts` | 51 | 0 |
| `test/ui-i18n.test.ts` | 9 | 9 |
| `test/upstream-visibility.test.ts` | 2 | 2 |
| `test/webui.test.ts` | 16 | 15 |
| `test/zcode-cache.test.ts` | 2 | 2 |
| `test/zcode-catalog.test.ts` | 3 | 3 |
| `test/zcode-cli.test.ts` | 7 | 7 |
| `test/zcode-config.test.ts` | 14 | 12 |
| `test/zcode-endpoint-routing.test.ts` | 2 | 2 |
| `test/zcode-gateway.test.ts` | 16 | 13 |
| `test/zcode-plans.test.ts` | 2 | 2 |
| `test/zcode-request-context.test.ts` | 4 | 4 |
| `test/zcode-request.test.ts` | 4 | 4 |
| `test/zcode-response.test.ts` | 3 | 3 |
| `test/zcode-signing.test.ts` | 7 | 6 |
| `test/zcode-vision.test.ts` | 2 | 2 |
| `tsconfig.base.json` | 19 | 0 |
| `tsconfig.json` | 8 | 13 |
| `vite.config.ts` | 2 | 2 |

</details>

### 📁 Files Modified
提交前最终验收（2026-10-11）：当前工作树 `bun run check` 完整通过，970 项测试通过、0 失败；八个公开包的隔离打包、严格声明类型、CLI/default、五家目录与 Responses 冒烟检查通过。模型预设现由私有 `packages/models` 提供并内联；覆盖规则仅存于 `apps/gateway/models.json` 且只供网关使用。配置固定字段移除的旧目录兼容已按用户决定排除，安装旧参数明确拒绝；旧挂载地址迁移区分托管、手动、已交还客户端及其他实例归属，实际 `status` 跨实例重放不再改写接管实例的配置和所有权。用户授权提交并创建 feat PR；真实 npm 发布由 PR 合入 main 后的 Deploy 流程执行，创建 PR 本身不等同已发布。

- `apps/gateway/src/gateway.ts`、`gateway-composition.ts`、`model-composition.ts`、`host-services.ts`
- `packages/plugin-api/src/` 及五个 agent 包
- `apps/gateway/src/default-install-migration.ts`、`codex-ownership.ts`、`launchd.ts`、`webui.ts`
- `scripts/`、workspace manifests、`bun.lock`、`nx.json`、CI、Schema、`test/`
- [插件契约](../../plugin-contract.md)、[迁移指引](../../monorepo-migration.md)、[执行计划](../../exec-plans/completed/codex-gateway-monorepo.md)
