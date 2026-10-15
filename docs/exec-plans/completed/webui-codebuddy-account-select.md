# Web UI CodeBuddy 账号下拉切换（选择框）

状态：已完成（2026-10-14 实施完毕，`bun run check` 992 用例全量通过）
创建日期：2026-10-14

## 目标

把 Web UI 配置页 CodeBuddy/WorkBuddy 块的只读账号标签改为**下拉选择框**：列出认证目录内全部 `.info` 登录，选中即写 `codebuddyAccount` 配置并走既有「校验 → 写盘 → state 同步 → 审计 → 重启」保存管线，语义与 CLI `codebuddy --switch` 完全一致——选 `auto` 跟随最近刷新的登录；选具体 `.info` 文件名锁定该账号（文件缺失时运行期回退 auto，不改配置）。

本计划**显式推翻 2026-10-08 的「账号切换只在 CLI、UI 只读」产品决策**（见 `completed/codebuddy-account-switch.md` 决策记录）。所有后端原语（`listCodebuddyAccounts`、`resolveCodebuddyAccountFile`、`isCodebuddyAccountName`、`codebuddyAccount` 字段与校验）在 CLI 切换落地时已备齐，本次只打通 Web UI 的展示与写入通道。

## 范围

- 包含：
  - `GET /ui/api/config` 下发 `editable.codebuddyAccount`（归一后的 `"auto"` 或文件名）与 `detected.codebuddyAccounts`（`file/label/broken/autoResolved`，仅非敏感标签）。
  - `POST /ui/api/config` 可写白名单加入 `codebuddyAccount`：形状校验（`isCodebuddyAccountName`）、脏比较按归一值、`"auto"` 显式落盘（与 CLI 一致）。
  - 保存管线把该字段纳入 structural（触发重启）与 modelsChanged（重建模型目录 + 失效 `models_cache.json`）。
  - 前端 `ConfigPage.tsx` 的只读 span 替换为 `<select>`（auto 折叠当前命中登录、broken 不可选、悬空值占位），`api.ts` 类型、i18n 中英文案、`styles.css` 清理。
  - `gateway-config.schema.json` 的 `codebuddyAccount` description 补充 Web UI 入口（无结构变化）。
  - `test/webui.test.ts` 翻转「UI 提交被拒」用例并新增 GET/POST 覆盖。
- 不包含：
  - 凭据的登录/登出/刷新（网关仍只读 `.info`，登录在官方桌面端/CLI 完成）。
  - CLI `codebuddy --switch` 行为改动（保留，两个入口写同一字段、同一条校验语义）。
  - keychain / credentials.json 任何变化（CodeBuddy token 从不经这两处）。
  - 其他 agent（zcode/qoder/agy/opencode-zen）的账号切换 UI。
  - 自动跟随/定时检测账号变化的新机制（沿用每次请求重扫 `.info` 的现状）。

## 背景

- 相关文档：
  - `docs/exec-plans/completed/codebuddy-account-switch.md`：CLI 切换与「UI 只读」决策的出处；本计划推翻其 2026-10-08 的 UI 只读决策，其余语义（auto 折叠、broken 不可选、缺失回退）全部继承。
  - `AGENTS.md` 红线：UI 改动后须 `bun run build:ui`；配置字段写入路径变更须同步 schema 与测试。
