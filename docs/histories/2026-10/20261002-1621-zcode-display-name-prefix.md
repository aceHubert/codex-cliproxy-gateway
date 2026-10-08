# [2026-10-02 16:21] | Task: ZCode 目录显示名改为 ZCode/<模型名>

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 把 zcode 的 model catalog 合并时的显示名称去掉后面括号里的 ZCode，修改为 `ZCode/<model name>`。

### 🛠 Changes Overview
**Scope:** codex-cliproxy ZCode 模型目录（`src/zcode/catalog.ts` 与相关测试）

**Key Actions:**
- **[显示名]**: 渠道标识从尾部括号 ` (ZCode)` / `（ZCode ...）` 改为前缀 `ZCode/<模型名>`；套餐分组括号简化为 ` (个人/团队/免费)`，多 API Key 的 provider 名括号简化为 `（<providerName|providerId>）`，不再重复 ZCode 字样。
- **[目录分层]**: 厂商全量目录不再预置 ZCode 后缀，由 `/v1/models` 的套餐作用域投影层统一加 `ZCode/` 前缀，落盘目录与接口共用同一结果。
- **[回归测试]**: 更新 `test/zcode-catalog.test.ts` 与 `test/zcode-gateway.test.ts` 的显示名断言，覆盖套餐分组与多 Key provider 名两种形态。

### 🧠 Design Intent (Why)
旧显示名把渠道信息放在模型名后的括号里（如 `GLM-5.3 (ZCode个人)`），与 CodeBuddy 现有的 `INTL-C/<模型名>` 前缀风格不一致，模型选择器里也更难扫读。改为 `ZCode/<模型名>` 前缀后渠道一目了然，同时保留套餐/Key 括号用于区分同名模型，且 slug 与路由行为完全不变。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（本次任务相关文件）。

- **Files changed:** 3
- **Insertions:** +31
- **Deletions:** -21

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/catalog.ts` | +20 | -13 |
| `test/zcode-catalog.test.ts` | +9 | -6 |
| `test/zcode-gateway.test.ts` | +2 | -2 |

### 📁 Files Modified
- `src/zcode/catalog.ts`
- `test/zcode-catalog.test.ts`
- `test/zcode-gateway.test.ts`

### ✅ Verification
- `bun run typecheck` 通过。
- `timeout 60 bun test test/zcode-catalog.test.ts`：13 pass / 0 fail。
- `timeout 60 bun test test/zcode-gateway.test.ts`：38 pass / 0 fail。
- `bun test` 全量 499 pass / 0 fail（31 个文件；沙箱内因禁止监听端口会报 `EADDRINUSE`，已在沙箱外复跑通过）。
