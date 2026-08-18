# Model catalog 动态刷新实现

## 目标

移除静态 `model_catalog_json` 依赖，让 Codex 通过 gateway `/v1/models` 读取
本地 merged catalog，并由 Codex 自己维护 `models_cache.json`。

## 范围

- 包含：native 来源降级、catalog/metadata、cache 失效、CLI 生命周期、动态 `/models`。
- 不包含：实时请求 CLIProxy、连接 app-server RPC、真实同步与重启验收、ETag。

## 背景

- 相关文档：`docs/model-catalog-dynamic-refresh-plan.md`
- 相关代码路径：`src/catalog.ts`、`src/cli.ts`、`src/gateway.ts`
- 已知约束：保留未提交改动，只删除确认由旧安装管理的 legacy catalog。

## 风险

- 风险：CLI/App 版本漂移、PID 识别错误、迁移覆盖用户配置、旧 cache 继续生效。
- 缓解方式：优先 Desktop runtime、版本防降级、只恢复托管 TOML key、原子失效 cache。

## 里程碑

1. 实现 native runtime 发现与固定降级链。
2. 接入安装、同步、迁移、卸载和动态 `/models`。
3. 补齐测试、构建和文档。

## 验证方式

- 命令：`bun run check`
- 手工检查：由用户后续执行真实 `models --sync` 与 App 刷新验收。
- 观测检查：`/v1/models` 测试确认零上游 fetch，两种响应 shape 正确。

## 进度记录

- [x] 完成 native live/bundled/CLI/previous-cache 降级链。
- [x] 完成动态配置、cache 失效、gateway 响应和旧安装迁移。
- [x] 41 项测试、类型检查和构建通过。
- [ ] 真实同步和 app-server 刷新由用户手动验收。

## 决策记录

- 2026-08-17：`/v1/models` 只读本地 catalog，不访问任何上游。
- 2026-08-17：优先运行中的 Desktop `.app` runtime，再比较 runtime 版本。
- 2026-08-17：保留可选 ETag，首版使用稳定的 200 响应以减少实现面。
