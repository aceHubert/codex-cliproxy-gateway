## [2026-10-26 11:05] | Task: 清理 zen 提示词过时注释并补四入口透传兼容性测试

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/agent-system-prompt-conversion-layer`

### 📥 User Query
> 提示词注入迁移到转换层后复查：model catalog 只有 Codex 客户端消费，zen 与其他四家插件一样在 catalog 期无特殊处理，index.ts 里那条「合成时替换」注释应删除；再确认 zen 的系统提示词无注入（因门禁工具问题保留各 agent 客户端自身系统提示词，与 Codex 原行为一致），并为其他 agent 客户端补兼容性测试。

### 🛠 Changes Overview
**Scope:** packages/opencode-zen、test

**Key Actions:**
- **[注释清理]**: 删除 `packages/opencode-zen/src/index.ts` catalog() 中描述「合成期替换提示词」的过时注释（2026-10-14 `a8d21a2` 回落决策时漏改，与 `catalog.ts` 现状矛盾）。
- **[措辞修正]**: `forwardResponses` 文档注释中「chat 目标注入官方模板」改为「垫补官方门禁工具，system 内容原样透传」，消除与提示词注入的歧义；`fingerprint.ts` 中关于标题生成器模板的两处「官方模板」表述准确、保持不变。
- **[兼容性测试]**（同日被后续任务改写）: `test/opencode-zen-gateway.test.ts` 新增的端到端测试断言「system 原样透传、不含 OpenCode 模板」——当日下午门禁换代实测推翻该前提（system 须包含官方当前代模板），已由 [20261026-1506 记录](20261026-1506-zen-gate-2026-10-26-refresh-adaptation.md) 改写为「官方模板包裹客户端提示词」语义。原始内容：chat-completions（system 消息）、responses（instructions 字段与首条 developer 消息两种载体）、anthropic（顶层 system）、gemini（systemInstruction）四类客户端入口经 zen 全链路转发后，客户端系统提示词原样到达上游 system 槽，且上游请求体不含 `OPENCODE_ZEN_AGENT_SYSTEM_PROMPT`。

### 🧠 Design Intent (Why)
提示词注入已从 catalog 合成期下移到 zcode/qoder/agy/codebuddy 四家插件的请求转换层，注入与 catalog 无关；zen 维持不注入（门禁只检查官方工具在场，不检查 system 内容），客户端自带系统提示词原样透传、与 Codex 原行为一致。zen 的 catalog() 因此与其他四家「无特殊处理」同构，旧注释描述的合成期替换机制已不存在，留着会误导后续维护。测试补齐此前缺失的「非 Codex 客户端系统提示词经 zen 透传」的网关级断言（此前仅 gemini 入口有 system 断言，且无任何「不注入 OpenCode 提示词」的反向断言）。

### 📊 Change Stats
> 数据来自 `git diff`（工作区未提交改动）。

- **Files changed:** 2
- **Insertions:** +76
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/index.ts` | +2 | -3 |
| `test/opencode-zen-gateway.test.ts` | +74 | -0 |

### 📁 Files Modified
- `packages/opencode-zen/src/index.ts`
- `test/opencode-zen-gateway.test.ts`
