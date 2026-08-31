## [2026-08-30 16:12] | Task: 收敛 CLI 命令并移除 websocket 开关

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3-Flash`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 纠正几个问题：1、websocket 的配置不需要了，都应该由上游来判断返回即可；2、models --sync 中的配置再重了，很多情况是不需要选择模型了，应该把一些配置单独设置 config --cpaOnly 这样，这些只需要重启网关的配置，log on/off 也可以合并成 config --log on/off 这样，然后 models --select pass 这个 pass 也可以去掉了，分析一个命令参数给一个修改方案。补充：多个参数时不要重置默认，只对带参数的做修改；需要记录每次配置被改的记录到网关日志下。

### 🛠 Changes Overview
**Scope:** CLI（src/cli.ts）、网关路由（src/gateway.ts）、请求日志（src/request-log.ts）、配置契约（types/schema）、测试与文档

**Key Actions:**
- **[移除 websocket 开关]**: 删除 `GatewayConfig.websocket`、`--websocket` 参数、Schema property 与 healthz/status 字段；`responsesWebSocketTarget()` 不再门控，CPA WS 一律桥接、由上游按请求判断，上游拒绝走既有 426 降级路径。
- **[新增 config 命令]**: `config` 打印当前设置；`--cpa-only on|off` 定向切换路由模式并同步 config.toml `model_catalog_json`（含非受管守卫）；`--log on|off` 取代 `log on|off`；多设置合并生效、单次重启、已满足即 no-op；未传入字段一律不动。
- **[配置审计]**: `logConfigChange()` 把 `install`/`models --sync`/`config` 的字段级 `before -> after` 变更追加到 `logs/cliproxy-config-*.log`，含 config.toml 的 `model_catalog_json` 变化，不依赖 requestLogging。
- **[精简 models --sync]**: 不再修改 `cpaOnly`/`websocket` 等路由字段，不再重启网关；删除 `--select pass` 与 `--select`（无值）复用语法。
- **[遗留清理]**: `syncGatewayConfigFile()` 清除老配置中的 `websocket` 残留键。

### 🧠 Design Intent (Why)
`models --sync` 原本同时承担同步目录、选模型、切路由模式、切 WS 开关四件事，且「未传参数回写 false」会隐式重置配置；而 CPA 上游本就按请求决定 WS/HTTP-SSE 回退（此前已移除模型门控），全局开关是最后一层多余门控。此次把低频配置收敛到 `config` 命令、按「只改显式传入项」的语义实现，并把每次配置变更审计到网关日志，便于事后排查路由异常时的配置轨迹。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作区累计，含同日尚未提交的
> split-ws thread 粘性改动，见 `20260828-1133-split-ws-route-reconnect.md`；其中
> `src/gateway.ts`、`test/gateway.test.ts`、`src/realtime.ts`、`models.json` 为两批
> 改动叠加）。

- **Files changed:** 14
- **Insertions:** +648
- **Deletions:** -245

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +205 | -87 |
| `src/gateway.ts` | +49 | -14 |
| `src/request-log.ts` | +32 | 0 |
| `src/types.ts` | 0 | -5 |
| `src/realtime.ts` | +8 | -4 |
| `schemas/gateway-config.schema.json` | 0 | -4 |
| `models.json` | +26 | -6 |
| `test/gateway.test.ts` | +82 | -39 |
| `test/model-catalog-dynamic.test.ts` | +58 | -24 |
| `test/realtime.test.ts` | +31 | -2 |
| `test/app-server.test.ts` | +12 | -9 |
| `README.md` | +11 | -12 |
| `docs/exec-plans/completed/split-websocket-route-reconnect.md` | +131 | -36 |
| `docs/exec-plans/tech-debt-tracker.md` | +3 | -3 |

新增（未计入上方 diff）：`docs/exec-plans/completed/cli-config-command-split.md`、
`docs/histories/2026-08/20260830-1612-cli-config-command-split.md`。

### 📁 Files Modified
- `src/cli.ts`
- `src/gateway.ts`
- `src/realtime.ts`
- `src/request-log.ts`
- `src/types.ts`
- `schemas/gateway-config.schema.json`
- `models.json`
- `test/gateway.test.ts`
- `test/model-catalog-dynamic.test.ts`
- `test/realtime.test.ts`
- `test/app-server.test.ts`
- `README.md`
- `docs/exec-plans/completed/split-websocket-route-reconnect.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/exec-plans/completed/cli-config-command-split.md`（新增）
- `docs/histories/2026-08/20260830-1612-cli-config-command-split.md`（本文件）
