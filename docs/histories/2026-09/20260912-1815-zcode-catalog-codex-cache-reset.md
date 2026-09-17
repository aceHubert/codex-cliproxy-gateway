## [2026-09-12 18:15] | Task: ZCode 厂商目录重建时过期 Codex 目录缓存

### 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `deepseek-v4.1-flash`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> zcode 启动后是不是因为没有把 codex 的 cache_models.json 重置导致不会更新选择框啊？
>
> 这里就是跟 models --sync 一样，如果 zcode-catalog.json 有更新的话就把 cache_models 的时间戳和版本重置让 codex 重新缓存。

### 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关

**Key Actions:**
- **[目录重建即失效]**: `loadZcodeCatalogCache` 新增可选 `codexModelsCacheFile`；只有真正重建
  `zcode-catalog.json`（首次生成、厂商预设或覆盖规则变化、缓存被改写或损坏）时，才复用已有的
  `invalidateModelsCache` 过期 Codex 的 `~/.codex/models_cache.json`；复用现有缓存时不写该文件。
- **[启动链路传递]**: `ZcodeDependencies` 新增 `codexModelsCacheFile`，`createZcodeAdapter` 在建目录时
  透传；`serve()` 用 `paths.modelsCacheFile` 注入，配置了 `zcode` 才会走到该路径。
- **[保持不变]**: 只重置 `fetched_at` 与 `client_version`，保留已缓存目录；`install`、`uninstall`、
  `models --sync` 的既有失效行为不变。
- **[测试]**: 新增目录层与网关层两条用例，覆盖"重建必须过期""复用不得重复过期""缓存被改写后重建同样过期"。
- **[文档]**: README 的"两层缓存"补充重建与 Codex 目录缓存的联动。

### 🧠 Design Intent (Why)
选择框不更新不是 Codex 的 bug：网关 `/v1/models` 已返回 `z.ai/*` 条目，但 Codex 仍沿用上一次
`~/.codex/models_cache.json` 的目录，直到它自己重新拉取。既有失效能力（`invalidateModelsCache`）
已经存在并被 `install`、`models --sync` 复用，因此不再新增"预测是否将要重建"的判断层，而是把失效
挂在真正重建目录的位置：只有目录内容确实变化时才让 Codex 重新缓存，未变化时保持原样、避免无谓刷新。
失效点位于网关启动阶段，所以 `config --zcode on/off` 重启网关后同样会走到；仅切换开关而
`zcode-catalog.json` 本身未变化时不会触发，此时由 Codex 自身的周期性刷新收敛。

### 🧪 Validation
- `bun run check` 通过：236 测试，0 失败，0 跳过；严格类型检查与单文件构建通过。
- 新增用例：`test/zcode-catalog.test.ts`（目录层，含覆盖规则/内容变化的重建路径）、
  `test/zcode-gateway.test.ts`（处理器装配 `codexModelsCacheFile` 后的实际写入）。
- 验证期间同工作树有并行的 upstream-only 改动（`zcodeEnabled` 排除 `upstreamOnly`）落地，
  中途一次全量运行因此出现与本任务无关的失败；该改动稳定后重跑全量 236 项全通过。
  upstream-only 模式下不建 `zcode-catalog.json`、也不进入本任务的失效路径，两者语义一致。
- 实机只读核对：网关 `/v1/models` 已返回 `z.ai/glm-5.3`、`z.ai/glm-5.3-flash`，
  而 `~/.codex/models_cache.json` 缺少这两条，确认症状与本次修复的假设一致；
  未改动本机运行中的网关与 Codex 缓存。

### 📊 Change Stats
> 使用任务开始前的编辑前快照与当前工作树逐行比对（等价于 `git diff --no-index --numstat`），
> 只统计本次任务改动；分支上继承的未提交改动与生成的 `dist/` 产物不计入。

- **Files changed:** 6
- **Insertions:** +75
- **Deletions:** -8

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +5 | -1 |
| `src/cli.ts` | +1 | -0 |
| `src/zcode-catalog.ts` | +16 | -5 |
| `src/zcode.ts` | +7 | -1 |
| `test/zcode-catalog.test.ts` | +25 | -0 |
| `test/zcode-gateway.test.ts` | +21 | -1 |

### 📁 Files Modified
- `src/zcode-catalog.ts`
- `src/zcode.ts`
- `src/cli.ts`
- `test/zcode-catalog.test.ts`
- `test/zcode-gateway.test.ts`
- `README.md`
