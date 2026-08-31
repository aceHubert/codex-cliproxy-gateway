# CLI 命令收敛：config 命令、websocket 开关移除与配置审计

> **最终语义（2026-08-30 评审后）**：`--cpa-only` 已回归
> `models --sync --cpa-only`，无 flag 的 `models --sync` 切回 split；`config`
> 只保留设置打印与 `--log on|off`。模式实际变化时自动重启网关；带参数的
> `config` 每次写盘后都重启网关以重新加载配置。`install`、`uninstall`、
> `restart` 和 `models --sync` 都接受 `--restart-codex`，用于在写入受管
> `config.toml` 后停止旧 Codex app-server。手工修改配置文件不会触发重启。
>
> **参数名恢复（2026-08-31）**：2026-08-30 评审中曾将 `--restart-codex` 更名为
> `--codex-restart`；该更名已撤销，当前提示与示例统一使用 `--restart-codex`。
>
> 下方“目标”“范围”和早期验收步骤保留了首版实施轨迹，不作为当前
> CLI 操作指南；当前用法以 README 与文末“评审后修订”决策为准。

## 目标

把低频的路由/日志配置从 `models --sync` 中拆出，收敛为 `config --cpa-only on|off` 与
`config --log on|off`；删除 `websocket` 配置字段与 `--select pass` 特殊语法，使 CPA
WebSocket 完全由上游按请求判断；每次真实配置变更都审计到网关日志目录。

## 范围

- 包含：
  - 删除 `GatewayConfig.websocket`、`models --sync --websocket` 参数与 JSON Schema 中
    的 `websocket` property；`responsesWebSocketTarget()` 不再做网关侧门控，CPA 路由
    的 WS 升级一律桥接 CLIProxy，上游拒绝时由既有拨号失败路径回 426 降级 HTTP/SSE。
  - 新增 `config` 命令：无参数打印当前设置；`--log on|off` 取代
    `log on|off`；每次带参数的配置写入后统一重启网关。
  - `models --sync --cpa-only` 切换 CPA-only，无 flag 的 `models --sync` 切回
    split；删除 `--select pass` 与 `--select`（无值）复用语法。
  - 配置审计：`install`、`models --sync`、`config` 的真实字段变更以
    `logs/cliproxy-config-*.log` 落盘，含 config.toml 的 `model_catalog_json` 变化，
    不依赖 requestLogging 开关，与请求日志共用保留策略。
  - `syncGatewayConfigFile()` 清理老配置中的遗留 `websocket` 键。
  - 更新 usage、README、类型注释、JSON Schema 与测试。
- 不包含：
  - CPA WebSocket 帧级协议兼容、透明热换上游、连接池（仍属
    `split-websocket-route-reconnect.md` 的真机验收范围）。
  - `config` 命令暴露 `maxRequestLogs`、`logDir` 等其余字段的编辑入口（模式已预留，
    按需追加）。
  - `install` 的整体重置语义（安装仍是全新配置写入，路由模式重置为 split）。

## 背景

- 相关文档：
  - `docs/exec-plans/completed/split-websocket-route-reconnect.md`（决策记录
    2026-08-30：移除 websocket 开关）
  - `docs/exec-plans/tech-debt-tracker.md`（2026-08-30 行）
  - `docs/exec-plans/completed/cpa-only-websocket-forwarding.md`
- 相关代码路径：
  - `src/cli.ts`：`configCommand()`、`applyModelCatalogToml()`、`recordConfigAudit()`、
    `models()`、`runCli()` 参数守卫。
  - `src/gateway.ts`：`responsesWebSocketTarget()`、`/healthz`。
  - `src/request-log.ts`：`logConfigChange()`。
  - `src/types.ts`、`schemas/gateway-config.schema.json`、`README.md`。
- 已知约束：
  - AGENTS.md 要求修改 config 字段必须同步 JSON Schema 与测试。
  - `models --sync [--cpa-only]` 在切换模式时同时 patch
    `~/.codex/config.toml` 的受管键，沿用「拒绝替换非受管
    model_catalog_json」守卫。
  - 用户裁决：多参数操作只修改显式传入的字段，不重置未指定配置；CPA-only 目录继续
    按选择筛选；`--select` 保持手动选择语义。

