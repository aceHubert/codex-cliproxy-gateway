# llm-bridge 链路内置工具适配（web_search 剥离与原生映射）

## 目标

zcode 翻译链路（llm-bridge 参与的 Responses↔Anthropic 路径）对任何内置工具类型不再硬 400：默认把带不过去的内置工具剥离并声明式降级；在实测确认 z.ai Anthropic 端点支持后，可开关地启用 `web_search` 的原生映射。llm-bridge 的职责边界（纯文本 input 翻译 + SSE 帧归一化）显式化并有测试守护。

## 范围

- 包含：`src/zcode-request.ts`（translateTools / translateInput / translateChoice）、`src/zcode-response.ts`（process / normalize 的块分派边界）、`src/zcode-catalog.ts` 仅翻转 `supports_search_tool` 开关值（不改合成逻辑）、`src/zcode.ts` 的剥离日志透传、`test/zcode-request.test.ts`、`test/zcode-response.test.ts`。
- 不包含：`models/vendor_models.json` 与根 `models.json` 规则调整（已论证：zcode 链路被硬编码覆写、newapi 透传链路的 `true` 是真实能力，改动无效且误伤）；newapi/CLIProxy 纯透传链路；对 llm-bridge 上游提 PR（仅评估记录）；网关代理执行搜索（调 `/paas/v4/web_search` 的中断-续传循环，明确推迟到债务表）。

## 背景

