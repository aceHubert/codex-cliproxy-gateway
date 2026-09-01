## [2026-09-01 13:56] | Task: README 为 --max-log-size 增加 bytes 包引用

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> readme 中增加一个使用的 ref 到 github。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（仅 README）

**Key Actions:**
- **[README]**: `--max-log-size` 说明处补充 [bytes](https://github.com/visionmedia/bytes.js) 格式来源链接，示例扩为 `512KB`/`10MB`/`1M`，与 `parseMaxLogSize` 实际接受的语法（含归一化的无 B 后缀写法）一致。

### 🧠 Design Intent (Why)
* SIZE 的单位语法（1024 进制、b/kb/mb/gb/tb/pb）由 bytes 包定义，README 直接给出上游仓库链接，用户无需翻源码即可查到完整格式说明。

### ⚠️ 已知未决问题
- 无新增。

### 📊 Change Stats
- **Files changed:** 1（`README.md`，本任务净增约 +1/-1）

### 📁 Files Modified
- `README.md`

### ✅ Verification
- 人工核对 README:165 链接与示例渲染正确；纯文档改动，无需跑 `bun run check`。