- 相关代码路径：
  - 只读展示现状：`apps/gateway/src/ui/ConfigPage.tsx:515-519`（`account-readonly` span 与「切换只在 CLI」注释）、`apps/gateway/src/ui/api.ts:68-72,98-99`（类型与注释）、`apps/gateway/src/webui.ts:406-484`（`configResponse`，L414 已解析 `codebuddyAuthDir`，L416-420 实例上下文解析标签）。
  - 写入白名单：`apps/gateway/src/config-update.ts:73-101`（`WebUiConfigPatch` + `SUPPORTED_PATCH_FIELDS`）、`applyWebUiConfigPatch`（L395 起，布尔字段模式 L419-423）。
  - 保存管线：`apps/gateway/src/webui.ts:682-759`（structural L725、modelsChanged L726-728、invalidateModelsCache L746）。
  - 插件原语：`packages/codebuddy/src/credentials.ts` —— `listCodebuddyAccounts`（L394-410，`[{file,label,broken}]`）、`resolveCodebuddyAccountFile`（L329-343）、`isCodebuddyAccountName`（L94-97）；子路径导出 `@agent-proxy/codebuddy/credentials`（`cli.ts:55-59` 已这样导入）。
  - CLI 先例：`apps/gateway/src/cli.ts:1837-1898`（箭头菜单：auto 置顶折叠当前命中、broken 跳过）、`codebuddyCommand`（L2096-2111，写 `codebuddyAccount` → `writeConfigAndRestart` + `invalidateModels: true`）。
  - 下拉控件先例：`ConfigPage.tsx:448-455`（日志单位 `<select className="input-text">`）。
  - Schema：`apps/gateway/schemas/gateway-config.schema.json:137-141`（`codebuddyAccount`，pattern `^(auto|[^/\\]+\.info)$`，已存在无需改结构）。
- 已知约束：
  - `/ui/api/*` 既有 ui-token + Host/Origin 白名单门禁不变；token 绝不进响应（账号列表与既有 `codebuddyAccountLabel` 同一敏感级别：昵称/邮箱/地域）。
  - Web UI 写配置已存在成熟管线（布尔开关、日志、排除模型均走 `POST /ui/api/config` 的校验+审计+原子写）；本次只是把 `codebuddyAccount` 纳入同一白名单，不新建写路径。
  - 凭据目录按实例解析（`providerDeps?.codebuddyAuthDir ?? defaultAuthDirectory(paths.home)`），与标签解析同源。

## 方案

### 1. GET `/ui/api/config`（`webui.ts` `configResponse()`）

- `editable.codebuddyAccount: live.codebuddyAccount ?? "auto"`——归一后下发，供 select 绑定与前端脏比较；未设置与 `"auto"` 在前端视为同值，不产生变更。
- `detected.codebuddyAccounts: Array<{ file, label, broken, autoResolved }>`：
  - `listCodebuddyAccounts(codebuddyAuthDir)` 取列表（直接传参，无需实例上下文）；
  - `resolveCodebuddyAccountFile(codebuddyAuthDir, "auto")` 得到 auto 当前命中的文件名，命中项标 `autoResolved: true`（供前端折叠进 auto 选项，对齐 CLI 菜单决策）；
  - 只含文件名与展示标签，token 绝不进响应（沿用 `codebuddyAccountLabel` 的提取边界）。
- 保留 `detected.codebuddyAccountLabel`（auto 项文案与「未命中」提示仍需要）。
- 更新 L454-458 注释中「账号切换只在 CLI，UI 不提供也不接受该字段的写入」的过时表述。

### 2. POST 可写字段（`config-update.ts`）

- `WebUiConfigPatch` 与 `SUPPORTED_PATCH_FIELDS` 加入 `codebuddyAccount`；同步更新 L73-76 注释。
- `applyWebUiConfigPatch` 新增分支（紧随 `codebuddy` 布尔分支）：
  - `typeof patch.codebuddyAccount !== "string"` → 报错并说明合法形状；
  - `!isCodebuddyAccountName(value)`（从 `@agent-proxy/codebuddy/credentials` 导入）→ 报错（拒绝路径注入与任意字符串）；
  - 脏比较 `(config.codebuddyAccount ?? "auto") !== value` 才记 `change()`——语义相同不写盘（未设置 + 提交 auto 是无操作）；
  - 写值：`config.codebuddyAccount = value`（选 auto 显式落 `"auto"`，与 CLI `--switch` 一致）。
- 尾部组合校验 `validateCodebuddyConfig` 已在既有流程统一执行，无需新增。
- **不做存在性强校验**（与 CLI 写盘管线一致，只校验形状）：POST 与桌面端登录态存在竞态，选中的文件随后缺失由既有「运行期回退 auto + 告警一次」机制兜底，不锁死用户。

