## [2026-10-14 12:15] | Task: Zen 门禁复测固化与伪装面收敛立项（同日实施推进）

### 🤖 Execution Context
* **Agent ID**: zcode
* **Base Model**: account:zai-individual-coding-plan/GLM-5.3
* **Runtime**: ZCode CLI
* **Git User**: hubert
* **Branch**: main

### 📥 User Query
> apply_patch 静默丢弃问题已修复（`0ee31ce`）。执行建议：把两轮门禁探针固化成仓库手动诊断脚本（`scripts/`，失败时单点重测）；结论更新到 `docs/fingerprint-data.md`、`docs/opencode2-zen-free-models-gateway-research.md` 与技术债登记；再创建执行计划到 docs 下。随后「开始实施」推进 M1/M2。

### 🛠 Changes Overview
**Scope:** scripts/、docs/、packages/opencode-zen（门禁画像相关）

**Key Actions:**
- **[诊断脚本]**: 新增 `scripts/zen-gate-probe.ts`——隔离探针矩阵（垫补对照 / 回退形态 / 仅客户端工具 / read+bash 与 shell+read 垫补 / 单名缺失 ×2 / 无模板 / 两段式 UA / 无工具 ×2），复用仓库指纹材料，输出画像漂移判定与退出码；实测 11/11 OK、退出码 0。
- **[调研报告]**: 追加「2026-10-14 门禁复测修正」段——system 模板不再检查、工具检查为名单制（须含 `read` 与 `bash`/`shell` 之名、schema 不查）、两段式 UA 放行；对照形态仍 200。
- **[指纹数据文档]**: opencode-zen notes 补 10-14 复测结论；「更新方法」改为以探针脚本验证；更新记录表新增一行。
- **[技术债]**: 新增 2026-10-14 行闭环 10-09「待真机观察」项；10-08 行 ⑥ 追加「Endpoint is unavailable 探测 403 被归一化为 zen_free_tier_error」同类实例（cat-jam-free 五连 403 实测，真实流量同窗口 200）。
- **[执行计划]**: 新建 `docs/exec-plans/completed/zen-gate-fingerprint-reduction.md`；M0 完成，M1/M2 由协作会话实施（`padOpencodeZenGateTools` 垫补、模板注入移除、目录停发提示词替换）、本会话复核并验证（check 全绿 990 pass、探针 10/10）。
- **[实施（协作会话 + 本会话复核）]**: `fingerprint.ts` 垫补函数替代官方工具合并、`injectOpencodeZenFingerprintBody` 移除模板分支（system 与工具定义原样透传）；`catalog.ts` 停用 `withAgentSystemPrompt`，条目回落 Codex 官方提示词；`index.ts` 注释与调用同步；三组测试改写（含空列表垫补、同名优先、畸形输入）。
- **[验收与归档（下午晚些）]**: M3 用户验收通过（验收会话 rollout `01a13905`，模型 space-bunny-free：rollout 提示词 19,754 字符与服务目录逐字吻合且为 Codex 官方提示词；apply_patch 以 `custom_tool_call` 形态端到端新建 test.txt 成功——`0ee31ce` 修复形态的实证；占位零误调）；期间完成 cat-jam-free 勘误（上新中测试模型而非下线：官方 opencode2 客户端对照得一致 403 `Endpoint is unavailable`、元数据在册未 deprecated、门禁次序实证后端未就绪；撤销同日误登的探针信号分类技术债行，并给并行任务的错误透传历史补勘误段）。计划归档至 `completed/zen-gate-fingerprint-reduction.md`，4 处 `active/` 引用同步，技术债 2026-10-14 收敛行关闭。
- **[运行时切换（下午）]**: 修复探针首帧判定（累积读取至 SSE 帧边界，消除 `no-tools-pad` 截断误报，修复后 11 项真网 11/11 OK、退出码 0）；真机 `models --sync --select <现存 7 项>`（上游已下架 `gemini-pro-agent`，无终端交互失败后显式传参）并重启网关服务；`/v1/models?client_version=0.162.0` 核对 7 个 zen 条目两提示词字段均为 Codex 官方提示词（19,737/19,754 字符）、OpenCode 模板零残留；计划 M2 运行时项与 M3 自动化项勾选完成，指纹数据文档补「已据此实施收敛」与实现记录行，技术债行标记待用户验收。

### 🧠 Design Intent (Why)
2026-10-08 mitm 实证的三层门禁（含 system 模板逐字符匹配）已漂移：10-14 探针显示请求体只剩工具名单闸且仅查名字。现行注入面（模板合并 + 12 个官方工具定义 ≈4.3K token/请求 + 目录提示词全量替换）不再为过闸所必需，且替换提示词已真机证实造成工具调用错位（write/shell/read 幻觉、apply_patch 约定丢失）。收敛到最小伪装面（两个无参占位）：占位被误调时由 Codex `unsupported call` 一轮自纠兜底（真机 8 次实录）；`convert.ts` 的 customNames 只转换客户端声明的 custom 工具，占位名天然按 function_call 透传，无需显式登记。运行时切换已执行（sync + 服务重启 + 服务目录核对）；成品条目无需缓存迁移——store 读盘只取 ids/元数据/裁决，条目每次进程内重建，新代码随服务重启即生效。剩余用户验收：新开 Codex 会话核对 rollout 提示词、apply_patch 往返、占位自纠。

### 📊 Change Stats
> 口径说明：`packages/opencode-zen/src/index.ts` 与 `test/opencode-zen-gateway.test.ts` 的工作区 diff 同时含有本任务（M1 注释/调用与上游体断言）与并行任务「错误消息透传」（归一化函数块与错误路径断言，见 [20261014-1339 历史](20261014-1339-zen-error-message-passthrough.md)）的未提交改动，`git diff HEAD` 无法分离，下表为两文件合并统计。

- **Files changed:** 11（tracked 11；新增未跟踪：探针脚本、计划、本历史文件）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/fingerprint.ts` | +46 | -81 |
| `packages/opencode-zen/src/index.ts` | +84 | -54 |
| `packages/opencode-zen/src/catalog.ts` | +10 | -7 |
| `test/opencode-zen-fingerprint.test.ts` | +33 | -70 |
| `test/opencode-zen-gateway.test.ts` | +52 | -21 |
| `test/opencode-zen-catalog.test.ts` | +8 | -3 |
| `scripts/zen-gate-probe.ts` | +24 | -13（新增后追加修改） |
| `docs/exec-plans/completed/zen-gate-fingerprint-reduction.md` | +10 | -4（新增后追加修改） |
| `docs/opencode2-zen-free-models-gateway-research.md` | +14 | -1 |
| `docs/fingerprint-data.md` | +12 | -7 |
| `docs/exec-plans/tech-debt-tracker.md` | +2 | -2 |

### 📁 Files Modified
- `packages/opencode-zen/src/{fingerprint,index,catalog}.ts`
- `test/opencode-zen-{fingerprint,gateway,catalog}.test.ts`
- `scripts/zen-gate-probe.ts`
- `docs/exec-plans/completed/zen-gate-fingerprint-reduction.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/fingerprint-data.md`
- `docs/opencode2-zen-free-models-gateway-research.md`
