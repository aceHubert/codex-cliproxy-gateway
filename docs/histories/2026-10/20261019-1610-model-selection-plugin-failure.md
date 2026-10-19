## [2026-10-19 16:10] | Task: 解耦模型选择保存与插件目录可用性

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-model-selection-save`

### 📥 User Query
> models --sync 因 ZCode、Antigravity 模型目录异常而无法保存模型选择；选择与插件是否可用应当独立。创建 fix 分支修改。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/gateway` 模型目录保存与热加载

**Key Actions:**
- 插件目录收集失败改为脱敏警告，CLI 和 Web UI 继续保存上游模型选择，静态目录合并可用模型。
- 网关热加载逐插件读取目录，失败时尝试缓存或空目录，避免保存后的重载再次因单个插件失败而回滚。
- 新增 CLI、Web UI 两个保存接口、动态与静态热加载回归，覆盖配置与安装状态落盘、目录发布、插件恢复及日志脱敏。
- 保留静态空目录、重复 ID、无效条目、受管 TOML 与文件写入失败的检查及回滚。

### 🧠 Design Intent (Why)
插件登录、网络或本地目录故障不应否定独立的上游模型选择。命令保存与运行态重载均按插件隔离失败，同时保留真正的数据完整性校验。

### ✅ Validation
- CLI 插件故障回归：2 项通过。
- 模型状态测试：10 项通过。
- Web UI 测试：60 项通过。
- 网关热加载测试：9 项通过。
- 全仓 `bun run check`：边界检查、构建、类型检查通过，1218 项测试全部通过。
- 端口监听测试在沙箱内被限制，已获原生审批在沙箱外重跑。

### 📊 Change Stats
> 使用本次相关文件的 `git diff --shortstat` 与 `git diff --numstat`，新文件以 `git diff --no-index --numstat /dev/null <file>` 计入；排除任务前 gateway.ts 已有的 5 行新增，以及本记录自身。

- **Files changed:** 6
- **Insertions:** +207
- **Deletions:** -15

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/model-state.ts` | +3 | -2 |
| `apps/gateway/src/gateway.ts` | +8 | -7 |
| `test/model-state.test.ts` | +17 | -6 |
| `test/webui.test.ts` | +59 | -0 |
| `test/gateway-model-reload.test.ts` | +67 | -0 |
| `test/models-sync-plugin-failure.test.ts` | +53 | -0 |

### 📁 Files Modified
- `apps/gateway/src/model-state.ts`
- `apps/gateway/src/gateway.ts`
- `test/model-state.test.ts`
- `test/webui.test.ts`
- `test/gateway-model-reload.test.ts`
- `test/models-sync-plugin-failure.test.ts`
