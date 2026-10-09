## [2026-10-09 18:21] | Task: agy 调试转储加 debug 配置开关并归入 logs 目录

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> `agy-debug-400.json` 这个是不是应该加一个 debug 的配置来控制写调试信息？写一个执行计划，在 --config 中增加一个 debug on/off 的开关，debug 文件也放到 logs 目录下去。（随后确认方案，开始实施。）

### 🛠 Changes Overview
**Scope:** codex-cliproxy（CLI config 命令、agy 适配器、配置 schema、测试、文档）

**Key Actions:**
- **[配置字段]** `GatewayConfig` 新增 `debug?: boolean`（默认关闭），`schemas/gateway-config.schema.json` 同步声明布尔类型与默认值。
- **[CLI 开关]** `config --debug on|off`：复用 `onOffValue` 解析，加入 `COMMAND_OPTIONS.config` 白名单、`AUDITED_FIELDS` 审计字段与 usage 文本；无参数 `config` 输出报出 `debug` 状态；启用提示带出落盘目录。
- **[agy 落盘门控与迁移]** `src/agy/index.ts` 上游 400 的调试转储改为仅在 `config.debug === true` 时写，路径从 runtimeHome 根目录迁到 `config.logDir || <catalog 同目录>/logs`（与请求日志同一解析规则，抽出共享 `logDir` 常量）。
- **[测试]** agy 三场景（缺省关闭不落盘 / debug 开启落 logs 目录含完整请求体与上游错误 / logDir 未配置时回退默认 logs 且目录不存在可直写）；CLI `config --debug` 持久化、审计（`debug: null -> true`）、不回填 logDir、非法值拒绝及 schema 形状断言。
- **[文档]** README 配置表补 `--debug on|off` 行；Web UI 开关明确推迟并登记 tech-debt。

### 🧠 Design Intent (Why)
调试转储内容是完整请求体（含提示词），无条件落盘既是隐私面也是无界行为；改为显式 opt-in 的独立开关（与 requestLogging 互不依赖）后，默认安全、排查时一条命令开启。文件移入 logs 目录消除 runtimeHome 根目录的杂散文件；保持单文件覆盖写（atomicWrite，0600），`.json` 不匹配请求日志保留正则，天然不被 `--max-request-logs` 裁剪、也不占日志配额。

### 📊 Change Stats
> 本任务未单独提交，工作树同时携带其他在途任务改动，以下为按本任务改动手工统计。

