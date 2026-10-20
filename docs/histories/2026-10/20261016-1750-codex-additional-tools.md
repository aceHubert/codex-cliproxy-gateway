## [2026-10-16 17:50] | Task: 适配 Codex additional_tools 增补工具声明

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/model-catalog-push`

### 📥 User Query
> additional_tools 是 Codex 新增的，需要适配；先确认 @ai-sdk 是否已有对应配置。

### 🛠 Changes Overview
**Scope:** llm-bridge、opencode-zen、zcode、agy 及回归测试和执行文档。

**Key Actions:**
- **[入站归一化]**: 跨协议转换先将 input.additional_tools 中的声明合入顶层 tools，再移除信封；顶层同身份优先，function/custom 共用名称身份，同名 namespace 合并成员，多批声明去重且不修改原始请求。
- **[原生协议]**: 原生 Responses 仍保留信封及其历史位置，仅用合并视图注册工具身份，避免破坏有序增补和缓存前缀。
- **[插件入口]**: ZCode 在服务端工具规划前提升声明；AGY 遵循独立转换边界，在自身包内处理同等增补规则并保留扁平 namespace 身份，不新增任何依赖。
- **[Zen 集成]**: muse-spark 复用公共归一化替代重复提升代码；保留模型特有净化与实际顶层 read 门禁。模拟上游验证增补的 functions.exec 能还原为 custom_tool_call。
- **[SDK 核对]**: 本地 @ai-sdk/openai 4.0.95 源码无 additional_tools/additionalTools 配置，[Vercel PR #17176](https://github.com/vercel/ai/pull/17176) 仍未合并。该配置面向 OpenAI 出站序列化，不能替代网关入站解析；未更新 SDK 版本。
- **[边界留档]**: 执行计划归档；审查发现的既有原生 Responses 跨 namespace 同名工具非流式聚合身份冲突另记 P2 技术债。

### 🧠 Design Intent (Why)
原实现只收集顶层 tools，并将 input.additional_tools 连同其中的真实工具声明一并丢弃；Zen 随后补入门禁 read，导致上游只看到宿主无法执行的 read。将声明提取放在工具规划和协议转换前，恢复已有工具调用能力；原生 Responses 保留服务支持的原始有序信封。

### ✅ Validation
- 构建、严格类型检查与包边界检查通过，`git diff --check` 通过。
- 完整测试复验：`bun scripts/run-tests.ts`，1210 pass / 0 fail，85 个文件，30.02 秒；脚本设置 60 秒超时。
- `bun run check` 的测试阶段先后遇到沙箱禁止监听与既有 Web UI 临时端口竞争，后者触发 Bun 测试注册级联错误；相同构建产物的完整测试复验全部通过。
- 独立审查未发现本次适配的阻断问题；测试使用离线转换与模拟上游，没有使用真实上游凭据或部署服务。
- 用户真机验收补记（17:51，北京时间）：会话「ll alpha 是新模型吗？」使用 space-bunny-free，通过 functions.exec 连续执行两次 search_service.web_run；两次调用均为 custom_tool_call，返回匹配的 custom_tool_call_output 与搜索结果，本轮无 unsupported call。与该会话 17:32 read 误调失败对照，确认真实客户端工具链恢复；最终回答把 ll-alpha 误判为目录名的内容错误单独说明。

### 📊 Change Stats
> 仅统计本次任务：`git diff --shortstat` / `--numstat` 指定涉及的 12 个已有文件，新增 helper 与执行计划以 `git diff --no-index --numstat /dev/null <file>` 补齐；不包含本历史文件或工作区原有 models-push 等改动。

- **Files changed:** 14
- **Insertions:** +693
- **Deletions:** -60

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/responses-tools.ts` | +79 | -0 |
| `packages/llm-bridge/src/request.ts` | +11 | -10 |
| `packages/llm-bridge/src/index.ts` | +1 | -0 |
| `packages/llm-bridge/src/types.ts` | +1 | -1 |
| `packages/llm-bridge/README.md` | +6 | -0 |
| `packages/opencode-zen/src/index.ts` | +11 | -38 |
| `packages/zcode/src/request.ts` | +8 | -1 |
| `packages/agy/src/request.ts` | +50 | -0 |
| `test/llm-bridge-convert.test.ts` | +208 | -6 |
| `test/opencode-zen-gateway.test.ts` | +60 | -4 |
| `test/zcode-request.test.ts` | +55 | -0 |
| `test/agy-request.test.ts` | +149 | -0 |
| `docs/exec-plans/completed/codex-additional-tools.md` | +53 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |

### 📁 Files Modified
- `packages/llm-bridge/src/{responses-tools,request,index,types}.ts` 与包 README。
- `packages/{opencode-zen,zcode,agy}/src/{index,request}.ts`，具体文件见上表。
- `test/{llm-bridge-convert,opencode-zen-gateway,zcode-request,agy-request}.test.ts`。
- `docs/exec-plans/completed/codex-additional-tools.md` 与技术债追踪。
