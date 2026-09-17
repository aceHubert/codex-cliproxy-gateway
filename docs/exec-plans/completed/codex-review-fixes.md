# Codex Review 修复：发布阻断、凭据边界与实例隔离

## 目标

逐条修复 2026-09-13 Codex review（session `01a09a60-2604-7bd3-94c8-6ab86774e0a4`）提出的 9 个问题（3×P1、6×P2），使干净检出可通过 `bun run check`，凭据/路由边界在降级与临时实例场景下不泄漏、不越权，配置保存失败不再造成不可恢复状态。

## 范围

- 包含：review 列出的全部 9 项修复及对应回归测试（详见「问题清单与修复方案」）。
- 不包含：review 未提及的重构、Web UI 功能扩展、`schemas/gateway-config.schema.json` 变更（本轮不改任何 config.json 字段形状）。

## 背景

- 相关文档：`docs/exec-plans/active/web-config-ui.md`（本轮 review 针对的主要特性）、`AGENTS.md`（凭据响应边界、`/ui` 路由边界、安装备份要求）。
- 相关代码路径：`src/webui.ts`、`src/gateway.ts`、`src/cli.ts`、`src/config-update.ts`、`src/request-log.ts`、`src/credentials-store.ts`、`src/zcode.ts`、`src/zcode-response.ts`、`src/zcode-vision.ts`、`src/ui/ConfigPage.tsx`、`src/paths.ts`、`src/launchd.ts`、`.gitignore`。
- 已知约束：
  - `/ui` 前缀必须最前部拦截且不计入请求日志（AGENTS.md 安全边界）；
  - 凭据（API key / OAuth / ui-token）绝不出现在任何响应或旁白文本中；
  - `gateway.ts` 的依赖树不得反向引用 `cli.ts`（config-update.ts 模块注释）；
  - 改 UI 后必须重跑 `bun run build:ui`。

## 问题清单与修复方案

以下每项均已对照当前代码逐条确认属实（证据为 file:line）。

### F1 [P1] 干净检出缺少 `html.generated.ts`，typecheck 必挂

- 确认：`src/webui.ts:9` 静态导入 `./ui/dist/html.generated.ts`；`git ls-files src/ui/dist/` 为空，`git check-ignore -v` 显示 `.gitignore:2` 的 `dist/` 规则命中该文件（`dist/` 无锚定，匹配任意层级目录）。`.gitignore:45` 注释意图是“stays committed for typecheck”，但规则本身使其不可能被提交。
- 方案：`.gitignore` 将 `dist/` 改为 `/dist/`（只忽略仓库根构建产物），保留 `src/ui/dist/index.html` 的忽略；`git add src/ui/dist/html.generated.ts`（约 497KB 生成物）随源码提交。
- 测试/验证：干净检出复现——`git clone --no-hardlinks . <tmp> && cd <tmp> && bun install && bun run typecheck` 应通过。
- 备选（已记录，不采用）：`"typecheck": "bun run build:ui && tsc --noEmit"`，缺点是裸 `tsc --noEmit`（IDE）在干净检出仍失败。

### F2 [P1] 图片识别降级旁白可能携带 API key

- 确认：`src/zcode-vision.ts:174-176` 把上游错误正文（前 200 字符）拼进 `ZcodeVisionError`；`src/zcode-response.ts:544-548` 捕获后直接拼入助手旁白与 tool_result 回填，`sanitizeError`（`zcode-response.ts:212`）只覆盖最终失败事件，管不到这条 `completed` 路径。
- 方案：在 `src/zcode.ts:204-212` 的 `gatewayTools.execute` 钩子处包一层 try/catch——非 abort 失败时以 `redact(error.message)`（`zcode.ts:112` 现有闭包，持有 `snapshot.apiKey`）重新抛出；`zcode-response.ts` 降级逻辑不动。redact 在该作用域可用，改动最小。
- 测试：`test/zcode-vision.test.ts`（或 zcode-gateway 集成）注入返回 401 且正文含占位 key 的 fetchImpl，断言抛出消息与客户端可见旁白均不含该 key。