## 风险

- 风险：删除 `websocket` 开关后，split 模式 CPA WebSocket 从默认 426 降级变为默认
  尝试桥接，上游拒绝时客户端多一次失败握手再降级。
- 缓解方式：真机已实证 426 降级与 1012 重握手两条恢复路径（见
  `split-websocket-route-reconnect.md` 的 2026-08-28/2026-08-30 复盘）；回滚手段为
  恢复网关侧门控代码，已记入技术债。
- 风险：配置审计写入失败或路径缺失。
- 缓解方式：审计复用 `append()` 的吞错语义，绝不阻塞命令流程；目录按
  `logDir || dirname(catalogPath)/logs` 递归创建。

## 里程碑

1. 删除 websocket 配置与网关侧门控，收敛 schema/类型/healthz/status。
2. 实现 `config` 命令（定向 patch、写盘后统一重启）与配置审计。
3. 精简 `models --sync` 并删除 `log` 命令与 pass 语法。
4. 测试矩阵更新与 `bun run check` 收口。

## 验证方式

- 命令：
  - `bun test`
  - `bun run typecheck`
  - `bun run check`
- 手工检查：
  - `bun run dev config` 打印当前设置。
  - `bun run dev config --log on` 后请求日志落盘，重复执行仍重启网关。
  - `models --sync --cpa-only --restart-codex` 后 `status` 显示 `cpaOnly: true`，
    config.toml 出现受管 `model_catalog_json`。
  - `models --sync --websocket` / `--select pass` 报参数错误。
  - 每次变更后 `logs/cliproxy-config-*.log` 追加一条 `field: before -> after` 记录。

## 进度记录

- [x] 删除 websocket 配置与网关侧门控。
- [x] 实现 `config` 命令与配置审计。
- [x] 精简 `models --sync`、删除 `log` 命令与 pass 语法。
- [x] 测试矩阵更新，`bun run check` 全绿。
- [x] README、split-websocket 计划、技术债与历史记录同步。
- [x] 评审修复（2026-08-30 第二轮）：TOML 单引号绕过、preflight 审计缺口、URL 脱敏、
  参数白名单、pendingRestart 重试、`--cpa-only` 切换回归 `models --sync`
  （`config --cpa-only` 移除，P1 空目录与 TOML no-op 两项随入口删除闭合）。

## 决策记录

- 2026-08-30：CPA WebSocket 不再保留任何网关侧开关；「由上游判断返回」是最终语义，
  回滚 = 恢复门控代码而不是配置项。
- 2026-08-30：`config` 命令采用定向 patch——先读当前值、仅覆盖显式传入项；
  带参数的每次调用都写盘重启，让网关重新加载完整配置。
- 2026-08-30：审计格式沿用日志分组惯例（每条一个文件、`maxRequestLogs` 裁剪），
  记录字段级 `before -> after`，敏感凭据本就不存于 config.json（Keychain），无需遮蔽。
- 2026-08-30（最终语义）：`models --sync --cpa-only` 与无 flag 的
  `models --sync` 显式选择两种路由模式；`--select pass` 及 `--select` 无值
  复用语法删除，选择回到纯手动（picker 或显式值）。
- 2026-08-30（评审后修订）：`--cpa-only` 切换回归 `models --sync`——模式切换与
  `--restart-codex` 绑定，必须一步到位；`config` 不再承担模式切换。模式由 flag 显式
  选择（无 flag = split），与「不重置默认」不冲突：websocket 开关已删除、不会被回写。
- 2026-08-30（评审后修订）：重启采用 persist → restart 顺序，失败在 state.json 留
  `pendingRestart`，下一次 `models --sync` / `config` 自动补一次重启；审计对 URL
  query 统一脱敏（diff 仍按原始值比较），preflight 写盘同样留审计。
- 2026-08-30（重启语义收敛）：无参数 `config` 只查询；任何带参数的
  `config` 调用都写盘并重启网关，不再根据目标值是否已匹配跳过重载。
  所有会写受管 `config.toml` 的命令统一接受 `--restart-codex`。
