# Web 配置界面（/ui）：配置编辑 + 日志查看

## 目标

在网关进程外提供一个刻意保持简单的本地 Web 配置页（不做 ccr 那样的多 Tab 控制台）：Web UI 是网关的内建基础能力，运行在独立 UI 端口（网关端口 + 1）的 `/ui` 路径上，默认不启动、由 `codex-cliproxy web` 按需拉起并打开浏览器（`webui` 命令可前台运行）；主页面是一张按 `schemas/gateway-config.schema.json` 现有字段生成的配置表单，header 提供「全屏日志查看」「中英文切换」「保存」三个控件；保持 UI 单页自包含与 CLI 单文件入口不变。

## 范围

- 包含：
  - 网关提供 `/ui` 单页与 `/ui/api/*` JSON 接口；React SPA 由 Vite 构建为自包含 HTML，页面文案中英文可切换（技术字段名不译）。
  - 表单主体按 schema 字段分两组：「运行行为」可编辑组（`zcode`、`requestLogging`、`maxRequestLogs`、`maxGatewayLogBytes`，全部为 config 命令已支持的现有字段）与「安装配置」只读组（`upstreamBaseUrl`、`upstream_type`、`upstreamOnly`、`host`/`port`、`prefix`、`selectedModels`、`catalogPath`，标注由 install/models 命令管理）。
  - header：「日志」按钮打开全屏日志视图（覆盖地址栏以下的整个窗口：`gateway.log` 尾部单栏；请求日志目录为左右分栏——文件表 + 内容预览）、「中/EN」语言切换、「保存」按钮（dirty 检测，无改动禁用；保存弹确认层说明网关将重启）。
  - 写盘后复用「审计 + pendingRestart + launchctl kickstart 重启」语义。
  - CLI：`codex-cliproxy web`——检查网关健康（healthz），未运行则经 LaunchAgent 启动并等待健康，随后打印带 token 的 /ui URL 并用 `open` 打开浏览器；Web UI 无独立启停开关，生命周期完全跟随网关。
  - 安全边界：UI token 文件（0600）、loopback 绑定校验、Host 头校验（防 DNS rebinding）、`/ui/api/*` token 鉴权、CSP、无 CORS 头。
  - 配置面零侵入：不新增任何 config.json 字段，`schemas/gateway-config.schema.json` 无变更。
- 不包含：
  - 修改 `upstreamBaseUrl` / `upstream_type` / `port` / `prefix` / 模型选择——这些属于 `install` / `models --sync` 的写路径（涉及目录重建、config.toml 受管键与密钥校验），UI 只读展示并提示用命令行。
  - 多用户/远程访问：UI 仅 loopback 可用，`config.host` 非 loopback 时 `/ui` 一律 404。
  - WebSocket 实时日志推送：第一版用轮询（2s 自动刷新），SSE/WS 留作后续债务。
  - `llm-bridge`、ZCode 转发等网关转发逻辑的任何行为变化。

## 背景

- 相关文档：
  - `AGENTS.md`（配置/schema 同步要求、安全约束、请求日志遮蔽规则）
  - `docs/exec-plans/completed/` 中 request-log、config 相关已完成计划
  - 交互原型：OpenDesign 项目 `codex-cliproxy-web-ui-2a22`（状态总览 / 配置 / 日志三页，链接见决策记录）
- 相关代码路径：
  - `src/gateway.ts`：`handleCore` 在 `/healthz`、`${mountPath}/models` 之后新增 `/ui` 与 `/ui/*` 拦截；logging wrapper 的排除清单同步加入 `/ui`（避免 UI 自身轮询刷爆请求日志）。
  - `src/cli.ts`：`configCommand`（`config --zcode/--log/--max-request-logs/--max-log-size`）的「写盘 + 审计 + 重启」逻辑需提取为共享模块，避免 `gateway.ts ↔ cli.ts` 循环依赖；`restartGatewayOnce` 的 pendingRestart 语义直接复用。
  - `src/request-log.ts`：`isRequestLogName`、`safeLogPath`（现为私有）——日志查看接口的文件名校验复用这套边界。
  - `src/process-log.ts`：`logConfigChange` 审计格式（`config changed by \`webui config\``）。
  - `src/paths.ts`：新增 `uiTokenFile`（`~/.codex-cliproxy-gateway/ui-token`）。
  - `src/launchd.ts`：`launchctl kickstart -k` 重启即网关进程自杀+拉起，与 CLI 侧一致。
