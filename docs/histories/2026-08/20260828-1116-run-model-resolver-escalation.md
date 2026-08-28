## [2026-08-28 11:16] | Task: Update model resolver sandbox policy

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5.6-luna`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> Investigate the failed `glm-5.3-flash` lookup, require sandboxed-out model resolution, remove `--selftest`, and use English instructions.

### 🛠 Changes Overview
**Scope:** `plugins/run-task-with-model`

**Key Actions:**
- **Sandbox policy**: Always run the resolver outside the sandbox so dynamic model refresh can reach the local Codex gateway.
- **Remove selftest**: Delete the built-in `--selftest` mode and its README example.
- **Instruction language**: Write the sandbox instruction in English without a catalog exception.

### 🧠 Design Intent (Why)
In a Codex task sandbox, `codex debug models` may silently fall back to the bundled catalog when the local gateway is unreachable, causing gateway models to be reported as unavailable.

### 📊 Change Stats
> `git diff --shortstat -- plugins/run-task-with-model`

- **Files changed:** 3
- **Insertions:** +5
- **Deletions:** -38

| File | +Added | -Removed |
| --- | ---: | ---: |
| `plugins/run-task-with-model/README.md` | +0 | -6 |
| `plugins/run-task-with-model/skills/run-task-with-model/SKILL.md` | +5 | -0 |
| `plugins/run-task-with-model/skills/run-task-with-model/scripts/resolve-model.py` | +0 | -32 |

### 📁 Files Modified
- `plugins/run-task-with-model/README.md`
- `plugins/run-task-with-model/skills/run-task-with-model/SKILL.md`
- `plugins/run-task-with-model/skills/run-task-with-model/scripts/resolve-model.py`
