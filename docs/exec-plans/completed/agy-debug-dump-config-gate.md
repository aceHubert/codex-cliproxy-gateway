# 执行计划：debug 落盘开关（config --debug）与调试文件归入 logs 目录

## 目标

上游调试转储（当前为 agy 上游 400 时完整请求体落盘）由 `config.json` 的 `debug` 布尔开关控制、默认关闭，文件统一写入请求日志目录（logs），不再散落在 runtimeHome 根目录；CLI 通过 `codex-cliproxy config --debug on|off` 切换。

## 范围

- 包含：
  - `GatewayConfig` 新增 `debug?: boolean`（缺省视为 false），同步 `schemas/gateway-config.schema.json`。
  - CLI `config` 命令新增 `--debug on|off`：复用 `onOffValue` 解析、加入 `COMMAND_OPTIONS.config` 白名单、更新 usage 文本；无参数输出增加 `debug` 字段。
  - `src/agy/index.ts` 的 400 调试落盘：仅当 `config.debug === true` 时写入；目标路径改为 `config.logDir || path.join(path.dirname(config.catalogPath), "logs")`（与请求日志同一目录解析规则），文件名保持 `agy-debug-400.json`，保留 atomicWrite 单文件覆盖语义。
  - README「配置与日志」小节补 `--debug on|off` 说明。
  - 测试：agy 适配器 debug 开/关两种路径的落盘断言；`config --debug` 的持久化与审计断言。
- 不包含：
  - Web UI 的 debug 开关（`applyWebUiConfigPatch` 白名单与 ConfigPage 不动），完成后登记到 tech-debt-tracker。
  - 其他适配器（zcode/qoder/codebuddy/zen）接入 debug 开关——它们目前没有调试落盘行为。
  - 调试文件的时间戳多文件保留/轮转——维持单文件覆盖写，不参与 `pruneLogDir` 保留计数。
  - 旧位置（runtimeHome 根目录）存量 `agy-debug-400.json` 的自动迁移或清理——保持简单，用户可手工删除；不做额外状态机。

## 背景

- 相关代码路径：
  - `src/agy/index.ts:302-324`：`AgyTransportError` 且 `status === 400` 时，无条件 `atomicWrite` 到 `path.dirname(config.catalogPath)/agy-debug-400.json`，即 runtimeHome 根目录（默认 `~/.codex-cliproxy-gateway/`）。内容含 `request_body`（完整提示词），仅用于本机离线重放验收。
  - `src/agy/index.ts:115-119`：请求日志 sink 的目录解析惯例 `config.logDir || path.join(path.dirname(config.catalogPath), "logs")`（`webui.ts:208` 同一规则）。
  - `src/cli.ts`：`configCommand`（约 1686 行起）开关模式、`onOffValue`（1537 行）、usage 文本（135、178-195 行）、`COMMAND_OPTIONS.config` 白名单（1984 行）。
  - `src/config-update.ts`：CLI 与 Web UI 共享的配置写入/审计路径；本期不改 `SUPPORTED_PATCH_FIELDS`。
  - `src/toml.ts:140`：`atomicWrite` 自带 `mkdirSync(recursive)` 与 0600 权限，logs 目录不存在时可直写。
  - `src/request-log.ts:92`：`REQUEST_LOG_NAME` 只识别请求日志文件名，`agy-debug-400.json` 不匹配——既不会被保留计数误删，也不占用请求日志配额。
- 已知约束：
  - AGENTS.md 红线：修改 config.json 字段必须同步 schema 并补测试。
  - `debug` 与 `requestLogging` 是两个独立开关：debug 只管调试转储，不依赖也不开启请求日志；`config --debug on` 时若 `logDir` 未设置，按请求日志同一规则落到默认 logs 目录（不强制回填 `logDir` 字段）。
  - `--debug` 属纯日志类选项，不触发 models 缓存失效（`invalidateModels: false`），与 `--log`/`--max-log-size` 同类。

## 风险

- 风险：行为变更——现状是无条件落盘，改后默认关闭；已依赖该文件排查 400 的人会突然「丢日志」。
  缓解：默认关闭是安全取向（文件含完整提示词，属于敏感载荷，显式 opt-in 更合理）；启用只需一条命令；README 与配置输出中写明开关位置与文件路径。
- 风险：`debug` 语义被误解为「打开所有详细日志」（请求日志、进程日志冗余）。
  缓解：schema 描述与 usage 明确限定为「上游错误调试转储（当前仅 agy 400 完整请求体）」；命名沿用 `debug` 但文档说明边界。
