# new-api 上游连接与模型目录本地生成

## 目标

网关支持把第三方上游从 CLIProxyAPI 切换为 new-api（OpenAI 兼容网关）：`install --upstream-type newapi` 后，目录同步从 new-api 的 OpenAI `/v1/models` 列表本地合成 Codex catalog 条目，Codex `/model` picker 能看到并使用 new-api 的模型；路由、认证、请求转发链路全部复用现有 cliproxy 数据面。

## 范围

- 包含：`upstream_type` 配置字段（types/schema/审计/状态输出）、`fetchUpstreamCatalog` 统一目录拉取入口、`synthesizeModelEntry` 合成模板、models.json 覆盖规则的裸模型名别名匹配、install `--upstream-type` 选项、测试、README。
- 不包含：install 之外的上游切换命令、`cliproxyBaseUrl`/keychain/env 变量重命名、运行时动态刷新 new-api 模型列表（与 CLIProxy 一致，仅 `models --sync` 时拉取）、`models.json` 内容变更。

## 背景

- 相关文档：调研会话结论（new-api 无 Codex catalog 端点，`/v1/models` 仅返回 OpenAI `{"data":[{id}]}`）；`docs/model-catalog-dynamic-refresh.md`。
- 相关代码路径：`src/catalog.ts`（目录拉取/覆盖/落盘）、`src/cli.ts`（install/models --sync/审计）、`src/types.ts`、`schemas/gateway-config.schema.json`。
- 已知约束：合成条目字段集必须能被当前 Codex 解析（对齐仓库 models.json 中 deepseek/z.ai 条目字段集）；`upstream_type` 进 JSON Schema 且需同步扩展 `src/config.ts` 内置校验器的 enum 支持；旧配置由 `mergeMissingConfig` 自动回填默认值。

## 风险

- 风险：合成条目缺少 Codex 必填字段导致 catalog 解析失败（Codex 启动即报错）。
  缓解：模板字段集完全对齐现有 z.ai/deepseek 覆盖条目（已在生产验证可解析），context_window 取保守值 128000。
- 风险：裸名别名匹配让通配规则误伤其他组模型。
  缓解：`name === "*"` 的通配全部规则不加裸别名，保持组前缀作用域。
- 风险：new-api 聚合渠道模型列表很大（数百条）。
  缓解：拉取后去重排序，选择仍走 chooseModels/`--select`。

## 里程碑

1. 配置字段与 schema（types/config 校验器/cli DEFAULTS/审计/status）。
2. 目录合成（fetchUpstreamCatalog + synthesizeModelEntry + 裸名别名匹配）。
3. install/models 接线与消息、usage 文档。
4. 测试与 README，`bun run check` 全量验证，收尾记录。

## 验证方式

- 命令：`bun run check`（typecheck + node:test 全量 + 构建）。
- 手工检查：`bun run dev install --upstream-type newapi --cliproxy-url https://<newapi>/v1 --cpa-only --select all` 后检查 `~/.codex-cliproxy-gateway/cliproxy-catalog.json` 条目字段。
- 观测检查：`codex-cliproxy status` 输出 `upstreamType`；`bun run dev models` 列出 new-api 模型。

## 进度记录

- [x] 确认范围和约束（计划已批准）。
- [x] 配置字段与 schema（types/config enum 校验器/DEFAULTS/审计/status）。
- [x] 目录合成与裸名别名匹配（fetchUpstreamCatalog/synthesizeModelEntry）。
- [x] install/models 接线与文档（usage/README "Using a new-api upstream"）。
- [x] 完成验证并记录结果：`bun run check` 通过（typecheck + 116 测试 + 构建）；本地 mock new-api 冒烟验证排序去重、z.ai/deepseek 裸名覆盖命中（1048576）、未知模型保守默认（128000）。

## 决策记录

- 2026-09-08：配置用显式 `upstream_type: "cliproxy" | "newapi"`（默认 cliproxy），而非按响应自动检测——行为可预期、进 schema、可审计；路由模式维持现状（默认 split，`--cpa-only` 显式全切），不对上游类型做特判。
- 2026-09-08：非 openai 组的覆盖规则编译出 `组名/名称` 与裸 `名称` 两个模式，使 models.json 既有 z.ai/deepseek 元数据自动套用到 new-api 裸模型 ID；通配全部规则（`*`）不加裸别名。
- 2026-09-08：new-api 模型 ID 按大小写不敏感去重（`gpt-5.2` 与 `GPT-5.2` 视为同一模型），保留先出现的写法作为 catalog slug；合成条目 `context_window` 保守取 128000，宁小勿大防上下文溢出。
