# [2026-10-02 18:30] | Task: CodeBuddy 显示前缀与 ZCode 日志命名

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 把 CodeBuddy/WorkBuddy 显示前缀调整为 `WB-INTL/`、`WB-CN/`、`CB-INTL/`、`CB-CN/`；并且把日志文件名里的 `zai` 修改为 `zcode`。历史命名不需要兼容，直接修改；`bigmodel` 也一起改为 `zcode`，日志不再区分渠道。

### 🛠 Changes Overview
**Scope:** codex-cliproxy CodeBuddy 目录显示层与 ZCode 请求日志命名

**Key Actions:**
- **[CodeBuddy/WorkBuddy]**: `displayLabel` 由地域在前（`INTL-C` / `CN-W`）改为产品在前（`CB-INTL` / `WB-CN`），完整显示名为 `CB-INTL/<模型名>`、`WB-CN/<模型名>` 等；模型 slug、缓存文件名与请求路由不变。
- **[ZCode 日志]**: `zai` 与 `bigmodel` 渠道请求日志统一写入 `zcode-*`，不再按上游渠道区分文件命名。
- **[无兼容策略]**: 请求日志识别规则不再接受旧 `zai-*` 文件；已有历史文件不迁移、不按请求日志保留策略识别。
- **[测试]**: 更新 CodeBuddy 显示名、双产品目录、ZCode 日志文件名与 `isRequestLogName` 断言。

### 🧠 Design Intent (Why)
`CB` / `WB` 比单字母 `C` / `W` 更直接表达 CodeBuddy 与 WorkBuddy，产品在前也更符合用户阅读顺序。ZCode 日志原名沿用上游渠道 `zai` / `bigmodel`，容易与产品名 ZCode 混淆；两类渠道统一为 `zcode-*` 后与模型命名空间一致，排查时也只需要关注一个产品命名空间。用户明确不需要历史命名兼容，因此识别规则直接切换，避免新旧命名长期并存。

### 📊 Change Stats
> 数据按本次任务涉及的代码改动统计；工作区同时存在其它未提交任务改动，未计入。

- **Files changed:** 6
- **Insertions:** +21
- **Deletions:** -20

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/catalog.ts` | +4 | -4 |
| `test/codebuddy-catalog.test.ts` | +10 | -10 |
| `src/request-log.ts` | +2 | -2 |
| `src/zcode/index.ts` | +1 | -1 |
| `test/zcode-gateway.test.ts` | +2 | -2 |
| `test/gateway.test.ts` | +2 | -1 |

### 📁 Files Modified
- `src/codebuddy/catalog.ts`
- `test/codebuddy-catalog.test.ts`
- `src/request-log.ts`
- `src/zcode/index.ts`
- `test/zcode-gateway.test.ts`
- `test/gateway.test.ts`

### ✅ Verification
- `bun run typecheck` 通过。
- `timeout 60 bun test test/codebuddy-catalog.test.ts test/codebuddy-gateway.test.ts`：41 pass / 0 fail。
- `timeout 60 bun test test/zcode-gateway.test.ts`：38 pass / 0 fail。
- `timeout 60 bun test test/gateway.test.ts`：91 pass / 0 fail。
- 当前全量 `bun test` 被工作区并行存在的 Qoder 改动阻断：`Qoder 流式响应停顿产生超时失败事件并在专属日志中记录 504` 失败后触发 Bun `test() inside another test()` 级联错误；与本任务的 CodeBuddy 显示名和 ZCode 日志命名改动无关。
