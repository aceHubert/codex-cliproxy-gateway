## [2026-09-01 14:09] | Task: README 补记 --max-request-logs

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> --max-request-logs 没有记录在 readme 里吗？

### 🛠 Changes Overview
**Scope:** codex-cliproxy（仅 README）

**Key Actions:**
- **[命令示例]**: Commands 代码块补 `codex-cliproxy config --max-request-logs 20`（排在 `--max-log-size` 之前，与 CLI usage 顺序一致）。
- **[请求日志段落]**: 新增保留策略说明：按路径前两段分组（如 `cliproxy-v1-responses-*`）保留最新 N 个文件，默认 0 不限制；明确与 `--max-log-size` 互不作用（前者只管 `logs/` 请求日志，后者只管 `gateway.log`）。
- **[表述泛化]**: config 段落与 Restart requirements 要点由"每个 `config --log on|off` 调用会重启"泛化为"任一 `--log`/`--max-request-logs`/`--max-log-size` 写入都会重启"，与 `configCommand` 实际行为一致。

### 🧠 Design Intent (Why)
* `--max-request-logs` 在 20260901-0956 任务落地时只更新了 CLI help 与测试，README 全文零提及（grep 确认），用户指出后补齐。顺带把"哪些 config 调用触发重启"的表述同步到三个选项齐全的现状，避免读者以为只有 `--log` 会重启。

### ⚠️ 已知未决问题
- 无新增。

### 📊 Change Stats
- **Files changed:** 1（`README.md`，本任务净增约 +9/-5）

### 📁 Files Modified
- `README.md`

### ✅ Verification
- `grep -n "max-request-logs" README.md`：命令示例（120）、config 段（150）、Restart 要点（154）、保留策略说明（166）四处齐全；分组示例与 `logGroupFromPath`（路径前两段）一致。纯文档改动，无需跑 `bun run check`。
