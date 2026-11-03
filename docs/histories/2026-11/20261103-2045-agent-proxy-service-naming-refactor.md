# [2026-11-03 20:45] | Task: 重构服务命名 codex-cliproxy-gateway → agent-proxy

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `refactor/agent-proxy-naming`（基于 `fix/zcode-startplan-catalog` 的 f1cae1d，独立 worktree）

### 📥 User Query
> 现在,要修改的是 codex-cliproxy-gateway，这个名字已经替换成 agent-proxy 了，所以代码中的需要重构掉。创建 worktree 进行重构。

### 🛠 Changes Overview
**Scope:** apps/gateway（launchd/paths/cli/codex-ownership/keychain/gateway）、packages/plugin-api、packages/opencode-zen、test/

**Key Actions:**
- **[launchd 服务命名]**: `LAUNCHD_LABEL`/`WEBUI_LAUNCHD_LABEL` 改为 `agent-proxy-gateway`/`agent-proxy-webui`，plist 文件名同步（paths.ts）；新增 `adoptLegacyLaunchAgents`（纯改名收养，幂等、不触碰已加载任务）与 `removeLegacyLaunchAgents`（卸载回收旧 label 任务与旧 plist）。
- **[install/uninstall 接入]**: 收养发生在两个确认门（默认迁移确认、原地更新确认）之后——拒绝安装零改动；失败恢复改用 `plistServiceLabel` 读取 plist 真实 Label 拉回服务（收养后旧 plist 内是旧 label）。uninstall 额外清理旧命名任务与 plist。
- **[旧 label 任务回收]**: 收养只改名不卸载，旧 label 任务仍按旧路径注册在 launchd 中——`installLaunchAgent` 在提交点额外按 `legacyLabelForLabel` 推导的旧 label bootout（按新路径 bootout 找不到被改名的注册），start/reload 的 kickstart 改按 plist 内真实 Label 执行，避免新旧两个 KeepAlive 服务并存抢占网关端口。
- **[review 修复（agy @ t1r 独立审查后）]**: ① `prepareManagedWebUiMigration` 的探测/bootout/kickstart 全部改按 plist 真实 Label（迁移对象是旧 Label plist 时，按新名探测误判未加载、按新名 kickstart 必失败），reload 补按 Label bootout 回收旧路径注册；② `startLaunchAgent` 的加载判定与 `stopLaunchAgent` 的回收同样按 plist 真实 Label，`status` 探测兼顾新旧 label——覆盖「已收养、未重装完成」窗口；③ `readOwnerAny` 双文件并存时校验归属一致，`adoptOwnerFile` 增加 `acceptableLegacyOwner` 参数放行同源转交（新名指新目录+旧名指旧默认目录）并只对真冲突报错；④ keychain 注释/测试标题对齐「默认实例卸载双槽位删除」语义并补非默认实例删除不动旧槽断言；⑤ 补 `resolveLegacyServiceCodexPaths` 旧文件名分支测试与 webui 迁移的 Label 目标断言。审查中「回滚按路径 bootout 漏卸载新服务」的推断经实验证伪（bootout 按路径走注册表，不重读磁盘内容），未采纳但 reload 已按双路 bootout 加固。
- **[Keychain 槽位]**: 服务名改为 `agent-proxy-gateway`；默认实例读取回退旧命名槽位（读到即用、不回写），写只落新槽位，卸载时默认实例双槽位删除；非默认实例（含后缀）绝不回退。
- **[归属声明]**: `.codex-cliproxy-owner.json` → `.agent-proxy-owner.json`；读取回退旧名，`claimCodexHome`/`migrateCodexOwnership` 写前收养（改名或同归属去重、冲突报错），`releaseCodexHome` 双名释放；所有权扫描正则认双名 plist；`resolveLegacyServiceCodexPaths` 在收养前按旧文件名回退读取。
- **[HTTP 头与种子]**: 响应头 `x-codex-cliproxy-gateway` → `x-agent-proxy`（gateway.ts、plugin-api/registry.ts，与既有 `x-agent-proxy-websocket` 风格对齐）；opencode-zen 的 session id 派生与项目指纹种子前缀改为 `agent-proxy:`（均为确定性派生、无金值测试依赖）。
- **[测试]**: 新行为断言改新名；迁移类测试保留旧名固件（正是收养/回退路径的覆盖）；新增 `test/launchd-migration.test.ts`（收养幂等/内容不变、卸载清理、plistServiceLabel、双名扫描）与 keychain 回退/双删、owner 收养/冲突/双释放测试。

