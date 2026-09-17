## [2026-09-12 18:27] | Task: 补齐 vendor_models.json 的 z.ai 推理等级字段

### 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `deepseek-v4.1-flash`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 我现在删除了model_cache.json 怎么codex 中的模型还是没有zcode的？
>
> 重启codex 模型没有了，是不是合并出问题了？
>
> vendor_models.json 是这个配置的的z.ai 有问题
>
> 只copy根目录的的部分字段，参考 cliproxy-catalog.json 中补充

### 🛠 Changes Overview
**Scope:** 模型目录数据（`models/vendor_models.json`）

**Key Actions:**
- **[补齐必填字段]**: z.ai 组 `glm-5.3`、`glm-5.3-flash` 增加 `supported_reasoning_levels`，
  取值与 `cliproxy-catalog.json` 上游同名条目一致（`low`/`high`/`max` 三档），
  仅补该字段，其余厂商字段保持原样。
- **[未改动]**: `glm-5-turbo` 保留既有空数组；根目录 `models.json` 的 z.ai 规则不动
  （该文件是叠加式覆盖层，`applyModelOverrides` 只增改字段、不会删除厂商预设已提供的键）。

### 🧠 Design Intent (Why)
选择框"模型全没了"不是合并逻辑的问题：网关 `/v1/models` 已正确返回 28 条（含 `z.ai/glm-5.3`、
`z.ai/glm-5.3-flash`），但 Codex 0.154 客户端把 `supported_reasoning_levels` 当必填字段，
厂商预设缺该键导致**整份目录解码失败**，客户端回退到内置目录，所有 `cliproxy/*` 与 `z.ai/*`
一并消失。日志证据：

```
codex_models_manager::manager: failed to refresh available models: stream disconnected
before completion: failed to decode models response: missing field
`supported_reasoning_levels` at line 1 column 1216301
```

把 z.ai 条目对齐上游厂商元数据（而不是塞空数组），既能通过解码，也让 GLM-5.3 在
Codex 里暴露真实的 `low`/`high`/`max` 推理档位。

### 🧪 Validation
- 目录层：`loadZcodeCatalogCache` 重建后 3 条 z.ai 条目均含 `supported_reasoning_levels`。
- 端到端：重启受 launchd 托管的网关（`codex-cliproxy-gateway`）后，
  `/v1/models?client_version=0.154.0` 返回 28 条，缺该字段的条目数由 2 → 0；
  Codex 客户端于 18:26:35 自行写回 `~/.codex/models_cache.json`（28 条，含两条 `z.ai/*`），
  此后再无解码错误。
- `bun run check` 通过：236 测试，0 失败，0 跳过；严格类型检查与单文件构建通过。

### 📊 Change Stats
> `models/` 目录尚未纳入版本控制，`git diff` 无法统计；按任务前后逐行比对，仅统计本次改动。

- **Files changed:** 1
- **Insertions:** +10
- **Deletions:** -0

| File | +Added | -Removed |
| --- | ---: | ---: |
| `models/vendor_models.json` | +10 | -0 |

### 📁 Files Modified
- `models/vendor_models.json`
