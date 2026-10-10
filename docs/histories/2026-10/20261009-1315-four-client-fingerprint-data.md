## [2026-10-09 13:15] | Task: 分析四个官方客户端并生成统一指纹数据文件

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `step-5-preview`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> 分析一下zcode codebuddy qoder agy，生成fingerprint-data.json，不要直接使用zcode内置的了

### 🛠 Changes Overview
**Scope:** `src/zcode/fingerprint-data.json`、`src/codebuddy/fingerprint-data.json`、`src/qoder/fingerprint-data.json`、`src/agy/fingerprint-data.json`（各模块新增，各自维护）、对应四个适配器模块、`test/zcode-request-context.test.ts`、`test/qoder-transport.test.ts`、`test/codebuddy-gateway.test.ts`、`test/agy-gateway.test.ts`、`docs/fingerprint-data.md`（新增）、`docs/exec-plans/tech-debt-tracker.md`

**Key Actions:**
- **[客户端分析]**: 对本机四个官方客户端做指纹提取：ZCode.app 3.14.5（Info.plist + `~/.zcode/cli/rollout/model-io-*.jsonl` 共 128 条真实请求头）、`@tencent-ai/codebuddy-code` 2.157.0（npm 包）、`qodercli-1.1.65`（`~/.qoder/bin/qodercli`，二进制常量表）、`agy 1.3.1`（`go version -m` 取 cl/985595000）。
- **[数据文件]**: 按用户要求**各适配器模块各自维护自己的** `fingerprint-data.json`（对齐 `src/opencode-zen/fingerprint-data.json` 惯例），JSON 只存纯数据（版本、UA 模板、产品身份、内置提示词）；新增 `docs/fingerprint-data.md` 统一记录四个客户端的 source/notes 与更新方法（JSON 内不写注释性字段）。
- **[适配器接线]**: 四个适配器删除硬编码指纹常量，改读本模块数据文件（局部接口断言形状）；`appVersion` 等与本机安装强相关的值仍运行时动态读取。
- **[内置提示词]**: 按用户追加要求提取各客户端内置 agentSystemPrompt：zcode 三条（agent/标题/网页搜索，取自 179 条真实请求）；qoder 两条（CLI 484 字符 + 桌面 1253 字符）；agy 三条（Go text/template 原文 + 短身份行 + 标题生成器）；codebuddy 主提示词初版误判为「运行时拼装、无静态字面量」（只检索了 JS bundle），经用户质疑后复查定位到真实来源——安装包 `product.json` 的 `prompts` 数组（PromptManager 模板表，123 个模板）：`cli-agent-prompt`（19,627 字符 Jinja 模板，cli 与 general-purpose 代理共用）、`base-agent-instructions`（24 字符身份行）、`terminal-title-generator-instructions`（1,922 字符），已全部回填 JSON。
- **[校准结论]**: ZCode UA 去掉已失效的 `ai-sdk/anthropic/3.0.81` 后缀（3.14.5 真实流量为 `ZCode/3.14.5`，了结 zcode-3.12.3-compat 待办④；`x-zcode-agent=glm`、`x-zcode-app-version` 确认仍在）；CodeBuddy CLI 版本 2.151.0 → 2.157.0；Antigravity 版本/changelist 成对更新 1.2.17/cl=993434119 → 1.3.1/cl=985595000；Qoder 1.1.65 与 cli profile 经二进制核对一致。
- **[测试]**: 四个适配器既有测试文件各并入一条指纹用例（数据驱动来源头/版本、提示词留痕、agy 版本与 cl 成对、qoder 双 profile 齐全）；更新 3 处 UA 断言；`bun run check` 全绿（738 用例）。
- **[模板剥变量]**: 应用户要求把 codebuddy（Jinja，48 处构造）与 agy（Go template，5 处）的 `agentSystemPrompt`/`titleSystemPrompt` 按确定性规则剥掉变量指令（if/else 保留 else 默认分支、默认不成立的守卫块整块删除、for 循环删除、裸变量行删 token 后只剩标签/骨架的整行删除、空容器连标签删除、压缩空行）；方法写入 `docs/fingerprint-data.md` 供下次更新沿用。codebuddy 19,627→12,223 字符、agy 627→454 字符、标题提示词 1,922→1,857 字符，产物零 `{{`/`{%` 残留（测试断言）。
- **[base_instructions 接线]**: 应用户「直接替换」决策，四个适配器 `catalog()` facade 把目录条目 `base_instructions` 直接替换为各自 `agentSystemPrompt`——Codex 按该字段发送系统提示词（真实 Codex catalog 快照每条目带 17–21K 字符官方提示词可证），经 `/v1/models?client_version=` 与 `model_catalog_json` 缓存文件下发；workbuddy/* 初版不赋值，当晚按用户决策改为直接沿用 CodeBuddy 主提示词（未做品牌名替换，真实 WorkBuddy 客户端经 `CODEBUDDY_BRAND_NAME` 全局替换模板品牌字样，盲目替换会连文档 URL 一起改错，待拿到 WorkBuddy 产品配置后再处理）；OpenCode Zen 不在此列（门禁要求走转发路 `injectZenFingerprintBody`）。四个网关测试各加接线断言。

### 🧠 Design Intent (Why)
四个适配器的客户端指纹（版本号、UA、产品标识）此前散落硬编码在各模块源码里，随官方客户端发版逐一漂移：CodeBuddy 停在 2.151.0（本机已 2.157.0）、Antigravity 停在 1.2.17/cl=993434119（本机已 1.3.1/cl=985595000）、ZCode 的 `ai-sdk/anthropic/3.0.81` 后缀在 3.12.3 host 代码里已搜不到却仍带着上线（3.12.3 兼容计划明确「待抓真实流量后决定更新或移除」）。本次按用户要求以「分析本机客户端」替代「沿用 zcode 内置值」：用真实请求日志（ZCode）、安装包版本（CodeBuddy）、二进制常量表（Qoder）、go build info（Antigravity）四类一手来源取值，收敛到单一 JSON，客户端轮换时只改数据不改码。无法在本机闭环验证的值（WorkBuddy 版本、Qoder desktop profile、`Z Code@cli` flavor）不盲改：保留实测可用值并在 `notes` 与技术债追踪里登记差异，待对应实流出现时再切。

### 📊 Change Stats
> 工作区存在其他会话的未提交改动，以下只统计本次任务触碰的文件（新增文件为实测行数）。

- **Files changed:** 10（新增 5）
- **Insertions:** +247
- **Deletions:** -21

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/fingerprint-data.json` | +17 | 新增 |
| `src/codebuddy/fingerprint-data.json` | +7 | 新增 |
| `src/qoder/fingerprint-data.json` | +19 | 新增 |
| `src/agy/fingerprint-data.json` | +11 | 新增 |
| `docs/fingerprint-data.md` | +108 | 新增 |
| `src/codebuddy/request-context.ts` | +10 | -4 |
| `src/zcode/request-context.ts` | +13 | -5 |
| `src/agy/transport.ts` | +12 | -3 |
| `src/qoder/transport.ts` | +13 | -5 |
| `test/zcode-request-context.test.ts` | +18 | -2 |
| `test/qoder-transport.test.ts` | +19 | 0 |
| `test/codebuddy-gateway.test.ts` | +17 | 0 |
| `test/agy-gateway.test.ts` | +18 | 0 |
| `test/zcode-gateway.test.ts` | +1 | -1 |
| `docs/exec-plans/tech-debt-tracker.md` | +2 | -1 |

### 📁 Files Modified
- `src/{zcode,codebuddy,qoder,agy}/fingerprint-data.json`（新增：各自模块的纯指纹数据）
- `docs/fingerprint-data.md`（新增：四客户端 source/notes 与更新方法、更新记录表）
- `src/zcode/request-context.ts`（UA 模板/title/agent/channel/referer 改取本模块数据文件）
- `src/codebuddy/request-context.ts`（三个版本常量改取本模块数据文件）
- `src/qoder/transport.ts`（协议版本与 client profiles 改取本模块数据文件）
- `src/agy/transport.ts`（版本与 changelist 改取本模块数据文件）
- `test/zcode-request-context.test.ts`、`test/qoder-transport.test.ts`、`test/codebuddy-gateway.test.ts`、`test/agy-gateway.test.ts`（各并入指纹用例）、`test/zcode-gateway.test.ts`（UA 断言更新）
- `docs/exec-plans/tech-debt-tracker.md`（④ 已了结；登记未复验项）

### 🔍 Verification
- `bun run typecheck` 通过；`bun test` 738+ 用例全绿；`bun run check`（含 UI 构建与 CLI 打包）通过。
- 运行时冒烟：`ZCode/3.14.5`（与本机真实流量一致）、`CLI/2.157.0`、`cosyVersion 1.1.65`、`antigravity/cli/1.3.1 … cl=985595000`；四个数据文件的提示词字段与客户端源提取结果逐条比对一致。
- 接线冒烟：四个适配器 `catalog()` 产出的条目 `base_instructions` 均等于各自数据文件的 `agentSystemPrompt`（codebuddy 仅 `codebuddy/*`，workbuddy/* 留空）。
- 安全边界：数据文件只含版本/UA/产品标识/内置提示词等非敏感常量，未引入任何凭据、令牌或会话内容。