- 相关文档：`docs/histories/2026-09/20260912-1532-zcode-responses.md`（链路实现）、CLIProxyAPI 参考实现 [`claude_openai-responses_web_search.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/translator/claude/openai/responses/claude_openai-responses_web_search.go) 及 issue [#3199](https://github.com/router-for-me/CLIProxyAPI/issues/3199)、[#4718](https://github.com/router-for-me/CLIProxyAPI/issues/4718)。
- 相关代码路径：`src/zcode-request.ts:127-129`（内置工具白名单硬失败，2026-09-12 18:32 zai 400 的直接原因）、`src/zcode-request.ts:204`（未知历史条目硬失败）、`src/zcode-response.ts:282`（未知 content block 抛错）。
- llm-bridge 2.0.1 实测边界：`bridgeText` 仅翻译纯字符串 input（tools/history 永不进入库）；`openaiResponsesToUniversal` 只认 `function` 工具且内置工具白名单停留在 `web_search_preview` 等旧类型；`parseAnthropicStream` 只保留单个工具上下文（现由 `normalize()` 补帧绕过），对 `server_tool_use` / `web_search_tool_result` 完全无概念——未知块静默吞掉、其 `input_json_delta` 因 `currentToolCallId` 未设置被丢弃。
- 已知约束：z.ai Anthropic 兼容端点对 `web_search_20250305` 无文档化支持，必须先实测；Anthropic 系校验回放搜索结果的 `encrypted_content`，伪造整请求被拒；Codex Desktop 的 web search 是 app 级开关，可能不采信目录 `supports_search_tool`（时间线证据：目录已下发 `false` 后请求仍携带 `web_search`，但当时 Codex 缓存未刷新，未定论）。

## 风险

- 风险：z.ai 实测不支持 `web_search_20250305`，M3 空转。
- 缓解方式：M0 前置一次性人工实测再决策；M1/M2 与 M3 解耦，剥离路线独立成立。
- 风险：server_tool_use 帧分流绕过 `normalize()` 后，本地需自行管理块配对（`tool_use_id` 关联 `server_tool_use` 与 `web_search_tool_result`），错误配对会留下事件序号空洞或错序。
- 缓解方式：配对状态独立于现有 `blocks` Map；配对失败按未知块降级为忽略+日志，不炸流；用交错块流测试固化序号连续性。
- 风险：历史回放 `web_search_call` 时无真 `encrypted_content`，构造假值会被上游整请求拒绝。
- 缓解方式：无载荷的结果条目一律丢弃、降级为空结果列表（CLIProxyAPI 实战结论），测试覆盖。
- 风险：Codex Desktop 无视目录字段，目录开关形同虚设。
- 缓解方式：剥离兜底是主修复，目录开关仅作为第一道防线，验收不依赖它。

## 里程碑

1. **M0 实测与基线（0.5 天）**：人工 curl `https://api.z.ai/api/anthropic` 的 `/v1/messages`，带最小请求 + `{"type":"web_search_20250305","name":"web_search"}`，记录是否 200/错误文案到决策记录（仅 https 公网 host，一次性操作不留代码）；补当前 400 行为的基线测试（改造为剥离后期望翻转）。
2. **M1 请求侧剥离 + 降级（1 天）**：`translateTools` 对非 function/custom/namespace 类型不再 `fail`，改为丢弃并收集 `dropped` 集合；有剥离时 system 末尾追加一条降级说明（如“本通道不支持内置 web_search 工具，已移除；无法联网检索，不要向用户声称可以搜索”）；`translateInput` 对 `web_search_call` 等服务端调用历史降级为文本摘要块；`translateChoice` 指向被剥工具时降级 `auto`；`zcode.ts` 把 dropped 写入请求日志 logical note。
3. **M2 响应侧防线与 llm-bridge 边界固化（0.5 天）**：`zcode-response.ts` 的 `content_block_start` 分派不再对未知类型抛错——`server_tool_use` / `web_search_tool_result` 分流到本地处理（M3 消费），其余未知块忽略+日志；补 `normalize()` 输入输出契约测试（补帧行为、未知块吞帧行为），防止 llm-bridge 升级悄悄改变语义。
4. **M3 native web_search 映射（仅 M0 通过时执行，2 天）**：请求侧 `{"type":"web_search"}` 且 `external_web_access ≠ false` → `{"type":"web_search_20250305","name":"web_search"}`，映射 `filters.allowed_domains`→`allowed_domains`、`max_uses`、`user_location`，`external_web_access:false` 丢弃；历史回放 `web_search_call` → `server_tool_use`+`web_search_tool_result` 块对（id 净化为 `srvtoolu_` 前缀、`ws_` 前缀往返，无 `encrypted_content` 的结果丢弃）；响应侧把分流的块对折叠为单个 `web_search_call` 输出条目及 `response.output_item.added/done` 事件序列；`tool_choice` 指向 web_search 时转 `{"type":"tool","name":"web_search"}`，上游拒收对象形式则降级 `required`（xAI 教训）；`zcode-catalog.ts` 的 `supports_search_tool` 翻为 `true`（若选择配置化，同步 `schemas/gateway-config.schema.json` 与测试）。
5. **M4 收尾（0.5 天）**：`bun run check` 全绿；更新 README 与 AGENTS.md 中 zcode 链路的工具语义说明；`docs/exec-plans/tech-debt-tracker.md` 记录两项债务（z.ai 未文档化支持的实测依赖；llm-bridge 上游增强选项：builtin 工具/custom/namespace/history 解析）；按 HISTORY_GUIDE 归档。

## 验证方式

- 命令：`bun run check`（类型检查、全量测试、单文件构建）。
- 手工检查：M0 实测 curl 结论已写入决策记录；Codex Desktop 开启 web search 复现原 400 场景——M1 后应 200、日志含剥离 note、模型不再声称可搜索；M3 启用后应出现 `web_search_call` 条目且 Codex UI 正常渲染。
- 观测检查：`~/.codex-cliproxy-gateway/logs/zai-v1-responses-*` 不再出现“不支持服务器内置工具”；错误日志中无新增块配对错序。

## 进度记录

- [x] M0：实测 z.ai `web_search_20250305` 支持性并记录结论；补 400 基线测试。
- [x] M1：请求侧剥离+降级落地，四组测试（剥离、历史降级、tool_choice 降级、system 注入）通过。
- [x] M2：响应侧未知块防线与 llm-bridge 契约测试落地。
- [x] M3：native 映射三向转换（声明/历史/流）+ 开关联动落地（M0 通过）。
- [x] M4：全量验证、文档与债务表更新、历史归档。

## 决策记录

- 2026-09-12：默认策略取“剥离+声明式降级”而非“透传映射”——z.ai 对 `web_search_20250305` 无文档化支持，且目录字段无法约束 Codex Desktop 行为；native 映射降级为 M0 实测通过后的可选阶段。
- 2026-09-12：响应侧 server 工具帧在进入 `normalize()`/llm-bridge 前分流本地处理——库对未知块静默吞帧且不产出归一化事件，无法承载 `server_tool_use` 语义。
- 2026-09-12（M0 实测）：`api.z.ai` Anthropic 端点接受 `web_search_20250305`（HTTP 200，usage 含 `server_tool_use.web_search_requests` 统计）。流式形状为 z.ai 私有变体：`server_tool_use`（name=`web_search_prime`，query 在 `input.search_query`）配 `tool_result` 文本块（非 Anthropic 标准的 `web_search_tool_result`），id 为 `call_` 前缀。映射与回放按该实测形状实现，并兼容 Anthropic 标准形状（`query`/`input_json_delta`/`web_search_tool_result`）。
- 2026-09-12（实现修订）：`tool_choice` 指向内置工具时省略选择（回退上游默认 auto）而非映射为 `{"type":"tool","name":"web_search"}`——保守规避 xAI 教训（issue #4718）中对象形式被部分上游拒绝的风险。
- 2026-09-12（E2E 验收）：用 Codex 形状请求（web_search 声明 + 历史 `web_search_call` + 待剥离 `image_generation`）走完整翻译链路打真实上游：翻译正确（剥离+映射+回放），上游 200，模型真实执行两次搜索，响应折叠出两个带结果的 `web_search_call` 条目且事件序号连续。
