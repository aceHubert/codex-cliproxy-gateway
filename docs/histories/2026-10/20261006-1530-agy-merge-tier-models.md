## [2026-10-06 15:30] | Task: 合并 agy 多档位模型为单条目并按 reasoning effort 解析

### 🤖 Execution Context
* **Agent ID**: zcode
* **Base Model**: account:zai-individual-coding-plan/GLM-5.3
* **Runtime**: ZCode CLI
* **Git User**: hubert
* **Branch**: main

### 📥 User Query
> （截图展示 /v1/models 中 AGN/Gemini 3.8/3.7/3.6 Flash 各列 -high/-medium/-low 三条）
> 这些是不是应该合并成一个，使用 reasoning level 进行选择才对

### 🛠 Changes Overview
**Scope:** src/agy/、test/、docs/

**Key Actions:**
- **[目录家族合并]**: `parseAgyCatalogData` 按 `-high/-medium/-low` 后缀把同一基名的变体聚成 `AgyModelFamily`（≥2 成员才合并；基名与显式无后缀模型冲突时不合并，避免重复 slug）；`buildAgyCatalog` 对家族只产出 `agy/<base>` 一个条目（展示名去掉档位括号、能力取并集、窗口取最大值），单档位后缀模型（`gpt-oss-120b-medium`、`gemini-3.1-pro-low`）保持独立。
- **[effort 解析]**: 新增 `agyEffortTier`/`resolveAgyFamilyModel`（复用 request.ts 导出的 `THINKING_LEVELS`）：effort→目标档（缺省/未知 medium），缺档按「就近偏高」回退；`forward()` 对合并条目按 `input.reasoning.effort` 解析具体上游模型，显式档位 slug（`agy/gemini-3.8-flash-high`）经 memberIds 集合保持直连兼容。
- **[缓存 v2]**: `CACHE_REVISION` 升 2，家族随 `agy-catalog.json` 落盘并参与 content_hash；磁盘回退（上游拉取失败）时家族仍可用于解析；目录内容指纹改为 `{models, families}`。
- **[转发前元数据加载]**: `forward()` 在 `catalog()` 尚未调用过时尽力加载一次目录元数据（含磁盘缓存回退），避免合并条目透传基名（上游不存在该模型 id）。
- **[测试]**: catalog 侧 +4 例（合并/冲突不合并/解析回退/家族落盘回退）、gateway 侧 +1 例（effort 路由 medium/high/minimal、无 effort 不带 thinkingLevel、显式档位兼容、目录只列合并条目）。
- **[文档]**: README agy 小节改写；调研文档 §5.3 补「网关侧档位合并」注记；tech-debt 修正 agy 计划链接（active→completed）并新增 thinkingLevel 与模型 id 服务端优先级未实证的观察项。

### 🧠 Design Intent (Why)
上游把推理档位发布为独立模型 id（`tieredModelIds` 是系列标签→id 的映射，不存在无档位基名模型），导致 Codex 选择器里 flash 系列一次出现 9 条重复条目。档位的唯一确定 lever 是模型 id（`thinkingLevel` 字段能否跨变体生效未实证），因此合并必须在网关侧完成：目录只暴露 `agy/<base>`，请求侧用 `reasoning.effort` 选择变体——这既是用户期望的交互（一个模型 + 推理档位设置），也不依赖任何未实证的上游参数语义。显式档位 id 保留直连以兼容已写入用户 config 的模型名，语义与 `deprecatedModelIds` 重定向一致。

### 📊 Change Stats
> 本任务基于未提交的 agy 特性增量（src/agy 与 test/agy-* 均为未跟踪新文件，git 无法给出任务级 diff，数值为手工统计）。

- **Files changed:** 8
- **Insertions:** 约 +390
- **Deletions:** 约 -55

| File | 变化 |
| --- | --- |
| `src/agy/catalog.ts` | 家族类型/解析/合成/解析器 + 缓存 v2（291→425 行） |
| `src/agy/index.ts` | loadCatalogMeta + forward 档位解析（271→313 行） |
| `src/agy/request.ts` | 导出 `THINKING_LEVELS` |
| `test/agy-catalog.test.ts` | +4 例（134→229 行） |
| `test/agy-gateway.test.ts` | +1 例与 tiered fixture（316→358 行） |
| `README.md` | agy 模型说明改为合并 + effort 语义 |
| `docs/antigravity-cli-upstream-research.md` | §5.3 网关侧档位合并注记 |
| `docs/exec-plans/tech-debt-tracker.md` | agy 行链接修正 + 观察项⑥ |

### 📁 Files Modified
- `src/agy/catalog.ts`、`src/agy/index.ts`、`src/agy/request.ts`
- `test/agy-catalog.test.ts`、`test/agy-gateway.test.ts`
- `README.md`、`docs/antigravity-cli-upstream-research.md`、`docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run check`：646 tests / 0 fail（较上一任务 +5 例）。
- 生产网关 `restart` 后实测 `/v1/models`：agy 条目 14 → 8（flash 三族合并为 `agy/gemini-3.8|3.7|3.6-flash`，显示名 `AGN/Gemini 3.8 Flash` 等）；磁盘 `agy-catalog.json` 含三组完整档位家族。未发起真实推理调用（解析逻辑为纯本地映射，已由 mock 测试覆盖）。

