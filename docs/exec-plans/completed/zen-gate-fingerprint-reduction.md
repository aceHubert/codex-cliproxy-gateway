# OpenCode Zen 门禁伪装面收敛（占位垫补替代模板与官方工具注入）

状态：已完成并归档（2026-10-14 用户验收通过）。

## 目标

zen 链路的伪装收缩到 2026-10-14 实测的最小必需集：请求头与会话标识保持现状，请求体仅在工具名单缺 `read`/`bash`（或 `shell`）之名时垫两个无参占位工具，不再注入官方 system 模板与 12 个官方工具定义；zen 目录条目停发提示词替换，Codex 恢复自身操作性指令（apply_patch freeform 协议、shell 约定）；占位名登记响应声明表，模型误调时由既有 `unsupported call` 机制兜底。

## 范围

- 包含：
  - `packages/opencode-zen/src/fingerprint.ts`：`mergeOpencodeZenTools` 改为「客户端同名定义优先；缺 `read` 或 `bash`/`shell` 之名才垫对应无参占位」；`injectOpencodeZenFingerprintBody` 移除模板合并分支（保留 `stream: true` 强制、`include_usage`、`prompt_cache_key`、effort 归一化）。
  - zen 目录合成（`packages/opencode-zen/src/catalog.ts`）：条目停发 `base_instructions` 与 `model_messages.instructions_template` 的官方提示词替换，回落官方 Codex 提示词基底（两字段必须一起回落——只改 base_instructions 无效）。
  - 响应声明表（0ee31ce 修复后的转换层）：登记两个占位名为已知 synthetic 工具，模型调用按普通 `function_call` 回传，不在「未声明的工具」处转 failed。
  - 测试：fingerprint 合并/注入、目录合成、响应还原的既有用例按新行为改写；补「同名去重」「缺名垫补」「无模板过闸」用例。
  - `scripts/zen-gate-probe.ts` 与三份文档更新（M0，已随本计划入库）。
- 不包含：
  - 其余四家适配器（zcode/codebuddy/qoder/agy）的 base_instructions 策略与门禁——各自上游校验不同，未重测，维持现状。
  - UA 简化为两段式（四段式继续可用，无收益；两段式仅作为探针中的画像对照项）。
  - llm-bridge 替换/收编（apply_patch 静默丢弃已由 `0ee31ce` 修复，custom_tool_call 往返闭环；llm-bridge 的定位调整属独立债务）。
  - 标头层收敛（traceparent/b3 等保留，零成本且免疫未来收紧）。

## 背景

- 相关文档：[调研报告 10-14 修正段](../../opencode2-zen-free-models-gateway-research.md)、[指纹数据文档 opencode-zen notes](../../fingerprint-data.md)、[技术债 2026-10-14 行](../tech-debt-tracker.md)、`scripts/zen-gate-probe.ts`。
- 相关代码路径：`packages/opencode-zen/src/fingerprint.ts`、`catalog.ts`、`convert.ts`、`index.ts`、`fingerprint-data.json`。
- 已知约束：
  - 2026-10-14 实测画像：工具名单闸（须含 `read` 与 `bash`/`shell` 之名，schema 不查）；system 模板不检查；两段式 UA 放行；对照形态（现行注入）仍 200。
  - 门禁五天内漂移过一次（10-08 → 10-14），最小面可能再收紧：`fingerprint-data.json` 数据与探针脚本承接回退，注入实现移除后以 git revert 为回退路径。
  - Codex 按 `model_messages.instructions_template` 发系统提示词（2026-10-09 实测，只改 `base_instructions` 无效）；停发替换须两字段一起回落。
  - 目录条目缓存落盘 + 客户端 `/v1/models` 本地缓存：改提示词后须执行 `models --sync`（或重启 Codex）并**新开会话**验证（见指纹数据文档「客户端缓存时序」）。
  - 模型误调占位工具的兜底已实测：Codex 回 `unsupported call: <name>`，模型一轮自纠（真机 rollout 8 次实录）；占位 schema 为空对象，带不出参数、不可能触发真实执行。

## 风险

