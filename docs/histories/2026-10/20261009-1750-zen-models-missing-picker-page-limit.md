## [2026-10-09 17:50] | Task: 排查 Zen 模型不在 Codex picker 显示（目录超 100 条分页上限）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> 分析一下opencode-zen 的模型没有显示是为什么，是不是删除了重要字段？
> 是不是哪个会话测试把cliproxy的所有模型选择了，导致超出限制了

### 🛠 Changes Overview
**Scope:** 无仓库代码改动；仅运维操作（`models --sync --select` 恢复原选择）+ 文档记录。

**Key Actions:**
- **[排除数据侧嫌疑]**: 逐层核验——网关 `/v1/models`（各 client_version/鉴权/两种形状）均返回 11 个
  zen 条目；磁盘 `opencode-zen-catalog.json` 成品条目字段集与 qoder 完全一致（46 个顶层字段、
  12 个 model_messages 字段），**无字段删除**；Codex 客户端 `models_cache.json` 与 app-server
  `model/list`（实测：直接 spawn `codex app-server` 发 JSON-RPC）均返回 11 条且 `hidden=false`。
- **[定位真因]**: 渲染层主 picker 的 `model/list` 查询只取**第一页**（`{includeHidden:true,
  cursor:null, limit:100}`，不跟随 nextCursor——分页循环只存在于 daybreak/自动化另一条代码路径）。
  实测 `limit:100` 返回 100 条 + `nextCursor:100`，第一页内 zen 模型数为 **0**；不限量时 zen
  位于第 114-124 位。适配器条目 priority 最大、排序在目录尾部，超页即被整体截断（agy 8 条同因消失）。
- **[根因归属]**: 本次会话 16:46 为验证系统提示词跑的 `models --sync --select all` 把上游选择
  从 8 个扩到 55 个，目录总数 77 → 124，越过 100 条分页上限。网关日志 `config changed by
  models --sync` 审计行留有原选择，按记录恢复为原 8 个模型。
- **[文档]**: 本记录 + `docs/fingerprint-data.md` 更新记录补一行运维约束。

### 🧠 Design Intent (Why)
用户两个猜测都对：既没有删字段（数据四层核验全在），也确实是被「全选上游模型」撑爆了客户端
分页。Codex Desktop picker 的单页 100 条上限是客户端行为，网关无法绕过；适配器模型按 priority
排在目录尾部，上游选择越多越先被挤掉。这类「改一个配置把模型列表挤没」的事故值得留下审计线索
与恢复方法（网关日志的 config changed 行）。

### 📊 Change Stats
> 无仓库代码改动；运维操作 + 文档。

| 项 | 值 |
| --- | --- |
| `selectedModels` | 55 → 8（恢复审计记录中的原值） |
| 目录总数 | 124 → 77 |
| 第一页 zen 模型数 | 0 → 11 |

### ✅ Verification
- 恢复后实测：网关目录 77 条（官方 10 + cliproxy 8 + zcode 4 + codebuddy 21 + qoder 15 +
  agy 8 + zen 11）；`model/list` limit=100 返回全部 77 条、无 nextCursor，zen 位于第 67-77 位；
  客户端 `models_cache.json` 于 17:45:51 自动重拉为 77 条、含 11 个 zen。

### 📌 Notes
- **运维约束**：`selectedModels`（上游勾选）与适配器模型共享客户端的 100 条单页上限，
  上游选择建议控制在「总数 ≤ 100」以内；改选择后用 `models --sync` 并核实目录总数。
- 恢复原选择的依据是 `~/.codex-cliproxy-gateway/gateway.log` 中 `=== config changed by
  \`models --sync\` ===` 审计行（含变更前后值）。
- picker 若仍显示旧列表，重开模型选择器或重启 Codex Desktop（staleTime 5 分钟 + 窗口聚焦重取）。
