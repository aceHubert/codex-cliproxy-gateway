# [2026-09-12 19:53] | Task: ZCode 链路内置工具适配（web_search 原生映射与剥离降级）

## 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

## 📥 User Query
> 分析一下工具转换的问题，给一个解决方案（18:32 zai `/v1/responses` 因内置 `web_search` 工具 400）；随后确认 llm-bridge 适配方式、CLIProxyAPI 参考实现与目录字段归属；要求只针对 llm-bridge 链路给出执行方案，并"把当前的 changes 添加到暂存区后执行"。

## 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关（zcode 翻译链路）

**Key Actions:**
- **[请求侧映射]**: `web_search` 声明原生映射为 `{"type":"web_search_20250305",...}`，透传 `max_uses`/`filters.allowed_domains`/`user_location`；`external_web_access:false` 走剥离。
- **[剥离降级]**: 未知内置工具类型不再 400：从 tools 剥离并记录 `dropped`，system 注入降级说明，`*_call` 服务端历史降级为文本摘要，`tool_choice` 指向内置工具时省略选择。
- **[历史回放]**: `web_search_call` 历史在启用原生映射时还原为 z.ai 实测回放形状（`server_tool_use`(web_search_prime/search_query) + `tool_result` 文本块，`ws_` 前缀 id 往返）。
- **[响应折叠]**: 上游 `server_tool_use`/`tool_result`(z.ai)/`web_search_tool_result`(Anthropic 标准) 块配对折叠为单个 `web_search_call` 输出条目及事件；结果块缺失由 `message_stop` 兜底闭合；未知 content block 类型改为忽略不炸流。
- **[目录开关]**: zcode 目录 `supports_search_tool` 翻为 `true`。
- **[日志]**: 交换日志记录被剥离的内置工具名。

## 🧠 Design Intent (Why)
18:32 的 400 由 `translateTools` 白名单硬失败触发：Codex Desktop 的 web search 是 app 级开关，目录字段无法可靠约束，任何内置工具类型都会让整个会话瘫痪。M0 两次授权实测确认 z.ai Anthropic 端点接受 `web_search_20250305`（200，usage 含 `server_tool_use.web_search_requests`），且流式返回 z.ai 私有变体形状（`web_search_prime`/`search_query`/`tool_result` 文本块）。因此采用"可映射的原生映射 + 不可映射的剥离降级"双轨，响应侧 server 工具帧在进入 llm-bridge `normalize()` 前分流本地处理（库对未知块静默吞帧）。

## 📊 Change Stats
> 基线为任务开始时 `git add -A` 的暂存区快照；统计仅含本次任务的未暂存增量。

- **Files changed:** 10
- **Insertions:** +346
- **Deletions:** -20

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode-request.ts` | +91 | -8 |
| `src/zcode-response.ts` | +118 | -3 |
| `test/zcode-request.test.ts` | +66 | -1 |
| `test/zcode-response.test.ts` | +51 | -0 |
| `src/zcode-catalog.ts` | +2 | -1 |
| `src/zcode.ts` | +3 | -1 |
| `src/zcode-wire.ts` | +2 | -0 |
| `test/zcode-catalog.test.ts` | +1 | -1 |
| `README.md` | +4 | -0 |
| `docs/exec-plans/completed/llm-bridge-builtin-tools.md` | +8 | -5 |

## 📁 Files Modified
- `src/zcode-request.ts`、`src/zcode-response.ts`、`src/zcode-wire.ts`、`src/zcode-catalog.ts`、`src/zcode.ts`
- `test/zcode-request.test.ts`、`test/zcode-response.test.ts`、`test/zcode-catalog.test.ts`
- `README.md`、`docs/exec-plans/`（计划归档至 `completed/llm-bridge-builtin-tools.md`）、`docs/exec-plans/tech-debt-tracker.md`

## 🧪 Validation
- `bun run check`：249 项测试全通过（新增 13 项：原生映射、剥离+说明、历史回放/降级、tool_choice 省略、服务端块折叠、结果缺失兜底、未知块忽略），严格类型检查与单文件构建通过。
- M0 实测（授权、一次性、https 公网）：`/v1/messages` + `web_search_20250305` 返回 200；流式采集确认 `server_tool_use(web_search_prime)` + `tool_result` 配对形状。
- E2E（授权、一次性）：Codex 形状请求（web_search 声明 + 历史 `web_search_call` + 待剥离 `image_generation`）走完整翻译链路打真实上游：剥离与映射正确、上游 200、模型真实执行两次搜索、折叠出两个带结果的 `web_search_call` 条目、事件序号连续。
- 探测与 E2E 脚本均为 /tmp 一次性文件，已删除；未改动运行中的网关与任何缓存文件。
