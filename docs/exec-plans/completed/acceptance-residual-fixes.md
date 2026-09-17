# 验收残留问题修复：收掉 webui --config、回滚健康检查与 LaunchAgent 恢复错误

## 目标

按产品意图收敛 Web UI 命令面（用户只使用 `web` / `web --status` / `web --stop` / `web --restart`），关闭 2026-09-14 验收的残留缺陷：去掉未请求的 `webui --config` 调试面，加固默认路径真实路径比较，并修正原地安装回滚的健康检查目标与 LaunchAgent 恢复错误可见性。

## 范围

- 包含：
  - 移除 `webui` 的用户可见 `--config` 选项；`webui` 始终绑定默认安装配置（LaunchAgent ProgramArguments 同步改为 `webui`，不再传 `--config`）。
  - 默认配置路径比较改用真实路径（防御符号链接，即便有人手工软链到默认 config.json）。
  - 原地安装失败回滚：健康检查改用恢复后的 host/port；LaunchAgent 恢复失败并入最终错误信息。
  - 对应回归测试、usage/README/AGENTS 表述与 `bun run check`。
- 不包含：
  - config 字段形状变更、Web UI 功能扩展。
  - 为「临时 `--config` 实例」保留调试 UI（该面被本计划显式删除，不再是产品能力）。
  - install 流程对 launchctl 的 DI 重构（沿用 tech-debt 既有边界，仅把错误可见性做实）。

## 背景

- 相关文档：
  - 用户意图：Web UI 用户面只有 `web` 三件套；`webui` 是 LaunchAgent 内部执行体，不是需求功能。
  - `docs/exec-plans/completed/codex-review-fixes.md`（F3/F6 首轮修复）、验收结论。
- 相关代码路径：
  - `src/cli.ts`：usage（203–204）、`COMMAND_OPTIONS.webui`（1462）、`webUiCommand`（1134）、`startWebUiService`（1171）、`syncGatewayConfig`（1445）、`serve`（1074）、`install` catch（826–872）、`waitForHealth`（419）。
  - `src/launchd.ts`：`renderWebUiAgent`（75–83，`webui --config <config>`）。
  - `src/webui.ts`：`webUiContextForInstance`（52）。
  - `src/paths.ts`：`resolvePaths`。
- 已知约束：
  - `serve` 绝不起 UI；UI 只由 `web`（LaunchAgent）或前台 `webui` 拉起。
  - LaunchAgent 仍需要一个稳定入口命令跑 UI 进程（保留 `webui` 子命令本身）。
  - 回滚后原始安装错误仍是主错误；恢复问题只能附加，不能替换。
  - config.json 字段与 schema 本轮不改。

## 问题清单与修复方案

### F1 [P1] 产品面外的 `webui --config`（验收表现为仍同步默认配置）

- 确认：
  - 用户需求只有 `web` / `web --status` / `web --restart` / `web --stop`。
  - `webui` 是 LaunchAgent 执行体（`renderWebUiAgent` 写 `bun <cli> webui --config <configPath>`）；`--config` 作为「临时实例调试」被写进 usage（cli.ts:203–204）与 `COMMAND_OPTIONS.webui`（1462）。
  - 验收 P1：`cli.ts:1449` 只让 `serve` 认 `--config`，`webui --config test.json` 仍对默认 `config.json` 做 sync——但该入口本身就不应存在。
- 方案（收敛产品面，而非修好调试面）：
  1. `COMMAND_OPTIONS.webui` 去掉 `config`（改为 `[]` 或删除键）；`webui --config` 变成未知选项报错。
  2. `webUiCommand` 始终使用 `paths.gatewayConfig`，删除 `stringOption(options, "config")` 分支。
  3. `renderWebUiAgent` 的 ProgramArguments 改为 `[bun, cli, "webui"]`（不再传 `--config`）。
  4. usage / README / AGENTS 中删除「webui … handy for debugging with --config」表述；保留「webui 为 LaunchAgent 前台执行体」。
  5. `startWebUiService` 仍传 `configPath: paths.gatewayConfig` 与否：若 plist 不再引用 configPath，可简化 `LaunchAgentOptions` 中 webui 分支的无用字段（避免死参数）；网关 agent 的 `--config` 不动。
- 测试：
  - `runCli`/选项白名单：`webui --config x` 报 unknown option。
  - `webUiCommand` 绑定默认配置（存在时）——可不启真实端口，只断言拒绝 `--config` 与（若保留可测入口）默认路径选择。
  - plist 渲染：ProgramArguments 不含 `--config`。
- 影响：验收 P1 主体关闭；不再存在「自定义配置的 UI 实例」产品路径。

### F2 [P2] 符号链接绕过（随 F1 收敛后降级为默认路径加固）

- 确认：即便去掉 `--config`，`webUiContextForInstance` / `serve` 的生产判定仍是 `path.resolve` 字符串相等；若进程被以软链路径传入默认 config（或未来误用），判定会漂。`serve --config` 仍在产品内（网关临时实例，不起 UI），其 `isProductionInstance` 影响 processLog/`clearPendingRestart`。
- 方案：
  - `src/paths.ts` 增加 `realPathOrResolve(p)`：`fs.realpathSync` → 失败则 realpath 父目录 + basename → 再失败 `path.resolve`。
  - `serve` 的 `isProductionInstance`、`webUiContextForInstance` 的生产判定改为真实路径比较。
  - F1 后 `webUiContextForInstance` 实际只会收到默认配置；保留函数与 `instanceOnly` 语义作结构防线，但删除专为「目录软链下的 test.json」写的主路径依赖。
