# ZCode 链路图片识别适配（analyze_image 网关代执行）

## 目标

Codex 经网关调用 z.ai GLM 文本模型时，用户粘贴或 `view_image` 返回的图片能像 Claude Code / ZCode 客户端一样被识别：模型通过 `analyze_image` 内置工具拿到图片内容描述，而不是退化成本地 OCR 命令或幻觉式描述。

## 范围

- 包含：zcode 翻译链路（`zcode-request.ts` / `zcode-response.ts` / `zcode.ts`）新增图片适配；新增网关侧 `analyze_image` 执行器；请求含图片时的工具声明与 system 说明；上游续跑（continuation）机制；对应测试。
- 不包含：z.ai 网页产品内置工具的其他能力（web_fetch 等非图片内置工具）；newapi/CLIProxy 链路；视觉模型直连方案（已实测排除）。

## 背景

### 实测机制（2026-09-13 探测结论，一次性脚本已删除）

1. **URL 改写**：z.ai Anthropic 端点收到含图片块的请求后，自动上传图片至 UCloud CDN，并把模型可见输入改写为上传通知文本（`File ... has been successfully uploaded to CDN and is available at: https://maas-log-prod.cn-wlcb.ufileos.com/anthropic/<session_id>/<md5>.png?...`）。URL 文件名为图片字节的 **md5**（已验证），可反查网关持有的 base64。
2. **内置工具执行**：当请求呈现 Claude Code 客户端指纹（完整 CC system 指令 + CC 工具集）时，模型以 `server_tool_use(name=analyze_image, input={})` + `tool_result` 在**同一条 SSE 内**完成调用与结果回传，全部文本化，客户端零参与。
3. **指纹门控是概率性的**：ccr（Claude Code Router）原始 body 重放 9/9 触发；仅换 system 或仅换工具集为 Codex 形状时命中率下降（复跑才触发）；纯网关形状 0/N 触发（模型思考显示完全不知道 analyze_image 存在）。
4. **显式声明即调用**：把 `analyze_image` 作为普通 function 工具声明进请求（`{imageSource, prompt}`，即 z.ai MCP 形状），模型 3/3 确定调用（带它看到的 URL），但作为普通 `tool_use` 返回客户端等待执行——服务端不按名字拦截。
5. **执行信封**（E1 已验证）：`model=GLM-5.3` + 完整 CC system（3 块）+ 81 个 CC 工具 + 最小消息 `[user: [image(base64), text(指令)]]` → 服务端完整执行并返回 markdown 结果。
6. **已排除路径**：coding-plan 端点的 `glm-4.5v` / `glm-4.6v` 对 URL 与 base64 图片均幻觉（实测描述与真实内容不符）；不存在可声明的服务端图片工具类型（`image_analysis` 等均被当普通 function 工具）；端点 URL、请求头、`metadata.user_id`、`output_config`、`thinking` 形状均与触发无关（逐项变异实测）。
7. **触发链路证据**：ZCode 会话 `sess_2d3686b2`（works）、ccr 日志 `ccr-20260913002000.log` + Claude 会话 `f839e3b4`（works）、网关日志 `zai-v1-responses-http-202609122343*.log`（fails）。

### 相关代码路径

- `src/zcode-request.ts`：`translateZcodeRequest` / `translateTools` / `translateInput`（图片块已正确转 Anthropic base64）。
- `src/zcode-response.ts`：`createZcodeResponse`（单上游流 → Codex Responses SSE）。
- `src/zcode.ts`：上游 fetch 编排（`:179` 端点动态路由）。
- `src/zcode-request-context.ts`：`decorateZcodeBody`（metadata/cache_control 已模仿 ZCode）。

## 方案设计

主对话不依赖概率性指纹，改为**确定声明 + 网关代执行 + 上游续跑**：

1. **请求侧**（`zcode-request.ts`）：翻译后的 messages 含 image 块时——
   - 向上游 tools 追加 `analyze_image` function 声明（`{imageSource: string, prompt: string}`，描述对齐 z.ai MCP 语义）；
   - 向 system 追加适配说明（图片已被服务端转 URL，用 `analyze_image(imageSource=URL, prompt=…)` 识别，禁止伪装看图/本地 OCR）；
   - 在工具映射表中标记为 **gateway 代执行**（区别于客户端回传），并收集本请求图片清单（base64 + md5）。
