## [2026-09-14 18:45] | Task: 修复 review 提出的四项提交前阻塞问题

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 必须修(提交前)：1) AGENTS.md 兜底合成描述与 catalog.ts 实际行为方向相反(P0)；2) tech-debt-tracker 引用已移入 completed/ 的计划仍写 active/(P1)；3) webui.test.ts 11 个用例 makeFixture 缺 try/finally 清理,本机 TMPDIR 已积累 910 个 ccp-webui-* 目录(P1)；4) Web UI 错误反馈缺失——ConfigPage loadConfig 无 .catch、LogsPage 四处 .catch(() => {}) 吞错,ui-token 轮换后无重新输入通道,建议 401 统一上抛复用 TokenPrompt(P1)。

### 🛠 Changes Overview
**Scope:** `src/ui/`、`test/`、`AGENTS.md`、`docs/exec-plans/`

**Key Actions:**
- **AGENTS.md 措辞纠正**: 兜底合成由「抬高其最低客户端版本」改为「解除其最低客户端版本限制」,与 `catalog.ts` 的 `delete model.minimal_client_version` 实际行为一致。
- **失效链接修复**: `tech-debt-tracker.md` 的 Web UI 计划链接由 `active/web-config-ui.md` 改为 `completed/web-config-ui.md`。
- **测试临时目录清理**: `webui.test.ts` 11 个用例补 try/finally + `fs.rmSync(home)`(SPA 壳、缺失资产、令牌校验、Host/Origin、loopback 禁用、config 分组、URL 脱敏、非法字段、favicon 共 10 个 makeFixture 用例 + favicon),并清除本机 TMPDIR 已积累的 910 个 `ccp-webui-*` 泄漏目录。
- **Web UI 错误反馈**: App 新增 `handleAuthExpired` 下发 `onAuthExpired`;ConfigPage `loadConfig` 补 catch——401 上抛复用全局 TokenPrompt,其余错误以 `restart-banner error` 横幅 + 重试按钮展示;重启轮询的静默 catch 补 401 分支;LogsPage 四处吞错统一走 `handlePageApiError`(401 → TokenPrompt,其余 → 页内错误横幅,成功后清除)。

### 🧠 Design Intent (Why)
AGENTS.md 是重构时的行为契约,方向性错误会引导后续改动做出相反行为;活文档中的链接失效会误导后续排查。测试泄漏违反仓库 finally 清理约定且已在实机堆积。UI 侧 401 只在启动 `reload` 生效,会话中令牌轮换后页面级 API 全部静默失败,用户没有任何重新输入令牌或看到错误的通道——401 统一上抛可零成本复用既有 TokenPrompt 流程,非 401 错误按页面就近展示避免整页替换。

### 📊 Change Stats
> 数据来自 `git diff --numstat`(工作区 vs 暂存区),只统计本次任务改动。

- **Files changed:** 6
- **Insertions:** +209
- **Deletions:** -108

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +1 | -1 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -1 |
| `src/ui/App.tsx` | +7 | -2 |
| `src/ui/ConfigPage.tsx` | +32 | -6 |
| `src/ui/LogsPage.tsx` | +33 | -7 |
| `test/webui.test.ts` | +135 | -91 |

### 📁 Files Modified
- `AGENTS.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `src/ui/App.tsx`
- `src/ui/ConfigPage.tsx`
- `src/ui/LogsPage.tsx`
- `test/webui.test.ts`

### ✅ Verification
- `bun run check` 全绿:类型检查、322 测试(0 fail)、构建(含 `build:ui` 重建 `dist/ui/index.html`)。
- 单独复跑 `bun test test/webui.test.ts`:29 pass,`ccp-webui-*` 泄漏目录数运行前后均为 910→910(不再增长),随后清理至 0。
