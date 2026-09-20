## [2026-09-20 17:00] | Task: 跳过上游目录拉取

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/zcode-apikey`

### 📥 User Query
> `--upstream-only --select none` 应跳过 CPA/newapi 的模型目录调用，清空选择与 cliproxy catalog；空目录不写 `model_catalog_json`，由 Codex 回退官方模型目录。

### 🛠 Changes Overview
**Scope:** `codex-cliproxy` CLI 与模型目录同步

**Key Actions:**
- **[CLI]**: 在读取 API key 与请求上游目录前识别显式 `--select none`，直接得到空选择；`install` 与 `models --sync` 均不访问 CPA/newapi `/models`。
- **[静态目录]**: 仅在上游模式下确实选中模型时写 `model_catalog_json`；空选择会移除受管键，让 Codex 回退官方模型目录。
- **[目录文件]**: `--select none` 仍原子重建 `{ "models": [] }`，保持配置选择与目录文件一致。
- **[测试]**: 覆盖 `none` 不触发上游请求、清空 config/catalog/Toml，以及网关遇到空 CPA catalog 时回退官方目录。

### 🧠 Design Intent (Why)
清空第三方上游选择不应要求一个可用的第三方上游。`none` 是显式选择，可以在拉取前短路；同时空的静态目录对 Codex 没有价值，移除 `model_catalog_json` 比加载空列表更符合既有官方目录回退行为。`upstreamOnly` 的请求路由语义保持不变。

### 📊 Change Stats
> 数据来自本次工作区diff。

- **Files changed:** 4
- **Insertions:** +137
- **Deletions:** -42

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +3 | -1 |
| `src/cli.ts` | +72 | -37 |
| `test/model-catalog-dynamic.test.ts` | +19 | -4 |
| `docs/histories/2026-09/20260920-1700-select-none-skips-upstream.md` | +43 | -0 |

### 📁 Files Modified
- `README.md`
- `src/cli.ts`
- `test/model-catalog-dynamic.test.ts`
- `docs/histories/2026-09/20260920-1700-select-none-skips-upstream.md`