2. **响应侧**（`zcode-response.ts`）：`tool_use` 命中 gateway 代执行工具时不映射为 Codex `function_call`（Codex 未声明会 400），改为吸收并上报给驱动层；其余（思考/文本/普通工具）行为不变。事件序号、output 下标在续跑段保持连续。
3. **续跑编排**（`zcode.ts`）：上游流以 `stop_reason=tool_use` 结束且存在被吸收的 `analyze_image` 调用时——
   - 逐个执行：`imageSource` 按 URL 尾部 md5 反查请求图片清单（查不到时若仅一张图则兜底用它；多图且无法定位则回错误 tool_result）；
   - 执行器 = E1 信封侧请求（内嵌 CC system+tools 模板资产，同端点同凭证），SSE 内未出现 `server_tool_use:analyze_image` 视为未命中，重试 ≤2 次；
   - 把 `assistant(tool_use)` + `user(tool_result)` 追加进上游 messages，重新请求上游，SSE 续接进同一条 Codex 响应流；
   - 续跑上限（如 3 次）防循环；请求日志按上游腿分别记录。
4. **模板资产**：CC system（3 块）+ 工具集以 JSON 资产内嵌（对齐 `models/` 资产做法），来源与版本写入文件头注释；后续若 z.ai 收紧指纹可只换资产。

## 风险

- 风险：E1 信封依赖 z.ai 未公开的 Claude Code 适配指纹，官方变更后执行器命中率可能下降。
  缓解：模板资产化便于更新；重试 + 失败时向模型回"分析不可用" tool_result 让其降级作答，不影响主链路。
- 风险：续跑机制改动 `createZcodeResponse` 的流生命周期（abort、usage 合并、`message_stop` 校验）。
  缓解：续跑作为外层驱动重入（每次续腿仍是完整独立上游流），响应翻译层仅增加"吸收指定 tool_use"能力，最小化对现有状态机的侵入。
- 风险：多图 md5 反查失败或模型编造 imageSource。
  缓解：单图兜底 + 失败回错误 tool_result（模型可重试或说明），不做静默丢弃。
- 风险：声明 analyze_image 与未来 z.ai 服务端按名拦截行为冲突（若官方开始拦截同名 function 工具）。
  缓解：探测脚本结论 4 表明当前不拦截；实现时保留开关（配置项），冲突时可快速关闭回退。

## 里程碑

1. 调研收敛（已完成，见背景）。
2. M1：请求侧声明 + system 说明 + 工具映射新类别（含单测）。
3. M2：响应侧吸收 tool_use + zcode.ts 续跑编排（含单测：吸收、续跑、上限、失败降级）。
4. M3：执行器（模板资产 + md5 反查 + 重试）与 E2E（授权一次性实测，验证 Codex 粘贴图片端到端识别）。
5. 收尾：README、schema（如加配置项）、tech-debt 登记、history 记录。

## 验证方式

- 命令：`bun run check`（类型 + 全部测试 + 构建）。
- 手工检查：新增单测覆盖声明注入、吸收、续跑状态机、md5 反查、重试与降级。
- 观测检查：授权一次性 E2E——Codex 粘贴图片提问，网关日志出现 analyze_image 续腿与 tool_result，Codex 端展示真实识别内容（与图片实际内容一致，非幻觉）。

## 进度记录

- [x] 机制探测与方案收敛（本文件背景节，一次性脚本已删除）。
- [x] M1：请求侧声明与说明注入（`zcode-request.ts` + `zcode-vision.ts`）。
- [x] M2：响应侧吸收与续跑编排（`zcode-response.ts` 网关工具吸收 + `zcode.ts` 执行钩子与续跑 fetch）。
- [x] M3：执行器（`zcode-vision-template.json` 指纹资产 + 标识反查 + 重试）与 E2E。
- [x] 收尾文档与 history。

## 验证结论（2026-09-13）

- `bun run check`：267 项测试全通过（新增 11 项：声明注入/冲突让位、图片收集含 tool_result、标识反查、结果提取、执行器命中与重试、吸收续跑事件连续、失败降级、续跑上限）。
- E2E（授权、临时端口 8399 `serve --config` 隔离实例、一次性）：Codex 形状请求带真实截图 → 上游 tools 含 `analyze_image`、system 含适配说明 → 模型调用被吸收 → 执行器侧请求触发服务端 `server_tool_use:analyze_image` → 续跑 1 腿 → 最终输出与图片真实内容逐项一致（非幻觉）；交换日志含 `analyze_image continuation legs: 1`。临时实例与文件已清理。

## 决策记录

- 2026-09-13：采用"确定声明 + 网关代执行 + 上游续跑"而非"环境指纹伪装"——指纹门控是概率性的（仅换 system/工具单侧时需复跑才触发），不可作为产品路径；显式声明实测 3/3 确定调用。执行器复用触发链路的 E1 信封（完整 CC system+tools），放弃视觉模型直连（coding-plan 的 glm-4.5v/4.6v 实测为幻觉输出）。
- 2026-09-13：`imageSource` 反查采用 URL 尾部 md5（实测 URL 文件名即图片字节 md5），单图时无条件兜底，多图定位失败回错误 tool_result。
