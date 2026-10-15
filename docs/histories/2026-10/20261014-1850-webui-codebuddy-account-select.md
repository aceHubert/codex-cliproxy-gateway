## [2026-10-14 18:50] | Task: Web UI CodeBuddy 账号改为下拉切换

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 设计一下把 Web UI 中的 CodeBuddy 账号改成选择框可以切换；先写成执行计划，然后开始实施。

### 🛠 Changes Overview
**Scope:** apps/gateway（webui 后端、config-update 白名单、UI 配置页）、schemas、test

**Key Actions:**
- **[GET 账号数据]**: `/ui/api/config` 下发 `editable.codebuddyAccount`（归一 `"auto"`）与 `detected.codebuddyAccounts`（`file/label/broken/autoResolved`，auto 命中项由 `resolveCodebuddyAccountFile(dir,"auto")` 标记；只含昵称/邮箱/地域标签，token 绝不进响应）。
- **[POST 可写白名单]**: `codebuddyAccount` 加入 `WebUiConfigPatch`/`SUPPORTED_PATCH_FIELDS`；形状校验复用 `isCodebuddyAccountName`（只接受 `"auto"` 或 `.info` 纯文件名），脏比较按 `config.codebuddyAccount ?? "auto"` 归一，`"auto"` 显式落盘与 CLI `--switch` 一致；不做存在性强校验（缺失由既有运行期回退 auto 兜底）。
- **[保存管线]**: 该字段自动纳入 structural（重启）；modelsChanged 谓词增加 `codebuddyAccount`（重建模型目录 + 失效 `models_cache.json`，对应 CLI `invalidateModels: true`）；审计自动记录。
- **[前端下拉]**: 只读 `account-readonly` span 替换为 `<select>`：auto 项折叠当前命中登录（继承 CLI 菜单 2026-10-08 决策）、损坏登录 disabled、锁定文件缺失时追加占位 option 防值悬空；FormState/genericDirty/save 构建、`api.ts` 类型（含旧后端缺省兼容）、i18n 中英文案（新增 3 条、删除无消费者的 `codebuddyAccountNone`）、`styles.css` 样式替换。
- **[Schema]**: `codebuddyAccount.description` 切换入口补「Web UI 配置页下拉」，无结构变化。
- **[测试]**: `webui.test.ts` 翻转「UI 提交 codebuddyAccount 被拒」为接受（断言写盘/state 同步/审计/调度重启/模型缓存失效/切回 auto/幂等无操作），GET 用例补账号列表与 autoResolved/broken 断言及 token 不泄露断言，非法值用例改为形状校验（路径注入/非字符串 → 400）。

### 🧠 Design Intent (Why)
CLI `codebuddy --switch` 落地时确立了「账号切换只在 CLI、UI 只读」的边界（见 `docs/exec-plans/completed/codebuddy-account-switch.md`）。本次按用户要求推翻该决策：Web UI 已有成熟的受审计写配置管线（布尔开关/日志/排除模型均走 `POST /ui/api/config` 的校验+审计+原子写），把 `codebuddyAccount` 纳入同一白名单不新增写路径；两个入口共用同一形状校验与「缺失回退 auto」运行期语义，CLI 行为零改动。下拉选项语义与 CLI 箭头菜单保持一致（auto 折叠当前命中、broken 不可选），避免双入口行为分叉；唯一细化是当前锁定的值即使被折叠也保持可选，防止 select 值悬空。完整决策留痕见 `docs/exec-plans/completed/webui-codebuddy-account-select.md`。

### 📊 Change Stats
> 数据来自 `git diff`（工作区未提交改动，仅统计本任务文件；schema 文件的既有改动属前一任务未计入）。

