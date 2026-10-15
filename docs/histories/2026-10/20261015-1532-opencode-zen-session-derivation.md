# [2026-10-15 15:32] | Task: OpenCode Zen 会话 id 按外部会话确定性派生（替换随机生成）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> x-opencode-session-id 现在是怎么生成的，这个是会话级的，应该通过agent ide 的会话id来持久化，而不是随机生成的，这个headers 一直是必须的
> https://github.com/jiesou/dsh-opencode-zen-free-provider/commit/5de7c178d3683ce09711e18df276cfaab36184cb 看一下这个pin session id 是如何做的

### 🛠 Changes Overview
**Scope:** packages/opencode-zen（session.ts / index.ts）、scripts/zen-gate-probe.ts、test/（session/gateway）、docs/fingerprint-data.md、docs/opencode2-zen-free-models-gateway-research.md（修正段）；CHANGELOG 为自动生成文件不手工编辑

**Key Actions:**
- **[现状确认]**: `x-opencode-session-id` 与 `x-opencode-session` 同值，取自 `resolveOpenCodeSession`：合法入站 `x-opencode-session` 透传 → `x-session-id` 经内存 LRU 绑定表（24h TTL，重启即丢）→ 每请求随机铸币。抓包实证 **Codex 实发的是 `session-id` 头**（与 `thread-id` 同值；用一次性 echo server + `codex exec -c` 覆盖直连捕获），绑定表只认 `x-session-id`，Codex 流量全部落随机分支。
- **[实证]**: 服务端会**解码 session id 的时间段结构**——摘要哈希直接当前缀的 id 一律 403（4/4 复现；dsh 同类插件 commit 5de7c17 同结论），counter 位（低 12 位）须为官方形状（counter=1 → hex 以 `ffe` 结尾）；「哈希高 36 位 + counter 固定 1」的确定性派生 id 3/3 过闸（含同 id 复用），老时间戳（30 天/1 年/epoch）全过（不校验新鲜度）。dsh 的做法是 128 条内存 Map 首铸钉住（理由：Zen 按会话计量免费额度并按它路由 prompt cache）。
- **[session.ts]**: 新增 `deriveOpenCodeSessionId(external)`——SHA-256(外部会话 id) 高 36 位作 ms 段、counter 固定 1、摘要派生 base62 尾；同一外部会话跨请求、跨进程重启恒得同一 id，会话粘性不依赖任何进程内状态或磁盘持久化。解析器外部会话头扩为三源优先级 `x-session-id` → `session-id` → `thread-id`；`SessionBindingCache` 及其 TTL/LRU 机制整体移除（确定性派生使其冗余）。
- **[index.ts]**: 移除 `sessionCache` 依赖注入与绑定表装配，resolver 改为无参构造。
- **[探针]**: `zen-gate-probe.ts` 增加探针级 `session` 覆盖字段与 `derived-session-id` 对照项（确定性派生 id 须放行），实跑 **11/11 OK**。
- **[测试]**: session 测试改写（派生确定性、counter 形状、三源优先级、跨实例稳定）；gateway 会话连续性用例改用 Codex 实发标头形态并断言四件套镜像同值；`bun run check` 1129/1129 通过。
- **[真机验证]**: 生产网关重启后，`/v1/responses` 带 Codex 形态标头（`session-id`/`thread-id`/`originator`）连续两请求 200。

### 🧠 Design Intent (Why)
用户指出 `x-opencode-session-id` 是会话级且恒为必需，不应随机生成。dsh 的内存 Map 钉住能稳定会话但重启即换 id（丢失上游 prompt cache 亲和与计量连续性）；本仓实证「counter 位固定官方形状的确定性派生可过闸」后，采用**无状态确定性派生**：以外部会话 id（IDE conversation id）为唯一输入，纯函数派生合规 Zen 会话 id——稳定性等价于永久持久化，且零状态、免落盘、免过期策略，比内存 LRU 更简单也更可靠。随机兜底仅保留给完全无会话标头的请求（如裸 curl）。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区 vs HEAD；`index.ts`、`opencode-zen-gateway.test.ts`、`zen-gate-probe.ts`、`fingerprint-data.md` 的差值混有同日早前的 403 修复任务，本表为两任务合计）。

- **Files changed:** 6
- **Insertions:** +258
- **Deletions:** -262

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/session.ts` | +37 | -81 |
| `test/opencode-zen-session.test.ts` | +39 | -57 |
| `packages/opencode-zen/src/index.ts` | +40 | -30 |
| `test/opencode-zen-gateway.test.ts` | +66 | -58 |
| `scripts/zen-gate-probe.ts` | +45 | -35 |
| `docs/fingerprint-data.md` | +31 | -1 |

### 📁 Files Modified
- `packages/opencode-zen/src/session.ts`
- `packages/opencode-zen/src/index.ts`
- `scripts/zen-gate-probe.ts`
- `test/opencode-zen-session.test.ts`
- `test/opencode-zen-gateway.test.ts`
- `docs/fingerprint-data.md`
