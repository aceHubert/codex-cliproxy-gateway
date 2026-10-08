# CodeBuddy 账号选择：--switch 直接锁定 .info 文件

状态：已完成（2026-10-08 实施完毕，`bun run check` 全量通过）
创建日期：2026-10-08

## 目标

把 CodeBuddy/WorkBuddy 的凭据选择从「按 region 猜」改成「直接锁定认证目录下的具体 `.info` 文件名」。新增交互式 `--switch`：列出认证目录内所有 `.info` 的 `account id (region)` 供选择，并提供一个 **default** 选项（等价现状 region 的 `auto`：全扫取最近刷新的登录）。配置里保存的就是 `.info` **文件名**，网关按文件名判断——存在就只读那一个文件（不再全扫）；**不存在不改配置，运行期直接 fallback 到 default（auto）选出的凭据**。

Web UI 取消 region 切换控件，改为**只读展示当前 `account id (region)`**。该标签不落配置、由 UI 侧按需**实时解析**得出（default 或文件缺失时同样按 auto 规则解析真实命中账号）。`codebuddyRegion` 不再作为选择依据，**标记为过时（deprecated）保留字段**以兼容存量读取，写入一律归一到 `codebuddyAccount`。全程除 CLI `--switch` 外，任何进程都不写 `config.json`。

## 范围

- 包含：
  - 交互式账号选择命令（`config --codebuddy-switch`，并封装等价的顶层 `codebuddy --switch`，二者共享同一函数）。
  - 新增 `codebuddyAccount`（值为 `.info` **文件名**或哨兵 `"default"`）接管凭据选择；`codebuddyRegion` 保留但标 deprecated，停止读写为选择依据。
  - 凭据缓存按文件名直读：`codebuddyAccount` 为文件名时 `existsSync` → 命中直接 `readCredential` 单文件（跳过全扫）；缺失 → **运行期 fallback 到 default（auto）选凭据，绝不改写配置**。`default`/未设置 → 维持现状全扫 + 最近刷新。
  - 只读标签解析：新增受限函数按 `codebuddyAccount`（文件名/default/缺失）解析出 `account id (region)`，**只提取非敏感 `accountUid` 与 profile 地域，绝不返回 token**；供 Web UI 展示与 CLI 列表复用。
  - 与模型 slug 的 region 硬路由协调：锁定文件的 profile 决定其 region/product；请求 slug 地域与账号地域不匹配时按现有「该地域没有凭据」语义报错，不跨地域回退（保留防错账号/SSRF 边界）。
  - 存量 `codebuddyRegion` 的一次性归一迁移（读到旧值即视为 `codebuddyAccount = "default"`，见风险与决策）。
  - Web UI：`src/ui/{api,i18n,ConfigPage}.tsx`、`src/webui.ts` 去掉 region 三按钮，改为只读渲染实时解析的 `account id (region)`；token 绝不进 UI 响应/配置/日志。
  - 测试：`--switch` 列举/选择/写盘（账号字段的唯一交互写盘入口）、文件名直读命中、文件缺失运行期 fallback（不写配置）、标签解析（含 default/缺失/无凭据）、地域不匹配报错、UI 只读标签渲染、deprecated region 迁移。
- 不包含：
  - 除 CLI `--switch` 之外任何进程（网关/Web UI）写 `config.json`。
  - Web UI 的账号切换/选择控件：UI 只读、不可点、不触发写盘；一切选择只在 CLI。
  - 让 token 进入 UI 进程、配置、API 响应或日志（标签解析只回 `accountUid`+region）。
  - 凭据刷新、同 profile 多文件去重策略改动（沿用「同 profile 取最近刷新」）。
  - ZCode/Qoder/agy 的凭据选择（本次仅 CodeBuddy）。

## 背景

