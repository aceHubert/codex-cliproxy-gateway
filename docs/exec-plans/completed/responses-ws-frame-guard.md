# Responses WebSocket 逐帧路由守卫补全（zcode/codebuddy/workbuddy 族）

## 目标

补全 Responses-over-WebSocket 桥的逐帧路由守卫：连接按握手 hint 钉定 official/cliproxy 后，客户端在其上发送 zcode/`codebuddy-*`/`workbuddy-*`（含旧 `codebuddy/`、`workbuddy/` 前缀）族的 `response.create` 帧时，网关必须本地断开该连接（1012），让客户端重新握手并进入现有 426/HTTPS-SSE 降级链路，绝不再把这些模型名原样送到 ChatGPT 官方后端或 CLIProxy 上游。

## 范围

- 包含：
  - `src/realtime.ts`：
    - `checkFrameRouting`（现 :82-101）返回值从 `string | null` 改为单次 JSON 解析的判别联合：`{ kind: "forward"; frame: string } | { kind: "reconnect" } | { kind: "reject"; model: string; family: string }`；`reconnect` 保留 cliproxy 族在 official 桥上的既有语义，`reject` 为新增的 HTTP-only 族断开降级。
    - 家族识别复用纯前缀判定 `isZcodeModel`（`src/zcode/catalog.ts:27`，匹配 `zcode/`、`zcode-`）与 `isCodebuddyModel`（`src/codebuddy/catalog.ts:33`，匹配 `codebuddy-{cn,intl}/`、`workbuddy-{cn,intl}/` 与旧 `codebuddy/`、`workbuddy/`），**不依赖** `zcodeEnabled`/`codebuddyEnabled` 配置。
    - `realtimeWebSocketHandler.message`（现 :559-601）新增 `reject` 分支：不调用 `upstream.send`；关闭上游与客户端连接（1012）以触发重新协商；`logRealtimeEvent` 记 `ws-route-mismatch`（detail 带 family/model）；经 `sink.processLog` 向 gateway.log 写一条错误摘要（事故当时只能翻 ws 会话日志才发现，必须 surfaced）。
  - `test/realtime.test.ts`：扩展既有 guard 测试（:434-476）覆盖判别联合的新分支；新增 handler 级用例（仿 :420 附近的 fake socket/upstream 模式）断言：上游未收到帧、客户端 1012 断开、mismatch 有日志。
  - README 的 Responses WebSocket 桥说明补一句逐帧守卫语义（若该节存在）。
  - 实现收尾：按 `docs/HISTORY_GUIDE.md` 写 history 文档，本计划移至 `completed/`。
- 不包含：
  - HTTP 路径：`gateway.ts` handleCore 已按 body 模型全族拦截（`codebuddy-cn/…` POST 会按 slug 取 CN 凭据走 `www.codebuddy.ai`），无需改动。
  - 握手闸门 `isZcodeResponsesWebSocket`/`isCodebuddyResponsesWebSocket`（`gateway.ts:445-458`）：保持现状（hint 命中即 426）。
  - `upstreamOnly` 纯转发模式对保留 HTTP-only 命名空间仍做帧级拦截，其余空前缀帧保持纯管道行为。
  - Codex Desktop 拿到 426 后不降级 HTTPS 的客户端行为（实测 0.155.0-alpha.9.2 重试 WS 3 次即放弃）：不在网关侧修复；保留观察，必要时入 `tech-debt-tracker.md`。
  - cliproxy 族既有 1012 断连重连语义（`pinCpaThread` + 重连按 thread 粘性）保持不动。

## 背景

- 相关文档：`docs/exec-plans/completed/codebuddy-proxy-adapter.md`（前缀族与适配器边界）、`docs/codex-app-server-restart-policy.md`（region 切换与 models 缓存失效时序）。
- 相关代码路径：
  - `src/realtime.ts:55-61` —— 连接级路由注释已明确「Codex 会复用同一条连接跨 turn 发不同模型……必须逐帧校验」，但逐帧校验只写了 `cliproxy/` 一族。
  - `src/realtime.ts:96` —— `official` 桥上仅 `cliproxy/*` 帧返回 null 触发 1012；其余（含全部 HTTP-only 族）原样放行。
  - `src/realtime.ts:99` —— `cliproxy` 桥上仅剥离 `cliproxy/`；HTTP-only 族帧带完整 slug 漏到 CLIProxy。
  - `src/gateway.ts:464-498` —— `responsesWebSocketTarget` 在 upgrade 时按 `x-codex-routing-hint` + thread 粘性一次性钉定上游。
- 事故现场（2026-09-21，本机日志已核实，会话 `~/.codex-cliproxy-gateway/logs/cliproxy-v1-responses-ws-01a0c18a-1948….log`）：
  - 11:50 `config --codebuddy-region` 最终 `cn -> auto`，auto 按最近登录解析为 intl，网关目录只剩 `*-intl/*` 族；Codex 11:56 才重拉目录，picker 仍持 `codebuddy-cn/hy4-preview-f`。
  - 11:51:22 Codex Desktop 预热 WS，hint `model=gpt-5.6-sol`（官方模型）→ 网关按 hint 把连接桥到 `wss://chatgpt.com/backend-api/codex/responses`。
  - 11:51:25 复用该连接发送 `response.create`（model=`codebuddy-cn/hy4-preview-f`），帧未被逐帧守卫识别，原样透传。
  - 11:51:26 官方后端 400：`The 'codebuddy-cn/hy4-preview-f' model is not supported when using Codex with a ChatGPT account.`
