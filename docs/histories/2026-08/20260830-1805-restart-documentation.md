## [2026-08-30 18:05] | Task: 收敛网关与 Codex 重启语义

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5.6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 忽略手工破坏配置的边界情况，修正现有重启文档；带参数的 `config`
> 每次都重启网关重新加载配置；所有会操作 `~/.codex/config.toml` 的命令
> 统一提供 `--codex-restart`。

### 🛠 Changes Overview
**Scope:** CLI 使用文档、目录同步方案、重启策略与 WebSocket 执行计划

**Key Actions:**
- **[重启矩阵]**: 在 README 区分网关自动重启、Codex app-server 显式刷新、no-op 和手工文件修改。
- **[config 统一重载]**: 删除目标值 no-op 判断；无参数 `config` 只查询，任何带参数的配置写入都重启网关。
- **[`--codex-restart`]**: 抽取共享 app-server 停止流程，并接入 `install`、`uninstall`、`restart` 和 `models --sync`；旧参数名 `--restart-codex` 统一更名。
- **[目录语义]**: 明确 split 与 CPA-only 模式切换会自动重启网关，`--restart-codex` 只停止 Codex app-server。
- **[WebSocket 文档收敛]**: 将 active 计划的当前语义改为无 `websocket` 开关，更新里程碑、手工验收和验收标准，并标注旧方案为历史记录。
- **[失效回滚说明]**: 从技术债当前动作中删除已失效的 `websocket: false` 配置回滚建议。

### 🧠 Design Intent (Why)
网关进程与 Codex app-server 是两个独立的生效边界。带参数的 `config` 不需要按字段判断是否重启，写盘后统一重载网关最直接。而 `config.toml` 只有在 Codex app-server 重新读取后才生效，因此会写该文件的命令统一暴露一个显式参数。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（当前工作区累计，含本轮之前未提交的 CLI 与 WebSocket 改动）。

- **Files changed:** 19
- **Insertions:** +1011
- **Deletions:** -308

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +286 | -103 |
| `test/app-server.test.ts` | +98 | -9 |
| `README.md` | +36 | -21 |
| `docs/codex-app-server-restart-policy.md` | +18 | -3 |
| `docs/model-catalog-dynamic-refresh-plan.md` | +30 | -12 |
| `docs/exec-plans/completed/split-websocket-route-reconnect.md` | +170 | -54 |
| `docs/exec-plans/completed/app-server-restart.md` | +8 | -0 |

### 📁 Files Modified
- `README.md`
- `src/cli.ts`
- `test/app-server.test.ts`
- `docs/model-catalog-dynamic-refresh-plan.md`
- `docs/codex-app-server-restart-policy.md`
- `docs/exec-plans/completed/split-websocket-route-reconnect.md`
- `docs/exec-plans/completed/cli-config-command-split.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/histories/2026-08/20260830-1805-restart-documentation.md`
