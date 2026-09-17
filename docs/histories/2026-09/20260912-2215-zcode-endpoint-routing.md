# [2026-09-12 22:15] | Task: ZCode 端点动态重映射（跟随 z.ai 服务端 ultra 调度）

## 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

## 📥 User Query
> 根据 https://github.com/TriDefender/zcode-api 分析一下是使用的固定上游吗？→ 按（其 endpoint-routing 方案）补充动态重映射方案的实现。

## 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关（zcode 链路上游选择）

**Key Actions:**
- **[新模块]**: `src/zcode-endpoint-routing.ts` — 复刻 ZCode 桌面客户端 3.7+ 的 `ProviderEndpointRoutingService`：定期（成功 TTL 5 分钟 / 失败冷却 30 秒 / 超时 3 秒）拉取 `zcode.z.ai/api/v1/agent/configs`，按 `data.proxyEndpoint.mapping`（from → to）把 Anthropic 上游 URL 重写为官方 ultra 中转；归一化键精确匹配、保留查询串、条目上限 256、并发去重、全程 fail-open。
- **[安全校验]**: 重映射目标仅接受 `z.ai`/`bigmodel.cn` 官方域名的公网 https 地址（拒绝非 https、userinfo/query/hash、环回/私网/保留 IP、`.local`/`.internal`/`.arpa`），非法条目整表拒绝。
- **[接入]**: `src/zcode.ts` 在构建上游 URL 后应用重映射；`ZcodeDependencies.endpointRouting` 支持注入，传 `null` 禁用（网关测试默认禁用以维持既有断言）。
- **[测试]**: 单元 5 组（命中/归一化、fail-open 各态、非法目标、TTL/并发去重、条目上限）+ 网关集成 1 组（重写后上游 URL 与配置拉取通道隔离）。
- **[文档]**: README ZCode 段落、执行计划归档。

## 🧠 Design Intent (Why)
当晚 api.z.ai 海外边缘经代理的路径反复 502；调研 zcode-api 发现 z.ai 已通过服务端映射表把 coding-plan 的 Anthropic 流量调度到 `zcode.z.ai` ultra 中转（国内直连、0.2s），而 ZCode 应用正是因为内置该机制才不受影响。网关补齐同款跟随逻辑后不再依赖任何单一端点的可用性；ultra 实测接受未签名业务 key（Client Signing V4 无需实现，`codingPlanSignature` 仅留观察）。

## 📊 Change Stats
> 基线为任务开始时 `git add -A` 的暂存快照；仅统计本任务增量。同窗口另一会话在重构 `request-log.ts`/`gateway.ts`/`process-log.ts`（错误摘要并入进程日志），`src/zcode.ts` 的未暂存差异含其 import 迁移（约 +1 行），已在验证记录注明。

- **Files changed:** 6（另含计划与本文档）
- **Insertions:** +349
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode-endpoint-routing.ts`（新增） | +167 | -0 |
| `test/zcode-endpoint-routing.test.ts`（新增） | +91 | -0 |
| `test/zcode-gateway.test.ts` | +31 | -1 |
| `src/zcode.ts` | +16 | -2 |
| `README.md` | +6 | -0 |

## 📁 Files Modified
- `src/zcode-endpoint-routing.ts`、`src/zcode.ts`、`test/zcode-endpoint-routing.test.ts`、`test/zcode-gateway.test.ts`
- `README.md`、`docs/exec-plans/completed/zcode-endpoint-routing.md`

## 🧪 Validation
- 单元与网关集成测试：`bun test test/zcode-endpoint-routing.test.ts test/zcode-gateway.test.ts` 全过（网关 30/30，含新集成用例）。
- E2E（授权、一次性）：真实拉取映射表 → `routed=true` 重写为 `https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages` → 未签名业务 key 请求 200（SSE）→ 响应折叠 `response.completed`、事件序号连续。
- mapping 形状实测：`code=0`，`from` 为完整 messages URL；`mapping` 非数组按参考语义降级为空表快照（已固化测试）。
- 全量 `bun run check`：并行日志重构会话（错误摘要并入进程日志、stdout/stderr 日志路径迁移）收敛后重跑通过——255 项测试 0 失败，类型检查与构建通过；两任务在 `src/zcode.ts` 的合并状态经复核（重映射接线、进程日志摘要、剥离注记共存）。
