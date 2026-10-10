## [2026-10-09 15:05] | Task: 指纹文档补「包内提取」取值法，Zen 目录下发 base_instructions

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `Fable 5.1`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 再补充一个获取方式到 fingerprint-data.md, 并把系统 agentSystemPrompt 按其它agent 的一样更新到catalog 中

### 🛠 Changes Overview
**Scope:** `docs/fingerprint-data.md`、`src/opencode-zen/index.ts`、`src/opencode-zen/fingerprint.ts`、`test/opencode-zen-gateway.test.ts`、`test/opencode-zen-fingerprint.test.ts`

**Key Actions:**
- **[文档]**: `docs/fingerprint-data.md` 由「四客户端」升为「五客户端」，补 opencode-zen 的运行时消费点行；`## base_instructions 接线` 段落把 zen 从排除项改为在列；新增 `## opencode-zen` 章节，记 source/notes 与两条取值路径——包内提取（首选，npm dist-tags 定版本 → core chunks 取模板 → 平台二进制取 UA 字面量）与 mitm 抓包（回退）；更新记录补两行。
- **[目录下发]**: `index.ts` 的 `catalog()` facade 把 zen 条目 `base_instructions` 直接替换为官方 agent 提示词，与 zcode/codebuddy/qoder/agy 四个适配器一致。
- **[不重复注入]**: `injectZenFingerprintBody` 增加「首条 system 已完整包含待注入模板」判定——目录下发后 Codex 送来的 system 就是官方提示词，此时原样保留、不追加优先级注记，避免模型看到两遍同一段提示词。
- **[测试]**: 目录用例断言 Codex 形状下所有 zen 条目 `base_instructions` 等于官方提示词；注入用例覆盖「标题模板已在场」与「agent 模板已在场」两条不重复注入路径，并断言工具仍按门禁并集。

### 🧠 Design Intent (Why)
文档那半是补一条更可复现的取值路径：本次同步 GA 时 mitm 抓包没走通（GA 客户端在隔离 HOME 下内部 server 起不来），而包内提取不需要运行客户端——dist-tags 定版本、core chunks 取模板、平台二进制取 UA 字面量，全程可脚本化复核。base_instructions 那半是让 zen 与其它四个适配器对齐：Codex 按该字段发送系统提示词，此前只有 zen 留空串、回退 Codex 内置默认提示词，同仓行为不一致。两者叠加后必须处理重复注入：目录已把官方提示词交给 Codex，转发路再注入同一份模板就会翻倍，因此加「已含模板即不注入」分支，同时保留「客户端自带其它提示词时模板在前、客户端指令在后」的原行为。

### 📊 Change Stats
> `src/opencode-zen/` 未纳入版本控制，取不到 `git diff`；下表为本次触碰行的手工计数。

- **Files changed:** 5
- **Insertions:** +72
- **Deletions:** -6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `docs/fingerprint-data.md` | +41 | -3 |
| `src/opencode-zen/index.ts` | +4 | -3 |
| `src/opencode-zen/fingerprint.ts` | +9 | -6 |
| `test/opencode-zen-gateway.test.ts` | +11 | 0 |
| `test/opencode-zen-fingerprint.test.ts` | +21 | 0 |
| `docs/histories/…`（本记录） | 若干 | — |

### 📁 Files Modified
- `docs/fingerprint-data.md`
- `src/opencode-zen/index.ts`、`src/opencode-zen/fingerprint.ts`
- `test/opencode-zen-gateway.test.ts`、`test/opencode-zen-fingerprint.test.ts`
- `docs/histories/2026-10/20261009-1505-opencode-zen-base-instructions-and-doc.md`

### ✅ Verification
- `bun run check` 全绿：类型检查 + 741 测试 + UI/CLI 构建，退出码 0。
- 真实上游端到端（临时 handler + 真实上游，模拟 Codex 流程）：
  - `?client_version=` 的 Codex 形状目录 11 个 zen 条目全部带 `base_instructions`（长度 1474，头 50 字符为官方 GA 提示词）；
  - 把该 `base_instructions` 当 system 发回网关 → 上游收到的 system 与之一字不差（1474 字符、模板仅出现一次），工具按门禁并集 13 个，`stream: true`，HTTP 200 且回答正常。

### 📌 Notes
- 按用户先前指示未改技术债台账；zen 行 ① 仍写着 beta UA 与 mitm 抓包法，属陈旧描述，如需对齐可另起一次修订。
- GA 新增标头（`x-opencode-session-id`/`X-Session-Id`/`x-opencode-parent-session-id`）与 GA 工具 JSON schema 仍未跟随/重取，理由与残留见 `20261009-1430` 记录与 `docs/fingerprint-data.md` 的 opencode-zen 章节。
