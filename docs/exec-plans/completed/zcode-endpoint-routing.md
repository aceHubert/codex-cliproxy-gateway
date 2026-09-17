# ZCode 端点动态重映射（endpoint routing）

## 目标

zcode 链路像 ZCode 桌面客户端 3.7+ 一样跟随 z.ai 服务端下发的端点映射：定期拉取 `https://zcode.z.ai/api/v1/agent/configs`，按 `data.proxyEndpoint.mapping`（from → to）把 Anthropic 上游 URL 重写到官方 ultra 中转（当前实测：`api.z.ai/api/anthropic/v1/messages → zcode.z.ai/api/v1/ultra-zai/...`，国内直连可达）。拉取失败一律 fail-open 回退原始 URL。

## 范围

- 包含：新模块 `src/zcode-endpoint-routing.ts`（拉取/校验/缓存/重写，含公网与域名校验）、`src/zcode.ts` 接入（`ZcodeDependencies.endpointRouting` 注入，默认启用、传 `null` 禁用）、`test/zcode-endpoint-routing.test.ts`、`test/zcode-gateway.test.ts` 增加重写集成用例、README。
- 不包含：Client Request Signing V4（Ed25519+PoW，见 zcode-api `client-signing.ts`；其本身也 fail-open，ultra 是否强制签名由 E2E 实测决定，未强制则记债务）、配置开关与 Schema 变更（行为与官方客户端一致且 fail-open，不加开关）。

## 背景

- 参考：[TriDefender/zcode-api](https://github.com/TriDefender/zcode-api) `src/proxy/endpoint-routing.ts`（TTL 5min / 失败冷却 30s / 超时 3s / 条目上限 256 / 归一化键精确匹配 / 保留查询串）。
- 实测（2026-09-12 22:1x）：`GET agent/configs` 返回 `code=0`，`data.proxyEndpoint.mapping` 两条，`from` 为完整 messages URL；响应另含 `codingPlanSignature`（签名 gate 配置，本任务不实现）。
- 动机：z.ai 已把 coding-plan Anthropic 流量调度到 zcode.z.ai ultra（国内直连）；网关此前固定 api.z.ai 海外边缘，依赖不稳定的代理路径。

## 风险

- 风险：ultra 端点可能要求请求签名（VERIFY_* 401）。
- 缓解方式：E2E 实测；若拒绝则 fail-open 语义不变（重写后 401 会按上游错误透传——此时把 mapping 应用处增加"401 VERIFY_* 回退原 URL 重试一次"或直接记债务停用，以实测结果决策）。
- 风险：恶意/异常 mapping 把请求导向内网（SSRF）。
- 缓解方式：`to` 必须为 https、无 userinfo/query/hash、域名为 z.ai/bigmodel.cn 白名单内、且非环回/私网/保留地址；条目超限或重复 from 整表拒绝。
- 风险：zcode.z.ai 不可达时每个请求最多多等 3 秒。
- 缓解方式：30 秒失败冷却 + 5 分钟成功 TTL，与参考实现一致。

## 里程碑

1. 实测 mapping 端点形状（已完成）。
2. 实现 `zcode-endpoint-routing.ts` + `zcode.ts` 接入。
3. 单元测试（命中/未命中/归一化、fail-open 三态、TTL/冷却/并发去重、非法目标拒绝）+ 网关集成用例。
4. `bun run check` + E2E（真实拉表 → 重写 → ultra 上游 200）。
5. 文档：README、本计划归档、历史记录。

## 验证方式

- 命令：`bun run check`。
- 手工检查：E2E 输出显示路由命中且上游 200。
- 观测检查：网关日志中 upstream URL 为重写后的 ultra 地址。

## 进度记录

- [x] 实测 agent/configs 端点形状（code=0，两条映射，from 含完整 messages 路径）。
- [x] 实现模块与接入。
- [x] 测试（单元 5 组 + 网关集成 1 组）。
- [x] E2E：真实拉表 → 重写 ultra-zai → 未签名业务 key 200 → 响应折叠正常。
- [x] 文档：README、计划归档、历史记录。

## 决策记录

- 2026-09-12：不实现 Client Signing V4——参考实现同样 fail-open，先以最小重映射落地，签名需求由 E2E 实测决定后再立项。
- 2026-09-12：不加配置开关——fail-open + 官方客户端同款行为，风险由白名单与超时兜底。
- 2026-09-12（E2E 结论）：ultra 上游接受未签名的业务 key 请求（200 SSE），Client Signing V4 无需实现；`codingPlanSignature` 字段仅留观察。
- 2026-09-12（实现修订）：`mapping` 非数组时按参考语义降级为空表快照（成功、无重写），而非失败——已在测试固化。
- 2026-09-12（并行任务说明）：全量 `bun run check` 期间工作树存在另一会话对 `request-log.ts`/`gateway.ts` 的在途重构（`logGatewayError` 签名变更），与本任务无关的失败以其稳定后重跑为准。
