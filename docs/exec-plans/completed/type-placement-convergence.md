# 类型定义错位收敛：网关契约类型副本与插件层共享资产重复

状态：已完成并验收归档（2026-10-15）。实施与验证记录见下方进度记录；验收补充确认：新增边界测试的覆盖边界为只遍历 `.ts`（不含 `.tsx`）且只覆盖 `export` 声明——当前 `.tsx` 中无契约名声明，无实际漏检，属已知边界而非缺陷。

## 目标

按包依赖顺序（plugin-api 契约包 → models 构建期私有包 → llm-bridge → 四类桥接插件与 agy → gateway）消除类型定义的重复声明：gateway 不再持有 plugin-api 契约类型的副本，插件层不再自持桥接共享资产的等价定义；同时收尾审查发现的注释残留与死类型。收敛后「契约类型只在 plugin-api 单一来源」的口径与协议类型、CodebuddyRegion 的既有收敛完全一致。

## 范围

- 包含：gateway 内 8 处契约类型副本改为 re-export；qoder SSE 读取器收敛（先裁决）；zcode 工具定义 extends 收敛；六处「三种客户端协议」注释更新；ProtocolErrorShape 死类型处置。
- 不包含：任何运行时行为变更（qoder 若并入共享读取器，其语义差异须先裁决并以全量测试矩阵为行为合同）；配置结构、协议面、插件边界与包依赖清单不变。

## 背景

- 相关文档：`completed/llm-bridge-aisdk-rebase.md`（协议类型单一来源条目，2026-10-14 追加）、`completed/plugin-config-ownership.md`（CodebuddyRegion 单一定义先例，契约包与网关不维护副本）、`docs/plugin-contract.md`。
- 相关代码路径：`packages/plugin-api/src/types.ts`（契约类型单一来源）、`apps/gateway/src/{types,catalog,request-log,process-log,host-services}.ts`、`packages/qoder/src/{sse,queue}.ts`、`packages/zcode/src/{wire,request}.ts`、`packages/llm-bridge/src/{sse,types,index,errors}.ts`。
- 已知约束：`scripts/check-boundaries.ts` 只检查 import 与依赖清单，检测不到重复声明，本类问题不进入现有边界验收；本清单全部为 main 存量（本分支未引入也未消除），网关副本与契约包形状一致。
- 来源：2026-10-14 类型定义错位审查（worktree `llm-bridge-conversion`），方法为按名碰撞扫描（plugin-api 与 llm-bridge 全部导出类型名 vs 所有包），除本清单外零命中。

## 待修改清单

### A. 网关契约类型副本收敛（8 处，行为中性，建议一次提交）

现状：以下类型 plugin-api 已定义，gateway 内再次声明同形接口；网关内引用路径与调用点全部不动，仅把声明改为 re-export。

| 类型 | 删除位置（gateway 副本） | 单一来源（plugin-api） |
| --- | --- | --- |
| ModelEntry | apps/gateway/src/types.ts:6 | packages/plugin-api/src/types.ts:6 |
| ModelCatalog | apps/gateway/src/types.ts:18 | packages/plugin-api/src/types.ts:18 |
| ProcessLogTarget | apps/gateway/src/types.ts:77 | packages/plugin-api/src/types.ts:112 |
| ModelOverrideRule | apps/gateway/src/catalog.ts:5 | packages/plugin-api/src/types.ts:124 |
| RequestLogSink | apps/gateway/src/request-log.ts:17 | packages/plugin-api/src/types.ts:113 |
| ExchangeEntry | apps/gateway/src/request-log.ts:234 | packages/plugin-api/src/types.ts:116 |
| ErrorEntry | apps/gateway/src/process-log.ts:123 | packages/plugin-api/src/types.ts:123 |
| RequestSummary | apps/gateway/src/process-log.ts:159 | packages/plugin-api/src/types.ts:122 |

- 替换形式：`export type { ModelEntry, ModelCatalog, ProcessLogTarget } from "@agent-proxy/plugin-api";`，其余文件同理。
- 保留网关侧说明性注释到 re-export 附近（RequestLogSink.maxLogs 的 CLI/UI 提示、ProcessLogTarget 的 maxGatewayLogBytes 说明、ExchangeEntry 的 upstreamRequestBody 注释）。
- 注意：process-log.ts 的 ErrorEntry 现为平铺声明，plugin-api 为 `extends RequestSummary`，字段集合一致，re-export 后语义不变。
- 引用面（re-export 后不动）：ModelCatalog 11 文件、ModelEntry 6、ProcessLogTarget 6、RequestSummary 4、ModelOverrideRule 3、RequestLogSink 3、ExchangeEntry 与 ErrorEntry 各 1。

### B. 插件层桥接共享资产重复（2 处）

**B1（待裁决）qoder SSE 读取器**：`packages/qoder/src/sse.ts:2` 的 `Frame`/`readFrames` 与 `packages/llm-bridge/src/sse.ts:7` 的 `SseFrame`/`readSseFrames` 同源；桥接注释声明其为共享基础，qoder 依赖 llm-bridge。`packages/qoder/src/queue.ts:73` 另有内联取帧。差异：qoder 有 8MB 单帧上限、event 必填、严格 EOF、不产 `[DONE]` 哨兵。

- 方案 A：改用 `readSseFrames`，qoder 侧薄封装补大小上限与 `[DONE]` 语义。
- 方案 B：判定差异为产品必要，维持实现，至少在注释记录与桥接读取器的关系及不收敛理由。
- 裁决前不改动。