### 3. 保存管线（`webui.ts` POST，L725-748）

- structural（L725）：`codebuddyAccount` 非 `excludedModels` 字段，自动纳入 → markPendingRestart + 重启，与 CLI `--switch` 的重启语义一致。
- modelsChanged（L726-728）谓词增加 `change.field === "codebuddyAccount"`：切换账号可能改变本地适配器可用模型（地域/产品不同），触发重建 UI 模型目录 + 失效 `models_cache.json`（对应 CLI `invalidateModels: true`）。
- 审计随 `applied` 字段自动记录（`webui config` 命令名），无额外改动。

### 4. 前端（`apps/gateway/src/ui/`）

- `api.ts`：
  - `UiConfig.editable.codebuddyAccount: string`；
  - `UiConfig.detected.codebuddyAccounts: Array<{ file: string; label: string; broken: boolean; autoResolved: boolean }>`（兼容旧后端：缺省 `[]`，写法同 `qoderSources` 的 L209）；
  - `UiConfigChanges.codebuddyAccount?: string`；
  - 更新 L68-72、L98-99 的「只读/不在此列」注释。
- `ConfigPage.tsx`：
  - `FormState` 加 `codebuddyAccount: string`；`loadConfig` 归一缺省 `"auto"`；`genericDirty`（L180-191）与 `save()` 的 changes 构建（L266-293）加该字段比较。
  - L515-519 的只读 span 替换为 `<select className="input-text">`（仿 L448-455）：
    - 首项 `auto`：文案 = `t("config:codebuddyAccountAuto")` + 有命中标签时追加 `· <codebuddyAccountLabel>`；
    - 其后列出 `autoResolved !== true` 的登录（value = `.info` 文件名）——**auto 当前命中的登录折叠进 auto 项不单独列出**，继承 CLI 菜单 2026-10-08 决策（选它等价于 auto，而 auto 还能随客户端切换自动跟随，避免把当下恰好默认的文件名写死）；
    - `broken` 项渲染但 `disabled`（对应 CLI「展示但跳过」）；
    - **悬空值兜底**：当前 `form.codebuddyAccount` 不在选项集中（锁定文件已缺失、或恰为被折叠的 auto 命中项）时，追加一个占位 option（文案 `t("config:codebuddyAccountMissingFile", { file })`），保证 select 值不悬空、用户能切走；
    - `disabled` 沿用 `excludedDisabled`（saving/restarting/confirm 阶段）。
  - 删除 L515-516 过时注释。
- i18n（`ui/i18n/locales/{zh,en}/config.ts`）：
  - 改写 `descCodebuddyAccount`：说明 auto（跟随最近刷新）/锁定（固定该登录，缺失自动回退）语义，CLI `--switch` 仍可用；
  - 新增 `codebuddyAccountAuto`（「自动（跟随最近刷新的登录）」/"Auto (follows the most recently refreshed login)"）、`codebuddyAccountBroken`（「（不可用）」/" (unusable)"）、`codebuddyAccountMissingFile`（「{{file}}（文件缺失，运行期已回退 auto）」/"{{file}} (file missing; runtime falls back to auto)"）。
- `styles.css`：`.account-readonly`（L451）仅此一处使用，随替换删除。

### 5. Schema 与文档

- `gateway-config.schema.json` 的 `codebuddyAccount.description`：切换入口从「codebuddy --switch」改为「Web UI 配置页下拉或 codebuddy --switch」。无结构/校验变化（字段、pattern、default 均不动）。
- 实施完成后按规范写 `docs/histories/2026-10/` 历史记录（含 diff 统计），本计划移至 `completed/`。

## 风险

- 风险：账号列表进入 UI 响应，扩大凭据目录信息的暴露面。
  缓解：列表只含文件名与 `昵称 <邮箱> / 地域` 标签，与已上线的 `codebuddyAccountLabel` 同一敏感级别与提取边界（不读 token/refreshToken/uin/手机号）；仍在 ui-token + Host/Origin 门禁之后；测试断言响应不含 token。
