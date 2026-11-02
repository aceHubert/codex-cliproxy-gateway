## [2026-11-02 15:35] | Task: 按 ZCode 宿主日志门禁 Start Plan 目录

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/zcode-startup`

### 🛠 Changes Overview
**Scope:** packages/zcode

**Key Actions:**
- **[宿主日志信号源]**: `plans.ts` 新增 `latestZcodeStartPlanBillingPayload` / `zcodeStartPlanEntitledFromLog`——只读 `~/.zcode/v2/logs/<当天>.log` 尾部 1MB 窗口内最后一条 start-plan `billing/balance` 记录（providerId 兼容 `builtin:`/`account:` 前缀），payload 复用 `parseZcodeBillingPlans` 判定有无 active 权益；日志缺失/渠道不符/窗口外一律返回 undefined（无信号）。
- **[目录门禁接线]**: `index.ts` 的 `republishFromPlans` 对 start-plan 路由消费该信号：`false` 撤下免费档条目（会话点名仍由上游 405/3012 拒绝），`true`/`undefined` 保持发布；门禁结果纳入「快照不变但状态翻转」的短路判定，`/v1/models` 的 get 路径无需刷新缓存即可即时增删条目并落盘重投影（写盘 → prune Codex 缓存 → 过期新鲜度）。

### 🧠 Design Intent (Why)
* Start Plan 到期后条目仍常驻目录：镜像 `config.json` 的 `models`/停用标记会长期冻结（本机实证停在 10-20，与真实权益脱节），凭据 biz JWT 又无 exp，导致目录层完全没有可用的到期信号。
* ZCode 官方宿主进程周期性拉取 billing/balance 并把完整响应落盘（LocalQuotaBar 同源实证：周末包 11-01 记录 `plans:[active + model:glm-5.3-flash]`，11-02 09:00 到期后全部记录为空 `plans:[]`）。读取宿主日志即可零网络、零新凭据地获得权威权益信号；每次 `/models` 实时读尾部，不引入缓存与定时器，跨天/宿主未运行等无信号场景按现状回退（条目常驻、上游拒答），行为渐进增强。

### 📊 Change Stats
> 数据来自工作区 `git diff`（未提交前统计）。

- **Files changed:** 4
- **Insertions:** +225
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/zcode/src/plans.ts` | +84 | -0 |
| `packages/zcode/src/index.ts` | +15 | -1 |
| `test/zcode-plans.test.ts` | +86 | -1 |
| `test/zcode-gateway.test.ts` | +40 | -0 |

### 📁 Files Modified
- `packages/zcode/src/plans.ts`
- `packages/zcode/src/index.ts`
- `test/zcode-plans.test.ts`
- `test/zcode-gateway.test.ts`

### ✅ Validation
- `bun run check`：1278 pass / 0 fail（含新增 4 个用例：最后一条记录判定、无信号场景、尾部窗口截断、适配器级目录随日志增减）。