- 相关代码路径：
  - `src/codebuddy/credentials.ts`：`CodebuddyCredential`（含 `profile`、`accountUid`、`domain`）、`profileRegion()`、`defaultAuthDirectory()`、`createCodebuddyCredentialCache(authDirectory, { preferredRegion })`、`readCredential(file)`、`scanSync()` 全扫、`regionFor()`/`activeRegion()`/`select()` 选取链、`forProduct(product, region)`。
  - `src/codebuddy/index.ts`：`createCodebuddyAdapter` 按 `config.codebuddyRegion` 传 `preferredRegion`；`validateCodebuddyConfig` 校验 region 枚举。
  - `src/codebuddy/catalog.ts`：四前缀各自 `region`+`product`，是请求路由的硬地域来源。
  - 配置读写面：`src/types.ts` `CodebuddyRegion` 与 `GatewayConfig.codebuddyRegion`；`src/config-update.ts` 对 `codebuddyRegion` 的解析/校验/`change()`（`applyWebUiConfigPatch`）；`schemas/gateway-config.schema.json` 的 `codebuddyRegion`；`src/cli.ts` `config` 的 `--codebuddy-region`、无参打印、`AUDITED_FIELDS`、失效缓存触发；`src/config.ts` `LEGACY_FIELD_MIGRATIONS`/`migrateLegacyConfig`。
  - Web UI 探测现状：`src/webui.ts` 用 `codebuddyCredentialsPresent(defaultAuthDirectory())` 做**存在性探测**（不读内容）——本计划的标签解析是其受限扩展。
  - 交互先例：`src/cli.ts` `confirmInstallOverwrite()`/`promptModifyCodexConfig()` 单行 stdin 读取（EOF/读失败安全默认）。
  - 命令分发：`src/cli.ts` `COMMAND_OPTIONS` 白名单、`runCli` 的 `switch (command)`、`configCommand` 的写盘 + `recordConfigAudit` + `restartGatewayOnce` 管线。
- 已知约束：
  - 凭据文件在 `defaultAuthDirectory()`（内含各产品独立 `<authId>.info`）；**网关与 UI 均只读，除 CLI `--switch` 外无任何写配置路径**。
  - UI/日志红线：token/refreshToken 绝不进 UI 进程响应、配置、日志；`accountUid`/`profile 地域` 为非敏感标识，可作为展示标签来源。

## 方案

### 1. 配置模型：新增 `codebuddyAccount`，`codebuddyRegion` 标 deprecated

- `GatewayConfig.codebuddyAccount?: string`：值为认证目录下 `.info` 文件名（如 `<authId>.info`）= 锁定该账号；值为 `"default"` 或缺省 = 沿用 auto（全扫取最近刷新）。
- `codebuddyRegion`：**不删除**。`types.ts` 保留 `CodebuddyRegion` 与字段并加 `@deprecated 使用 codebuddyAccount`；schema 保留条目、`description` 前置「(deprecated)」；停止在 `config` 命令行暴露 `--codebuddy-region`，无参打印不再输出 region 而输出 `codebuddyAccount`。
- 不引入 `codebuddyAccountLabel` 配置字段：展示标签实时解析，绝不落盘。
- `validateCodebuddyConfig`：`codebuddyAccount` 若设置必须是字符串；不再据 region 校验或分派。
- 存量迁移：`LEGACY_FIELD_MIGRATIONS` 或加载路径把旧 `codebuddyRegion`（任意值）归一视为 `codebuddyAccount = "default"`（auto 语义等价）；下次 CLI 写盘时旧字段丢弃，不长期保留兼容分支。

### 2. 凭据缓存：按文件名直读，缺失运行期 fallback（不写配置）

`createCodebuddyCredentialCache` 依赖从 `preferredRegion` 改为 `preferredAccount`（`.info` 文件名 / `"default"` / undefined）：

- `preferredAccount` 为具体文件名：`fs.existsSync(join(dir, name))` 命中 → 直接 `readCredential` 该文件得凭据（跳过 `scanSync`）；缺失 → 记一条进程日志 warning，并**回落到 default 全扫 + auto 选取**（不触碰配置）。
- `preferredAccount` 为 default/undefined：维持现状 `scanSync()` + `regionFor()`/`activeRegion()`/`select()`。
- 地域安全边界：`forProduct(product, region)` 中实际命中凭据的 `profileRegion` 与请求 slug `region` 不一致 → 抛「没有可用的 {地域} 凭据」，不跨地域兜底；default 模式同 profile 多文件仍取最近刷新。

### 3. 只读标签解析：default 与具体文件走同一流程

**default 不是特殊分支**：它等价于「一个由 auto 规则解析出来的固定文件名」。解析分两步，UI 与 CLI 共用，展示流程与选了具体文件时完全一致：

