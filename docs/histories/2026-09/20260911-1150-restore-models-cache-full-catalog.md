## [2026-09-11 11:50] | Task: 恢复 models-cache.json 完整目录缓存与 last-good 回退

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> models-cache.json 为什么这个里面的模型没有了 —— 是修改有问题，不要修改上游的返回，全部缓存进去。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（网关 /models 路由与缓存写入）

**Key Actions:**
- **[writeModelsCache]**: 将上午修复引入的 `rememberClientVersion`（只存 `fetched_at`/`client_version`）替换为 `writeModelsCache`：官方刷新成功时把上游返回的 `models` **原样全部写入**（不增删字段）；刷新失败时只更新版本与时间戳，从现有文件保留 `models`，绝不清空目录。
- **[last-good 回退]**: `catalogModelsResponse` 在官方刷新失败时回退读取 `models-cache.json` 缓存目录并正常走合并/响应链路，仅在缓存同样不可用时才返回 502（恢复 `cef889f` 之前的旧语义）。
- **[测试]**: 更新"刷新成功"用例断言缓存包含上游 models 原文；新增"官方刷新失败回退 last-good 并保留 models"用例；不带缓存文件的失败路径仍断言 502。
- **[实机恢复]**: 用会话早期持久化日志中留存的 8/27 快照（8 个官方模型）重新播种 `~/.codex-cliproxy-gateway/models-cache.json`，重启网关后 `/models` 从 502 恢复为 200（8 个官方 + 19 个 CLIProxy 合并条目），且版本记录照常更新。

### 🧠 Design Intent (Why)
上午的修复只记录客户端版本，重启后第一次 `/models` 请求就把 8/27 的 last-good 目录快照覆盖成了 78 字节的紧凑格式——目录数据"消失"，且官方刷新 401 时 `/models` 直接 502。用户拍板：上游返回不许删减，完整缓存；据此恢复 `a7c69c0`～`cef889f^` 时期的完整缓存 + 失败回退语义，同时保留新版本记录能力（失败路径更新版本但不动 models）。

### 📊 Change Stats
> `git diff --numstat`，工作区相对 HEAD；同三文件还叠加上午 codex-version 修复（均未提交）的改动。

- **Files changed:** 3
- **Insertions:** +184
- **Deletions:** -60

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/gateway.ts` | +78 | -29 |
| `test/model-catalog-dynamic.test.ts` | +83 | -31 |
| `AGENTS.md` | +23 | -0 |

### 📁 Files Modified
- `src/gateway.ts`
- `test/model-catalog-dynamic.test.ts`
- `AGENTS.md`