- **Files changed:** 12（另 schema 1 行、执行计划 1 份）
- **Insertions:** +312
- **Deletions:** -61

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/config-update.ts` | +19 | -1 |
| `apps/gateway/src/model-reload.ts` | +5 | -1 |
| `apps/gateway/src/webui.ts` | +26 | -8 |
| `apps/gateway/src/ui/ConfigPage.tsx` | +54 | -6 |
| `apps/gateway/src/ui/api.ts` | +18 | -4 |
| `apps/gateway/src/ui/i18n/locales/zh/config.ts` | +4 | -2 |
| `apps/gateway/src/ui/i18n/locales/en/config.ts` | +4 | -2 |
| `apps/gateway/src/ui/styles.css` | +5 | -16 |
| `packages/codebuddy/src/credentials.ts` | +34 | -5 |
| `test/webui.test.ts` | +90 | -16 |
| `test/model-reload.test.ts` | +15 | -0 |
| `test/codebuddy-credentials.test.ts` | +38 | -0 |

### 📁 Files Modified
- `apps/gateway/src/webui.ts`
- `apps/gateway/src/config-update.ts`
- `apps/gateway/src/model-reload.ts`
- `apps/gateway/src/ui/ConfigPage.tsx`
- `apps/gateway/src/ui/api.ts`
- `apps/gateway/src/ui/i18n/locales/zh/config.ts`
- `apps/gateway/src/ui/i18n/locales/en/config.ts`
- `apps/gateway/src/ui/styles.css`
- `packages/codebuddy/src/credentials.ts`
- `apps/gateway/schemas/gateway-config.schema.json`
- `test/webui.test.ts`
- `test/model-reload.test.ts`
- `test/codebuddy-credentials.test.ts`
- `docs/exec-plans/completed/webui-codebuddy-account-select.md`（由 active/ 归档）

### 追加（2026-10-15，真机实测暴露的两个问题与 UX 微调）

**问题一：保存整单回滚（存量 bug）。** 真机点保存返回 400「无法确认网关健康状态」且配置被回滚。根因：`model-reload.ts` 的 `isConnectionRefused` 只认 Node 的 `ECONNREFUSED`，Bun fetch（JSC WebFetch）连接被拒抛的错误码是 `ConnectionRefused`（消息 "Unable to connect..."、无 cause）；结构性保存会 kickstart 重启网关，重启窗口期（杀旧进程、新进程未绑定端口）的健康探测必然落进该形状 → 被误判硬失败 → 整单回滚。测试全部注入 fetch，从未覆盖 Bun 原生形状。修复：识别 `ConnectionRefused`，使其按「网关暂未运行」可重试处理（重启分支 15 秒轮询直至新网关就绪）；`test/model-reload.test.ts` 补 Bun 形状回归用例。真机验证：保存 200（约 2 秒完成重启+重载周期）。

**问题二：官方 CLI 保留登录状态导致账号重复（另一会话已分析，本会话实施）。** 本机 `codebuddy` CLI 的 logout/刷新会把旧登录改名为带时间戳的 `.info` 备份保留，同一账号积累多份文件（实测 7 个文件仅 3 个账号），且规范文件会被新登录覆盖/删除（用户锁定的 cn 规范文件即被删除）。修复（按分析会话已定语义）：`listCodebuddyAccounts` 按 `(uid, profile)` 去重，保留 `lastRefreshTime` 最新（平手比 mtime）的代表文件；同 uid 跨地域/跨产品是合法不同登录不合并；uid 缺失与损坏文件不参与归并、原样保留。只改插件一处，CLI `--switch` 菜单与 Web UI 下拉同时修复，前端零改动。`test/codebuddy-credentials.test.ts` 补去重用例。真机验证：7 文件收敛为 3 账号。

**问题三：文件名锁定的结构性缺陷——CLI 轮换文件后锁失效（claude code 会话 9854c991 复审发现，2026-10-15 重构修复）。** 复审确认两点：锁定文件被去重归但仍在磁盘时运行期直读生效（占位文案「已回退 auto」与事实相反）；更深一层，官方 CLI 每次 logout/刷新都轮换文件名，锁文件名终会漂移。按用户决策重构为 **uid 锁定**，二轮复审后再定为 **`profile:uid` 选择值**（与 `(uid, profile)` 去重键对齐；用户澄清 cn/intl 账号体系隔离、同 uid 跨地域不会发生，但 cli/work 产品共享账号 token、同 uid 双行仍可能经由产品维度出现，且 profile 作用域可钉住地域不随最近刷新漂移）：`codebuddyAccount` 值域为 `"auto"` | `profile:uid`（钉住该地域/产品最新登录）| 裸 uid（跟随该账号最新）| 历史 `.info` 文件名（读取时换算为该文件的 `profile:uid`，无 uid 登录保持文件直读）；凭据缓存新增 byUid（跟随最新）与 byAccount（profile 作用域）索引；`canonicalCodebuddyAccountValue` 让 GET/前端/CLI 菜单的取值与运行期同源（历史文件名/裸 uid 规范为当前命中的 `profile:uid`，用户无需纠正）；webui POST 按「值在当前登录列表」拒绝列表外取值。顺带把「最新」判据三处统一（lastRefreshTime 主、mtime 决胜），消除复审指出的 autoResolved/去重 tie-break 分叉。曾短暂落地的过渡方案 `codebuddyAccountFileExists` 按用户要求整体撤销。schema pattern 放宽为 `^(auto|[^/\\]+)$`。测试：`codebuddy-credentials` 重写锁定用例为 uid 语义、新增 canonical/uid 重扫/同账号跨地域（钉住 vs 跟随）用例；`codebuddy-gateway` 的 `--switch` 断言 profile 作用域值并给重测试显式 30s 超时；`webui` 新增规范化与列表外拒绝（含裸 uid）用例。真机验证：config 留存历史文件名，GET 规范化为 `cn-cli:<uid>`，下拉直接选中；锁定文件再次被 CLI 轮换删除后，占位与 auto 回落按预期工作；网关健康。

**UX 微调（用户反馈）。** auto 项文案缩短为「自动」并放在账号标签之后（`CnUser / cn · 自动`，账号优先可见）；auto 选项恢复置顶；auto 项账号标签改用 `autoResolved` 命中登录（此前误用当前配置实际命中标签，锁定状态下显示错账号）；描述文案去掉 CLI 命令提示。

**遗留说明：** 锁定值仍是文件名快照——CLI 后续刷新同一账号会写新文件，锁定文件的 token 最终会过期（届时运行期回退 auto + 告警，UI 占位提示可重选最新快照）。uid 级稳定锁定在 `docs/exec-plans/` 分析中已识别为可选后续项，本次未做。
