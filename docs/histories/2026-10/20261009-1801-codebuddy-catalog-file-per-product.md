## [2026-10-09 18:01] | Task: 按产品收敛 CodeBuddy/WorkBuddy 目录缓存文件

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6（当前运行时未提供具体变体）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> codebuddy-catalog-file-per-product.md 开始实施

### 🛠 Changes Overview
**Scope:** CodeBuddy/WorkBuddy 目录缓存、受管文件清单及回归测试。

**Key Actions:**
- 接手工作区已有改名代码：使用 `codebuddy-catalog.json` / `workbuddy-catalog.json`，按产品定位，账号/地域隔离仍由原缓存键校验负责。
- 新文件原子写成功后只清理同产品两个旧地域文件；逐个捕获清理异常，一个失败不阻断另一个；写失败保留旧文件。
- 受管清单补齐 WorkBuddy，覆盖实例目录定位、TOML 受管守卫与卸载清理；保留同文件中其他任务已有改动。
- 补充清理隔离、失败路径、跨地域切换与同地域账号标识变化的缓存隔离测试。
- 完成真机重启、计划归档；其他适配器清单缺口与既有弱账号身份问题记入技术债。

### 🧠 Design Intent (Why)
默认适配器每产品只提供一个目录族，地域无需出现在磁盘文件名中。产品文件可随账号变化重建，减少跨地域切换后的残留；模型路由前缀、内存结构、TTL、单飞与 last-good 规则保持原样。

现有身份摘要只使用 profile/accountUid/enterpriseId，空或相同标识不能保证区分登录；这是改名前已有的限制，本次保持键规则并单独记录。未来若支持同产品多地域同时刷新，需要重新设计磁盘隔离。

### ✅ Validation
- `bun run check` 成功：类型检查、748 个测试（0 失败）、UI 与 CLI 构建通过；检查进程设置 60 秒上限。
- `git diff --check` 通过；并行只读审查复核新增异常处理和测试。
- 执行 `bun run dev restart` 后健康检查正常，四个旧地域文件清除，仅剩两产品文件，分别存储 16/21 个裸模型条目。
- 重启前后 `/v1/models?client_version=1.0.0` 中 21 个 CodeBuddy/WorkBuddy 展示条目的 slug/display_name 逐字节一致；观察窗口新增日志 5 行、错误 0 行。
- 未改变真实账号选择；账号切换通过隔离自动化用例验证，未执行真实 `codebuddy --switch`。
- 2026-10-09 晚验收复核（claude-code）：独立重跑 `bun run check`（748 pass / 0 fail，类型检查与构建通过）、交叉核对运行目录与 `/v1/models`（21 条 codebuddy 族展示条目，与两产品缓存文件的 16/21 个裸 ID 一致、cli 为 work 子集）、重启后 gateway.log 0 错误；结论与上述记录一致，无差异。

### 📊 Change Stats
> 未提交工作区：对下列 7 个源码/测试文件执行 `git diff --shortstat` / `git diff --numstat`，原始结果为 197 插入、27 删除。剔除接手时已存在的系统提示词与 OpenCode Zen 日志测试改动（13 插入、6 删除）后，本任务为以下统计；文档与历史记录不计入代码行数。

- **Files changed:** 7（源码/测试；另有计划、技术债与本记录）
- **Insertions:** +184
- **Deletions:** -21

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/catalog.ts` | +27 | -8 |
| `src/codebuddy/index.ts` | +1 | -1 |
| `src/paths.ts` | +1 | -0 |
| `test/codebuddy-catalog.test.ts` | +128 | -10 |
| `test/codebuddy-gateway.test.ts` | +1 | -1 |
| `test/gateway.test.ts` | +14 | -0 |
| `test/paths.test.ts` | +12 | -1 |

### 📁 Files Modified
- `src/codebuddy/catalog.ts`
- `src/codebuddy/index.ts`
- `src/paths.ts`
- `test/codebuddy-catalog.test.ts`
- `test/codebuddy-gateway.test.ts`
- `test/gateway.test.ts`
- `test/paths.test.ts`
- `docs/exec-plans/completed/codebuddy-catalog-file-per-product.md`（由 active 归档）
- `docs/exec-plans/tech-debt-tracker.md`
- 本历史记录
