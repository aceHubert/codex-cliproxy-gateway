## [2026-09-17 14:06] | Task: 进程日志上限改为数字与单位选择

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex desktop 旁支会话`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 进程日志大小上限改为数字 + 下拉框单位，0 直接传数字 0，非零转成字符串；仅保留 KB、MB，范围 0～1024。请求日志保留数范围 0～1000，step 为 10。

### 🛠 Changes Overview
**Scope:** Web UI 日志上限输入、配置补丁的零值解析。

- 进程日志大小数字输入框限制 0～1024，单位下拉框仅保留 KB、MB。
- 请求日志保留数限制 0～1000 的整数，数字输入框步进为 10；越界、负数、小数或空值禁止保存。
- 零值提交数字 `0`，非零值提交如 `10MB` 的字符串；负数、空值、非有限值及超出安全字节范围的输入禁止保存。
- 按字节值比较修改状态，已有配置回显不舍入，等价单位转换不产生多余保存。
- 后端允许数字零，继续通过原有解析器校验带单位字符串；磁盘配置仍保存非负整数字节数，既有 JSON Schema 无需变更。

### 🧠 Design Intent (Why)
数字和单位分开输入，避免用户自行拼接大小字符串；保存前校验完整表单，避免无效日志上限伴随其他字段先产生写入。

### 📊 Change Stats
> 仅统计本旁支任务文件，相对编辑前暂存区执行 `git diff --shortstat` / `git diff --numstat`，并计入新增文件；不含本历史记录及主任务并行改动。

- **Files changed:** 7
- **Insertions:** +162
- **Deletions:** -39

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/config-update.ts` | +4 | -3 |
| `src/ui/ConfigPage.tsx` | +44 | -30 |
| `src/ui/api.ts` | +2 | -2 |
| `src/ui/i18n.tsx` | +10 | -4 |
| `src/ui/styles.css` | +7 | -0 |
| `src/ui/log-size-field.ts` | +29 | -0 |
| `test/log-size-field.test.ts` | +66 | -0 |

### 📁 Files Modified
- 上表所列文件及本历史记录。

### ✅ Verification
- `bun test test/log-size-field.test.ts`：4 个测试通过，覆盖输入上下界、单位与精度，测试进程设置 60 秒上限。
- `bun run typecheck`、`bun run build:ui`、`git diff --check` 通过。
- 本旁支未操作主任务的浏览器页面、重启运行中服务或提交实际日志配置。