- 风险：UI 与 CLI 双写入口可能语义漂移。
  缓解：两入口写同一 `codebuddyAccount` 字段、共用 `isCodebuddyAccountName`/`validateCodebuddyConfig` 校验与「缺失回退 auto」运行期语义；CLI 代码零改动，测试各自覆盖。
- 风险：POST 时选中的文件与桌面端登录态竞态（保存后文件被删/损坏）。
  缓解：既有「锁定文件缺失 → 运行期回退 auto + 告警一次、不改配置」机制兜底；GET 的悬空值占位 option 让用户下次打开页面能看清并切走。
- 风险：旧前端配新后端（或反之）的升级窗口。
  缓解：新前端对 `editable.codebuddyAccount`（缺省 `"auto"`）与 `detected.codebuddyAccounts`（缺省 `[]`）做缺省兼容，写法同 `qoderSources`；UI 由后端同版本分发，窗口极短。
- 风险：`codebuddyAccount` 纳入 modelsChanged 后，切账号触发目录重建失败会把整次保存回滚。
  缓解：沿用现有 `modelSaveRollback` 事务（恢复配置并重启回原状态），错误文案带修复指引；与 `excludedModels` 保存失败同路径，非新增风险。

## 验证方式

- 命令：`bun run build:ui`（UI 改动后必须）；`bun run check`（构建 + typecheck + 全部测试）。
- 重点回归：`test/webui.test.ts`（GET 标签实时解析既有用例不动；「UI 提交被拒」用例翻转为接受并断言写盘/state/审计/重启/缓存失效；新增非法值 `../evil.info`、非字符串 → 400）；`test/codebuddy-gateway.test.ts`（CLI `--switch` 用例不动）。
- 手工检查：认证目录放两个 `.info` → UI 下拉列出（auto 项含当前命中标签、另一登录可选）→ 选另一登录保存 → `config.json` 的 `codebuddyAccount` 变为该文件名、审计出现 `webui config` 条目、网关重启、标签切换；选回 auto → 显式落 `"auto"`；删除锁定文件后刷新页面 → 占位 option 显示「文件缺失」、标签回落 auto 命中。
- 观测检查：`/ui/api/config` 响应与 `gateway.log` 均无 token/refreshToken；切账号后 `models_cache.json` 的 `fetched_at` 被重置。

## 进度记录

- [x] 调研与方案收敛（确认全部后端原语已存在，本计划成文）。
- [x] 后端 GET：`editable.codebuddyAccount` + `detected.codebuddyAccounts`（含 autoResolved 标记）。
- [x] 后端 POST：白名单 + 形状校验 + 归一脏比较 + 保存管线（structural/modelsChanged）。
- [x] 前端：api.ts 类型、ConfigPage select（auto 折叠/broken 禁用/悬空占位）、i18n、styles 清理。
- [x] 测试：翻转拒绝用例、新增 GET/POST 覆盖。
- [x] `bun run build:ui` + `bun run check` 全量通过（992 pass / 0 fail）。
- [x] schema description 更新、历史记录、本计划移至 completed/。

### 实施备注（2026-10-14）

- auto 折叠的细化：**当前锁定的值即使被折叠（恰为 auto 命中项）也保持可选**（`codebuddyAccountOptions` 过滤条件 `!autoResolved || file === 当前值`），否则该状态下 select 值悬空；悬空占位 option 因此只出现在「文件真正缺失」的场景，文案准确。
- 归一脏比较同时守卫写值：`(config.codebuddyAccount ?? "auto") !== value` 不成立时**连赋值也跳过**，避免「无变更却把 `"auto"` 显式写进文件、且无审计条目」的静默改写。
- i18n：`codebuddyAccountNone`（「未选择」）随只读 span 移除后无消费者，两个语言包一并删除。
- 测试新增 POST 用例以 `scheduleRestart`/`modelDeps` 注入观测调用序（`gateway → reload → update`），并断言 `models_cache.json` 的 `fetched_at` 被重置为哨兵值、切回 auto 显式落 `"auto"`、重复提交 auto 幂等无操作。

### 真机实测修订（2026-10-15 追加）

