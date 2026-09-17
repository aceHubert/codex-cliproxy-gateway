## [2026-09-15 17:44] | Task: 添加 DeepSeek v4.1 Flash 与别名规则

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 在 models.json 添加 deepseek-v4.1-flash，别名 deepseek-flash，两者为同个模型。
> 后续要求：查阅官方资料，修正描述并声明多模态支持。
> 同步修正 models/vendor_models.json 中的厂商预设。

### 🛠 Changes Overview
**Scope:** 模型元数据覆盖规则。

**Key Actions:**
- 新增两个精确名称规则，保持两者配置一致。
- 根据 DeepSeek 官方发布说明修正描述，声明原生视觉理解及文本、智能体能力提升；输入模态设为 text 和 image。
- 保留原有 deepseek-v4-* 规则。
- 修正 deepseek-flash 厂商预设并新增同配置的 deepseek-v4.1-flash 预设，让两个名称都获得完整厂商能力。
- 扩展现有目录测试，验证正式名称、别名及厂商前缀形式在合成和覆盖后均支持图片输入。

### 🧠 Design Intent (Why)
现有 deepseek-v4-* 不匹配带小版本号的 deepseek-v4.1-flash；采用精确规则支持正式名称和别名，避免扩大通配匹配范围。

[官方发布说明](https://api-docs.deepseek.com/news/news260910/) 确认 V4.1-Flash 原生支持多模态，API 名称为 deepseek-flash；[模型详情](https://api-docs.deepseek.com/quick_start/pricing/) 明确支持视觉输入。修正最初误沿用的纯文本声明。

### 📊 Change Stats
> 数据来自 `git diff --shortstat -- models.json models/vendor_models.json test/gateway.test.ts` 和对应的 `git diff --numstat`，相对任务开始时的暂存版本，仅统计本次配置及测试改动，不含本历史文件。

- **Files changed:** 3
- **Insertions:** +107
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `models.json` | +46 | -0 |
| `models/vendor_models.json` | +46 | -2 |
| `test/gateway.test.ts` | +15 | -0 |

### 📁 Files Modified
- `models.json`
- `models/vendor_models.json`
- `test/gateway.test.ts`
- `docs/histories/2026-09/20260915-1744-deepseek-flash-alias.md`

### ✅ Validation
- 通过实际规则加载与目录合成断言：正式名称、别名及两者的 deepseek/ 前缀形式得到一致描述与 text/image 输入模态；旧 v4 规则保持不变。
- `bun test test/gateway.test.ts --test-name-pattern 'bundled vendor presets|synthesized entries can still|catalog applies|override rules also match' --timeout 60000`：4 项通过。
- `bun run typecheck`：通过。
- `bun run build`：通过，厂商资产已重新内联至构建产物。
- `git diff --check -- models.json models/vendor_models.json test/gateway.test.ts`：通过。