**B2 zcode 工具定义**：`packages/zcode/src/wire.ts:2` 的 `ZcodeToolDefinition` 手抄 `ToolIdentity` 的 name/custom/namespace 三字段再加 gateway 标记，`packages/zcode/src/request.ts:303` 附近逐字段拷贝。改为 `interface ZcodeToolDefinition extends ToolIdentity { gateway?: "analyze_image" }`，拷贝处可展开 identity。对照先例：codebuddy 用别名 `CodebuddyToolMap = ToolIdentityMap`，qoder/zen 直接引用桥接类型；agy 属零桥接边界豁免，不处理。

### C. 注释残留与死类型

- C1「三种客户端协议」六处更新为四种（gemini 客户端入口）：`packages/llm-bridge/src/index.ts:5`、`errors.ts:2`、`types.ts:86`；`packages/zcode/src/response.ts:180`；`packages/agy/src/response.ts:124`；`packages/qoder/src/request.ts:6`。
- C2（待裁决）`packages/llm-bridge/src/types.ts:87` 的 `ProtocolErrorShape`：无任何使用且未从 index.ts 导出。删除；若判定属预期公共面，补导出与消费测试。

## 风险

- 风险：re-export 改变类型身份来源，若副本与契约包存在未察觉的字段漂移，会在装配点由 typecheck 暴露。缓解：视为期望的暴露，逐点核对修正；收敛前后对比 `bun run typecheck` 诊断数。
- 风险：B1 若动流式读取语义，涉及断流、超限帧等边界行为。缓解：先裁决再实施；以 qoder 既有用例与 SSE 边界用例为行为合同。
- 风险：删本地声明时丢失网关侧产品说明注释。缓解：注释随 re-export 保留。

## 里程碑

1. 裁决 B1 收敛方案与 C2 死类型处置。
2. A 组 8 处副本 re-export 收敛并跑 typecheck。
3. B2 extends 收敛、C1 注释更新、C2 处置实施。
4. 全量验证与碰撞扫描回归，记录结果。

## 验证方式

- 命令：`bun run check`（边界 + 构建 + typecheck + 全量测试）；`bun run check:boundaries`。
- 手工检查：按名碰撞扫描零命中：

```bash
for src in packages/plugin-api packages/llm-bridge; do
  grep -rhoE 'export (interface|type|class) [A-Za-z0-9_]+' "$src/src" --include='*.ts' |
    awk '{print $3}' | sort -u | while read -r n; do
      grep -rnE "export (interface|type|class) $n\b" packages apps --include='*.ts' |
        grep -v node_modules | grep -v '/dist/' | grep -v "^$src/"
    done
done
# 预期：修复后零输出
```

- 手工检查：host-services.ts 的 CatalogServices/RequestLogServices/ProcessLogServices 装配点 typecheck 通过。
- 观测检查：qoder/zcode/gateway 相关测试通过；除 B1 按裁决外无运行时行为变化。可考虑把按名碰撞扫描固化为边界测试（断言契约类型名仅在 plugin-api 声明），实施时裁决是否新增。

## 进度记录

- [x] 裁决 B1 收敛方案与 C2 死类型处置（B1 取方案 B 维持实现并落注释；C2 删除，见决策记录）。
- [x] A 组 8 处契约类型副本收敛（types.ts 3 处、catalog.ts / request-log.ts 2 处 / process-log.ts 2 处改为 re-export，说明性注释随 re-export 保留，调用点未动）。
- [x] B2 zcode ZcodeToolDefinition 收敛（extends ToolIdentity，身份表同步处展开 identity）。
- [x] C1 六处注释更新（types.ts:86 随 C2 删除一并消失，其余五处实际修改）。
- [x] C2 死类型处置实施（ProtocolErrorShape 已删除）。
- [x] 全量 check 与碰撞扫描回归通过，记录结果（`bun run check` 1120 pass / 0 fail、退出码 0，80 个测试文件；按名碰撞扫描零输出；碰撞扫描已固化为 `test/contract-type-boundaries.test.ts`）。

## 决策记录

- 2026-10-14：审查确认 8 处网关副本与 2 处插件层重复为 main 存量、本分支未引入；收敛方向与 CodebuddyRegion 先例一致：契约包单一来源，网关改 re-export，调用点不动。影响：仅声明来源变化，行为中性。
- 2026-10-14（实施）：B1 裁决为方案 B（维持 qoder 独立读取器，注释记录关系与理由）。依据：Qoder 上流的 `[DONE]` 不是权威结束标识（响应层必须等独立 finish 事件），折叠成哨兵会破坏语义；8MB 上限在帧累积过程中熔断，薄封装只能在整帧产出后校验，无法等价复现内存保护；queue.ts 的窥探读取需要自持字节缓冲并把未解析余量与 reader 交还调用方，与共享生成器的流所有权模型不同型。注释落在 `packages/qoder/src/sse.ts` 头部。
- 2026-10-14（实施）：C2 删除 `ProtocolErrorShape`——全仓库无使用且从未从 index.ts 导出，判定不属于预期公共面；其"三种客户端协议"注释（C1 清单第 6 处）随之消失。
- 2026-10-14（实施）：按名碰撞扫描固化为 `test/contract-type-boundaries.test.ts`，断言 plugin-api 与 llm-bridge 导出的类型名不在其余包与网关源码中再次声明（re-export 的花括号形式不算再声明）；与 scripts/check-boundaries 互补，防止同类漂移回归。