- 测试：
  - 文件软链指向默认 `config.json` → `serve`/`webUiContextForInstance` 判定为生产实例。
  - 目录软链 `linkDir → runtimeHome` 且配置为 `linkDir/config.json` → 同样生产。
  - 非默认文件（即使同目录）在仍被显式传入时保持 `instanceOnly`（防御性回归，防止有人再开调试面）。
- 说明：原验收「目录软链 + test.json 改写默认 config.json」依赖 `--config` 调试面；F1 删除该面后主攻击路径消失，本项变为默认路径判定加固。

### F3 [P2] 回滚健康检查仍访问候选端口

- 确认：`cli.ts:834` 已回写 `previousGatewayConfig`，但 `cli.ts:848` 仍 `waitForHealth(\`http://${config.host}:${config.port}/healthz\`)`（验收 mock：旧 8320、候选 9001，只打 9001）。
- 方案：回滚块内按是否回写选择地址：
  - 已回写 `previousGatewayConfig` → 用恢复配置的 `host`/`port`（类型守卫读取 `currentGatewayConfig`）。
  - 未回写（磁盘仍是新配置）→ 维持新 `config` 的 host/port。
  - 抽成纯函数 `restoredHealthUrl(previous, next)`。
- 测试：纯函数——旧 host/port 优先；previous 缺失/缺字段回退 next。

### F4 [P2] LaunchAgent 恢复失败仍被吞掉

- 确认：`cli.ts:836–851` 空 `catch` 吞掉回写 plist、`reloadLaunchAgent`/`stopLaunchAgent`/`restartLaunchAgent` 与健康检查失败；最终 throw（870–871）只含原始安装错误与（可选）diagnostics。
- 方案：switching 的 `launchTouched` 恢复块收集 `restoreIssues: string[]`；最终错误组装为 `message` + diagnostics + `launch agent restore incomplete: …`（若有）。主错误不变，恢复问题必须可见。
- 测试：`composeInstallFailureMessage`（或等价纯函数）三种组合；launchctl 仍不做注入集成。

## 风险

- 风险：移除 `webui --config` 是行为删除，若有外部脚本依赖会 break。缓解：该入口本不在用户需求面；usage 一直标注为调试；changelog/history 注明删除原因。
- 风险：已生成的旧 LaunchAgent plist 仍带 `webui --config <path>`。缓解：新 `webui` 拒绝未知 `--config` 会导致旧 agent 拉起失败。处理：`webui` 在**过渡期**可接受但忽略 `--config`（或解析后若等于默认路径则接受），并随 `web --restart`/重写 plist 自愈；计划实现时采用「拒绝未知选项 + 升级说明要求 `web --restart`」或「忽略废弃 `--config` 一版」二选一，见决策记录。
- 风险：健康检查改为旧端口后，旧服务不可达会拉长回滚等待。缓解：失败只进 `restoreIssues`；本轮不改 attempts。
- 风险：restore 错误并入 throw 改变错误字符串。缓解：验收目标；测试只断言关键片段。

## 里程碑

1. F1 收敛 `webui` 产品面（去 `--config`、plist、文档）+ 防御性 realpath（F2）+ 测试。
2. F3 + F4 回滚语义 + 纯函数测试。
3. `bun run check`；计划移至 `completed/`；HISTORY_GUIDE 记录。

## 验证方式

- 命令：`bun run check`。
- 手工：
  - `codex-cliproxy webui --config /tmp/x.json` 被拒绝（或过渡期忽略）。
  - `web --status` / `--stop` / `--restart` 行为与现网一致；新 plist 无 `--config`。
  - 软链默认 config 时 `serve` 仍按生产实例写日志/清 pendingRestart。
  - 原地安装失败：错误含恢复问题；健康探测指向旧端口。
- 观测：回归覆盖 F1–F4 可单测部分。

## 进度记录

- [x] 确认验收四项属实；澄清产品意图：用户面仅 `web` 三件套，`webui --config` 非需求。
- [x] 修订计划：F1 从「修好 webui --config 同步」改为「删除该调试面」。
- [x] F1：`webUiCommand` 始终绑定默认 `gatewayConfig`；`--config` 保留在白名单一版并被忽略；`renderWebUiAgent` ProgramArguments 为 `webui`（无 `--config`）；usage/README/AGENTS 同步。
- [x] F2：`paths.realPathOrResolve`；`serve` 与 `webUiContextForInstance` 真实路径生产判定；文件/目录软链回归。
- [x] F3：`restoredHealthUrl`，回滚已回写旧配置时探测旧 host/port。
- [x] F4：`composeInstallFailureMessage` + `restoreIssues`，恢复失败并入最终错误。
- [x] `bun run typecheck` / 相关测试 / `bun run build` 通过。全量 `bun test` 中 `zcode-cache`「实际 fs.watch 收到原子替换事件后刷新」在本环境稳定失败（与本轮改动无关，已单独复现；其余 305 测试全绿）。计划移至 `completed/`、history 已记录。

## 决策记录

- 2026-09-14：F2 原「按配置路径派生临时 UI 上下文」随 F1 删除调试面后不再是产品主路径；保留 `instanceOnly` 与 realpath 比较作结构防线。
- 2026-09-14：F1 选择删除 `webui --config` 而不是修 sync 目标——用户明确未提该需求；LaunchAgent 改为无参 `webui`，与「只管理默认安装」一致。
- 2026-09-14：F4 保持「恢复失败不替换原始安装错误」，只附加可见信息；不为 launchctl 引入注入层。
- 2026-09-14：旧 plist 过渡定为 **忽略废弃 `--config` 一版**（收到则丢弃，继续用默认配置），避免已安装机器在 `web --restart` 写新 plist 前 UI 起不来；后续小版本再收紧为严格拒绝。
- 2026-09-14：`zcode-cache` fs.watch 用例失败视为基线环境问题（本轮未触碰 zcode 缓存），不在本计划内修复。