### F3 [P1] `--config` 临时实例的 Web UI 读写生产实例状态

- 确认：`src/cli.ts:1053-1054` 对任意 `--config` 实例都传 `{ paths }`（`resolvePaths()` 的默认安装路径）。后果：`webui.ts:259` 读写生产 `ui-token`；`configResponse`/`applyWebUiConfigPatch`（`webui.ts:269/289`）读写生产 `config.json`/`state.json`；`webui.ts:290-293` 检测到生产 LaunchAgent 后 `markPendingRestart` + 重启生产服务。
- 方案：按实际配置路径派生隔离上下文——`src/paths.ts` 的 `resolvePaths(env, runtimeHome?)` 增加可选覆盖参数；`serve()` 中非生产实例传 `resolvePaths(process.env, path.dirname(path.resolve(configPath)))`。派生后 ui-token/state/gateway.log/logs 落在临时配置同目录；派生 `launchAgent` 路径不存在 → POST config 自然返回 `restarting:false`，不触碰生产 state 与服务。
- 测试：paths 派生逻辑单测（新增或并入 gateway.test.ts）；手工验证 `bun run dev serve --config /tmp/xx/test.json` 后 POST `/ui/api/config`，生产 `~/.codex-cliproxy-gateway/config.json` mtime 不变。

### F4 [P2] WebSocket 升级请求绕过 `/ui` 拦截

- 确认：`src/gateway.ts:1029-1056` 的 `fetch()` 里 `responsesWebSocketTarget`（`gateway.ts:413`）只排除 `/zai` 与保留 realtime 路径，不限定 Responses 路径；带 `Upgrade: websocket` 的 `/ui`、`/ui/api/*` 请求在到达 `handleCore` 的 `/ui` 拦截（`gateway.ts:666`）之前就被桥接转发上游（含查询串与 `x-ccp-ui-token`）。
- 方案：在 `fetch()` 开头（`new URL(request.url)` 之后、所有 WS 分流之前）增加与 `handleCore` 相同的 `/ui` 前缀判断并直接 `handleWebUiRequest`；`handleCore` 内既有拦截保留（保护 `createGatewayHandler` 直接调用方）。带 Upgrade 头的请求进入 `handleWebUiRequest` 后按普通请求处理（HTML/401/404），不再外发。
- 测试：若 `test/gateway.test.ts` 已有 `startGateway` 真实端口模式则加回归用例（WS 升级请求打 `/ui/api/config` 断言不外发、走 401/404）；否则将前置判定提取为可单测的纯函数。

### F5 [P2] Web UI / CLI 开启 ZCode 未做组合校验，重启后网关起不来

- 确认：`src/config-update.ts:101-105` 只查 boolean 即写盘；`src/cli.ts:1133-1138` 同样直接赋值后 `writeGatewayConfig` + 重启。而 `startGateway` 首行 `validateZcodeConfig(config)`（`gateway.ts:1019`）会在 `prefix` 与 `z.ai/`/`bigmodel/` 重叠（`zcode.ts:49-50`）或非回环监听时拒绝启动——保存成功但服务死亡，UI 一起不可用。
- 方案：`applyWebUiConfigPatch` 在 `writeGatewayConfigFile` 之前、`configCommand` 在 `writeGatewayConfig`（`cli.ts:1157`）之前调用 `validateZcodeConfig(config)`（从 `./zcode.ts` 导入；已核实 zcode.ts 依赖树不引用 config-update/webui/cli，无环）。校验失败抛既有带修复指引的错误 → Web UI 400 / CLI 报错，原配置与运行服务保持不动。注意 `validateZcodeConfig` 内部对 `upstream-only`（`zcodeEnabled` 为 false）提前返回，与现有“保存但不生效”语义一致。
- 测试：`test/webui.test.ts` POST `{zcode:true}`（现有 config `prefix:"z.ai/"`）→ 400 且配置文件字节不变；CLI 侧同场景报错、不写盘不重启。

### F6 [P2] 原地安装部分失败时不恢复原 LaunchAgent

