## [2026-09-19 20:18] | Task: ZCode 多套餐会话级选择

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 核对一下结论，把多个套餐变成会话级别的选择。catalog 修改为 `zcode-<plan 类型>/<模型>`，显示为 `<模型名称>(ZCode免费/个人/团队)`，段名与原来的 kind 对齐（individual-coding-plan / team-coding-plan / start-plan）。调用没有变，key 的计算也不变——原来是按文件找当前选择，现在按会话请求选择。

### 🛠 Changes Overview
**Scope:** `src/zcode` 与 ZCode 测试、AGENTS.md、README

**Key Actions:**
- **核对 3.14.0 结论**：逆向 `/tmp/index.js` 证实套餐选择走 `session/setModel`（按会话存 `(providerId, modelId)`），`providerFamilyConnectionSelections` 只是每渠道连接形态；修正上一会话「多套餐可同时 current」的说法——请求路由时恰好一个 account-plan 连接为 current。
- **config.ts**：`readSelection` 拆成按渠道的 `familySelection`（双源语义按 family 参数化）；新增 `readZcodePlanSelections` 把两个渠道的连接形态按套餐槽位分桶（当前渠道优先；api-key 只跟随当前渠道；start-plan 槽位兜底指向当前渠道 start-plan provider，不依赖连接形态）；`createZcodeConfigCache` 新增 `plan` 依赖固定解析一个槽位，槽位缺失时优先透出当前渠道根因；快照 `ZcodeProviderSnapshot` 携带 `plan`。
- **catalog.ts**：套餐作用域前缀表 `zcode-individual-coding-plan/`、`zcode-team-coding-plan/`、`zcode-start-plan/`（与 kind 一一对应），裸 `zcode/` 保留给 api-key 自定义 provider；显示名后缀 ` (ZCode个人/团队/免费)`；`isZcodeModel` 覆盖 `zcode/` 与 `zcode-`；新增 `zcodeModelPlan` slug 解析，`zcodeUpstreamModel` 强制套餐段与快照连接形态一致。
- **index.ts**：适配器改为套餐路由表（个人 → 团队 → 免费 → 自定义），每槽位一个独立配置缓存；目录为各可用套餐并集，单套餐失效只撤下自己的条目；`forward` 按请求模型的套餐段选路由，key 解析与上游调用链路不变；`validateZcodeConfig` 把 `zcode-` 纳入保留前缀。
- **request-context.ts**：`zcodePlan` 改按快照 `plan` 判定（start-plan 无 `x-api-key` 的行为不变）。

### 🧠 Design Intent (Why)
3.14.0 把套餐选择从全局开关改成会话级模型选择（按套餐分组勾选），磁盘上的连接形态不再表达「当前套餐」；网关若继续镜像单一全局选择，用户在 Codex 里永远只能用 ZCode 客户端连接的那个套餐。模型在套餐间重叠（GLM-5.3-Flash 同属个人与免费），必须用 slug 套餐段让每个会话显式选择；段名与 `ZcodeSelection.kind` 对齐避免再造一套命名。调用与 key 计算完全不变——变的只是「按文件找」到「按会话请求选」的路由入口。

### 📊 Change Stats
> 本次未提交；分支上还叠有此前任务（团队目录 / Start Plan 目录 / billing 解析）的未提交改动，以下为工作区相对 HEAD 的合计统计。

- **Files changed:** 10
- **Insertions:** +832
- **Deletions:** -245

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/config.ts` | +137 | -21 |
| `src/zcode/index.ts` | +119 | -27 |
| `src/zcode/catalog.ts` | +69 | -29 |
| `src/zcode/request-context.ts` | +3 | -3 |
| `test/zcode-gateway.test.ts` | +198 | -54 |
| `test/zcode-cache.test.ts` | +158 | -5 |
| `test/zcode-catalog.test.ts` | +133 | -96 |
| `test/zcode-request-context.test.ts` | +9 | -8 |
| `AGENTS.md` | +2 | -1 |
| `README.md` | +4 | -1 |

### 📁 Files Modified
- `src/zcode/config.ts`
- `src/zcode/catalog.ts`
- `src/zcode/index.ts`
- `src/zcode/request-context.ts`
- `test/zcode-request-context.test.ts`
- `test/zcode-catalog.test.ts`
- `test/zcode-cache.test.ts`
- `test/zcode-gateway.test.ts`
- `AGENTS.md`
- `README.md`

### ✅ Verification
- `bun run typecheck`
- `bun test`（455 pass / 0 fail）
- `bun run check`（类型检查 + 测试 + 构建）