- 风险：debug 开启但 `requestLogging` 关闭时 logs 目录可能尚未存在。
  缓解：`atomicWrite` 已递归建目录，无需额外处理；实现时以测试覆盖该场景。

## 里程碑

1. 方案收敛（本计划 + 决策记录）。
2. 配置字段与 schema：`src/types.ts` 增加 `debug?: boolean`；`schemas/gateway-config.schema.json` 增加同名 boolean 属性及描述。
3. CLI 开关：`cli.ts` 的 usage、`COMMAND_OPTIONS.config`、`configCommand`（`--debug on|off` 解析、applied 提示、无参数输出增加 `debug`），走既有写盘→审计→重启管线。
4. agy 落盘改造：`src/agy/index.ts` 400 分支按 `config.debug === true` 门控，路径改到 logs 目录（解析规则与 sink 一致，直接独立计算，不复用仅 requestLogging 存在时的 `sink.dir`）。
5. 测试与收尾：新增/调整测试；`bun run check` 全绿；tech-debt 登记 Web UI 延后项；按 HISTORY_GUIDE 写历史记录并归档本计划。

## 验证方式

- 命令：
  - `bun test test/agy-gateway.test.ts test/gateway.test.ts`
  - `bun run typecheck && bun test && bun run build`（即 `bun run check`）
- 手工检查：
  - 临时目录安装（`serve --config` 或测试注入）后 `config --debug on`，无参数 `config` 输出包含 `debug: true`。
  - debug=off 时触发 agy 上游 400：logs 目录与 runtimeHome 根目录均不出现 `agy-debug-400.json`。
  - debug=on 时触发 agy 上游 400：`<logDir>/agy-debug-400.json` 存在且含 `request_body`/`upstream_error`；runtimeHome 根目录不再产生新文件。
- 观测检查：
  - `config --debug on` 落审计到 gateway.log（`recordConfigChange` 的 `debug` 字段 before/after）。
  - `pruneLogDir`（`--max-request-logs` 生效时）不删除 `agy-debug-400.json`。

## 进度记录

- [x] 调研现状：确认 400 落盘唯一来源为 `src/agy/index.ts`，无其他适配器写调试文件。
- [x] 完成 `debug` 字段与 schema 更新。
- [x] 完成 CLI `--debug on|off` 开关。
- [x] 完成 agy 落盘门控与目录迁移。
- [x] 完成测试与 `bun run check` 验证，登记 tech-debt，写历史记录并归档计划。

## 决策记录

- 2026-10-09：`debug` 默认 false。理由：调试转储含完整提示词（敏感载荷），安全默认应为显式开启；现状无条件落盘是排查 400 的临时便利，转为开关后接受一步启用成本。
- 2026-10-09：CLI flag 命名为 `--debug on|off`、配置字段 `debug`，与其他布尔开关（zcode/agy/log）形态一致；`onOffValue` 直接复用，无需新解析器。
- 2026-10-09：调试文件保持单文件覆盖写（`agy-debug-400.json`）并落在请求日志目录，但不参与请求日志保留计数（`.json` 不匹配 `REQUEST_LOG_NAME`）；单文件覆盖天然不膨胀，无需轮转。
- 2026-10-09：Web UI 开关本期不做——`SUPPORTED_PATCH_FIELDS` 与 ConfigPage 的改动面（表单、i18n、api.ts）远大于 CLI 一个 flag，独立成后续任务并登记 tech-debt。
- 2026-10-09（实施）：启用 debug 的 applied 提示中直接带出落盘目录（复用 `config.logDir || paths.logDir` 的解析结果），但不回填 `logDir` 字段——目录解析在 agy 适配器内按同一规则独立计算，回填会引入「CLI 写了但 Web UI 看不到原因」的假字段。
- 2026-10-09（缺陷修复）：上一条的 `paths.logDir` 回退被用户复现出分叉——自定义 catalogPath、省略 logDir 时提示指向默认运行目录、实际写入 catalog 同目录。修正：把回退规则提升为 `src/request-log.ts` 的共享 `requestLogDir(config)`，运行时 8 处内联实现与 CLI 提示/无参输出/`--log on` 回填、Web UI patch 回填全部统一到它；回填持久化运行时实际目录而非默认安装目录；新增回归测试（test/gateway.test.ts「config 日志目录提示与运行时回退规则一致」）。
