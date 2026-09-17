## [2026-09-12 18:46] | Task: ZCode 渠道日志补充转换后发往上游的请求正文

### 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `deepseek-v4.1-flash`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 再在日志中补充一下如果通过 llm-bridge 转的，把实际转发的请求头，body 也加在同一个文件中。

（背景：用户排查 Codex 发送服务端内置工具 `web_search` 被判为 400 的问题时，发现渠道日志只有
入站正文，看不到经 llm-bridge 转换后真正发给 Anthropic 兼容端点的正文。）

### 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关（`src/request-log.ts`、`src/zcode.ts`）

**Key Actions:**
- **日志条目扩展**：`ExchangeEntry` 新增可选 `upstreamRequestBody`，渲染为
  `--- upstream request payload ---` 段落，紧跟已有的 `--- upstream request headers ---`，
  与 `--- request payload ---`（入站正文）在同一文件内并列。
- **ZCode 转发链路埋点**：在 `decorateZcodeBody` 之后、`fetchUpstream` 之前记录实际发送的
  Anthropic 正文，并复用既有的 `redactValue` 做密钥遮蔽；未开启请求日志时不计算该值，
  避免对整个正文做无意义的遍历脱敏。
- **段落顺序调整**：把 upstream 三段落（上游地址、上游头、上游正文）整体移到入站
  `--- request headers ---` / `--- request payload ---` 之后，同一文件内按「收到什么 → 发出什么」排列。
- **测试**：扩展 zcode 渠道日志用例，断言上游正文段落存在、条数与真实上游调用数一致、
  内容与注入 fetch 收到的 body 相同，并继续断言无凭据泄漏。
- **文档**：README 的传输与日志小节补充「入站正文」与「转换后发往上游的正文」。

### 🧠 Design Intent (Why)
渠道日志此前只记录入站头、上游头和入站正文。排查协议转换类问题时，真正决定上游行为的是转换
结果，而 llm-bridge 对部分字段是静默丢弃或改写的——只看入站正文无法判断网关最后发了什么。
把上游正文落在同一文件、与上游头成组，可以让一次请求的完整因果链（入站 → 转换 → 上游）在一处读完，
不需要另开文件或复现请求。段落顺序按「先入站、后上游」排列，读日志时先看到客户端送来的原始请求，
再看到网关实际发出的内容，对比转换差异不需要上下翻找。仅 ZCode 链路记录上游正文：
CLIProxy 直通链路的上游正文与入站正文一致，重复记录没有信息增量。

### 🧪 Validation
- `bun run check` 全通过：类型检查、238 个测试 0 失败、单文件构建成功。
- 实机核对该日志布局（临时网关，仅本地 mock 上游）。ZCode 链路依次出现
  `--- request headers ---`、`--- request payload ---`、`--- upstream: …/v1/messages ---`、
  `--- upstream request headers ---`、`--- upstream request payload ---`；上游正文为转换后的 Anthropic 结构
  （`model: GLM-5.3`、`max_tokens`、`messages`、`tools[].input_schema`、`metadata.user_id`），
  而 `authorization`、`x-api-key` 均为 `***`，Key 与入站 OAuth 均未出现在文件中。
- 同时核对 CLIProxy 直通链路（无 upstream 段）：仍为
  `--- request headers ---`、`--- request payload ---`、空行、响应段，行数未多出空段。

### 📊 Change Stats
> 本分支工作区带有大量本任务之外的未提交改动，`git diff` 无法隔离本次改动。下表按本次实际编辑范围统计：
> 先对编辑前内容做反向还原生成基线，再执行 `git diff --no-index --no-renames --numstat <baseline> <file>`。

- **Files changed:** 4
- **Insertions:** +24
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/request-log.ts` | +11 | -1 |
| `src/zcode.ts` | +4 | -1 |
| `test/zcode-gateway.test.ts` | +7 | -0 |
| `README.md` | +2 | -1 |

### 📁 Files Modified
- `src/request-log.ts`
- `src/zcode.ts`
- `test/zcode-gateway.test.ts`
- `README.md`

### 📌 Notes
- 段落顺序调整发生在共享渲染器 `logExchange` 内，两条链路同时生效；CLIProxy 直通链路不传上游字段，
  布局与改动前一致（仅少了原先紧跟 `=== … ===` 的那一行上游地址）。
- 上游正文与入站正文一样只在实际转发发生时存在；配置错误、模型 404、上游未调用等情况下不输出该段落。
- 本次改动不新增任何出站请求，也不改变既有上游地址与请求头的构造逻辑。