1. `resolveCodebuddyAccountFile(authDirectory, account): string | undefined`
   - `account` 为文件名且 `existsSync` → 原样返回该文件名；
   - `account` 为文件名但缺失 / `"default"` / 未设置 → 按 default（auto）规则全扫 + `activeRegion()` 选出实际命中的那一个 `.info` 文件名（与方案 2 的凭据选取同源，保证展示等于网关真实命中）；
   - 目录不存在或无有效凭据 → `undefined`。
2. `readCredential(join(dir, file))` 取该文件的 `accountUid` 与 `profileRegion`，拼成标签 `` `${accountUid || basename} (${region})` ``；上一步为 `undefined` 时标签为 `undefined`（UI 显示「未选择」占位）。

- 复用范围：`--switch` 列表项、Web UI 只读展示、`config` 无参打印（可选）都走这一条路径；标签只含非敏感 `accountUid`+region，token 绝不返回。
- 关键一致性：网关凭据选取与本节文件名解析必须同一实现（同一 auto 规则），否则 UI 可能显示与实跑不同的账号。

### 4. `--switch` 交互命令（账号选择的唯一交互写盘入口）

新增 `switchCodebuddyAccount(paths, config, deps?)`，`config --codebuddy-switch` 与顶层 `codebuddy --switch` 共享：

1. 读认证目录全部 `.info`，逐个 `readCredential`（损坏/未知域名跳过并标注）。
2. 打印 `[i] <account id> (<region>)`；末尾 `[0] default (auto: 最近刷新的登录)`。
3. 复用单行 stdin 解析编号（越界/EOF/非数字 → 安全取消，不改配置）。
4. 选中 → `config.codebuddyAccount = <文件名>`；选 default → `config.codebuddyAccount = "default"`。
5. 走 `configCommand` 后半程：组合校验 → `writeGatewayConfig` → 同步 state.config → `recordConfigAudit` → `invalidateModelsCache` → `restartGatewayOnce`。
6. 非 TTY：报错提示改用 `config --codebuddy <文件名|default>` 直接指定（可选兜底写盘路径）。

### 5. Web UI 只读展示（实时解析，不写配置）

- `src/webui.ts`：`/ui/api/config` 的响应新增派生只读字段（如 `codebuddyAccountLabel`），值来自方案 3 的两步解析（`resolveCodebuddyAccountFile` → `readCredential`），入参 `defaultAuthDirectory()` 与 `config.codebuddyAccount`；不回写配置。UI 进程只取非敏感的 `accountUid`+profile 地域并立即丢弃其余字段，token 绝不返回、绝不进 UI 响应。default 与锁定文件共用同一流程，UI 无需区分两种情况。
- `src/ui/api.ts`：去掉 `codebuddyRegion`，新增只读 `codebuddyAccountLabel`（不可提交）；`config` 保存请求体不含该字段。
- `src/ui/ConfigPage.tsx`：原 region 三按钮块替换为只读文本（如「当前账号：<label>」），无 `onClick`、不进 `changes`；`codebuddy` 开关本身保持可切换。
- `src/ui/i18n.tsx`：移除 region 按钮文案，新增只读标签文案（中/英）。

> 红线边界（已定）：UI 进程读取 `.info` 内容仅用于解析非敏感 `accountUid`+region（此前只做存在性探测），解析后立即丢弃其余字段，token 绝不返回、绝不进 UI 响应/配置/日志。因 default 与具体文件同一流程，不存在「default 只能显示泛化文案」的降级分支。

## 风险

- 风险：UI 显示 `account id (region)` 需读 `.info` 内容，可能触碰「凭据不进 UI 进程」红线。
  缓解：解析函数仅提取非敏感 `accountUid`+profile 地域并立即丢弃其余字段，token 绝不返回、绝不进 UI 响应/配置/日志；default 复用同一流程，无需泛化文案兜底。
- 风险：UI 标签解析与网关凭据选取若各写一套 auto 规则，展示可能与实跑账号不一致。
  缓解：两步解析的第一步直接复用凭据缓存的文件名选取逻辑（同一 `activeRegion`/`select` 实现），不另写规则；测试覆盖两者结果一致。
- 风险：文件缺失时不改配置，配置与实际命中凭据可能不一致（锁定的账号消失，实跑 default）。
  缓解：运行期 fallback + warning 可观测；UI 标签走方案 3 两步解析（与凭据选取同源），始终显示真实命中账号，不显示过期的锁定名。