- 确认：`src/launchd.ts:73-79` `installLaunchAgent` 先覆盖 plist、`bootout`（忽略错误）、再 `bootstrap`/`kickstart`（可抛错）；`src/cli.ts:802` `launchInstalled = true` 在整个调用成功后才置位，`cli.ts:818` 的恢复分支因此被跳过——配置与密钥回滚了，服务却保持停止、旧 plist 未恢复。fresh install 分支 `cli.ts:827` 同理跳过 `uninstallLaunchAgent`。
- 方案：在调用 `installLaunchAgent` 前读取并保存原 plist 内容（存在时），置 `launchTouched = true`；catch 分支以 `launchTouched` 替代 `launchInstalled` 作为恢复条件：switching 分支先回写旧 plist 再 `restartLaunchAgent` + `waitForHealth`（失败容忍不变）；fresh 分支有旧 plist 则回写、否则 `uninstallLaunchAgent`。
- 测试：install 流程若无可注入的 launchctl stub，则将回滚决策提取为纯函数单测，集成行为手工验证一次并在计划完成记录中说明。

### F7 [P2] 共享 `session-id` 的 WebSocket 日志被提前裁剪

- 确认：`src/request-log.ts:103/120-125` `activeLogFiles` 是 Set，任一连接关闭即整体删除活跃标记；`pruneLogDir`（`request-log.ts:146`）随后可删除仍被另一连接写入的文件。
- 方案：改为 `Map<string, number>` 引用计数；retain 时 +1，release 闭包以本地 `released` 标志保证幂等、仅首次 -1，减到 0 删除；`pruneLogDir` 判断改为计数 > 0。
- 测试：`test/gateway.test.ts:1123` 附近补用例——同名 retain 两次、释放一次后 prune 不删；全部释放后 prune 删除。

### F8 [P2] Web UI 保存失败后无法重试

- 确认：`src/ui/ConfigPage.tsx:161` `disabled={!dirty || phase !== "idle"}`；一次 400/网络错误后 `phase="failed"`（`ConfigPage.tsx:147-150`），表单 onChange 不复位，只能刷新页面。
- 方案：按钮条件改为 `disabled={!dirty || (phase !== "idle" && phase !== "failed")}`，允许失败态重试（`save()` 已重置 `saveError`）；改动后必须 `bun run build:ui` 重新生成并提交 `html.generated.ts`（与 F1 联动）。
- 测试：UI 层无测试框架，手工验证（输入非法日志大小 → 400 → 修正后可直接再保存）。

### F9 [P2] `optional` 豁免吞掉非 ENOENT 读取故障

- 确认：`src/credentials-store.ts:28-35` 对 `readFileSync` 的无差别 catch 在 `optional=true` 时返回空串；网关对 loopback 上游正是 optional 调用，EACCES/EISDIR 被静默解释为“无认证配置”，与函数 doc 注释（只豁免缺失/为空）自相矛盾。
- 方案：catch 中检查 `(error as NodeJS.ErrnoException).code`：`ENOENT` 维持现有行为（optional 返回空、否则抛带重建指引的缺失错误）；其余错误抛新错误——含文件路径、错误码与可执行修复提示（检查权限/路径类型或删除后重装），不静默降级。
- 测试：`test/credentials-store.test.ts` 补两条——路径为目录 / 无权限 + `optional=true` → 抛错含路径；文件缺失 + `optional=true` → 返回空串。

## 风险

- 风险：F1 提交约 497KB 生成物，带来 diff 噪音与“提交版本过期”风险。缓解：`bun run check` 每次都会重跑 `build:ui`，提交前用 `git diff` 校验生成物与源码一致；备选方案已记录在决策记录。
- 风险：F5 给 `config-update.ts` 引入对 `zcode.ts` 的依赖，存在未来成环可能。缓解：保持 `zcode.ts` 依赖树不引用 cli/webui/config-update 的现状约定（必要时把 `validateZcodeConfig` 下沉到叶子模块）。
- 风险：F3 改变 `--config` 实例的 ui-token/审计文件位置（原先误写生产目录）。缓解：该行为变化即修复目标；`serve` 帮助文案如有涉及同步更新。
- 风险：F6 的 launchctl 恢复在“原本就没有服务运行”的场景会尝试 bootstrap 旧 plist。缓解：仅在保存到旧 plist 时回写并恢复；原本无 plist 时沿用 uninstall 语义。

