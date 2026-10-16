# Codex additional_tools 工具声明适配

## 目标

Codex 在 input.additional_tools 中增补的工具经网关转发后仍可调用，不再因信封剥离丢失声明而只剩 Zen 门禁 read 工具。

## 范围

- 包含：共享 Responses 声明归一化、协议转换与插件入口必要接入、回归测试和历史记录。
- 不包含：上游服务器搜索能力新增、真实凭据请求、服务部署或重启。

## 背景

- 相关代码路径：packages/llm-bridge/src/request.ts、packages/opencode-zen/src/index.ts。
- 已知约束：function/custom/namespace 身份与调用历史必须保持一致；原生 Responses 保留工具增补位置和扩展字段；保留工作区已有改动。

## 风险

- 风险：同名声明冲突、namespace 合并遗漏、插件预处理先于公共转换导致工具仍丢失。
- 缓解方式：顶层同身份声明优先、namespace 合并成员、插件入口审计与请求/响应回归。

## 里程碑

1. 调研与离线复现。
2. 统一归一化并接入必要入口。
3. 回归验证、代码审查与记录。

## 验证方式

- 命令：针对性测试（60 秒上限）、bun run check。
- 手工检查：对比顶层工具与信封工具进入 Zen 上游后的名单；确认源对象不变。
- 观测检查：模拟上游工具调用可还原客户端 custom/namespace 身份。

## 进度记录

- [x] 确认工具信封先被丢弃、随后补入 read 的离线反例。
- [x] 完成公共归一化、ZCode/AGY 入口适配与 Zen 门禁集成。
- [x] 构建、类型及包边界检查通过，全量测试复验 1210 pass / 0 fail；完成审查与历史记录。

## 决策记录

- 2026-10-16：把工具信封当声明来源，在转换前提升；以顶层优先与 namespace 成员合并消除重复。压缩摘要请求继续按原有设计移除所有工具。
- 2026-10-16：核对本地 @ai-sdk/openai 4.0.95 源码，无 additional_tools/additionalTools 配置；Vercel PR #17176 仍未合并。SDK 是出站拼装器，原始入站信封仍由桥接解析。按有序增补语义，原生 Responses 直通保留信封位置，仅用合并视图注册身份；muse-spark 因上游明确不支持信封而单独提升。
- 2026-10-16：遵循既有 AGY 独立转换边界，其增补声明归一化在包内实现，不新增桥接或 SDK 依赖；ZCode 在自身服务工具规划前调用共享归一化。
- 2026-10-16：原生 Responses 非流式聚合按裸工具名匹配身份的既有跨 namespace 同名冲突不属于本轮信封解析修复，已登记技术债。Zen 门禁仍检查实际顶层 tools，历史信封不替代其门禁字段。

## 验证结果

- `bun run check`：包边界、全量构建与严格类型检查通过；首次测试受沙箱端口监听限制，放开本地端口后遇到既有 Web UI 临时端口竞争，引发 Bun 测试注册级联错误。
- 相同构建产物运行 `bun scripts/run-tests.ts` 复验：1210 pass、0 fail，85 个文件，30.02 秒；测试脚本有 60 秒超时。
- 代码审查：未发现本次适配的阻断问题；原生 namespace 同名聚合边界另行跟踪。
- SDK 核对：本地 `@ai-sdk/openai@4.0.95` 源码不含 `additional_tools` / `additionalTools`；[Vercel PR #17176](https://github.com/vercel/ai/pull/17176) 尚未合并，现有 `toolSearch` 不等价于入站信封解析。
- 用户真机验收（2026-10-16 17:51，北京时间）：会话「ll alpha 是新模型吗？」在 `opencode-zen/space-bunny-free` 下以 `functions.exec` 的 custom 调用执行两次 `search_service.web_run`，两次均返回真实搜索结果和匹配的 custom_tool_call_output，无 unsupported call。相同会话 17:32 仍是 read 误调失败，形成前后对照；工具链验收通过。回答将 ll-alpha 判断为目录名属于内容错误，不属于工具执行失败。