- **保存整单回滚的存量 bug**：`model-reload.ts` `isConnectionRefused` 只认 `ECONNREFUSED`，不识别 Bun fetch 的 `ConnectionRefused` 错误码；结构性保存 kickstart 重启网关后的健康探测落在重启窗口期（杀旧进程、新进程未绑定端口）即被误判硬失败并回滚整单（真机表现：点保存返回 400「无法确认网关健康状态」且配置回滚，前端红色横幅在页顶易被错过）。补识别后按「网关暂未运行」可重试处理（重启分支 15s 轮询直至新网关就绪），真机保存恢复 200（约 2s 完成重启+重载周期）。
- **账号列表按 (uid, profile) 去重**：真机发现官方 `codebuddy` CLI 的 logout/刷新会把旧登录改名为带时间戳的 `.info` 备份保留，同一账号积累多份文件（实测 7 个文件仅 3 个账号），规范文件还会被新登录覆盖/删除（用户锁定的 cn 规范文件即被删除）。`listCodebuddyAccounts` 改为按 `(uid, profile)` 去重，只保留 `lastRefreshTime` 最新（平手比 mtime）的代表文件；同 uid 跨地域/跨产品是合法不同登录不合并；uid 缺失与损坏文件不参与归并、原样保留。只改插件一处，CLI `--switch` 菜单与 Web UI 下拉同时修复，前端零改动。去重语义来自 sess_e53a612c 会话的前置分析。
- **锁定文件被归但仍在磁盘：运行期直读生效，不回退 auto**（2026-10-15 复审修正，随后升级为 uid 锁定）：去重只影响列表展示，运行期锁定路径按 `existsSync` 直读文件。先以 `codebuddyAccountFileExists` 区分占位文案的过渡方案落地后，按用户决策**重构为 uid 锁定**（见下条与决策记录），过渡方案整体撤销。

### uid 锁定重构（2026-10-15，用户拍板；同日复审后值域定为 profile 作用域）

复审确认「锁定旧快照」是文件名锁定的结构性缺陷后，按用户方案重构：**config 存账号 uid**（uid 不随 CLI 刷新轮换文件而变），网关与 Web UI 行为同源。第二轮复审指出同 uid 多行（同账号跨地域/跨产品）时选择值会撞车，最终值域定为 **`profile:uid`**（如 `cn-cli:<uid>`）——与 `(uid, profile)` 去重键严格对齐。用户澄清 cn/intl 账号体系隔离、同 uid 跨地域不会发生；cli/work 两产品共享同一账号 token，同 uid 双行仍可能经由产品维度出现，profile 作用域值同时钉住地域/产品——

- `codebuddyAccount` 值域：`"auto"` | `profile:uid`（钉住该地域/产品下的最新登录）| 裸 uid（跟随该账号最近刷新的登录）| 历史 `.info` 文件名（读取时换算为 `该文件的 profile:uid`，无 uid 的旧客户端登录保持文件级直读）。schema pattern 放宽为 `^(auto|[^/\\]+)$`（schema 层不再区分哨兵；`"default"` 仍由读取归一改写）。
- 凭据缓存（`createCodebuddyCredentialCache`）：`scanAuthDirectory` 新增 `byUid`/`fileByUid`（裸 uid 跟随最新）与 `byAccount`/`fileByAccount`（profile 作用域取该组合最新）索引；CLI 换文件后自动跟随；账号/地域不存在告警一次回退 auto。原先「锁定跳过全扫/直读单文件」的优化随语义移除（目录小、扫描廉价）。
- 「最新」判据三处统一（`isFresherCredential`：lastRefreshTime 为主、平手比 mtime）：auto 选取、账号索引、账号列表去重同一规则——顺带消除了复审发现的 autoResolved/去重 tie-break 分叉。
- 展示与提交同源：`canonicalCodebuddyAccountValue`（GET `editable.codebuddyAccount`）把历史文件名/裸 uid 值规范为当前命中的 `profile:uid` 下发——被列表归并的旧快照直接替换，用户无需纠正；`listCodebuddyAccounts` 条目携带 `value`（profile:uid，无 uid 登录为文件名）作为选择值；CLI `--switch` 菜单与 Web UI 下拉的选项值均为 `value`（同 uid 双行值唯一）；webui POST 按「值必须在当前登录列表（或 auto）」拒绝列表外取值，不静默写成死值。
- 真机验证：config 留存历史文件名值（不强制改写），GET 规范化为 `cn-cli:<uid>`，下拉直接选中该账号；锁定文件再次被 CLI 轮换删除后，占位「该登录已不存在」与 auto 回落均按预期工作；网关健康。