## 里程碑

1. P1 批次：F1、F2、F3 实现与测试，干净检出 typecheck 复现通过。
2. P2 批次：F4-F9 实现与测试。
3. 验证与收尾：`bun run check` 全绿、手工场景（F3/F6/F8）验证、必要文档同步、计划移至 `completed/` 并按 HISTORY_GUIDE 记录历史。

## 验证方式

- 命令：`bun run check`（typecheck + test + build，含 build:ui）。
- 干净检出：`git clone --no-hardlinks . /tmp/ccp-clean && cd /tmp/ccp-clean && bun install && bun run typecheck`。
- 手工检查：F3 临时实例保存配置不影响生产文件/服务；F8 失败后修正可再保存；F6 模拟 bootstrap 失败后服务可拉起（或以单测覆盖决策逻辑）。
- 观测检查：F2 模拟含密钥的 401 上游，客户端旁白与日志均无密钥；F7 双连接共享日志，释放一个后裁剪不删文件。

## 进度记录

- [x] 读取 codex review（session `01a09a60-…-6ab86774e0a4`）并逐条在代码中确认全部 9 项属实。
- [x] F1 提交 `html.generated.ts` 并锚定 `.gitignore` 的 `dist/` 规则（`/dist/` + `src/ui/dist/*` 白名单反转；497KB 生成物已暂存）。干净检出模拟（`git stash create` + `git archive` 到全新目录）`bun install` + `bun run typecheck` + `bun test` 全绿，TS2307 消除。
- [x] F2 在 zcode.ts execute 钩子脱敏图片识别降级错误（非 abort 失败以 `redact` 重抛）。回归：`zcode-gateway.test.ts`「analyze_image 执行失败的降级旁白先脱敏再发给客户端」——401 正文回显 key，最终响应只含 `***`。
  - 补充（同日三次 review，P1「图片识别降级仍可泄漏凭据」）：两个绕过——① 固定枚举转义变体漏掉 `\/`、`\uXXXX` 形式，客户端反序列化 JSON 可还原完整 key；② `zcode-vision.ts` 与续跑腿先 `slice(0, 200)` 截断后脱敏，key 跨边界时漏出前缀。修复：`redact` 改为逐字符生成四种互斥转义形式（裸字符、反斜杠+字符、`\u` 十六进制大小写）的确定性正则（首版 `\\{0,4}` 前缀写法存在灾难性回溯，已重写并在 5000 反斜帘对抗输入下验证 ≤2ms）；`ZcodeExecutorOptions.redact` 注入执行信封、续跑腿错误正文先脱敏后截断。回归：跨截断边界与 JSON 转义两个用例。
- [x] F3 按配置路径派生 Web UI 管理上下文（`resolvePaths(env, runtimeHome?)` + `serve()` 以 `path.resolve` 判定生产实例）。回归：`test/paths.test.ts`。
  - 补充（同日三次 review，P1「临时实例仍可能修改、重启默认实例」）：目录级派生丢失配置文件名——默认运行目录里的 `test.json` 派生出与生产完全相同的管理路径（UI 保存仍改默认 `config.json`），`$HOME/config.json` 的派生 LaunchAgent 恰好命中默认服务。修复：`webUiContextForInstance`（webui.ts）保留完整配置路径，`WebUiContext.instanceOnly` 显式禁止临时实例写默认 state 与重启 LaunchAgent（`applyWebUiConfigPatch` 增加 `syncState`），覆盖模式下 LaunchAgent 改用 `-temp` 占位名结构上永不等于默认路径。回归：`webui.test.ts` 两个新用例（test.json 同目录场景 + $HOME 场景 + 双 plist 存在时仍拒绝管理）。