- 已知约束：
  - CLI 入口是 `bun build src/index.ts` 生成的 `dist/index.js`；UI 是独立的自包含 `dist/ui/index.html` 并随 npm 包发布，`webui` 运行时直接读取它。
  - 网关 handler 的 `logging`/`sink` 在 handler 创建时闭包捕获，配置变更必须重启网关进程才生效——UI 写配置后必须触发重启，且重启必须发生在 HTTP 响应返回之后（否则响应被 SIGTERM 截断）。
  - launchd `KeepAlive` 保证 kickstart 后进程回来；失败时 `pendingRestart` 标记保证下一次 CLI 命令补重启。
  - UI 使用 React + Vite 构建；本地 `dev:ui` 默认在 8322 提供 HMR 并代理 8321 的 UI API，两个端口均可通过环境变量覆盖；生产期由 `vite-plugin-singlefile` 将 JS/CSS 内联进单个 HTML，避免扩展服务端静态资源路由。`web` 始终保持生产行为。

## 风险

- 风险：本机浏览器被恶意网页当作跳板（CSRF / DNS rebinding）打到 `127.0.0.1:8320/ui/api/*` 改配置。
  缓解：`/ui` 及 API 全部要求 `x-ccp-ui-token` 头匹配 token 文件；Host 头白名单（`127.0.0.1:port` / `localhost:port` / `[::1]:port`），不匹配 404；校验 Origin 头（存在且非同源即拒绝）；不输出任何 CORS 头；UI 无配置开关，不运行网关即无 UI。
- 风险：日志查看接口读到敏感内容或越权文件。
  缓解：仅接受 `isRequestLogName` 命中的文件名，路径解析后必须落在 `logDir` 内（复用 `safeLogPath` 逻辑并导出）；单次响应截断（gateway.log 尾部 ≤256KB、请求日志 ≤64KB 末尾）；请求日志本身写入时已遮蔽凭据头（`SENSITIVE_HEADERS`），UI 不做二次脱敏也不新增落盘。
- 风险：UI 写配置触发的进程内重启打断在途 Codex 请求。
  缓解：与 CLI `config` 命令现状一致（本来就是 kickstart 重启）；UI 保存前弹确认层说明「网关将重启、期间请求短暂失败」；响应 `{restarting:true}` 返回并延迟 ~300ms 再 kickstart；UI 前端轮询 `/healthz` + `/ui/api/status` 显示「重启中」横幅直至恢复。
- 风险：共享配置写逻辑提取时改变 CLI 现有行为。
  缓解：先做纯提取（cli.ts 行为不变、现有 `test/gateway.test.ts` 配置用例全绿），再在其上叠加 webui 调用点；分两个 commit。
- 风险：`/ui` 路径与 Codex 流量冲突。
  缓解：`/ui` 不在 `${mountPath}`（/v1）之下，拦截放在 handleCore 最前部（`/zai`、`/healthz` 同级）；`mountPath` 理论上可配成 `/ui`，拦截顺序上 `/ui` 判定在前即固定优先。

## 里程碑

1. **M1 安全地基 + 只读 UI**：token 文件与鉴权/Host 校验中间层；`GET /ui`、`GET /ui/api/status`、`GET /ui/api/config`（脱敏只读）、gateway.log 尾部、请求日志列表/查看；CLI `web`（检查 + 启动 + 打开浏览器）；测试（401/404/路径逃逸/大小上限、网关未运行时 `web` 自动拉起）。
2. **M2 写路径**：提取共享 `applyGatewayConfigUpdate`（含审计、state.json 同步、pendingRestart）；`POST /ui/api/config` + `POST /ui/api/restart`；前端保存确认与重启横幅；测试（写盘内容、审计条目、模拟 kickstart 的重启时序）。
3. **M3 收尾**：README/usage 文档、AGENTS.md 增补 `/ui` 拦截与排除规则、发布说明；真机验证（launchd 环境下 UI 全链路：打开→查看→改配置→重启→恢复）。
4. **M4 日志视图交互升级**（见下节「待执行」，原型已定稿待移植到 `src/ui/`）。
5. （可选，暂缓）模型选择 UI：依赖把 `models()` 的非交互路径（`--select` selector）抽成网关可调用形式，涉及 config.toml 受管键写入，风险显著高于本计划，先登记到 tech-debt-tracker。

## 待执行：日志视图交互升级（M4）

交互规格已在 OpenDesign 项目 `codex-cliproxy-web-ui-2a22`（`codex-cliproxy-web-ui.html`）中定稿并逐项实测；需移植到 `src/ui/`（LogsPage 拆出共享 `FindBar` 组件 + `usePaneSplitter` 拖拽 hook + 快捷键处理）。**当前 React 实现仍是旧版**：筛选式过滤（隐藏行）、固定 46% 分栏、单一工具条、无快捷键。

