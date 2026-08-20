## [2026-08-18 17:17] | Task: 修正模型目录运行时路径

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> `models --sync` 不应继续写入旧的 `~/.codex/cliproxy-catalog.json`；旧文件无需删除，只要不再由 gateway config 引用即可。同时移除不再需要的 `catalog-metadata.json` 运行时链路。三个 gateway 服务地址不应由模型同步改写，改为在 `restart` 时刷新，让旧安装无需卸载重装。

### 🛠 Changes Overview
**Scope:** CLI 配置同步、模型目录生成、gateway `/models`、测试与文档

**Key Actions:**
- **路径归一化**: 命令预检将受管旧 `catalogPath` 改为 gateway runtime 目录，并同步安装状态。
- **保留旧文件**: 路径迁移只改配置，不修改旧 catalog 文件。
- **删除 metadata 依赖**: 移除 metadata 类型、生成、读取、响应头和版本防降级分支。
- **调整配置时机**: `models --sync` 只移除静态 `model_catalog_json`；gateway `restart` 统一刷新三个服务地址并保持用户其他 TOML 配置。
- **发布入口同步**: 重新构建 `dist/index.js`，使实际 CLI 入口包含新路径逻辑。

### 🧠 Design Intent (Why)
`cliproxy-catalog.json` 是 gateway 的运行时缓存，应与 gateway 配置放在同一目录。旧文件不被 `config.json` 引用后不会参与运行，无需做破坏性清理。三个服务地址属于 gateway 生命周期配置，由 `restart` 刷新比模型同步更符合职责边界。

### 📊 Change Stats
> 数据来自本次任务相关文件的 `git diff --shortstat` 与 `git diff --numstat` 工作树快照。

- **Files changed:** 11
- **Insertions:** +388
- **Deletions:** -189

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +9 | -7 |
| `docs/model-catalog-dynamic-refresh-plan.md` | +17 | -36 |
| `docs/official-realtime-proxy-plan.md` | +66 | -29 |
| `src/catalog.ts` | +1 | -30 |
| `src/cli.ts` | +51 | -24 |
| `src/gateway.ts` | +15 | -19 |
| `src/paths.ts` | +0 | -1 |
| `src/types.ts` | +0 | -10 |
| `test/gateway.test.ts` | +28 | -3 |
| `test/model-catalog-dynamic.test.ts` | +7 | -22 |
| `test/realtime.test.ts` | +194 | -8 |

### 📁 Files Modified
- `README.md`
- `docs/model-catalog-dynamic-refresh-plan.md`
- `docs/official-realtime-proxy-plan.md`
- `src/catalog.ts`
- `src/cli.ts`
- `src/gateway.ts`
- `src/paths.ts`
- `src/types.ts`
- `test/gateway.test.ts`
- `test/model-catalog-dynamic.test.ts`
- `test/realtime.test.ts`
