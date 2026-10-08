## [2026-10-08 17:20] | Task: CodeBuddy `--switch` 交互改版（箭头菜单、昵称/邮箱标签、auto 置顶并改名、config 只管开关）

### 🤖 Execution Context
* **Agent ID**: claude-code
* **Base Model**: claude-fable-5-1
* **Runtime**: Claude Code CLI
* **Git User**: hubert <hubert@lejian.com>
* **Branch**: main

### 📥 User Query
> 实跑 `bun src/index.ts codebuddy --switch` 后提出：1) 用箭头选择而不是输入编号；2) 列表里的 id 改成登录邮箱或账号名；3) default 放在第一位；4) default 改名为 auto；5) 选择列表排除 auto 当前命中的那份 `.info`（与 auto 重叠，更推荐 auto 以随客户端切换自动跟随，而不是把当下恰好是默认的文件名写死）；6) `config` 不应加 `--codebuddy-switch`，切换只用专属命令，config 只管开关，默认 auto 即可；7) auto 项文案去掉「follows the most recently refreshed login」，`now:` 改为 `current:`；8) 再调整为账号信息在前、后缀 `(auto, follows the most recently refreshed login)`；9) 地域分隔改为 `/`（`username / region`）。

### 🛠 Changes Overview
**Scope:** src/codebuddy、src/cli.ts、src/config.ts、src/types.ts、src/webui.ts、src/ui、schemas、README、test、docs

**Key Actions:**
- **[凭据层]**: `tokenIssuer` 的 JWT 载荷解码抽成 `tokenClaims` 复用；`CodebuddyCredential` 新增 `accountNickname`/`accountUsername`/`accountEmail`（分别来自 `account.nickname`、JWT `preferred_username`、JWT `email`，不读取 `uin`/`phoneNumber`）；`formatAccountLabel` 改为 `昵称 <邮箱> / 地域`（分隔符 `/`），主标识回退链 nickname → preferred_username → uid → 文件名，email 与主标识相同时不重复。
- **[哨兵改名 default → auto]**: `isCodebuddyAccountName`、锁定判定、fallback 告警文案、schema `pattern`/description、types 注释、`validateCodebuddyConfig` 错误文案同步为 `auto`；`LEGACY_FIELD_MIGRATIONS` 的 `codebuddyRegion` 迁移目标改为 `"auto"`；`migrateLegacyConfig` 读取时把残留的 `codebuddyAccount: "default"` 归一为 `"auto"`（CLI/网关/Web UI 三条读取路径同时生效），`syncGatewayConfigFile` 据 `before` 判定后改写文件并记 `codebuddyAccount (default -> auto)` 审计。
- **[CLI 箭头菜单]**: `promptCodebuddyAccountSelection` 改为 async：新增 `SelectKey`/`SelectKeySource` 与 `openRawKeySource`（raw mode + stdin `data` 事件读键，不用 `fs.readSync`，避免 tty 流非阻塞导致 EAGAIN），↑/↓ 移动、Enter 确认、Esc/q/Ctrl-C/Ctrl-D/EOF 取消，损坏项展示但跳过、到顶/到底不环绕，菜单期间隐藏光标并整块原地重绘，`finally` 恢复光标与终端模式；`auto` 置顶，文案 `<它此刻命中的登录> (auto, follows the most recently refreshed login)`（`resolveCodebuddyAccountFile(dir, "auto")`），该登录不再单独列出；`interactive` 缺省要求 stdin 与 stdout 都是 TTY；移除 `readStdinLine`。
- **[config 只管开关]**: 撤回 `config --codebuddy-switch` 与 `--codebuddy <file.info|auto>` 直选（`--codebuddy` 回到 `on|off`，删除 `codebuddyOptionValue` 与 `accountChanged` 分支，COMMAND_OPTIONS/parseArgs/usage 同步）；`codebuddyCommand` 导出并接受 `CodebuddyAccountSwitchDependencies`，成为账号选择的唯一入口；非交互终端报错且不写配置，不选即 auto（缺省）；无参 `config` 打印缺省值 `auto`。
- **[Web UI]**: 标签函数共用，只读「当前账号」标签同步显示昵称/邮箱；i18n 中英文案、`api.ts`/`webui.ts` 注释更新，明确昵称/邮箱为账号标识而非凭据、token 仍绝不进响应。
- **[文档]**: README 的 `--codebuddy on|off` 与 `codebuddy --switch` 说明改为箭头菜单、auto 语义（置顶、显示命中登录、重叠登录不单列、不选即 auto）、标签格式、`default` 兼容说明，去掉 `config` 直选示例；执行计划决策记录追加五条（改名与迁移、标签内容与红线放宽、箭头菜单、auto 命中文件不单列、config 只管开关）。
- **[测试]**: credentials（`isCodebuddyAccountName` 形状、标签回退链与 email、`auto` 解析、标签与网关同源）、gateway（共享 `scriptedKeys` 按键源：`codebuddyCommand` 走完整写盘/state/审计管线、Enter/↓/↑/取消/无关键、broken 跳过与不环绕、auto 置顶与去重断言、光标隐藏恢复、非交互报错不写配置、`config --codebuddy auto|<file>` 与 `--codebuddy-switch` 被拒）、webui（昵称/邮箱标签、token 不泄漏）、zcode-config（schema 拒绝 `default`、region → auto、`default → auto` 文件改写与审计幂等）、catalog/app-server 夹具同步。