- 风险：移除 region 后同时服务 cn+intl 多套登录的能力回退。
  缓解：default（auto）完全保留现状地域分派；仅锁定单文件时收敛为单账号，可切回 default。
- 风险：存量 `codebuddyRegion: cn|intl` 迁移后丢固定地域偏好。
  缓解：统一迁到 default（等价 auto），用户在 `--switch` 重新显式锁定；说明写入历史记录与本计划。

## 验证方式

- 命令：`bun run check`（typecheck + `bun test` + build）。
- 重点回归：`test/codebuddy-credentials.test.ts`（`preferredRegion` → `preferredAccount` + 缺失运行期 fallback 且不写配置）、`test/codebuddy-gateway.test.ts`、`test/codebuddy-catalog.test.ts`、config/schema 相关测试；新增文件名解析/标签两步解析与 `--switch` 单测，并断言标签解析与网关选取命中同一文件。
- 手工：认证目录放两个同地域 `.info` → `config --codebuddy-switch` 选一个 → `config.json` 的 `codebuddyAccount` 为文件名、UI 只读显示 `account id (region)`；删除该文件重启网关 → 配置不变、运行期 fallback default、UI 标签切到 default 命中的真实账号；选 default 后确认 UI 显示解析出的 `account id (region)`。
- 观测：`gateway.log` 出现文件缺失 fallback warning；`/v1/models` 与请求地域随 `codebuddyAccount`/default 正确变化；确认无 token 出现在任何 UI/API/日志输出。

## 进度记录

- [x] 红线边界已定：UI 进程读 `.info` 仅解析非敏感 `accountUid`+region，token 不外泄；default 与具体文件同一流程。
- [x] 配置层：新增 `codebuddyAccount`，`codebuddyRegion` 标 deprecated（types/config-update/schema/validate/cli 打印/AUDITED），补存量迁移。
- [x] 凭据缓存：`preferredAccount` 文件名直读 + existsSync + 缺失运行期 fallback（不写配置）+ 地域硬校验。
- [x] 标签两步解析（文件名解析 → `readCredential` 拼标签；覆盖 default/缺失/无凭据）。
- [x] `--switch` 交互函数与命令接入（`config --codebuddy-switch` + 顶层 `codebuddy --switch`）。
- [x] Web UI：移除 region 三按钮，改只读实时标签（api/i18n/ConfigPage/webui）。
- [x] 测试改写与新增用例。
- [x] 更新 `docs/`（region 说明）与 README；生成历史记录。

### 实施备注（2026-10-08）

- `codebuddyOptionValue`：`--codebuddy` 扩展为 `on|off|<file.info>|default` 三态（开关 / 直选账号），作为 `--codebuddy-switch` 的非交互兜底；非法值报错提示可选形状。
- 凭据缓存锁定路径跳过构造期初始全扫（`reads === 1` 断言覆盖「存在即只读那一个文件」）；fallback 告警经 `onAccountFallback` 注入，缺省 `console.warn`（launchd 下随 stderr 落 gateway.log），文件恢复存在后重新布防。
- 锁定账号产品不一致时沿用同账号 token 只换端点（对齐 auto 的同地域产品回退语义）；地域不一致仍按「该地域没有凭据」硬报错。
- `syncGatewayConfigFile` 的旧键清理自动覆盖 `codebuddyRegion`（LEGACY_FIELD_MIGRATIONS 机制），非法旧值（如 `us`）不迁移、交由 schema 软告警。
- Web UI 补丁白名单移除 `codebuddyRegion`：旧 UI 提交该字段按 `Unsupported field` 拒绝（UI 由后端同版本分发，不存在长期混跑窗口）；`codebuddyAccount` 从未进入白名单。

### 复审修订（2026-10-08，实施后 review）

- 锁定模式下 `schedule()`（fs.watch 事件的去抖回调）直接跳过 `applyScan`：锁定命中的选取路径直读文件、缺失 fallback 也在选取前同步重扫，watch 触发的提前全扫是无效读取（计划「不再全扫」的完整落地）。
- 锁定文件**存在但持续损坏**时：网关维持直读失败即报错（不静默换账号），`codebuddyAccountLabel` 不再吞成「未选择」，改为返回 `文件名（凭据无法读取）` 诊断标签——与网关行为一致，不假装命中别的账号；auto 路径解析后随即读失败的竞态同样落入该标签，下一次解析自愈。