### 查找（替代筛选）

- `#/logs` 的两个文本视图（网关日志终端、请求日志预览）共用同一查找组件：输入即高亮全部命中——当前项实色琥珀、其余半透明琥珀；计数 `n/m`（无命中显示 `0`）；上一个/下一个（按钮 + Enter/Shift+Enter，末尾回绕）；导航 `scrollIntoView(nearest)` 滚动到当前命中；× 关闭（清空 + 隐藏）；输入防抖 ~200ms。
- 不筛选、不隐藏任何行；gateway 刷新或切换预览文件后自动重扫，命中保持。
- **查找范围仅当前文件**：只遍历各自文本容器的文本节点（gateway tail / 当前预览文件内容），页面其余部分绝不命中。

### 浮动查找框与快捷键作用域

- 查找框不放顶部工具条，浮在文本区内部右上角：统一 `text-view-wrap` 组件结构（外层负责定位、内层负责滚动，避免随内容滚走），两视图同构、位置一致（top 10px / right 14px、带阴影、默认隐藏）。
- 文本区 `tabindex="-1"` 承接焦点（去焦点描边）；焦点在文本内时 Cmd/Ctrl+F 由组件处理：preventDefault、呼出本视图查找框、聚焦并全选。
- 日志视图打开期间，document 捕获层一律拦截 Cmd/Ctrl+F——**浏览器原生全网页查找绝不触发**；焦点不在文本视图内时路由到当前 tab 的查找框。日志视图关闭（回配置页）时不拦截，保持浏览器原生行为。
- Esc 分层：查找框打开时先关闭查找框（清空查询与高亮）并把焦点还给文本区；没有打开的查找框时才退出日志视图；关闭日志视图时一并收起查找框并清除高亮。

### 分栏拖拽

- 请求日志「文件表 | 预览」中间 6px 分隔条可左右拖拽：Pointer Events + `setPointerCapture`（拖出边界不丢事件）、hover/拖拽青绿高亮、`col-resize` 光标；实时调整预览宽度，钳制预览 ≥240px、表格 ≥260px。

### 刷新语义按 tab 区分

- 左上角 tab 更名：「网关日志 / 请求日志」（原 `gateway.log` / 请求日志目录），i18n 中英文（Gateway Log / Request Logs）。
- 网关日志 tab 工具条：手动「刷新文本」按钮 + 「自动刷新」开关（2s 轮询 ≤256KB tail、保持贴底）。
- 请求日志 tab 工具条：仅手动「刷新目录」——只刷新文件列表，不重载已打开的预览；两套工具条随 tab 切换互斥显示。
- 待决（可选增强，尚未拍板）：目录自动轮询；预览跟随刷新（刷新时重拉选中文件的尾部，对增长中的 ws 会话日志有用）。

## 验证方式

- 命令：`bun run check`（typecheck + 全部测试 + 构建）；`bun run dev web`（分别在网关已运行与已停止两种状态下执行）。
- 手工检查：
  - 浏览器打开 `codex-cliproxy ui` 输出的 URL：三页可切换、日志可读、保存配置后网关自动重启且 UI 自动恢复。
  - 无 token / 错 token 访问 `/ui/api/status` 得 401；`Host: evil.com` 得 404；`curl http://127.0.0.1:8320/ui/api/logs/requests/../../config.json` 被拒。
  - `codex-cliproxy web` 在网关未运行时能自动启动网关并打开浏览器。
  - Codex 正常请求不受影响（`/v1/responses`、`/v1/models`、realtime WS 各验一次）。
- 观测检查：`gateway.log` 出现 `config changed by \`webui config\`` 审计条目；开启请求日志后 UI 自身轮询请求不产生请求日志文件。

## 进度记录

