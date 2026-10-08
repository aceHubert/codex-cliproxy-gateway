## [2026-10-08 17:00] | Task: 实现 CodeBuddy 账号选择（--switch 锁定 .info 文件）

### 🤖 Execution Context
* **Agent ID**: zcode
* **Base Model**: GLM-5.3
* **Runtime**: ZCode CLI
* **Git User**: hubert <hubert@lejian.com>
* **Branch**: main

### 📥 User Query
> docs/exec-plans/active/codebuddy-account-switch.md 实施

按执行计划落地：CodeBuddy/WorkBuddy 凭据选择从「按 region 猜」改为「直接锁定认证目录下的具体 `.info` 文件名」，新增交互式 `codebuddy --switch`，Web UI 改只读展示实时解析的 `account id (region)`，`codebuddyRegion` 标 deprecated 并做一次性迁移。

### 🛠 Changes Overview
**Scope:** src/codebuddy、src（cli/config/webui/types/config-update）、src/ui、schemas、test、docs

**Key Actions:**
- **[凭据缓存]**: `createCodebuddyCredentialCache` 依赖从 `preferredRegion` 改为 `preferredAccount`；锁定文件存在即只读该文件（跳过全扫，含构造期初始扫描），缺失时记一次 fallback 告警并回落 default（auto），绝不改写配置；地域不匹配仍硬报错，产品不一致沿用同账号 token 换端点。
- **[标签两步解析]**: 新增 `resolveCodebuddyAccountFile` / `codebuddyAccountLabel` / `listCodebuddyAccounts`；auto 规则与网关凭据选取共享同一 `scanAuthDirectory`/`freshestCredential` 实现，保证 UI 标签等于网关真实命中；只提取非敏感 `accountUid`+地域，token 绝不返回。
- **[CLI]**: 新增顶层 `codebuddy --switch` 与 `config --codebuddy-switch`（共享 `promptCodebuddyAccountSelection`，EOF/越界/损坏文件安全取消）；`--codebuddy` 扩展为 `on|off|<file.info>|default` 直选；写盘收尾抽取为 `writeConfigAndRestart` 复用（校验→写盘→state 同步→审计→失效目录缓存→重启）；无参打印与 AUDITED_FIELDS 改用 `codebuddyAccount`。
- **[配置层]**: `GatewayConfig.codebuddyAccount` 新增；`codebuddyRegion` 保留但标 deprecated（types 注释 + schema description 前缀）；`LEGACY_FIELD_MIGRATIONS` 把旧 region（合法枚举值）一次性归一为 `codebuddyAccount="default"`，非法旧值交 schema 软告警；Web UI 补丁白名单移除 `codebuddyRegion`。
- **[Web UI]**: `/ui/api/config` 的 `editable.codebuddyRegion` 移除，`detected.codebuddyAccountLabel` 新增（后端实时两步解析，default 与锁定文件同流程，缺失回落真实命中账号）；前端移除 region 三按钮，改为只读 `account-readonly` 标签（无 onClick、不进 changes、不写盘），i18n 中英文案同步。
- **[测试]**: credentials（锁定直读/fallback/地域硬校验/标签解析/同源一致性/列表）、gateway（validate 账号形状、CLI 写盘与审计、prompt 交互）、webui（标签随配置实时解析、token 不泄漏、UI 提交账号字段被拒）、app-server（目录缓存失效触发）、zcode-config（region→account 迁移与 schema 形状）。

### 🧠 Design Intent (Why)
- region 只能表达「国内/国际」粒度，多账号登录时无法指定具体身份；`.info` 文件名是认证目录内的唯一标识，可直接做存在性与 fallback 判据。
- 「网关与 UI 进程不写配置」红线保持：配置写入只发生在 CLI 命令（`--switch`/`--codebuddy` 直选、config 选项写盘与命令前置的旧键迁移），网关与 Web UI 进程对 `config.json` 只读；锁定文件缺失只做运行期 fallback + warning，配置与实际命中不一致时以实跑为准。
- UI 标签不落配置、实时解析，且与网关凭据选取同一实现，避免「显示 A 实跑 B」；default 不是特殊分支，统一为「auto 规则解析出的固定文件名」，无泛化文案降级。
- 旧 `codebuddyRegion: cn|intl` 的地域偏好迁移后失效：统一落到 default（等价 auto），需要锁定的用户在 `--switch` 重新显式选择，取舍已写入执行计划风险节。

### 📊 Change Stats
> 数据来自 `git diff HEAD`（工作区对 HEAD，任务未提交前统计）。

- **Files changed:** 18（另新增 docs 2 处：执行计划归档 + 本记录）
- **Insertions:** +927
- **Deletions:** -244

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +215 | -52 |
| `src/codebuddy/credentials.ts` | +206 | -51 |
| `test/codebuddy-credentials.test.ts` | +214 | -15 |
| `test/codebuddy-gateway.test.ts` | +79 | -10 |
| `test/webui.test.ts` | +79 | -8 |
| `README.md` | +29 | -10 |
| `src/ui/ConfigPage.tsx` | +8 | -22 |
| `src/ui/styles.css` | +7 | -37 |
| `test/zcode-config.test.ts` | +27 | -0 |
| `src/webui.ts` | +11 | -6 |
| `src/types.ts` | +11 | -2 |
| `src/codebuddy/index.ts` | +8 | -7 |
| `schemas/gateway-config.schema.json` | +7 | -2 |
| `src/ui/api.ts` | +7 | -3 |
| `src/ui/i18n.tsx` | +6 | -4 |
| `src/config.ts` | +8 | -0 |
| `src/config-update.ts` | +3 | -13 |
| `test/app-server.test.ts` | +2 | -2 |

### 📁 Files Modified
- `src/codebuddy/credentials.ts`、`src/codebuddy/index.ts`
- `src/cli.ts`、`src/config.ts`、`src/config-update.ts`、`src/types.ts`、`src/webui.ts`
- `src/ui/{api.ts,ConfigPage.tsx,i18n.tsx,styles.css}`
- `schemas/gateway-config.schema.json`
- `test/{codebuddy-credentials,codebuddy-gateway,webui,app-server,zcode-config}.test.ts`
- `README.md`、`docs/exec-plans/completed/codebuddy-account-switch.md`

### ✅ 验证
- `bun run check`（typecheck + 664 个 node:test 用例 + UI/CLI 构建）全部通过（含实施后 review 修订：锁定模式跳过 watch 触发的全扫、锁定文件持续损坏时标签返回诊断文案）。
