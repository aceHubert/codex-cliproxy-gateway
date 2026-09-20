## [2026-09-18 11:31] | Task: 补充 CodeBuddy 推理档位合并规则

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> CodeBuddy 的 DeepSeek 目录未提供可选推理档位，补充合并规则。

### 🛠 Changes Overview
**Scope:** `src/codebuddy/catalog.ts` 及目录测试。

**Key Actions:**
- 有效非空 `reasoning.supportedEfforts` 优先，保留上游列表。
- 列表缺失、为空或格式无效时，以有效的 `defaultEffort` 优先、`effort` 次之，生成单项 `supported_reasoning_levels`。
- 默认值去除首尾空白；没有有效列表或默认值时仍输出空数组，不补充未声明的档位。
- 目录缓存版本从 2 升到 3，使旧的空档位目录在下一次加载新代码并拉取目录时重建。
- 增加 DeepSeek 真实字段样例、字段优先级、无效值与旧缓存重建回归测试。

### 🧠 Design Intent (Why)
CodeBuddy 为 `deepseek-v4.1-flash` 声明了 `reasoning.effort: high`，但未提供 `supportedEfforts`。原转换生成默认档位为 high、可选档位为空的条目。兜底规则保留已声明能力，让默认档位也出现在可选列表中，并避免从其他通道推断额外档位。

### 📊 Change Stats
> 数据来自 `git diff --shortstat -- src/codebuddy/catalog.ts test/codebuddy-catalog.test.ts` 与对应 `--numstat`。以任务开始时已有暂存内容为基线，仅统计本次代码与测试增量；本历史文件不计入，原有暂存变更不计入。

- **Files changed:** 2
- **Insertions:** +105
- **Deletions:** -7

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/catalog.ts` | +8 | -7 |
| `test/codebuddy-catalog.test.ts` | +97 | -0 |

### 📁 Files Modified
- `src/codebuddy/catalog.ts`
- `test/codebuddy-catalog.test.ts`
- `docs/histories/2026-09/20260918-1131-codebuddy-reasoning-fallback.md`

### 验证
- 目录测试：15/15 通过，覆盖旧缓存未过期时的重建。
- 网关测试：14/14 通过。
- 类型检查与 `git diff --check` 通过；测试进程设置总超时 60 秒。
- 本次未修改本机运行配置，也未重启或部署网关。