### 🧠 Design Intent (Why)
- `auto` 比 `default` 更准确地表达「跟随最近刷新的登录」，并与旧 `codebuddyRegion: auto` 呼应。本机 `config.json` 已在上一任务写入 `"default"`，若只改名不迁移，`validateCodebuddyConfig` 会拒绝启动网关，所以读取归一必须覆盖 CLI、网关、Web UI 三条路径，文件级改写与审计交给命令前置同步。
- auto 当前命中的登录若仍单独可选，用户会把「此刻恰好是默认」的文件名写死，失去随客户端切换自动跟随的能力；把它折进 auto 项、账号信息在前并标注 auto 语义，既去重也让用户看清 auto 等价于谁。
- `config` 只管开关、切换只在 `codebuddy --switch`：职责单一，避免 `--codebuddy` 同时承担开关与账号两种语义；缺省即 auto，因此不需要非交互直选兜底。
- 按键改走 stdin 事件而不是同步读：tty 流一旦创建 fd 0 即为非阻塞，`fs.readSync(0)` 会 EAGAIN；raw mode 下 Ctrl-C 不再触发 SIGINT，由菜单按取消处理，保证 `finally` 一定恢复终端。
- 昵称/邮箱放宽进 UI 只读标签由用户确认并写入计划；标签来源仍只在 `formatAccountLabel` 一处，token 排除断言保留，`uin`/`phoneNumber` 不读取。

### 📊 Change Stats
> 数据来自 `git diff HEAD`（工作区对 HEAD）。本次与 17:00 的 codebuddy-account-switch 任务均未提交，以下为两次任务的**累计**统计；本次实际触及的文件见「Files Modified」。

- **Files changed:** 19（另新增 docs：本记录）
- **Insertions:** +1104
- **Deletions:** -249

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +254 | -51 |
| `test/codebuddy-credentials.test.ts` | +241 | -17 |
| `src/codebuddy/credentials.ts` | +232 | -54 |
| `test/codebuddy-gateway.test.ts` | +131 | -11 |
| `test/webui.test.ts` | +79 | -8 |
| `test/zcode-config.test.ts` | +54 | -0 |
| `README.md` | +26 | -10 |
| `src/types.ts` | +12 | -2 |
| `src/webui.ts` | +12 | -6 |
| `src/config.ts` | +11 | -0 |
| `src/ui/ConfigPage.tsx` | +8 | -22 |
| `src/ui/api.ts` | +8 | -3 |
| `src/codebuddy/index.ts` | +8 | -7 |
| `schemas/gateway-config.schema.json` | +7 | -2 |
| `src/ui/styles.css` | +7 | -37 |
| `src/ui/i18n.tsx` | +6 | -4 |
| `test/codebuddy-catalog.test.ts` | +3 | -0 |
| `src/config-update.ts` | +3 | -13 |
| `test/app-server.test.ts` | +2 | -2 |

### 📁 Files Modified
- `src/codebuddy/credentials.ts`、`src/codebuddy/index.ts`
- `src/cli.ts`、`src/config.ts`、`src/types.ts`、`src/webui.ts`
- `src/ui/api.ts`、`src/ui/i18n.tsx`
- `schemas/gateway-config.schema.json`
- `test/{codebuddy-credentials,codebuddy-gateway,codebuddy-catalog,webui,zcode-config,app-server}.test.ts`
- `README.md`、`docs/exec-plans/completed/codebuddy-account-switch.md`

### ✅ 验证
- `bun run check`：typecheck + 666 个 node:test 用例 + UI/CLI 构建全部通过。
- pty 实跑（`script -q /dev/null bun src/index.ts codebuddy --switch`，依次输入 ↓ 与 Esc；在 config 收口与文案改 `current:` 之前执行，菜单逻辑此后未变）：`auto` 置顶并显示当前命中登录，↓ 原地重绘移动光标，Esc 取消后退出码 0、未写入账号选择。
- 本机残留的 `codebuddyAccount: "default"` 已由真实网关进程重启时的命令前置同步改写为 `"auto"`（`gateway.log` 审计 `codebuddyAccount (default -> auto)`），网关正常启动，验证了迁移路径在网关侧生效。
