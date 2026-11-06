# 未声明工具调用容错与 analyze_image 执行腿可观测性

## 目标

上游（或模型模仿折叠名格式）回吐未声明工具名时不再把整条 SSE 以「stream disconnected」打断；zcode 视觉执行腿（analyze_image）的服务端瞬时失败可自动重试，且每次尝试的结局可事后取证。

## 范围

- 包含：
  - `packages/llm-bridge/src/output.ts`：四个客户端输出共用的事件级容错（骨架唯一映射、抑制提示、stop 降级），导出 `remapUndeclaredToolName`。
  - `packages/zcode/src/response.ts`：tool_use 未声明名的同款软化（映射或按未知块忽略）。
  - `packages/zcode/src/vision.ts`：服务端 MCP 错误结果识别与重试、`onAttempt` 观测回调（非致命）。
  - `packages/zcode/src/index.ts`：`onAttempt` 接进程日志与交换日志尾部；流内回调显式重入主机上下文。
- 不包含：
  - `packages/agy` 的同款容错（无 llm-bridge 依赖、腿未命中故障，记入技术债）。
  - codebuddy/qoder/opencode-zen 插件流中段日志的 ALS 断点（同类问题，记入技术债）。
  - 配置字段与 schema 变更（无）。

## 背景

- 2026-11-04 两起用户可见故障（Codex Desktop 经本网关）：
  1. `01a1a62c`（glm-5.3 经 zcode 腿）：`analyze_image` 服务端返回 MCP 400/1210「图片输入格式/解析错误」，重试 3 次仍失败后模型降级，会话废弃。次日同图同链路复现成功——判定为 Z.ai 服务端瞬时故障，图片字节（标准 8-bit RGBA PNG）与网关转换均无问题。
  2. `01a1a62f` 后续回合（deepseek-v4.1-flash 经 codebuddy 腿）：上游回吐 `tool_functions__.exec_command__1c9f81b6a094`（声明侧折叠名为 `tool_functions___exec_command___09e59a0e69fd`，点号与哈希均被上游/模型改写；`exec_command` 实为 `exec` JS isolate 的嵌套工具、从未声明），llm-bridge 严格身份表抛错断流。
- 相关代码：`packages/llm-bridge/src/output.ts`（tool_call_start 校验 ×4）、`packages/llm-bridge/src/request.ts`（`defaultSafeToolName` 折叠）、`packages/zcode/src/{vision,response,index}.ts`。
- 排查期间发现的既有缺陷（本次顺带修复）：插件响应体由 HTTP 层在 `withHostServices` 之外泵送，zcode 插件自己的交换/进程日志在流中段（onComplete、视觉续跑腿）调 `getHostServices()` 会抛「插件主机上下文未初始化」且被吞——生产 `logs/` 目录 `zcode-*`/`zai-*` 文件数为 0，插件侧交换日志从未落盘，也是视觉腿无取证来源的根因。

## 风险

- 风险：容错把真正的转换回归（身份表整体缺失）静默吞掉。
  缓解：抑制路径注入客户端可见的提示文本（进入下一轮上下文供模型自纠），交换日志保留完整输出；骨架映射要求唯一匹配，歧义不猜。
- 风险：MCP 错误结果检测误伤「内容恰好在开头描述 MCP 报错的截图」。
  缓解：检测窗口限摘要片段开头 200 字符且要求 `MCP error <code>` 形态；误检代价仅为重试与最终降级旁白。
- 风险：`inHostContext` 捕获 host 后跨异步回调持有。
  缓解：作用域限单次 `forward` 闭包，与 `bindHostMethods` 的既有语义一致（「后台回调继承相同实例」）。

## 里程碑

1. 取证与复现：rollout/日志取证定位两起故障机制；同图同链路线上复现证明 1210 为上游瞬时故障。
2. 实现切片一（B）：llm-bridge 事件级容错 + zcode 转换器软化。
3. 实现切片二（A）：vision 服务端失败重试 + onAttempt 观测 + 流内日志主机上下文重入。
4. 验证：单测（新增 9 例、更新 3 例旧断言）+ `bun run check` + 线上重放。

## 验证方式

- 命令：`bun run check`（boundaries + build + typecheck + 全量 node:test）。
- 手工检查：重启 launchd 服务后重放带图请求，`analyze_image` 成功返回识别结果。
- 观测检查：`~/.agent-proxy-gateway/gateway.log` 出现 `POST /v1/responses [analyze_image 1/3] -> 200` 摘要行；`logs/` 出现 `zcode-v1-responses-http-*.log` 交换转储；codebuddy 腿（deepseek）冒烟请求正常完成。

## 进度记录

- [x] 取证定位两起故障机制（rollout、gateway 日志、safeToolName 实跑比对）。
- [x] 同图同链路复现：1210 为上游瞬时故障，排除图片与转换侧。
- [x] llm-bridge 容错：骨架映射/抑制提示/stop 降级，四输出接线。
- [x] zcode 响应转换器软化 + vision 重试与观测回调。
- [x] 修复流内日志 ALS 断点（onComplete/onAttempt 显式重入）。
- [x] 测试与线上验证全部通过。

## 决策记录

- 2026-11-05：抑制而非给客户端回传未声明调用——Codex 对未知工具名的 function_call 行为不可控，注入提示文本 + 忽略是最小可控行为；全部调用被忽略时把 stop_reason `tool_calls` 降级为 `stop`，避免「零工具调用的 tool_calls 终态」协议矛盾。
- 2026-11-05：骨架匹配仅唯一命中才映射（`tool_functions__.x__<hash>` → `tool_functions___x___<hash>`）；歧义与零命中一律走抑制，不做相似度猜测（映射错工具比丢弃调用更危险）。
- 2026-11-05：1210 不做图片重编码重试——复现证明图片字节有效、故障为服务端瞬时；重编码属无证据修复，只加重试与观测。
- 2026-11-05：`onAttempt` 在 vision 层以 `reportAttempt` 包裹（观察钩子不致命），在驱动层以 `inHostContext` 重入主机上下文；两层缺一都会复现「日志抛错拖垮识别」。
