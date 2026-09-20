# ZCode 多 API Key Provider 路由

## 目标

ZCode 官方 API Key 全部从 `provider_config.json` 读取，并为每个可用官方 provider 独立发布模型目录、缓存与鉴权路由；Coding Plan / Team / Start Plan 的既有套餐链路不变。

## 范围

- 包含：provider_config 解析、API Key provider 枚举、provider 作用域模型前缀、目录显示名、独立配置缓存与请求路由。
- 不包含：ZCode 套餐 OAuth 凭据链路、`config.json` 套餐镜像、Start Plan billing 解析。

## 背景

- 相关代码路径：`src/zcode/config.ts`、`src/zcode/catalog.ts`、`src/zcode/index.ts`。
- 已知约束：`builtin:zai` 的 API Key 镜像已被 ZCode 忽略；`zai-api` / `bigmodel-api` 是官方 API Key 在 provider_config 中的模板槽位。
- 目录约定：`zcode-<providerId>/<model>`；显示名使用 `（ZCode <providerName|providerId>）`。

## 风险

- 风险：多个 provider 的模型 ID 重叠时误用另一个 Key，或 provider ID 与套餐前缀冲突。
- 缓解方式：每个 provider 一个独立缓存；请求前缀必须与快照 provider ID 一致；保留套餐前缀并拒绝冲突/大小写重复的 provider ID。

## 里程碑

1. 确认 provider_config 权威来源与 builtin 边界。
2. 实现 provider 枚举、目录前缀与多路由缓存。
3. 用缓存、目录和网关请求测试验证 Key 隔离。

## 验证方式

- 命令：`bun run typecheck`、ZCode 相关 `bun test`、`bun run check`。
- 手工检查：读取本机 provider_config 的脱敏摘要，确认目录只公开 provider ID / providerName，不公开 Key。
- 观测检查：不同 `zcode-<providerId>/` 请求使用对应 `x-api-key`，未知 provider 本地 404。

## 进度记录

- [x] 确认 provider_config 与 builtin 边界。
- [x] 实现多 provider 目录与请求路由。
- [x] 完成类型检查、测试与构建。

## 决策记录

- 2026-09-20：API Key 不读取 `config.json` 的 `builtin:zai` / `builtin:bigmodel` 镜像；legacy builtin 选择视为陈旧状态并重新从 provider_config 选择。
- 2026-09-20：官方模板优先，显式官方 Anthropic baseURL 的 custom provider 也可参与；第三方 baseURL 排除。
- 2026-09-20：API Key 目录不再生成单一 `zcode/` 前缀，改用 provider 作用域前缀，避免多个 Key 无法区分。
