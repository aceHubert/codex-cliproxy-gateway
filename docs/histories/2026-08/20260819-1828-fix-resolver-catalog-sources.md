## [2026-08-19 18:28] | Task: 修正 resolve-model 的模型目录来源链

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> `resolve-model.py` 使用 `codex debug models` 有个问题，`--bundled` 只是获取到当前版本包中的静态模型，例如当前没有配置 model_catalog_json 时就会获取不到非官方的模型列表了，应该去掉。
> 好像配置了 model_catalog_json，codex debug models 也是能获取到的。

### 🛠 Changes Overview
**Scope:** plugins/run-task-with-model

**Key Actions:**
- **[脚本]**: `resolve-model.py` 的 `codex debug models` 回退去掉 `--bundled`，改为实时目录。
- **[脚本]**: 删除「正则解析 `~/.codex/config.toml` 中 `model_catalog_json` 并直接读文件」这一级回退及 `codex_config_catalog_path()`，目录来源简化为自定义文件 → `codex debug models`。
- **[文档]**: 同步更新插件 README.md 与 SKILL.md 的模型目录来源说明。

### 🧠 Design Intent
`codex debug models --bundled` 只读取 Codex 二进制内置的静态快照（实测 8 个模型、0 个 cliproxy 行），动态模式下 `model_catalog_json` 未配置时解析器回退到它会拿不到 gateway 合并的非官方模型。去掉 `--bundled` 后经 base URL 刷新，实测返回 22 个模型、含 15 个 cliproxy 行。

进一步实测（用 `-c model_catalog_json=...` 注入只含一个金丝雀模型的目录验证）：配置 `model_catalog_json` 时 `codex debug models` 原样读取该静态文件、不触发网络刷新。即该命令同时覆盖动态与静态两种模式，因此删除脚本内对 config.toml 的正则解析回退：正则只认双引号字面量写法、也不带 Codex 的 schema 校验，交给 `codex debug models` 解析更忠实于宿主实际生效的目录，代码也更简单。

### 📊 Change Stats
> 数据来自 `git diff --shortstat / --numstat`（工作区未提交改动，仅统计本任务文件）。

- **Files changed:** 3
- **Insertions:** +8
- **Deletions:** -23

| File | +Added | -Removed |
| --- | ---: | ---: |
| `plugins/run-task-with-model/skills/run-task-with-model/scripts/resolve-model.py` | +6 | -19 |
| `plugins/run-task-with-model/skills/run-task-with-model/SKILL.md` | +1 | -2 |
| `plugins/run-task-with-model/README.md` | +1 | -2 |

### 📁 Files Modified
- `plugins/run-task-with-model/skills/run-task-with-model/scripts/resolve-model.py`
- `plugins/run-task-with-model/skills/run-task-with-model/SKILL.md`
- `plugins/run-task-with-model/README.md`
