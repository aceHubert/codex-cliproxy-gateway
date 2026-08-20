# 官方模型缓存与可选静态目录

## 目标

让动态 `/v1/models` 使用 Codex 当前认证请求官方模型目录，并把最近一次成功结果保存到
`~/.codex-cliproxy-gateway/models-cache.json`；增加 `models --sync --static`，使用该缓存
生成 `~/.codex/cliproxy-catalog.json` 并启用 Codex 静态模型管理。普通
`models --sync` 移除静态配置，恢复 Codex 的周期刷新。

## 范围

- 包含：
  - 动态 `/v1/models` 官方请求、last-good 原子缓存和 CLIProxy 模型合并。
  - `models --sync --static` 的缓存前置校验、catalog 生成和 TOML 配置。
  - 普通 sync 返回动态模式，并仅失效 Codex cache 的时间和版本字段。
  - CLI 帮助、测试、设计文档与历史记录。
- 不包含：
  - 按账号或 `client_version` 分片缓存。
  - 新增配置字段或外部依赖。
  - 主动定时任务；缓存由 Codex 约 300 秒一次的 `/models` 请求驱动更新。

## 背景

- 相关文档：`docs/model-catalog-dynamic-refresh-plan.md`
- 相关代码路径：`src/gateway.ts`、`src/cli.ts`、`src/catalog.ts`、`src/paths.ts`
- 已知约束：
  - 工作区已有未提交修改，必须增量编辑，不回滚现有内容。
  - `models-cache.json` 使用 gateway runtime 目录；Codex 自有缓存仍是
    `~/.codex/models_cache.json`。
  - 官方失败不得覆盖 last-good cache。

## 风险

- 风险：官方 ETag 不包含本地 CLIProxy rows，透传 `304` 会产生错误目录。
- 缓解方式：动态 catalog 请求不复用官方 ETag，成功取得完整 JSON 后再本地合并。
- 风险：静态模式在官方缓存缺失时生成过期 native rows。
- 缓解方式：`--static` 在任何模型选择和写入前强制检查、解析缓存。
- 风险：静态与动态目录路径混用。
- 缓解方式：gateway runtime catalog 保留为动态 CLIProxy overlay；静态 catalog 单独写入
  `~/.codex/cliproxy-catalog.json`。

## 里程碑

1. 收敛动态官方缓存和静态切换语义。
2. 实现 gateway 与 CLI 两个切片。
3. 完成自动化验证、文档和历史记录。

## 验证方式

- 命令：
  - `bun run typecheck`
  - `bun test`
  - `bun run build`
  - `bun run dev --help`
- 手工检查：
  - `--static` 缺少缓存时在写文件前失败。
  - static sync 写入 `model_catalog_json`，普通 sync 移除该字段。
- 观测检查：
  - 官方成功响应更新 runtime cache；官方失败保留并使用 last-good。

## 进度记录

- [x] 确认需求、路径和不按账号分片的边界。
- [x] 完成动态 `/models` 官方缓存。
- [x] 完成 `--static` 切换。
- [x] 完成测试与文档。
- [x] 完成全量验证并归档。

## 决策记录

- 2026-08-18：沿用隐藏目录 `~/.codex-cliproxy-gateway`，将用户消息中的无点路径视为笔误。
- 2026-08-18：缓存保存官方 native rows 和请求时 `client_version`；CLIProxy rows 继续来自
  `models --sync` 的本地选择。
- 2026-08-18：静态 catalog 使用明确要求的 `~/.codex/cliproxy-catalog.json`，不改变
  gateway config 的 runtime catalog 路径。
- 2026-08-18：官方 cache 的生产路径固定为 gateway runtime；自定义 `catalogPath`
  不获得删除 `model_catalog_json` 的所有权。
- 2026-08-18：退出静态模式时删除本工具生成的静态 catalog；Codex 自有 cache 保留
  `models`，只重置 `fetched_at` 与 `client_version`。
- 2026-08-18：新链路稳定后删除旧 native resolver、bundled debug 与 previous-cache
  fallback，避免保留不可达的第二套 catalog 来源。
- 2026-08-18：类型检查、构建和 47 项相关测试通过；全量 63 项中 62 项通过，既有
  Realtime WebSocket 测试因 Bun `port 0` 返回 `EADDRINUSE` 未通过。
