## [2026-09-14 10:40] | Task: Web UI 迁移到独立端口与独立进程，默认不启动

> 动机、方案对比与决策记录详见执行计划 `docs/exec-plans/active/web-config-ui.md`（决策记录 2026-09-14 两条）。

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode Desktop (darwin)`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 🥛 User Query
> 发现在一个问题，ui的各种请求也会被记录到 logs中，logs 只记录模型请求日志
>
> 是不是考虑把 ui换一个端口是不就可以解决，ccr是不是使用的2个不同的端口
>
> 问题是请求不好区别是否到upstream, 转发到上游是一个很严重的问题
>
> 不要这么多，使用不同的端口启动服务天然隔离
>
> 后期如果有功能冲突导致转发到上游产生严重后果
>
> 本轮修改重点是什么，我现在就是想要ccr那样独立的端口以免后期 baseurl 冲突直接转发到上游
> 以及逻辑是默认不启动web, codex-cliproxy web 逻辑为 检查网关状态是否开启，检查web是否启动，再在浏览器中打开 web
>
> 再补充几个命令 web --status 查看 web状态， --restart/stop 重启web服务 和 停止web服务

### 🛠 Changes Overview
**Scope:** codex-cliproxy（`src/webui.ts`、`src/gateway.ts`、`src/cli.ts`、`test/webui.test.ts`、`test/gateway.test.ts`、AGENTS.md、web-config-ui 执行计划）

**Key Actions:**
- **[webui.ts]**: 新增 `webUiPort(config)`（网关端口 + 1）与 `startWebUiServer(config, ctx)`——单独 `Bun.serve` 绑定 `127.0.0.1`，fetch 直进 `handleWebUiRequest`，不经过模型网关的路由、转发与日志包装；网关 host 非 loopback 时不启动；**每个请求重读 config.json**（读失败回落启动快照），CLI 侧配置变更无需重启 UI 进程。
- **[webui.ts]**: `handleWebUiRequest` 增加 `port` 参数，Host 头白名单按 UI 自己的监听端口校验；新增 `GET /favicon.ico` 内联 SVG（深色底 + 主题绿箭标，配色取自 `src/ui/styles.css`）；UI HTML 的 CSP 增加 `img-src 'self'` 放行同源 favicon。
- **[gateway.ts]**: `createGatewayHandler` 与 `startGateway` 移除 `webUi` 参数——**`serve` 不再启动 UI，UI 默认关闭**；模型端口对 `/ui` 与 `/ui/*` 一律本地 404，错误体 hint 指向 `http://127.0.0.1:<port+1>/ui`。fetch 层 `/ui` 拦截保留并改为交给 handler（本地 404），仍先于 WebSocket 桥接分流。
- **[gateway.ts]**: **mountPath 白名单**：新增 `isUnderMountPath`，`handleCore` 对 `mountPath` 子树外的任何路径（`/.well-known/*`、favicon、根路径等）一律本地 404（带 base_url 提示）、绝不转发上游；日志包装层同步改为白名单——只记录 mountPath 子树内的模型流量（`/v1/models` 目录请求除外）。动因：重启后 Chrome DevTools 对 8320 的自动探测仍被转发上游并写日志，证明端口隔离只挡 UI 自身流量、挡不住直连模型端口的浏览器噪声。
- **[launchd.ts]**: 新增 `WEBUI_LAUNCHD_LABEL`、`renderWebUiAgent`（RunAtLoad/KeepAlive 均为 **false**——重启登录后保持关闭，崩溃不自动拉起）与 `startWebUiLaunchAgent`（写 plist + bootout 旧定义 + bootstrap + kickstart）；ProgramArguments 为 `bun <cli> webui --config <config>`，日志指向 `runtimeHome/webui.log`。
- **[cli.ts]**: 新增 `webui` 前台命令（LaunchAgent 的执行体；`--config` 供临时实例调试），SIGTERM/SIGINT 干净关停；`web` 命令重写为三步——检查网关（未运行则启动 LaunchAgent 并等 healthz）→ 检查 UI 端口（未运行则 `startWebUiLaunchAgent` 并等待就绪）→ 打开带 token 的浏览器 URL；子选项 `--status`（打印 UI 是否运行与 URL）、`--stop`（仅停 UI 服务，网关不受影响）、`--restart`（先停再起），互斥校验、布尔 flag 解析与 `COMMAND_OPTIONS.web` 白名单同步；`stop`/`uninstall` 一并 bootout/卸载 UI agent；`removeManagedRuntimeFiles` 清理 `webui.log`；`webui` 纳入命令分发与 usage。
- **[paths/types]**: `ResolvedPaths.webUiLaunchAgent`（`~/Library/LaunchAgents/codex-cliproxy-webui.plist`，临时实例为 `-temp` 占位名，与网关 agent 同规则）。
- **[test/webui.test.ts]**: `makeFixture` 改为直连 `handleWebUiRequest`；Upgrade `/ui` 用例升级为双服务双端口——模型端口 404（绝不桥接上游）、UI 端口 401（缺令牌）；真实 socket 用例改用动态空闲端口（写死 8321 曾与本机生产 webui 服务冲突）；新增「UI 服务每请求重读配置（requestLogging 翻转即刻生效）」与「UI agent 的 plist RunAtLoad/KeepAlive 为 false（默认不启动的结构保证）」用例；favicon 用例（200 SVG 且不产生请求日志）。
- **[test/gateway.test.ts]**: 新增「mountPath 子树外请求本地 404、fetch 零调用、零日志」用例（锁死 well-known/favicon/根路径场景）与「模型端口 /ui 本地 404、hint 指向 8321、fetch 零调用」用例；日志排除用例扩展覆盖 `/ui` 与 `/favicon.ico`。
- **[docs]**: AGENTS.md 安全边界段落改写为「独立端口、独立进程、默认不启动、launchd 按需拉起」模型；README `web` 段落与 usage 同步；执行计划目标、进度与决策记录（2026-09-14 两条）同步。

### 🧠 Design Intent (Why)
* 起因：用户在请求日志目录里发现 `cliproxy-ui-http-*.log` 与 `cliproxy-favicon_ico-http-*.log`。实测确认 `/ui` 的排除逻辑已生效，真正的洞是浏览器打开 UI 时自动请求的 `/favicon.ico`：它不在任何拦截清单里，被原样拼到上游 URL 转发（带 API key 打到 `chatgpt.com/backend-api/codex/favicon.ico`），同时进请求日志并因 404 在 gateway.log 写错误摘要。
* 这暴露的结构性风险比日志污染更严重：**模型端口上任何未识别路径都会落穿到上游转发**。UI 与模型流量同端口意味着未来任何路由功能冲突（新端点、WebSocket 分流、重写规则、baseurl 变更）都可能把 UI 或其他非模型流量转发到上游。用户明确选择 ccr 式双端口方案：隔离靠端口边界而不是路径清单，清单是枚举不完的。
* 独立端口的保证是结构性的：`startWebUiServer` 的处理器闭包里没有上游 URL、没有 API key、没有任何 fetch 转发代码——无论模型网关侧将来怎么改，UI 流量都不可能被发往上游；模型端口的请求日志也因此天然只包含模型流量。
* 第二轮按用户要求改为**默认不启动**：`serve` 不起 UI，`web` 命令负责「检查网关→检查 UI→拉起→打开浏览器」，与 ccr 的 `ccr ui` 语义一致。生命周期选 launchd 而非 detached spawn：与本仓库网关同构的管理方式、RunAtLoad/KeepAlive false 保证重启登录后保持默认关闭、`stop`/`uninstall` 可干净回收、无孤儿进程。（detached spawn 方案先被 Mimosa 命令注入扫描拦截——argv 数组、无 shell 的自重启也被误报；即便不拦截，launchd 方案在这些维度上也更优。）
* 模型端口对 `/ui` 本地 404（而非移除拦截）：旧书签/误访问必须止步于本地，且 fetch 层那道拦截必须先于 `responsesWebSocketTarget`——带 Upgrade 头的 `/ui` 曾被当作可桥接目标转发上游（见既有回归测试）。
* UI 服务每请求重读 config.json：UI 是常驻独立进程后，`config` 命令、`install` 等写入的新配置必须无需重启 UI 即可见（requestLogging 翻转有测试锚定）。
* favicon 顺带补齐：UI 端口浏览器仍会自动请求站点图标，就地返回内联 SVG，避免 UI 端口出现无意义的 404 噪音。

### 📊 Change Stats
> 工作区在本任务进行时带有同一批文件里的其它在途改动（web-config-ui 计划与 credentials/zcode 相关的未提交实现），
> 下表是 `git diff --numstat`（工作区 vs index）的文件级结果，只列出本任务涉及的文件，包含少量不属于本任务的行。

- **Files changed (本任务相关):** 11
- **Insertions:** +689
- **Deletions:** -62

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/webui.ts` | +94 | -12 |
| `src/cli.ts` | +185 | -26 |
| `src/gateway.ts` | +45 | -13 |
| `src/launchd.ts` | +57 | -0 |
| `src/paths.ts` | +15 | -3 |
| `src/types.ts` | +2 | -0 |
| `test/webui.test.ts` | +193 | -3 |
| `test/gateway.test.ts` | +87 | -1 |
| `AGENTS.md` | +1 | -1 |
| `README.md` | +1 | -1 |
| `docs/exec-plans/active/web-config-ui.md` | +8 | -2 |

### 📁 Files Modified
- `src/webui.ts`
- `src/cli.ts`
- `src/launchd.ts`
- `src/gateway.ts`
- `src/paths.ts`
- `src/types.ts`
- `test/webui.test.ts`
- `test/gateway.test.ts`
- `AGENTS.md`
- `README.md`
- `docs/exec-plans/active/web-config-ui.md`

### ✅ Verification
- `bun run check` 全绿：typecheck、312 个测试（含新增 5 个用例）、`build:ui` + 单文件构建。
- 真实 socket 用例：模型端口对 Upgrade `/ui/api/config` 回 404（绝不桥接上游）、UI 端口回 401；UI 服务每请求重读配置（requestLogging 翻转即刻生效）；UI agent plist 的 RunAtLoad/KeepAlive 为 false。
- 真机冒烟（生产 config，前台 `bun run dev webui`）：`/ui` 200 HTML、`/favicon.ico` 200 SVG、`/ui/api/status` 无令牌 401、带令牌返回正常 status（无敏感字段）、请求日志目录无任何 UI 噪音；进程可干净终止。
- 真机生命周期（launchd）：`web --restart` 写入 plist 并拉起 `codex-cliproxy-webui`（launchctl 可见、8321 服务 200）→ `web --status` 报 running 与 URL → `web --stop` 干净停止（端口关闭）；`--status --stop` 组合报错；`serve --stop` 被按命令白名单拒绝。
- mountPath 白名单真机验证（临时实例，端口 8417）：`/.well-known/appspecific/com.chrome.devtools.json`、`/`、`/favicon.ico` 均本地 404（JSON 错误体带 base_url 提示），`/healthz` 200，日志目录零文件；生产网关重启前实测 well-known 仍被转发并产生日志（102→103 个文件），重启后由白名单拦下。
- 生产 LaunchAgent 网关仍在运行旧代码：`serve` 不再启动 UI 与 `/ui` 本地 404 需随下一次重启/发布生效；`web` 拉起的 UI agent 与之独立、立即可用（执行计划已登记「真机收尾」待办）。
