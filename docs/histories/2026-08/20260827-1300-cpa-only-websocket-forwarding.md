## [2026-08-27 13:00] | Task: CPA-only 静态目录与可选 WebSocket 纯转发

### 🤖 Execution Context

* **Agent ID:** codex
* **Base Model:** GPT-5
* **Git User:** hubert <hubert@lejian.com>
* **Branch:** main

### 📥 User Query

> 只用 CPA，不需要判断模型，完全转发，不添加 `cliproxy/` 前缀，兼容 subagents 的模型配置。
>
> CPA-only 使用静态 `model_catalog_json`，删除原 `--static`，新增仅在 `--cpa-only` 下适用的 `--websocket`。

### 🛠 Changes Overview

- 删除旧 `models --sync --static`；普通 sync 保持动态 split 路由。
- split 与 CPA-only 共用 `~/.codex-cliproxy-gateway/cliproxy-catalog.json`，文件始终只保存选中的 CPA 原始模型 ID。
- CPA-only 的 `model_catalog_json` 直接指向这份 runtime catalog，不读取或合并官方目录。
- split 仅在 `/v1/models` 响应阶段添加 `cliproxy/` 前缀并合并官方目录，不把前缀写回磁盘。
- `--websocket` 只允许和 `models --sync --cpa-only` 一起使用；省略时可靠回退 HTTP/SSE。
- 普通 HTTP 请求在 CPA-only 模式纯转发到 CLIProxy；启用 WebSocket 后帧同样不做模型路由或前缀改写。
- split 模式支持 `models --sync --select pass`，跳过交互并复用本地上次选择；原有带值选择器语义保持不变。
- CPA-only HTTP 直接转发请求体流；仍移除官方 OAuth、账号 ID、其他 API key，并注入 CPA key。
- CPA-only 正常读取原始目录时不请求官方；CPA 目录缺失、损坏或合并失败时，`/v1/models` 返回官方目录。
- 移除 gateway 的 `models-cache.json`：split 每次 `/v1/models` 实时请求官方，不再落盘或读取 last-good 官方目录；保留 Codex 自己的 `models_cache.json` 刷新机制。
- 健康检查和 `status` 增加 `cpaOnly`、`websocket` 可观测字段。
- 保留现有 split 模式和 `/live`、`/realtime` 专用处理不变。

### 📊 Change Stats

按限定本任务文件的 `git diff --numstat`（不含工作区已有的无关 `models.json` 与其他脚本）统计：

- **Tracked files changed:** 15
- **Insertions:** 556
- **Deletions:** 296
- **New docs:** 4（三个执行计划与本历史记录；未跟踪文件不计入 `git diff --numstat`）

### ✅ Verification

- `bun run typecheck` 通过。
- `bun run check` 通过：90 个测试、类型检查和构建全部通过。
- 新增覆盖：单一原始 CPA 目录、split 动态前缀、官方目录降级、WebSocket 参数约束、HTTP/WS 纯转发、Schema 类型和健康检查。

### ⚠️ Notes

- CPA-only 只消除网关层 official ↔ CPA 串线，不解决 CPA 内部账号/渠道因长连接而产生的粘性。
- 切换模式后建议使用 `--restart-codex` 或新建 session，避免旧 subagent 继续发送带 `cliproxy/` 前缀的模型名。
- `/live` 与 `/realtime` 仍按既有 Realtime provider 逻辑处理，不属于本次普通 Responses 纯转发范围。