### Amendment [2026-10-06 18:43] supported_reasoning_levels 按实际档位重建（xhigh 泄漏修正）
- **问题**（用户复核）：合并条目仍暴露 `xhigh`（及 `minimal`）档位——`buildAgyCatalog` 的 `structuredClone(BASE)` 原样保留了 gpt-5.5 快照的 OpenAI 风格 `supported_reasoning_levels`，而上游只有 high/medium/low 变体，客户端可能选出不存在的档位。
- **修正**：家族条目的 `supported_reasoning_levels` 改为按 `orderedTiers(family)` 重建（low→medium→high，文案复用基底快照对应档位，不沿用 xhigh/minimal）；`default_reasoning_level` 与转发侧缺省解析一致（medium→high→low）。独立条目（无档位后缀或单档位后缀模型）删除继承的档位列表，不暴露档位选择；effort 仍可在请求侧映射 thinkingLevel。
- **范围裁定**（用户指示）：评估过把 reroute 旧 id（`gemini-3.1-pro-high → gemini-pro-agent`）归族与单档位合并（`gpt-oss-120b-medium`），**不做**——`gemini-pro-agent`、`gemini-3.1-pro-low` 等保持独立条目，只修 flash 家族逻辑。
- `CACHE_REVISION` → 3；catalog/gateway 测试补 levels 与 default 断言；`bun run check` 646 pass / 0 fail；线上 `restart` 后实测 flash 三族 `levels=[low,medium,high] default=medium`，其余 agy 条目无档位列表。

### Amendment [2026-10-06 19:30] Codex 会话调用失败排查（thread 01a110e5）
- **现象**（用户报告）：Codex Desktop 会话（"查询杭州未来一周的天气"，`agy/gemini-3.8-flash`）连续 5 次 502「Antigravity 上游响应失败」后中断。
- **排查**：直接传输层复现（medium/low 变体、Codex 形状载荷）均 200；经网关复现同形状载荷一次流内失败（`response.failed`）、一次完整成功——失败为间歇性。抓到的一例流内失败真实原因是上游 `finishReason: "MALFORMED_FUNCTION_CALL"`（Gemini 在无对应工具声明时尝试搜索/终端类调用被上游判无效）；会话当时的 5 次流前 502 因当时无错误日志未取证（错误体被 `safeAgyUpstreamError` 归类后丢弃）。error.log 的 `unhandledRejection: TypeError` 自 2026-08-20 起存在（Bun 1.3.5 层面），与本适配器无关。
- **修复**：补齐两条错误日志黑洞——forward 的 `AgyTransportError`/未知异常分支与 `sanitizeError` 包装（流内错误）现在把原始错误体（截断 500 字符）写入 gateway.log（`agy upstream` / `agy forward failed` / `agy stream error` 前缀），客户端响应与请求日志仍只出预定义分类。`bun run check` 646 pass；网关已带日志重启；tech-debt 补观察项⑦（含再现时的取证入口）。
- **追加（用户建议）**：目录条目还泄漏了基底 gpt-5.5 的 `web_search_tool_type: "text_and_image"`（`supports_search_tool` 本已是 false）——Codex Desktop 可能据此附加搜索工具、进网关又被剥除并注入"工具已移除"旁白。已删除该字段（`CACHE_REVISION` → 4，测试断言 `web_search_tool_type === undefined`），线上验证 8 个 agy 条目均为 `search=False ws_type=None`。注：MALFORMED 复现时请求未声明任何工具，此修复消除一个触发面但不保证根除上游模型的自发调用行为。

### Amendment [2026-10-06 20:05] 目录字段删除疑似导致 Codex 回退默认模型（v5 回滚为保留字段）
- **事故**（用户报告）：`--restart-codex` 重拉 app-server 后 Codex 模型选择器只剩默认模型。时间线：v3（删独立条目的 `supported_reasoning_levels`）与 v4（删 `web_search_tool_type`）上线后，运行中的 app-server 一直用内存旧目录；19:33 起新实例首次解析新目录即出问题——怀疑 Codex 0.160.1 的目录反序列化要求字段存在，缺字段导致整个目录被弃用、回退内置默认。
- **修复（用户裁定：不删除、置中性值）**：`CACHE_REVISION` → 5——`web_search_tool_type` 恢复继承基底值（搜索能力由 `supports_search_tool=false` 关闭）；独立条目的 `supported_reasoning_levels` 置 `[]`、`default_reasoning_level` 置 `"medium"`，字段一律保留。测试断言同步更新（646 pass）。
- **恢复操作**：v5 网关重启后把网关当前目录亲手写入 `~/.codex/models_cache.json`（fresh `fetched_at` + `client_version: 0.160.1`，原文件备份 `.bak-agy-fix`），再停 app-server 让 Desktop 重拉。最终缓存文件呈现 Codex 自身的 Rust 微秒时间戳格式（69 模型、8 agy、无 xhigh），证明 Codex 已成功重取并解析 v5 目录。
- **教训**：对 Codex 消费的目录条目做字段级变更时，只覆盖值、不删键；字段形状必须与官方快照严格一致（缺键的兼容性未验证，出现过整目录弃用的疑似案例）。