- **Files changed:** 9（另新建计划与本文档）
- **Insertions:** +130（约）
- **Deletions:** -10（约）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/types.ts` | +5 | -0 |
| `schemas/gateway-config.schema.json` | +7 | -0 |
| `src/cli.ts` | +14 | -4 |
| `src/agy/index.ts` | +3 | -2 |
| `test/agy-gateway.test.ts` | +39 | -1 |
| `test/gateway.test.ts` | +60 | -0 |
| `README.md` | +1 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |
| `docs/exec-plans/completed/agy-debug-dump-config-gate.md` | 新建 | - |

### 📁 Files Modified
- `src/types.ts`、`schemas/gateway-config.schema.json`
- `src/cli.ts`、`src/agy/index.ts`
- `test/agy-gateway.test.ts`、`test/gateway.test.ts`
- `README.md`、`docs/exec-plans/tech-debt-tracker.md`
- `docs/exec-plans/completed/agy-debug-dump-config-gate.md`（计划，已归档）

### ✅ 验证
- `bun run check` 全绿：类型检查、750 个测试（含新增 4 个断言场景）、UI 构建与 CLI 打包。
- 行为变化说明：agy 上游 400 不再默认落盘；需排查时执行 `codex-cliproxy config --debug on`，转储出现在日志目录 `agy-debug-400.json`。

### 🔁 修复追加（同日 18:50，目录回退规则统一）

用户复现缺陷：自定义 `catalogPath`、省略 `logDir` 时，`config --debug on` 的提示指向默认运行目录的 logs（`resolvePaths().logDir`），而 agy 调试转储实际写入 catalog 同目录的 logs——提示与实际分叉。根因是同一条回退规则 `config.logDir || dirname(catalogPath)/logs` 在 8 处运行时代码内联重复，而 CLI 侧另用了 `paths.logDir`。

- **[统一规则]** 把 webui.ts 的私有 `requestLogDir` 提升为 `src/request-log.ts` 的共享导出（带注释说明「运行时 sink 与 CLI/UI 提示、回填必须共用」），替换 gateway.ts、zcode/codebuddy/qoder/agy/opencode 各适配器 sink、webui.ts（3 处调用 + editable payload）共 8 处内联实现。
- **[CLI/Web UI 对齐]** `cli.ts` 的 debug 提示、无参数 `config` 输出的 `logDir`、`--log on` 的 `logDir` 回填，以及 `config-update.ts` 中 Web UI patch 的同类回填，全部改用 `requestLogDir(config)`——回填持久化的即是运行时实际目录，自定义 catalogPath 时不再把日志悄悄挪到默认安装目录（`gatewayDefaults` 的安装种子值不受影响：安装时 catalogPath 就在 runtimeHome 内，两规则等值）。
- **[回归测试]** `test/gateway.test.ts` 新增「config 日志目录提示与运行时回退规则一致」：自定义 catalogPath + 省略 logDir 时，无参输出与 `--debug on` 提示均等于 `<catalog 同目录>/logs` 且不等于默认目录，`--log on` 回填持久化同一目录。
- 验证：`bun run check` 全绿（751 个测试）。

### 🔁 第二轮追加（同日 19:40，运行主目录统一 + CODEX_CLIPROXY_HOME）

用户反馈「目录回退不一致是全局问题」：所有目录应默认 `~/.codex-cliproxy-gateway`，可经环境变量重定向（没有就创建），而不是从 catalogPath 等运行时文件位置倒推。落地（执行计划 [runtime-home-unification](../../exec-plans/completed/runtime-home-unification.md)）：

- **[环境变量]** `resolvePaths` 支持 `CODEX_CLIPROXY_HOME`（优先级：显式实例 override > 环境变量 > 默认主目录）；LaunchAgent plist 位置不随环境变量移动，`install` 在设置了该变量时直接拒绝——launchd 进程不继承 shell 变量，从源头防止「配置写到服务读不到的位置」。
- **[目录统一]** `requestLogDir` 缺省回退改为 `resolvePaths().logDir`；agy/codebuddy/qoder/opencode 适配器 `cacheDirectory` 缺省回退改为 `resolvePaths().runtimeHome`；zcode 新增 `cacheDirectory` 依赖（models.json 覆盖与 zcode-catalog.json 同用），全部废除 `path.dirname(config.catalogPath)` 倒推。默认安装行为不变（生产 catalogPath 本就在 runtimeHome 内，两规则等值）；自定义 catalogPath 与 `serve --config` 临时实例改为统一落运行主目录，多实例隔离用环境变量。
- **[测试与文档]** 新增 paths 环境变量优先级、install 防呆测试；重写 config 目录一致性回归（缺省=运行主目录 logs、环境变量重定向提示）、agy 调试转储缺省目录（环境变量钉住）、zcode 请求日志缺省目录；zcode fixture 注入 `cacheDirectory`。schema 补 `logDir` 描述，README 新增「运行主目录与环境变量」小节。
- 验证：`bun run check` 全绿（753 个测试）。

### 🔁 第三轮追加（同日 21:30，实例绑定的服务操作与后台多实例支持）

第二轮验收未过（P1 服务误绑定 + P2×3），用户在 Codex 会话拍板修订方案 A（plist 只在 install/web --daemon 写、上下文贯通、Keychain 一并隔离、plist 必须留在 ~/Library/LaunchAgents），本轮按其执行（[执行计划](../../exec-plans/completed/instance-scoped-service-binding.md)）：

- **[实例身份]** `resolvePaths` 新增 `instanceMarker`（主目录 realpath 哈希 8 位）与 `instanceSuffix`（默认实例空串、零迁移）；环境变量输入规范化（trim、`~` 展开、相对路径直接报错）；`bindInstanceHome` 在 runCli 配置同步**之前**对 `serve --config` 绑定实例主目录，主目录优先级 `--config 目录 > 绑定 > env > 默认`。
- **[服务绑定]** launchd.ts 全部 label 引用参数化（render×2、start/stop/restart/reload/status）；非默认实例 label/plist 文件名加同一哈希后缀，plist 仍留在 `~/Library/LaunchAgents/`（launchd 登录只扫描该目录，放到数据目录会失去自启——修正上一轮提案）；`config`/`restart` 按实例分派（未安装→保存并提示、绝不碰默认服务），`web --restart` 改纯重启不重写 plist。
- **[后台支持]** 删除 install 的环境变量拒绝；install/web --daemon 的 plist 嵌入规范化 `CODEX_CLIPROXY_HOME`（launchd 进程与 CLI 同根）；新增防呆——非默认实例托管 `~/.codex/config.toml` 需 `--manual-codex-config` 或独立 `CODEX_HOME`。
- **[Keychain 隔离]** 服务名 = 历史名 + 实例后缀；非默认实例只查自己槽位，结构上无回退路径。
- **[健康检查防顶包]** healthz 响应头 `x-ccp-instance` + `waitForHealth` 校验：端口被其他实例占用时其健康响应不算本实例启动成功（旧进程无标记兼容放行）。
- **[测试]** 新增/重写 8 个场景：plist 几何与后缀、默认身份零迁移、env 规范化拒绝、绑定优先级与 requestLogDir 贯通、install 托管防呆、config 两分支（A 未安装不碰默认 plist / A 已安装重启的是后缀 plist 且默认 plist 原样）、healthz 标记与跨实例拒绝、Keychain 服务名派生。
- 验证：`bun run check` 全绿（759 个测试）。

### 🔁 第四轮追加（2026-10-09 22:07，五项验收问题修复）

#### 🤖 执行上下文

- **Agent ID**：`codex`
- **Base Model**：`GPT-6（主代理，协作执行按宿主角色配置）`
- **Runtime**：`Codex Desktop`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`feature/opencode-zen`

#### 📥 用户诉求

> 验收发现 Web UI 目录分叉、目录首次创建后实例身份变化、进程绑定残留、健康检查认错实例和客户端目录归属不完整。用户授权：直接修改。

#### 🛠 改动与设计意图

- Web UI 的展示、日志列表、正文和开关回填统一使用本实例路径；异步上游调用及响应身份也绑定请求上下文。
- 路径从最近存在的真实祖先补齐缺失目录；符号链接下多级目录首次创建前后保持相同服务和凭据身份。
- 删除进程级绑定，采用调用级异步路径快照；命令异常、嵌套和并发不串实例，Keychain 存储对象固定创建时的槽位和账号。
- 启动等待、status、网关探测和 UI 探测统一严格核对实例标记，拒绝无标记及其他实例响应；网关标记固定在构造时。
- 安装记录保存客户端目录；托管安装校验并原子声明归属，省略 CODEX_HOME 的管理命令恢复原目录，显式不同目录拒绝。
- 安装失败恢复配置并撤销新声明；托管转手动中断及卸载中断可恢复。客户端恢复阶段完成后，重试只清理本网关，不再修改已交给其他实例的客户端。

#### ✅ 验证

- `bun run check`：790 个测试全部通过，类型检查、UI 构建和 CLI 打包成功。
- 新增实例上下文、稳定身份、日志隔离、归属争用、客户端路径恢复、模拟安装回滚和中断清理回归。
- 独立只读审查发现的归属释放中断窗口已修复并补测，最终复核通过。
- 本轮没有部署或修改本机真实安装；系统调用与凭据操作回归使用模拟执行器及测试临时目录。
- 无标记的旧网关/UI 进程需要更新到新版后重启，不能继续凭 HTTP 200 认定健康。

#### 📊 本轮变更统计

统计从本轮修改前的工作树快照比较当前结果，使用 `git diff --no-index --shortstat` 与 `--numstat`；不包含此前在途任务的改动。

- **Files changed:** 19
- **Insertions:** +1130
- **Deletions:** -169

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | 5 | 0 |
| `docs/exec-plans/completed/instance-scoped-service-binding.md` | 28 | 9 |
| `docs/histories/2026-10/20261009-1821-agy-debug-config-gate.md` | 61 | 0 |
| `src/cli.ts` | 122 | 85 |
| `src/codex-ownership.ts` | 189 | 0 |
| `src/config-update.ts` | 1 | 1 |
| `src/gateway.ts` | 3 | 1 |
| `src/instance-health.ts` | 22 | 0 |
| `src/keychain.ts` | 25 | 18 |
| `src/paths.ts` | 32 | 25 |
| `src/request-log.ts` | 3 | 3 |
| `src/webui.ts` | 25 | 13 |
| `test/codex-ownership.test.ts` | 182 | 0 |
| `test/credentials-store.test.ts` | 49 | 0 |
| `test/gateway.test.ts` | 2 | 2 |
| `test/install-rollback.test.ts` | 2 | 1 |
| `test/instance-regressions.test.ts` | 219 | 0 |
| `test/paths.test.ts` | 68 | 8 |
| `test/webui.test.ts` | 92 | 3 |