- [x] 调研代码现状（gateway/cli/config/request-log/launchd/schema）与 ccr ui 形态，方案收敛。
- [x] OpenDesign 交互原型（项目 `codex-cliproxy-web-ui-2a22`）。
- [x] M1：安全地基 + 只读 UI + CLI 命令（`/ui` 拦截、token/Host/Origin 校验、日志 API、`codex-cliproxy web`、`test/webui.test.ts` 15 用例）。
- [x] M2：写路径（`src/config-update.ts` 共享配置更新 + `webui config` 审计 + pendingRestart + 延迟 kickstart）。
- [x] M3：文档（README/AGENTS/usage）与验证（`bun run check` 全绿；真实 dist 产物在临时 HOME 端到端冒烟 + 浏览器实测配置页/日志页/保存联动/中英切换）。
- [x] M4 设计定稿：日志查找（高亮/上下一个/快捷键/范围=当前文件）、浮动查找框、分栏拖拽、tab 更名与按 tab 刷新语义——均在原型逐项实测（详见「待执行：日志视图交互升级」）。
- [x] M4 实现：移植到 `src/ui/`——共享 `TextView` 组件（`src/ui/TextView.tsx`：text-view-wrap 结构 + 浮动 FindBar + 查找/导航/快捷键）+ LogsPage 重写（分 tab 工具条、`pane-splitter` 拖拽带 ref 同步置位、捕获层拦截 Cmd/Ctrl+F、Esc 分层退回配置页）；`bun run check` 全绿（286 测试），冒烟网关浏览器全交互回归通过（含 CUA 真实鼠标拖拽）。
- [x] M4 增量：请求日志目录分页与服务端排序——mtime 倒序（最新在前）显式化为 API 契约（`offset/limit` 分页、默认每页 100、上限 500、返回 `total`）；前端分页条（上/下一页、`第 n/m 页 · 共 t 条`、每页 50/100/200 可选）；进入目录页默认选中并预览第一条（最新）；`logging` 字段区分三态——未开启（**右侧预览面板与分隔条整体不渲染**，左侧提示「请求日志未开启」占满全宽，服务端不列历史文件）、开启但目录空（提示开启后会有记录）、有文件（正常浏览）。
- [x] 端口拆分（2026-09-14）：UI 从模型网关端口迁到独立端口（`webUiPort`＝port + 1，`startWebUiServer` 单独 `Bun.serve` 绑 127.0.0.1）；模型端口对 `/ui` 一律本地 404 + 提示 UI 端口（handleCore 与 startGateway fetch 层各一道，fetch 层先于 WebSocket 桥接）；`web` 命令打开 UI 端口 URL；UI 端口补 `/favicon.ico` 内联 SVG；请求日志不再需要 `/ui` 排除即天然只含模型流量（排除清单保留兜底）。动机：浏览器自动请求的 `/favicon.ico` 曾落穿到上游转发并进请求日志，暴露「未知路径一律转发上游」的结构性风险——独立端口后 UI 处理器没有上游 URL、API key 与转发路径，未来路由冲突也不可能把 UI 流量发往上游。
- [x] 默认不启动 + `web` 三步语义（2026-09-14）：`serve` 不再启动 UI；新增 `webui` 前台命令（LaunchAgent 的执行体，也是临时实例调试入口）；`web`＝检查网关→检查 UI 端口→未运行则写 `codex-cliproxy-webui.plist`（RunAtLoad/KeepAlive 均为 false，重启登录后保持关闭）并 kickstart→打开浏览器；`stop`/`uninstall` 一并 bootout UI agent；UI 服务每请求重读 config.json（CLI 侧配置变更无需重启 UI 进程）。选 launchd 而非 detached spawn：与网关同构的生命周期管理、可干净回收、无孤儿进程。真机验证：`web --restart` 经 launchd 拉起（8321 服务 200）→ `--status` 报运行中 → `--stop` 干净停止。
- [x] `web` 子选项（2026-09-14）：`--status`（打印 UI 是否运行与 URL）、`--stop`（仅停 UI 服务，网关不受影响）、`--restart`（先停再起）；互斥校验与按命令选项白名单（`COMMAND_OPTIONS.web`）同步。
- [x] mountPath 白名单（2026-09-14，重启后实测收回）：Chrome DevTools 对 8320 origin 的自动探测 `/.well-known/appspecific/com.chrome.devtools.json` 在端口拆分后仍被转发上游并写入请求日志——端口隔离只挡住 UI 自己的流量，挡不住直连模型端口的浏览器噪声。`handleCore` 增加 `isUnderMountPath` 边界：子树外一律本地 404（带 base_url 提示）、绝不转发上游、不进请求日志；日志包装层同步改为白名单（只记 mountPath 子树内、排除 `/v1/models`）。回归测试锁死 well-known/favicon/根路径零转发零日志；真实 socket 用例改用动态空闲端口（此前写死 8321 与本机生产 webui 冲突）。
- [x] 真机收尾（2026-09-14）：发布后对生产 LaunchAgent 网关跑通 `codex-cliproxy web` 全链路；用户确认真机验收完成，本计划归档。

## 决策记录