### Amendment [2026-10-06 20:15] 工具 parameters 的 $ref 触发上游 400（日志黑洞修复后的第一个实锤）
- **现象**（用户报告）：`502 Antigravity 上游响应失败`。gateway.log（本轮新加的 `agy upstream` 日志）给出真实错误：`Invalid JSON payload received. Unknown name "$ref" at 'request.tools[0].function_declarations[18].parameters.one_of[0]'`——Codex Desktop 的第 19 个工具（MCP/插件类）parameters 用 JSON Schema 引用写法（`$ref`/`$defs`），上游 protojson 严格模式拒绝未知字段。
- **修复**：`request.ts` 新增 `sanitizeToolSchema`——本地 `$ref`（`#/$defs/x`、`#/definitions/x`）就地内联展开（循环引用、悬空/外部引用按宽松 `{}` 兜底，`$ref` 兄弟字段合并），剥除 `$defs`/`$definitions`/`$schema`/`$id` 元字段；`oneOf` 等其余字段原样保留。`translateTools` 对 function 工具统一过清洗。
- **测试**：`agy-request` +2 例（内联展开与元字段剥除；悬空/外部/循环兜底），`bun run check` 648 pass / 0 fail，网关已重启部署。
- **端到端验证**：用当时失败的确切形状（oneOf + 三个 `$ref` + `$defs` 的 function 工具）发起一次真实流式请求——200、`response.completed`、完整中文答案，上游校验通过。

### Amendment [2026-10-06 20:22] schema 白名单重写：以 Codex 真实工具数据驱动验收
- **新错误**（用户重试后）：`enum` 含布尔字面量（`(TYPE_STRING), true`）、联合 `type` 数组（`Proto field is not repeating, cannot start list`）——MCP 聚合工具（mcp_router_global 等，单请求 340+ 声明）的 JSON Schema 写法。
- **重写**：`sanitizeToolSchema` 改为 **Gemini Schema 白名单**策略——白名单外的键一律剥除（`const`→enum、`deprecated`/`exclusiveMinimum`/`x-*`/`propertyNames` 等自动覆盖），本地 `$ref` 内联、联合 type 拆解、元组 `items` 转 anyOf、enum 字面量转字符串；`properties` 按 map 处理（属性名不校验）。上游错误体日志截断放宽到 4096。
- **真实数据验收**（用户要求不再人工轮试）：从 `~/.codex/cache/codex_apps_tools/` 提取 Codex 实际缓存的 311 个工具声明（去重后 245 个），静态预检全部通过（输出只含已知 Gemini 键），再以这 245 个真实工具发起一次真实网关流式请求——200、`response.completed`、完整回答。
- **400 捕获**：上游 400 时把完整原始请求落盘到 `~/.codex-cliproxy-gateway/agy-debug-400.json`（含提示词，仅本机调试/重放用），后续同类失败无需用户复现。
- 测试 +3 例（enum/type 数组/白名单剥除与形态转换），`bun run check` 650 pass / 0 fail。

### Amendment [2026-10-06 20:43] thought 签名回放（工具调用多轮 400 的最后一环）
- **新错误**（400 捕获立功）：`Function call is missing a thought_signature in functionCall parts`——第一轮工具调用成功后，第二轮回放历史时上游强制要求带回 `thoughtSignature`（Google thinking 模型新约束：签名随响应下发、下轮必须回传）。原设计"响应侧不透传签名"与之冲突。
- **修复**：响应侧把函数调用携带的 `thoughtSignature`（独立 part 或附着形态均识别）以 `agn1:` 信封放进紧邻调用的 reasoning 项 `encrypted_content` 下发；请求侧回放历史时识别 `agn1:` 前缀（官方模型加密内容不受影响），把签名以 **Part 级字段**（与 `functionCall` 平级——回放实测 `functionCall` 内部会报 Unknown name）挂回下一个函数调用。
- **真实数据验收**：① 回放 786KB 捕获请求 + 伪造签名 → 错误从 "missing" 变为 "Corrupted"（证明字段位置与管线正确）；② 真实双轮往返——第一轮诱导工具调用拿到真签名（`agn1:Er4GCrsG…`），第二轮带签名回放 → 200 completed、模型正确引用工具输出。遗留：当时卡住的会话历史无签名不可恢复，需新会话。
- 测试 +2 例（agn1 挂回与信封下发），`bun run check` 652 pass / 0 fail。
