## [2026-08-18 18:31] | Task: 增加官方模型缓存与静态模式

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex App`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 动态 `/models` 保存最新官方目录，并为 `models --sync` 增加基于该缓存的
> `--static` 模式；普通 sync 恢复动态模型管理，任意 sync 后都可显式刷新模型选择器。

### 🛠 Changes Overview
**Scope:** 模型目录刷新、CLI 静态/动态切换

**Key Actions:**
- **官方 last-good**: 动态 `/v1/models` 转发官方请求，成功后原子更新 runtime cache，
  失败时保留并使用上一次有效目录。
- **静态模式**: `models --sync --static` 校验官方 cache，生成
  `~/.codex/cliproxy-catalog.json` 并配置 `model_catalog_json`。
- **动态恢复**: 普通 sync 删除受管静态配置和生成文件，只失效 Codex cache 的时间与版本，
  保留原模型列表。
- **重启边界**: `--restart-codex` 可用于任意 sync 后立即刷新选择器；静态模式进入和退出
  时用于重建模型管理器。
- **安全边界**: 固定生产 cache 路径，拒绝覆盖非受管静态配置，并遮蔽账号请求头。
- **删除旧链路**: 移除 App runtime 探测、`codex debug models --bundled`、
  previous-cache fallback 及其专用类型和测试。

### 🧠 Design Intent (Why)
官方 `/models` 请求携带真实 OAuth 和 `client_version`，避免使用不同版本的
`codex debug models --bundled` 生成过期 native metadata；显式静态模式则复用已经验证的
官方 last-good，保持离线确定性。

### 📊 Change Stats
> 数据来自本任务涉及的 tracked 文件相对 Git 索引的 `git diff --numstat`。工作区在任务开始前
> 已有重叠的未提交修改，因此这里记录的是这些文件的合计差异；新执行计划和本 history 未计入。

- **Files changed:** 11
- **Insertions:** +545
- **Deletions:** -828

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +13 | -8 |
| `docs/exec-plans/tech-debt-tracker.md` | +2 | -0 |
| `docs/model-catalog-dynamic-refresh-plan.md` | +77 | -286 |
| `src/catalog.ts` | +12 | -252 |
| `src/cli.ts` | +147 | -62 |
| `src/gateway.ts` | +92 | -34 |
| `src/paths.ts` | +2 | -2 |
| `src/types.ts` | +2 | -17 |
| `test/app-server.test.ts` | +4 | -0 |
| `test/gateway.test.ts` | +40 | -34 |
| `test/model-catalog-dynamic.test.ts` | +154 | -133 |

### 📁 Files Modified
- `README.md`
- `docs/model-catalog-dynamic-refresh-plan.md`
- `docs/exec-plans/completed/upstream-model-cache-static-mode.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `src/catalog.ts`
- `src/cli.ts`
- `src/gateway.ts`
- `src/paths.ts`
- `src/types.ts`
- `test/app-server.test.ts`
- `test/gateway.test.ts`
- `test/model-catalog-dynamic.test.ts`

### 🔁 Follow-up
- `--restart-codex` 恢复为任意 sync 可用：静态模式切换需要重建模型管理器；动态
  `/models` 即使更新缓存，当前选择器也可能仍持有旧快照。
- 相关 11 项测试与类型检查、构建通过。全量 63 项中 62 项通过；既有 Realtime
  WebSocket 用例仍因 Bun `port 0` 返回 `EADDRINUSE` 未通过。
