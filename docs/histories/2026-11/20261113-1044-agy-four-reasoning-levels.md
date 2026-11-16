## [2026-11-13 10:44] | Task: 修复 AGY 四档 reasoning 合并与 Orchestrator 缺失

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6 系列（会话未提供具体变体）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`（Git user.name 本身也含邮箱，此处去重展示）
* **Branch**: `codex/fix-plugin-stream-logging-and-agy-tool-tolerance`

### 📥 User Query
> AGY 更新后有四档 reasoning，当前模型合并不正确；另外缺少 Orchestrator。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/agy`、AGY 目录与请求及网关测试。

**Key Actions:**
- 将 `-xhigh` 纳入模型家族，按 low、medium、high、xhigh 输出实际存在的档位。
- 分离家族档位与传输枚举，xhigh/max 解析到最高档；缺档按距离优先、等距偏高回退。
- 默认档位复用请求回退顺序；缓存修订升为 8，缓存校验接受 xhigh。
- 选中 `-xhigh` 变体时不再传 thinkingLevel，避免原 high 映射覆盖最高档。
- 将客户端 UA 更新为官方实际目录请求的 1.5.7 / 1019769835，自动恢复 Orchestrator。
- 纠正指纹维护文档：AGY changelist 必须来自实际 UA，不能使用 Go 编译器构建号。
- 覆盖四档合并、缺档回退、磁盘恢复、请求转换及网关转发，保留原有暂存变更。

### 🧠 Design Intent (Why)
旧逻辑只识别三档后缀，导致 Hydrogen 的 xhigh 成为独立模型，且请求将 xhigh 映射为 high。
经用户授权只读查询目录，确认 Hydrogen 存在四个真实变体，其他已列出的家族仍为三档。
对官方 CLI 的只读检查确认：ResolveEffort 选定具体变体后清除透传 effort；
不能把其他协议中的 EXTRA_HIGH 枚举直接套用到本通道。

Orchestrator 缺失来自过旧的客户端指纹。官方 `agy models` 返回真实 ID
`gemini-pro-orchestrator-g1-pro`；只读观察实际请求确认 UA 为 1.5.7 / 1019769835。
保持网关原有请求体，仅替换 UA，即可从官方目录得到该条目；无需增加权益参数、
切换目录接口或硬编码模型。凭据元数据的临时诊断修改已完整撤销。
`go version -m` 显示的 cl/1012564305 是 Go 编译器构建号，不是 AGY UA 构建号。

### ✅ Validation
- 新增目录测试在修复前复现三项失败，修复后通过。
- 四档修复阶段 AGY 目录、请求、网关定向测试：58 项通过。
- 最终 `bun run check`：lint、边界检查、构建、类型检查及全量 1379 项测试通过。
- 用构建后的正式 transport → parse → build 链路只读请求官方目录，确认七个模型条目，
  包含四档 Hydrogen 与独立 Orchestrator；未使用额外请求包装或本机目录写入。
- Orchestrator 推理路由由模拟上游测试验证：保留真实模型 ID，并使用新版 UA。
- 独立审查穷举 44 个档位/缺档组合，默认档位与实际路由一致。
- 未执行真实推理、安装或服务重启；manual 模式使用新构建后需显式刷新目录。

### 📊 Change Stats
> 来自本任务八个代码/测试/文档文件的 `git diff --shortstat` 与 `git diff --numstat`。
> 原始合计为 8 files changed, 176 insertions(+), 43 deletions(-)；
> 扣除 `docs/fingerprint-data.md` 开工前已有的 13 行新增，得到下列本任务统计。
> 不包含已有暂存修改和本历史文件。

- **Files changed:** 8
- **Insertions:** +163
- **Deletions:** -43

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/agy/src/catalog.ts` | 24 | 24 |
| `packages/agy/src/fingerprint-data.json` | 2 | 2 |
| `packages/agy/src/request.ts` | 4 | 4 |
| `packages/agy/src/transport.ts` | 7 | 7 |
| `test/agy-catalog.test.ts` | 40 | 1 |
| `test/agy-gateway.test.ts` | 68 | 0 |
| `test/agy-request.test.ts` | 10 | 0 |
| `docs/fingerprint-data.md` | 8 | 5 |

### 📁 Files Modified
- `packages/agy/src/catalog.ts`
- `packages/agy/src/fingerprint-data.json`
- `packages/agy/src/request.ts`
- `packages/agy/src/transport.ts`
- `test/agy-catalog.test.ts`
- `test/agy-gateway.test.ts`
- `test/agy-request.test.ts`
- `docs/fingerprint-data.md`