- 门禁重新收紧（恢复模板/工具定义匹配）：探针脚本单点重测（对照探针失败即指纹本体过期）；`fingerprint-data.json` 保留全部官方数据作回退材料，回退路径为 git revert 本计划的指纹层提交。
- 停发替换提示词后每请求 token 上升（Codex 操作性指令长于 GA 模板，约 12.9K 字符官方工具定义同时退出）：`prompt_cache_key` 已按会话固定，增量集中在会话首请求。
- 模型受 OpenCode 调优先验误调 read/bash：占位描述明写不可执行并指回 harness 工具；实测 `unsupported call` 一轮自纠。
- 非 Codex 客户端（OpenCode 系自带 read/bash 真定义）：同名去重保证客户端定义优先、不重复垫补，天然过闸。

## 里程碑

1. M0 探针与画像固化（已完成）：`scripts/zen-gate-probe.ts` 入库并复测一致；调研报告、指纹数据文档、技术债登记更新。
2. M1 指纹层收敛：占位垫补替代官方工具合并；模板注入移除；`fingerprint-data.json` 数据保留。
3. M2 目录提示词回落：zen 条目停发替换；执行 `models --sync` 并按「客户端缓存时序」核对。
4. M3 测试与真机验收：`bun run check` 全绿；真机 Codex 会话核对 rollout 提示词、apply_patch/exec_command 往返、占位调用自纠。
5. 归档：计划移至 `completed/`，技术债 2026-10-14 行标记已清偿。

## 验证方式

- 命令：`bun run check`；`bun scripts/zen-gate-probe.ts`（11 项全部 OK，对照探针 200；偶发 DRIFT 先复跑再定性，见脚本头注释）。
- 手工检查：`bun run dev models --sync` 后新开会话，`~/.codex/sessions/**/rollout-*.jsonl` 的 `session_meta.base_instructions.text` 为 Codex 官方提示词（不再含 OpenCode 模板特征行）；带工具会话中 apply_patch 增删文件往返成功。
- 观测检查：`~/.agent-proxy-gateway/logs/opencode-zen-v1-responses-http-*.log` 中上游请求 tools 仅含客户端工具 + 至多两个占位、system 无官方模板；模型误调占位时 Codex 回 `unsupported call` 且下一轮自纠。

## 进度记录

- [x] M0：探针脚本入库并复测一致（2026-10-14，8/8 OK）；调研报告 10-14 修正段、指纹数据文档 notes/更新方法/更新记录、技术债登记。
- [x] M1：占位垫补替代官方工具合并，模板注入移除（2026-10-14 实施会话落地，本会话复核）：`padOpencodeZenGateTools`（缺 `read` 垫 read；`bash`/`shell` 都缺才垫 bash；空列表同垫）；`injectOpencodeZenFingerprintBody` 移除模板合并分支，system 与工具定义原样透传；官方模板/工具定义保留为回退材料。响应侧无需显式登记占位名——`convert.ts` 的 `customNames` 只把「客户端声明为 custom 的工具」转成 `custom_tool_call`，占位名自然按普通 `function_call` 透传，不会命中「未声明即失败」路径。
- [x] M2（代码）：zen 目录合成停用 `withAgentSystemPrompt` 替换，条目回落 gpt-5.5 快照基底的官方 Codex 提示词（`base_instructions` 与 `instructions_template` 同步回落）。
- [x] M2（运行时，2026-10-14 下午完成）：真机执行 `models --sync --select <现有选择>`（上游已下架 `gemini-pro-agent`，选择集随现存 7 项重建）并重启网关服务；`/v1/models?client_version=0.162.0` 核对 7 个 zen 条目 `base_instructions`（19,737 字符）与 `instructions_template`（19,754 字符）均为 Codex 官方提示词、OpenCode 模板零残留。
- [x] M3（自动化部分）：`bun run check` 全绿（990 pass / 0 fail，含边界 + 构建 + 严格类型 + 三组测试改写）；探针 11 项真网复跑 11/11 OK、退出码 0（首帧判定修复后）。
- [x] M3（用户验收部分，2026-10-14 通过）：验收会话（rollout `01a13905-1a38`，14:06 运行，模型 `opencode-zen/space-bunny-free`）三项全过——① `base_instructions` 19,754 字符，与服务目录 `instructions_template` 长度逐一吻合，为 Codex 官方提示词、OpenCode 模板零残留；② apply_patch 以 **`custom_tool_call`** 形态往返（`0ee31ce` 修复的形态实证）：`*** Begin Patch` 新建 test.txt → `Success. Updated the following files`，exec_command `cat` 读回内容一致；③ 占位零误调（模型直取 apply_patch；自纠机制已有此前会话 8 次 `unsupported call` 实录兜底）。
- [x] 归档并更新技术债行状态（2026-10-14）。