- [x] F4 `fetch()` 最前部拦截 `/ui` 命名空间的 WS 升级请求。回归：`webui.test.ts` 用真实 `startGateway` + `node:http` Upgrade 探测，断言 401（修复前会被桥接上游、拨号失败回 426）。
- [x] F5 保存/写盘前执行 `validateZcodeConfig`（Web UI 与 CLI 两处）。回归：`webui.test.ts`（400 且配置逐字节不变）与 `zcode-cli.test.ts`（reject 且不写盘）。
- [x] F6 `launchTouched` 登记恢复责任并保存/回写旧 plist（switching 分支回写+重启，fresh 分支回写或卸载）。launchctl 副作用无法注入 stub，无自动化用例，恢复决策逻辑经代码审查确认——自动化缺口登记到 tech-debt。
  - 补充（同日二次 review，P2「安装回滚未重新加载旧 LaunchAgent 定义」）：回写磁盘旧 plist 后仅 `restartLaunchAgent` 会在任务已加载时按**新定义** kickstart，旧 plist 不会重新生效。新增 `reloadLaunchAgent`（bootout + bootstrap + kickstart）并在安装前记录 `previousServiceLoaded`：旧任务曾加载 → 重载旧定义拉回；本就未加载 → 仅恢复文件并 `stopLaunchAgent` 卸载新任务，回到安装前状态。
- [x] F7 `retainLogFile` 改 `Map` 引用计数（release 幂等、计数归零才允许裁剪）。回归：`gateway.test.ts` 双连接共享日志用例。
- [x] F8 ConfigPage 允许失败态重试（`disabled={!dirty || (phase !== "idle" && phase !== "failed")}`）并重建 UI 生成物（`build:ui`，472KB）。UI 层无测试框架，行为手工验证由后续发布前检查覆盖。
- [x] F9 `readUpstreamApiKey` 仅豁免 ENOENT——用户在两轮之间已自行实现（含 `{ cause }` 与 EISDIR/EACCES 两个用例，优于计划方案），原样保留。
- [x] `bun run check` 全绿（typecheck + 304 tests + build）+ 干净检出验证通过。
- [x] 收尾：计划移至 `completed/`、history 已记录。

## 决策记录

- 2026-09-13：F1 选择“提交生成物 + `.gitignore` 锚定 `/dist/`”而非把 `build:ui` 前置进 typecheck 脚本——与 `.gitignore:45` 既有注释意图一致，`tsc --noEmit` 保持开箱可用；代价是每次 UI 变更需重新生成并提交该文件（AGENTS.md 已有同等要求）。
- 2026-09-13：F3 选择“按配置文件目录派生隔离上下文”而非整体禁用临时实例 UI——保持“Web UI 随网关启动即存在”的内建语义；派生路径下 LaunchAgent 不存在，重启行为被自然抑制，无需额外开关。
- 2026-09-13：F2 选择在 `zcode.ts` 的 execute 钩子处脱敏（`redact` 闭包在此作用域可用、持有真实 key），`zcode-response.ts` 的降级语义不动。
- 2026-09-13：F5 复用 `validateZcodeConfig` 而非新写校验；`config-update.ts` → `zcode.ts` 的新依赖已核实当前无环，并在风险中登记约束。
- 2026-09-13：修复了工作区一处外部误改——`gateway.test.ts`「maxRequestLogs never deletes…」用例的末尾期望值被改成未在本用例种子中的 `20260904090000.log`，恢复为暂存区版本 `20260101000003.log`。
- 2026-09-13：F6 无自动化用例（launchctl 副作用无法注入），登记 tech-debt；F8 同为手工验证项。
- 2026-09-13（补充）：回滚恢复旧服务用 `reloadLaunchAgent`（强制重载磁盘定义）而非改造 `restartLaunchAgent` 的全局语义——常规重启（Web UI 调度、CLI restart）保留 kickstart 的轻量行为，重载仅用于安装回滚这一需要“磁盘定义重新生效”的场景。