- 已知约束：
  - 保留前缀命名空间受 `validateCodebuddyConfig` 保护，官方/CLIProxy 上游不服务这些 slug，本地拒绝不会误伤合法上游模型。
  - `response.create` 帧携带全量对话历史可达数百 KB，逐帧解析只能一次（现 `checkFrameRouting` 已是单次解析，重构不得引入第二趟）。
  - 非 JSON 帧、无 `model` 字段的控制帧照旧原样透传。
  - 无 `routeKind` 的 realtime live/sideband 连接不经此逻辑（既有条件守卫）。

## 风险

- 风险：Codex 对 1012/426 的降级行为因版本而异。
  缓解：1012 与 426 是既有协商语义；网关保证确认不支持的模型绝不转发上游，后续按真机日志评估客户端行为。
- 风险：`checkFrameRouting` 返回值类型变更破坏调用方。
  缓解：唯一调用方在 `realtime.ts` message 处理器内部，测试同步改造；`bun run typecheck` 兜底。
- 风险：误拒合法流量。
  缓解：仅识别本网关保留命名空间（zcode/codebuddy/workbuddy 前缀），判定为纯前缀匹配且大小写不敏感（与 `isZcodeModel`/`isCodebuddyModel` 一致）；`cliproxy/` 族与官方无前缀模型行为不变。

## 里程碑

1. 方案评审：确认判别联合形状与「断开降级」决策。
2. `checkFrameRouting` 重构：单次解析 + 三态返回 + 家族识别（引入两个 catalog 纯函数，无循环依赖）。
3. message 处理器 `reject` 分支：不转发、断开降级、ws-route-mismatch 日志 + gateway.log 错误摘要。
4. 测试：guard 单测扩展（official/cliproxy 桥 × 各家族帧 × 旧前缀 × 空 prefix）+ handler 级拒绝用例。
5. 验证：`bun run check`；本地 WS 脚本手工验证；真机 Codex Desktop 冒烟（复现 region 切换后旧模型发送）。
6. 收尾：README 一句、history 文档、计划归档至 `completed/`。

## 验证方式

- 命令：`bun run check`（类型检查、全量测试、构建）。
- 手工检查：bun 脚本模拟——WebSocket 客户端带 `x-codex-routing-hint: model=gpt-5.6-sol` 与 `openai-beta: responses_websockets=…` 升级本地网关 `/v1/responses`，随后发送 `{"type":"response.create","model":"codebuddy-cn/hy4-preview-f",…}`；预期：上游无 `ws-send` 记录，客户端连接以 1012 关闭；新握手带该模型 hint 时得到 426，客户端可降级 HTTPS/SSE。
- 观测检查：真机复现原事故操作（region 切换、picker 未刷新时发送 `codebuddy-cn/…`）：帧不进入任何上游，gateway.log 出现带 family 的路由拒绝摘要；随后以 HTTP 正常发送 `codebuddy-cn/…` POST 仍 200 走 CN 上游（回归确认 HTTP 路径不受影响）。

## 进度记录

- [x] 方案评审通过（用户「实施」指令即批准；错误文案实现时定稿）。
- [x] `checkFrameRouting` 判别联合重构 + 家族识别。
- [x] message 处理器 reject 分支与日志落盘。
- [x] guard 与 handler 测试补全。
- [x] `bun run check` 通过。
- [x] 本地 WS 脚本手工验证通过（`/tmp/verify-ws-frame-guard.ts`：假官方上游 + 网关 + WS 客户端完整桥接路径，6 项断言全过）。
- [ ] 真机 Codex Desktop 冒烟（未在本任务内执行：需 `codex-cliproxy restart` 重启网关后由用户在 picker 复现 region 切换场景；LaunchAgent 直跑 `src/index.ts`，重启即生效）。
- [x] README、history 收尾，计划移至 `completed/`（真机冒烟异常时按决策记录回退预案处理后回填上项）。

## 决策记录

- 2026-09-21（修订）：HTTP-only 族帧在已建立的 WebSocket 内无法直接返回 HTTP 426，因此选「不转发 + 1012 断开 + 上游关闭」，让客户端重新握手；新握手由既有 `zcode-http-only`/`codebuddy-http-only` 闸门直接返回 426。与 `cliproxy/` 的差别是：cliproxy 是路由变化需重连，而 zcode/codebuddy 是网关已确认不支持 WS，必须进入降级链路。
- 2026-09-21：家族识别用 `isZcodeModel`/`isCodebuddyModel` 纯前缀判定，刻意不依赖 `zcodeEnabled`/`codebuddyEnabled`——族被禁用时模型名同样不该漏到上游，且禁用态下握手 426 闸门（依赖 enabled）不会拦，帧级守卫是唯一防线。
- 2026-09-21：`checkFrameRouting` 改判别联合、单次 JSON 解析，不新增第二趟解析——`response.create` 帧带全量历史可达数百 KB，逐帧成本必须保持现状。
- 2026-09-21：代码、单测、`bun run check` 与完整桥接路径脚本验证完成后即归档；真机 Codex Desktop 冒烟属运行验收，需重启网关并由用户操作 picker，留待回填。