### 🧠 Design Intent (Why)
项目已从 `codex-cliproxy-gateway` 更名为 `agent-proxy`（npm 包 `@agent-proxy/gateway`、CLI `agent-proxy`、运行目录 `~/.agent-proxy-gateway` 均已切换），但 launchd 服务 label/plist 文件名、Keychain 服务名、归属声明文件名、HTTP 标记头仍停留在旧名。本次把对外可见的持久标识统一到新名；所有涉及存量安装的路径都带只读兼容或收养迁移：旧机器上的密钥、归属声明、服务定义在下一次 `install` 时无感迁移，`uninstall` 把新旧命名一并回收。收养设计为纯改名（不 bootout、不改内容），确认门之前零副作用，避免「拒绝安装却停了服务」或 KeepAlive 双服务抢端口。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（staged，基线 f1cae1d，含 review 修复轮）。

- **Files changed:** 27
- **Insertions:** +599
- **Deletions:** -108

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/launchd.ts` | +104 | -10 |
| `apps/gateway/src/codex-ownership.ts` | +60 | -16 |
| `apps/gateway/src/cli.ts` | +34 | -5 |
| `apps/gateway/src/keychain.ts` | +26 | -9 |
| `apps/gateway/src/paths.ts` | +15 | -4 |
| `apps/gateway/src/gateway.ts` | +4 | -4 |
| `packages/opencode-zen/src/fingerprint.ts` | +1 | -1 |
| `packages/opencode-zen/src/session.ts` | +1 | -1 |
| `packages/plugin-api/src/registry.ts` | +1 | -1 |
| `test/launchd-migration.test.ts` | +113 | -0 |
| `test/codex-ownership.test.ts` | +55 | -7 |
| `test/credentials-store.test.ts` | +47 | -4 |
| `test/default-install-migration.test.ts` | +27 | -11 |
| 其余测试与历史文档（断言改名/固件微调） | +159 | -47 |

### 📁 Files Modified
- `apps/gateway/src/launchd.ts`、`apps/gateway/src/paths.ts`、`apps/gateway/src/cli.ts`
- `apps/gateway/src/codex-ownership.ts`、`apps/gateway/src/keychain.ts`、`apps/gateway/src/gateway.ts`
- `packages/opencode-zen/src/session.ts`、`packages/opencode-zen/src/fingerprint.ts`
- `packages/plugin-api/src/registry.ts`
- `test/launchd-migration.test.ts`（新增）、`test/codex-ownership.test.ts`、`test/credentials-store.test.ts`、`test/default-install-migration.test.ts`、`test/instance-regressions.test.ts`、`test/paths.test.ts`、`test/gateway.test.ts`、`test/webui.test.ts`、`test/realtime.test.ts`、`test/gateway-model-reload.test.ts`、`test/model-exclude-gateway.test.ts`、`test/{agy,codebuddy,qoder,opencode-zen}-gateway.test.ts`、`test/plugin-registry.test.ts`

### ✅ Verification
- `bun run check` 全绿：check:boundaries + build（9 项目）+ typecheck + `node:test` 1292 通过 / 0 失败（含 review 修复轮新增用例）。

### 📌 Notes / Follow-ups
- 旧命名 plist 在下一次 `agent-proxy install`（确认后）被收养；此前旧服务仍按旧 label 运行，`status` 的 serviceLoaded 显示为 false 属预期，完成 install 后消失。
- `test/default-install-webui-migration.test.ts` 的旧 Label 固件由迁移函数的 Label 校验兼容（新旧 Label 均识别）。
