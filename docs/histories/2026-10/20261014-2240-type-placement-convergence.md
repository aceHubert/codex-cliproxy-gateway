## [2026-10-14 22:40] | Task: 收敛契约类型副本与插件层共享资产重复

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode Desktop CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> 新增了一条待执行计划，把当前 changes 放入暂存区后实施，完成后不要提交，等我审核。

### 🛠 Changes Overview
**Scope:** apps/gateway（types/catalog/request-log/process-log）、packages/{llm-bridge,zcode,qoder,agy}、test

**Key Actions:**
- **A 组 8 处契约类型副本收敛**: ModelEntry / ModelCatalog / ProcessLogTarget（types.ts）、ModelOverrideRule（catalog.ts）、RequestLogSink / ExchangeEntry（request-log.ts）、ErrorEntry / RequestSummary（process-log.ts）的本地声明删除，改为从 `@agent-proxy/plugin-api` re-export；网关侧说明性注释随 re-export 保留，全部调用点与引用路径不动。
- **B1 裁决为方案 B 并落注释**: qoder SSE 读取器维持独立实现，`packages/qoder/src/sse.ts` 头部注释记录与 `readSseFrames` 的同源关系及不收敛理由（[DONE] 非权威结束标识、8MB 增量熔断不可由薄封装等价复现、queue.ts 需交还 reader 所有权）。
- **B2 zcode 工具定义收敛**: `ZcodeToolDefinition` 改为 `extends ToolIdentity`（桥接包单一来源），身份表同步处由逐字段拷贝改为展开 identity。
- **C1/C2 注释与死类型**: 五处「三种客户端协议」注释更新为四种（含 gemini 客户端入口）；`ProtocolErrorShape` 死类型删除（无使用、未导出，其注释即 C1 第 6 处）。
- **碰撞扫描固化为测试**: 新增 `test/contract-type-boundaries.test.ts`，断言 plugin-api 与 llm-bridge 导出的类型名不在其余包与网关源码中再次声明，与 scripts/check-boundaries 互补。

### 🧠 Design Intent (Why)
契约类型此前在网关与插件层存在同形副本，`scripts/check-boundaries.ts` 只看 import 与依赖清单，检测不到重复声明，形状漂移只能靠人工审查发现。收敛后「契约类型只在 plugin-api 单一来源」与协议类型、CodebuddyRegion 的既有口径一致；qoder 读取器的差异经裁决为产品必要语义（方案 B），不强行收敛以免丢失增量熔断与流所有权交还行为。全程行为中性，仅声明来源与注释变化。

### 📊 Change Stats
> 数据来自 `git diff`（暂存基线 → 工作区），未提交；另有 1 个新增未跟踪测试文件不在此 diff 内。本次任务开始前已按要求把既有 79 项改动放入暂存区。

- **Files changed:** 15（含新增测试文件）
- **Insertions:** +108（64 已跟踪 + 44 测试文件）
- **Deletions:** -104

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/types.ts` | +8 | -24 |
| `apps/gateway/src/catalog.ts` | +3 | -5 |
| `apps/gateway/src/request-log.ts` | +14 | -27 |
| `apps/gateway/src/process-log.ts` | +8 | -22 |
| `packages/zcode/src/wire.ts` | +3 | -4 |
| `packages/zcode/src/request.ts` | +1 | -1 |
| `packages/zcode/src/response.ts` | +3 | -3 |
| `packages/qoder/src/sse.ts` | +10 | -1 |
| `packages/qoder/src/request.ts` | +1 | -1 |
| `packages/agy/src/response.ts` | +1 | -1 |
| `packages/llm-bridge/src/index.ts` | +2 | -2 |
| `packages/llm-bridge/src/errors.ts` | +1 | -1 |
| `packages/llm-bridge/src/types.ts` | +0 | -6 |
| `test/contract-type-boundaries.test.ts`（新增） | +44 | -0 |
| `docs/exec-plans/completed/type-placement-convergence.md` | +9 | -6 |

### 🧪 Verification
- `bun run check`：1120 pass / 0 fail（80 个测试文件），退出码 0（含边界检查、构建、严格 typecheck、全量测试；较上一基线 1119 新增 1 项碰撞扫描测试）。
- 计划内按名碰撞扫描（plugin-api + llm-bridge 全部导出类型名 vs 所有包）：零输出。
- host-services 装配点（CatalogServices/RequestLogServices/ProcessLogServices）经全量 typecheck 通过。

### 📁 Files Modified
- `apps/gateway/src/{types,catalog,request-log,process-log}.ts`
- `packages/zcode/src/{wire,request,response}.ts`
- `packages/qoder/src/{sse,request}.ts`
- `packages/agy/src/response.ts`
- `packages/llm-bridge/src/{index,errors,types}.ts`
- `test/contract-type-boundaries.test.ts`（新增）
- `docs/exec-plans/completed/type-placement-convergence.md`（进度与决策记录；2026-10-15 验收后由 active/ 归档）

### ✅ 验收（2026-10-15）
- 审核通过并归档计划。验收确认：边界测试的覆盖边界为只遍历 `.ts`（不含 `.tsx`）、只覆盖 `export` 声明；当前 `.tsx` 中无契约名声明，无实际漏检，属已知边界而非缺陷（已记入计划状态行）。
