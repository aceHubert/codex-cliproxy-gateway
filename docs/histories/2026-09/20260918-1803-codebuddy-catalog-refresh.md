## [2026-09-18 18:03] | Task: 实施 CodeBuddy 目录启动刷新与定时刷新

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5.6-terra`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 实施 codebuddy catalog 更新的逻辑

### 🛠 Changes Overview
**Scope:** codex-cliproxy（`src/codebuddy/` 目录刷新生命周期 + 测试 + 执行计划）

**Key Actions:**
- **[catalog]**: `createCodebuddyCatalogStore` 新增 `refresh()` 强制刷新入口，绕过 TTL 但复用同一个单飞 Promise；普通刷新进行中被强制刷新追赶时，会在当前轮结束后补一轮，避免启动/定时刷新被请求驱动刷新吞掉。新增 30 秒失败冷却，请求驱动刷新在冷却窗口内复用 last-good，强制刷新不受冷却限制。
- **[index]**: 适配器构造时 fire-and-forget 强制刷新一次目录，并注册每 16 分钟一次的 `setInterval`；定时器 `unref()`，`close()` 中 `clearInterval` 回收。新增 `refreshCatalogOnStart`、`catalogRefreshIntervalMs`、`setInterval`/`clearInterval` 注入点，测试不依赖真实时间。
- **[测试]**: catalog 覆盖强制刷新绕过 TTL、并发单飞、失败回退 last-good、30 秒冷却与冷却恢复；gateway 覆盖启动即刷新、定时回调触发刷新、16 分钟间隔与 `close()` 清理定时器。
- **[文档]**: 执行计划第三轮迭代的三项进度全部勾选，并把 zcode 的复核结论保留为「不存在启动刷新缺口，不计技术债」。

### 🧠 Design Intent (Why)
- **CodeBuddy 与 zcode 的缓存机制不同**：zcode 启动时按源码内厂商预设与覆盖规则指纹比对 `zcode-catalog.json`，代码更新后重启自动重建；CodeBuddy 的缓存键含固定 `CATALOG_SCHEMA_VERSION`，重启可能继续复用旧目录，因此需要显式启动刷新。
- **与 CLI 自身节奏对齐**：CodeBuddy CLI 实测约每 16 分钟刷新一次目录，网关采用同一间隔可让 Codex 选择框及时看到上游新增模型。
- **不阻塞启动且不重复打上游**：启动刷新 fire-and-forget；强制刷新与请求驱动刷新共享单飞，避免同时触发多次 `/v3/config`。
- **故障时不放大请求**：上游故障后请求驱动刷新进入 30 秒冷却，持续失败不会变成稳定周期性的重试风暴。

### 📊 Change Stats
> 数据来自本次任务相关文件的 `git diff --numstat`（工作区增量，基线为任务开始前的未提交状态）。

- **Files changed:** 5
- **Insertions:** +324
- **Deletions:** -44

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/catalog.ts` | +98 | -40 |
| `src/codebuddy/index.ts` | +29 | -0 |
| `test/codebuddy-catalog.test.ts` | +149 | -0 |
| `test/codebuddy-gateway.test.ts` | +43 | -0 |
| `docs/exec-plans/completed/codebuddy-proxy-adapter.md` | +5 | -4 |

### 📁 Files Modified
- `src/codebuddy/catalog.ts`
- `src/codebuddy/index.ts`
- `test/codebuddy-catalog.test.ts`
- `test/codebuddy-gateway.test.ts`
- `docs/exec-plans/completed/codebuddy-proxy-adapter.md`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test test/codebuddy-catalog.test.ts test/codebuddy-gateway.test.ts` 通过：38 项 0 失败。
- `bun test` 全量通过：421 项 0 失败（需脱离沙箱以绑定本机端口）。
- `bun run build` 通过。
