## [2026-08-18 17:32] | Task: 忽略未启用的 Realtime Profile

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> `*.config.toml` 只是 profile 设置；Realtime provider 应以主 `config.toml` 为准。

### 🛠 Changes Overview
**Scope:** Realtime provider 启动快照与测试

**Key Actions:**
- **配置来源**: provider 快照只读取传入的主 `config.toml`，不再枚举同目录的 `*.config.toml`。
- **回归测试**: 验证未启用的外部 provider profile 不会把内置 OpenAI 误判为第三方 provider。
- **运行验证**: 重启网关后 provider 模式为 `builtin`，无认证的 Live 请求正确进入认证校验并返回 401。

### 🧠 Design Intent (Why)
外部 profile 文件的存在不代表当前 provider 已启用；只有主配置决定当前 provider，避免未启用的 profile 阻断 Live。

### 📊 Change Stats
> 数据来自本任务补丁；不含本 history 文件。

- **Files changed:** 2
- **Insertions:** +3
- **Deletions:** -15

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/realtime.ts` | +1 | -13 |
| `test/realtime.test.ts` | +2 | -2 |

### 📁 Files Modified
- `src/realtime.ts`
- `test/realtime.test.ts`
