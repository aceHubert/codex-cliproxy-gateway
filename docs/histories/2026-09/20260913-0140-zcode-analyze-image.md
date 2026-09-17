## [2026-09-13 01:40] | Task: ZCode 链路图片识别适配（analyze_image 网关代执行）

### 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 排查两个 Codex 会话中 `Z.ai Built-in Tool: web_search_prime` 可触发而 `analysis image` 无法触发的原因；随后提供 ZCode（sess_2d3686b2）与 ccr（Claude Code Router）实测日志定位机制，要求按 body 协议适配给出方案并实现；"将 changes 暂存后执行"、"启动临时端口自验证验收"。

### 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关（zcode 翻译链路 + 新增图片识别适配模块）

**Key Actions:**
- **[机制探测]**: 定位 z.ai 协议适配双段机制——图片自动上传 UCloud CDN 并改写为 URL 文本（URL 文件名即图片字节 md5），模型经 `analyze_image` 内置工具消费；触发依赖完整 Claude Code 客户端指纹（system+tools），概率性而非字段门控。逐项排除端点 URL、请求头、`metadata.user_id`、`output_config`、`thinking` 形状；排除 coding-plan `glm-4.5v`/`4.6v` 视觉直连（实测幻觉输出）与可声明服务端工具类型。
- **[请求侧]**: `translateZcodeRequest` 检测翻译后消息含图片时，声明 `analyze_image` 函数工具（对齐 z.ai MCP 的 imageSource+prompt 形状）并注入适配 system 说明；客户端已声明同名工具时让位。实测显式声明后模型确定调用并携带服务端改写的 URL。
- **[图片清单]**: `collectZcodeImages` 收集 user 消息与 tool_result 内层（view_image 返回形态）的 base64 图片，按字节 md5 标识去重；`matchZcodeAnalyzeImage` 按 URL 尾部标识反查，单图无条件兜底。
- **[响应侧吸收]**: `createZcodeResponse` 对 gateway 标记的工具调用不产出客户端事件与输出条目，参数在 content_block_stop 时记入待执行清单。
- **[续跑编排]**: `message_stop` 以 `stop_reason=tool_use` 结束且存在被吸收调用时批量执行，tool_use/tool_result 消息对追加后重请求上游，SSE 续接进同一条 Codex 响应流（事件序号与输出条目跨腿连续，上限 3 腿，执行失败降级为错误 tool_result 文本）。
- **[执行器]**: `zcode-vision.ts` 以完整 Claude Code 指纹信封（`zcode-vision-template.json`，逐字提取自 claude-cli 2.1.259 实测请求）侧请求，服务端在同一条 SSE 内完成识别；未出现 `server_tool_use:analyze_image` 视为未命中，重试 ≤2 次。
- **[日志]**: 交换日志记录 `analyze_image continuation legs: N`。

### 🧠 Design Intent (Why)
两个 Codex 会话的 `analysis image` 失败根因是：GLM-5.3 文本端点收不到图片像素，z.ai 的 URL 改写 + `analyze_image` 内置工具注入按请求呈现的 Claude Code 指纹概率性触发，纯 Codex 形状 0 命中（模型完全不知道该工具存在，只能幻觉或退化本地 OCR）。概率性指纹不可作为产品路径，故采用"确定声明 + 网关代执行 + 上游续跑"：声明使模型调用确定化（实测 3/3），执行复用唯一被验证的服务端代执行信封，续跑让 Codex 看到一次连续响应。web_search 的原生映射模式不适用（上游无图片类服务端工具类型可声明）。

### 📊 Change Stats
> 基线为任务开始时 `git add -A` 的暂存区快照；统计仅含本次任务的未暂存增量与新增文件。

- **Files changed:** 12（新增 4）
- **Insertions:** +279（另新增 `src/zcode-vision.ts` +201、`src/zcode-vision-template.json` 指纹资产 +1 行、`test/zcode-vision.test.ts` +115、执行计划文档）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode-response.ts` | +100 | -8 |
| `src/zcode.ts` | +54 | -7 |
| `test/zcode-response.test.ts` | +70 | -0 |
| `src/zcode-vision.ts`（新增） | +201 | -0 |
| `test/zcode-vision.test.ts`（新增） | +115 | -0 |
| `src/zcode-request.ts` | +11 | -1 |
| `test/zcode-request.test.ts` | +31 | -1 |
| `src/zcode-wire.ts` | +6 | -0 |
| `README.md` | +7 | -0 |

### 📁 Files Modified
- `src/zcode-vision.ts`、`src/zcode-vision-template.json`、`src/zcode-request.ts`、`src/zcode-response.ts`、`src/zcode.ts`、`src/zcode-wire.ts`
- `test/zcode-vision.test.ts`、`test/zcode-request.test.ts`、`test/zcode-response.test.ts`
- `README.md`、`docs/exec-plans/completed/zcode-analyze-image.md`

### 🧪 Validation
- `bun run check`：267 项测试全通过（新增 11 项），严格类型检查与单文件构建（0.83MB，模板内联）通过。
- E2E（授权、一次性、`serve --config` 临时端口 8399 隔离实例）：Codex 形状请求带真实截图，上游 tools 含 `analyze_image`、执行器触发服务端代执行、续跑 1 腿，最终 markdown 表格与图片真实内容逐项一致（opencode-go-chat/deepseek-v4.1-flash 三条记录、3.48s 失败、27.6s/29.0 t/s、7.6s/10.8 t/s，与地面真值吻合，非幻觉）；总耗时 47.7s。临时实例、配置与日志文件已全部清理。
- 机制探测一次性脚本（差分重放 20+ 次、执行信封验证）均为 /tmp 临时文件，已删除；真实上游探测均在本账户凭证与既有端点内完成。