## 决策记录

- 2026-10-14：**推翻 2026-10-08「账号切换只在 CLI、UI 只读展示」决策**，`codebuddyAccount` 进入 Web UI 可写白名单。依据：Web UI 如今已有成熟的写配置管线（布尔开关/日志/排除模型均走 `POST /ui/api/config` 的校验+审计+原子写），当年「UI 不写配置」的红线实际已演化为「写入必须经该受审计管线」；账号切换走同一管线不新增写路径。CLI `--switch` 保留不动。
- 2026-10-14：下拉沿用 CLI 菜单的选项语义——auto 项折叠当前命中登录（不单独列出）、broken 展示但不可选，与 2026-10-08 箭头菜单决策保持一致，避免 UI 与 CLI 两个入口行为分叉。
- 2026-10-14：POST 只做形状校验（`isCodebuddyAccountName`），不校验文件存在性——与 CLI 写盘管线对齐；存在性竞态由既有「缺失运行期回退 auto + 告警」机制兜底，且 GET 侧悬空值占位 option 保证可切走。
- 2026-10-14：`"auto"` 显式落盘（未设置 ↔ auto 的归一只用于脏比较，不清洗存量配置），与 CLI `--switch` 选 auto 的落盘行为一致。
- 2026-10-14：`codebuddyAccount` 纳入 modelsChanged（重建目录 + 失效缓存）：切账号可能改变本地适配器可用模型，对齐 CLI `invalidateModels: true`；比 CLI 多做的目录重建复用 `excludedModels` 保存的既有事务与回滚。
- 2026-10-15：Bun fetch 连接拒绝（`ConnectionRefused`）按「网关暂未运行」处理而非硬失败——重启窗口期属预期，测试注入的 fetch 从未覆盖 Bun 原生错误形状。
- 2026-10-15：账号列表按 `(uid, profile)` 去重而非裸 uid（同账号跨地域/跨产品是合法不同登录）；「最新」以 `lastRefreshTime` 为主、mtime 决胜；锁定语义维持文件名不变，uid 级锁定为后续可选项。
- 2026-10-15（复审修正）：锁定文件被去重归但仍在磁盘时，运行期按 `existsSync` 直读该文件、**不回退 auto**——去重只作用于列表展示。
- 2026-10-15（最终方案，用户拍板）：**config 存账号 uid**，网关按「去重扫描中该 uid 的最新登录」选取、不存在回退 auto；Web UI 与 CLI 菜单的选项值同为 uid，展示经 `canonicalCodebuddyAccountValue` 与运行期同源（历史文件名值换算为 uid）。过渡方案 `codebuddyAccountFileExists`（向用户暴露新旧快照之别）整体撤销——用户不需要知道文件轮换的存在。「最新」判据三处统一为 lastRefreshTime 为主、mtime 决胜，消除 autoResolved 与列表去重的 tie-break 分叉。
- 2026-10-15（二轮复审修正）：选择值定为 **`profile:uid`**（与 `(uid, profile)` 去重键对齐）：同 uid 多行时值唯一，且地域/产品可钉住（`cn-cli:<uid>` 锁定即服务 cn 地域，不随最近刷新漂移）；裸 uid 保留为「跟随该账号最新登录」的语义，历史文件名值换算为该文件的 `profile:uid`。用户澄清 cn/intl 账号体系隔离、同 uid 跨地域不会发生——同 uid 双行只可能经由 cli/work 产品维度出现，profile 作用域值对此依然必要。