## 决策记录

- 2026-10-08：去掉 `--use`（不暴露任意路径/SSRF 面），只保留 `--switch` 从认证目录列举可选账号。
- 2026-10-08：`codebuddyRegion` 不删除、标 deprecated；写入统一归一到 `codebuddyAccount`，读取保留一次性迁移。
- 2026-10-08：`codebuddyAccount` 存储值确定为 `.info` **文件名**（唯一、可做存在性/fallback 判据），显示用 `account id (region)`。
- 2026-10-08：凭据缓存改「文件名直读」——存在即只读该文件、不全扫；**缺失运行期 fallback default，绝不改写配置**。
- 2026-10-08：新增 **default** 选项等价 region `auto`（最近刷新登录），作为「不锁定」与「锁定文件缺失后的 fallback」统一落点。
- 2026-10-08：**网关与 Web UI 进程都不写 `config.json`**（修订：初版写作「任何进程都不写配置」措辞过严——`config` 命令本身必然写盘，`syncGatewayConfigFile` 还会在命令前置检测到旧 `codebuddyRegion` 键时重写配置；红线实际约束的是网关与 UI 进程，写入只发生在 CLI 命令：`--switch`/`--codebuddy` 直选、config 选项写盘与命令前置的旧键迁移）；取消 `codebuddyAccountLabel` 配置字段，展示标签改由两步只读解析（先按 auto 规则解析出目标 `.info` 文件名，再 `readCredential` 拼 `account id (region)`），default 与具体文件同一流程，UI 始终显示真实命中账号。
- 2026-10-08：Web UI 取消切换控件，改只读展示 `account id (region)`；token 绝不进 UI，标签仅取非敏感 `accountUid`+region。
- 2026-10-08（实跑反馈后的交互改版）：哨兵 `default` **改名 `auto`**（与旧 `codebuddyRegion: auto` 语义呼应）。本机 config.json 已写入过 `"default"`，直接改名会被 `validateCodebuddyConfig` 拒绝启动，因此 `migrateLegacyConfig` 读取时把 `"default"` 归一为 `"auto"`（CLI/网关/Web UI 三条读取路径同时生效），`syncGatewayConfigFile` 再把文件改写并记 `codebuddyAccount (default -> auto)` 审计；schema 与 `isCodebuddyAccountName` 不再接受 `"default"`。
- 2026-10-08：标签从 `account id (region)` 改为 **`昵称 <邮箱> (地域)`**：主标识取 `account.nickname`，缺失退 JWT `preferred_username` → `accountUid` → 文件名，JWT 有 `email` 时追加 `<email>`；CLI 列表与 Web UI 只读标签共用同一 `formatAccountLabel`。红线放宽说明：昵称/邮箱是账号标识而非凭据，token 仍绝不进响应；不读取 `uin`、`phoneNumber`。
- 2026-10-08：`--switch` 改为**箭头菜单**（raw mode + stdin `data` 事件，不用 `fs.readSync`，避免 tty 流非阻塞导致 EAGAIN）：↑/↓ 移动、Enter 确认，Esc/q/Ctrl-C/EOF 取消；损坏项展示但跳过；到顶/到底不环绕；菜单期间隐藏光标、整块原地重绘，`finally` 恢复终端。`auto` 置顶并标出它此刻命中的登录。
- 2026-10-08：**auto 当前命中的 `.info` 不再单独可选**：选它与选 auto 等价，而 auto 还能随 CodeBuddy 客户端切换账号自动跟随，因此更推荐 auto，避免把当下恰好是默认的文件名写死。
- 2026-10-08：**`config` 只管开关，账号切换只在 `codebuddy --switch`**：撤回 `config --codebuddy-switch` 与 `--codebuddy <file.info|auto>` 直选（`--codebuddy` 回到 `on|off`），删除 `codebuddyOptionValue`；非交互终端不提供兜底，不选即 auto（缺省）。`codebuddyCommand` 导出并接受 `CodebuddyAccountSwitchDependencies`，测试据此注入按键源走完整写盘管线。
- 2026-10-08：标签分隔改为 `/`，最终格式 **`昵称 <邮箱> / 地域`**；菜单 auto 项为 `<该标签> (auto, follows the most recently refreshed login)`，账号信息在前。