- 2026-09-13：UI 内嵌在网关进程 `/ui` 路径，而不是像 ccr 那样另起独立 Web 服务。理由：本项目是 launchd 管理的单进程网关 + 单文件构建产物，内嵌方案零新增进程管理与资产分发问题；ccr 的独立服务源于其 Next.js 技术栈，不属于本方案目标。（**已被 2026-09-14 端口拆分决策部分取代**：仍单进程单产物，但 UI 监听独立端口。）
- 2026-09-14：Web UI 迁到独立端口（网关端口 + 1），与 ccr 的双端口形态对齐但仍是同一进程、同一 launchd 生命周期。动机：`/favicon.ico` 事件暴露了「网关端口上的未知路径会带着 API key 落穿到上游转发」的结构性风险，UI 与模型流量同端口意味着未来任何路由功能冲突都可能把 UI 流量转发上游（严重后果）；独立端口后 UI 处理器没有上游 URL、API key 与转发代码路径，物理上不可能转发，模型端口的请求日志也天然只含模型流量。模型端口对 `/ui` 本地 404 并提示 UI 端口；UI 端口占用时仅降级告警不影响网关本体。（同日稍后修订：见下一条，UI 进一步拆为独立进程。）
- 2026-09-14（修订）：UI 改为**默认不启动、按需运行**：`serve` 不再启动 UI；`web` 命令负责「检查网关→检查 UI→经 `codex-cliproxy-webui` LaunchAgent 拉起→打开浏览器」，`webui` 命令前台运行同一服务。生命周期选 launchd 而非 detached spawn（spawn 方案被安全扫描拦截，但即便不拦截 launchd 也更优）：与网关同构、RunAtLoad/KeepAlive false 保证重启登录后保持关闭、stop/uninstall 可干净回收、无孤儿进程。UI 服务每请求重读 config.json，配置热更新不依赖 UI 进程重启。
- 2026-09-13：token 用独立文件 `~/.codex-cliproxy-gateway/ui-token`（0600，进程启动时惰性生成），不复用 Keychain：CLI（打印 URL）与网关（校验）都要高频同步读，文件避免 keychain 弹窗与延迟；token 仅随 `ui` 命令输出，URL query 携带后前端立即 `history.replaceState` 清理并转存 sessionStorage，后续请求走 `x-ccp-ui-token` 头。
- 2026-09-13（已被后续决策取代）：`webUI` 默认 `true`、`config --webui off` 可整体关闭——随着 Web UI 收敛为内建能力，该开关不再存在。
- 2026-09-13：Web UI 定位为网关内建基础能力（base capability）：网关启动即存在、停止即消失，不提供 `webUI` 配置开关、不提供 ccr 式独立启停控制；config.json 与 `schemas/gateway-config.schema.json` 零变更。
- 2026-09-13：CLI 命令定名 `codex-cliproxy web`，行为收敛为「检查网关 → 未运行则启动 → 打开浏览器」三步；不再提供 `--status` 子选项与 `config --webui`。
- 2026-09-13：日志查找定为「查找」而非「筛选」：不隐藏行，命中高亮（当前项实色/其余半透明）+ 上一个/下一个导航；gateway 终端与请求预览共用同一查找组件（`text-view-wrap` 结构，查找框浮于文本区右上角、两视图位置一致）；焦点在文本内时组件处理 Cmd/Ctrl+F，日志视图打开期间捕获层一律拦截以杜绝浏览器原生全网页查找，查找范围锁定当前文件；Esc 分层（先关查找框还焦点，再退日志视图）。
- 2026-09-13：刷新语义按 tab 区分：网关日志 = 文本尾部刷新（自动刷新开关 + 手动刷新）；请求日志 = 手动「刷新目录」且不重载已打开的预览；tab 更名「网关日志 / 请求日志」；请求日志表/预览分栏可拖拽（预览 ≥240px、表格 ≥260px）。目录自动轮询与预览跟随刷新作为可选增强暂未拍板。
- 2026-09-13：交互原型由 OpenDesign 生成并经评审通过：项目 `codex-cliproxy-web-ui-2a22`，产物 `codex-cliproxy-web-ui.html`（run `9ac2a9e7`；此前按多 Tab 控制台规格的 run `c6357eb5` 已按新方向取消）。预览：`/api/projects/codex-cliproxy-web-ui-2a22/raw/codex-cliproxy-web-ui.html`（经 open-design daemon 端口访问）。原型确认了最终信息架构：单页表单（可编辑组 + 只读组）+ header（日志抽屉/中英切换/保存）。
- 2026-09-13：模型选择（models --sync 的 UI 化）明确划出范围，登记 tech-debt，避免与 install 写路径耦合拖垮本计划。
