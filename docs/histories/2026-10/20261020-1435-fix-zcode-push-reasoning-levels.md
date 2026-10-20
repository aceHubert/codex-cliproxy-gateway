## [2026-10-20 14:35] | Task: 修复 models --push zcode 推送后档位选择器缺失

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert`
* **Branch**: `fix/zcode-push-reasoning-levels`（基于 `origin/main` cfb03c8；排查在 `feat/model-catalog-push` 分支上进行）

### 📥 User Query
> 排查一下 gemini-4-argon 怎么没有 reasoning level（后续确认影响范围与 dsh 侧，并要求修复 zcode 侧）。

### 🛠 Changes Overview
**Scope:** apps/gateway（zcode 推送目标）

**Key Actions:**
- **[syncedRules 补档位]**：`pushZcodeModels` 的 `providerModelRules` 重建时，对目录声明了 `supported_reasoning_levels` 的模型写入 `optionSpecs.reasoningLevel.values`；无档位模型不写，保持 ZCode 的 enabled/disabled 开关兜底。
- **[测试]**：新增档位写入用例；扩展现有「移除过时上下文和推理配置」用例，断言旧 `optionSpecs` 被清除。

### 🧠 Design Intent (Why)
ZCode 的档位选择器只读 `provider_config.json` 规则里的 `optionSpecs.reasoningLevel`（schema 仅接受 `values`/`map`，默认档位取 values 末位），不读 `config.json` 的 `models[].reasoning.variants`。原推送只写后者，导致无 ZCode 内置模型知识匹配的模型（agy/gemini-*、qoder、hy 系、grok-4.7 等 40+ 个）只剩开关兜底；有内置知识匹配的模型（claude/gpt/glm 系）则显示与目录不符的内置档位。目录档位均为升序输出，末位即最强档，与 ZCode 内置供应商「最强档默认」的约定一致。选中的档位要进入请求体还需 CEL `map`（当前 /v1/messages 仅 zen 端到端转换且不消费 reasoning 字段），作为后续债务不在本次实现。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（未提交的工作区改动）。

- **Files changed:** 2
- **Insertions:** +33
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/zcode-client-sync.ts` | +7 | -1 |
| `test/models-push-zcode.test.ts` | +26 | -0 |

### 📁 Files Modified
- `apps/gateway/src/zcode-client-sync.ts`
- `test/models-push-zcode.test.ts`