## 决策记录

- 2026-10-14（上午）：apply_patch 四次静默丢弃定位为响应侧 custom_tool_call 不还原，`0ee31ce` 修复；与本计划的提示词收敛相互独立。
- 2026-10-14：探针复测画像（模板不查、名单闸、UA 放宽）；用户拍板收敛注入面——占位垫补替代模板 + 官方工具注入、zen 停发提示词替换、其余四家适配器不动、UA 维持四段式快照。
- 2026-10-14：占位名取 `read`+`bash` 而非 `shell`：为可能自带同名真工具的客户端让路；同名去重语义保留（客户端已声明同名时不垫）。
- 2026-10-14：占位调用不做网关侧拦截应答（不在响应流里合成 function_call_output），按普通 `function_call` 回传由 Codex 的 `unsupported call` 兜底——协议上模型流内合成输出未验证可行，实测自纠已足够。
- 2026-10-14（下午）：探针脚本对照形态随实现切换（`control-gateway` = 垫补形态），并新增 `fallback-official`（官方模板+官方工具）验证回退材料仍有效、`no-tools-plain`/`no-tools-pad` 两条无工具探针（名单闸不分有无工具）；探针间隔 2.5s → 5s 并注明「偶发 DRIFT 复跑定性」（当日实测同形态首跑被拒、复跑全过，疑 IP 限频或上游抖动）。
- 2026-10-14（下午）：13:17–13:18 五条 403 定性为**上新中测试模型 `cat-jam-free` 的目录探测**（`server_error: Endpoint is unavailable`，后端未就绪）——被既有错误归一化包成 `zen_free_tier_error` 误导为指纹失效，属归一化文案问题（同日由「错误消息透传」任务修正，见 [历史](../../histories/2026-10/20261014-1339-zen-error-message-passthrough.md)），非门禁漂移。**官方客户端对照实证（15:24）**：本机 opencode2（beta-19086）调 `cat-jam-free` 同样 403 `Endpoint is unavailable`、调 `space-bunny-free` 正常返回——网关与官方客户端行为逐字一致，`cat-jam-free` 为上新后端未就绪，探针默认保留其在目录是正确行为（不应按死模型剔除）。
- 2026-10-14（下午）：修复探针 DRIFT 误报的确定性根因——单次 `read()` 可能停在 SSE 帧中间导致 `no-tools-pad` 被误判「200 非 chunk」，改为累积读取至帧边界（`\n\n`）再判定；修复后 11 项复跑 11/11 OK、退出码 0。此前「疑 IP 限频」的同形态首跑被拒类 DRIFT 中至少此类为该误报。
- 2026-10-14（下午，运行时切换）：`models --sync` 无终端交互失败与 `gemini-pro-agent` 未知 ID 失败后，按现存 7 项显式 `--select` 重建（上游下架模型任何 sync 路径都保不住，非行为变更）；网关服务（LaunchAgent 直跑仓库源码）`restart` 后新代码即生效，成品目录无需缓存迁移（store 读盘只取 ids/元数据/裁决，条目每次进程内重建）。

- 2026-10-14（验收归档）：M3 用户验收通过（rollout 提示词回落逐字吻合、apply_patch 以 custom_tool_call 形态端到端建文件成功、占位零误调），计划归档至 `completed/`，技术债 2026-10-14 收敛行关闭。验收前同日完成 cat-jam-free 勘误（上新中测试模型而非下线，官方 opencode2 客户端对照得到一致 403 `Endpoint is unavailable`，网关行为与官方逐字一致）。
