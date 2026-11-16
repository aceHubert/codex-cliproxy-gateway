## [2026-11-10 14:56] | Task: 修复平铺工具声明被上游套命名空间前缀回吐后无法执行

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-plugin-stream-logging-and-agy-tool-tolerance`

### 📥 User Query
> [网关] 上游调用了未声明的工具 tool_functions__exec_command，已忽略该调用；请仅使用已声明的工具。codebuddy 还是会有工具执行不了

### 🛠 Changes Overview
**Scope:** packages/llm-bridge、test（codebuddy 响应测试）

**Key Actions:**
- **[兜底匹配]**: `remapUndeclaredToolName` 在骨架全名不匹配时，增加按声明身份原始工具名骨架的「相等或 `_` 后缀」唯一匹配兜底。
- **[测试]**: codebuddy-response 新增三个用例：平铺声明名被套 `tool_functions__` 前缀回吐、声明折叠名而上游只回吐裸名、后缀兜底歧义时不猜测。

### 🧠 Design Intent (Why)
客户端声明平铺工具名（如 `exec_command`，无 namespace）时安全名直通，映射表 key 就是裸名；而 codebuddy 上游模型按自家命名空间风格回吐 `tool_functions__exec_command`，与任何声明 key 的骨架都不一致，唯一的容错路径走到「忽略调用并注入提示」，工具永远执行不了。骨架全名匹配（上轮 DeepSeek 腿修复引入）只覆盖「声明侧本来就有折叠前缀+哈希」的场景。兜底匹配以声明身份的原始工具名为锚点：调用名骨架与其相等或以 `_原始名骨架` 结尾且唯一时映射回该声明；零个或多个候选仍返回 undefined 走原降级路径，不做猜测。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交改动）。

- **Files changed:** 2
- **Insertions:** +68
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/output.ts` | +15 | -1 |
| `test/codebuddy-response.test.ts` | +53 | -0 |

### 📁 Files Modified
- `packages/llm-bridge/src/output.ts`
- `test/codebuddy-response.test.ts`
