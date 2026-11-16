## [2026-11-16 11:30] | Task: 按最新 AGY 选择器重写思考级别与模型还原

### 🤖 Execution Context
* **Agent ID**: `zcode`（初始改动）、`codex`（本轮语义修正与验证）
* **Base Model**: 初始记录为 `GLM-5.3`；本轮为 `GPT-6 系列（未提供具体变体）`
* **Runtime**: `ZCode Desktop`、`Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`（user.name 本身也含邮箱，此处去重展示）
* **Branch**: `main`（本轮实际工作分支）

### 📥 User Query
> 把 agy max thinkingLevel 也加上，以免后面补充。
> （迭代）先不要管 max 的，为什么 xhigh: "high" 这是一个语义非常错误的地方，然后 catalog 里面又一套。这个变体怎么写的到处都是啊，不是保存一份，变体，然后内存中适配别名就可以了吗
> 已经没有其它会话在修改了，重新修正语义，diff 里修改是错的。
> 移除 catalog 的重复转导出，直接引用公共 tiers 文件。
> AGY_TOP_TIER 不需要提出来；max 直接对应 max，没有就不生效，不需要回退。
> AgyThinkingLevel 为什么又没有 xhigh？
> 不要考虑旧限制，重新评估最新的思考级别重写，抽象出来，然后如何还原兼容所有模型。
> 看一下 agy 是如何还原的，agy 切换模型时不也需要选择吗？（提供分组模型和 effort 滑条截图）
> 把新建的 tiers.ts 合并进 catalog.ts 中，不需要单独建个文件。
> 移除 Orchestrator 等无可选级别模型的默认 medium 占位值。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/agy`

**Key Actions:**
- **[重新核查]**: 读取最新官方 effort、models、enterprise 文档及本机 CLI 1.5.9 协议描述符；只读执行 `agy models`，确认当前账号模型变体。确认 `groupedModels` 才是家族/思考级别映射，`tieredModelIds` 属于性能系列，二者不能混同。
- **[统一定义]**: 在 `catalog.ts` 集中维护五档词汇与模型能力（fixed/parameter/variants），按用户要求合并并移除新建的 `tiers.ts`。移除 `AGY_TOP_TIER`、重复类型和枚举表；`resolveAgyModel` 输出可直接还原的 `{model, thinkingLevel?}`。请求转换只消费选择结果，不再按名称后缀猜测是否发送枚举。
- **[直接引用]**: 请求层、转发层和测试直接引用 `catalog.ts` 的实际定义，没有兼容转导出或重复定义；后缀识别、默认档位和 effort 归一化保留为模块内部实现。
- **[修正变体语义]**: 删除 `THINKING_LEVELS`，撤销 diff 中“按变体后缀再派生 thinkingLevel”的做法。任意 `-low/-medium/-high/-xhigh` 变体均由模型 ID 表达档位，选档后不再发送 `thinkingLevel`；显式变体 ID 也不会被矛盾的 effort 覆盖。
- **[按能力还原]**: 优先按 `groupedModels` 的 `thinkingSuffix` 构造并校验真实成员；独立条目为 fixed，明确声明 `supportedThinkingLevels` 的模型为 parameter。目录缺失时才同名透传已知档位，且不根据后缀猜测；minimal 归一化为 low，xhigh/max 独立。
- **[精确选档]**: 不使用邻近档位回退；服务端基名模型的 thinkingLevel 默认值优先，其次为属于家族的 defaultAgentModelId，否则 medium/最低档。旧目录无 groupedModels 才按后缀分组；显式分组优先，且不制造目录中不存在的 ID。
- **[缓存及转发]**: 模型能力、家族默认值与重定向一起参与内容哈希、磁盘校验和重载，缓存修订为 12；验证旧 v10/v11 缓存被拒绝，避免沿用旧分组及占位默认值。重定向后进入相同 resolver；Responses 与 Chat Completions 共用 effort 提取，嵌套字段缺失时读取顶层字段。
- **[无默认占位]**: Orchestrator、GPT-OSS 单档条目和空能力列表均保留空的 supported_reasoning_levels，省略 default_reasoning_level；真实模型 ID 与不发思考参数的转发行为保持一致。可调档模型继续声明实际默认值。
- **[输入边界]**: 直接在档位数组中校验 effort，避免 `toString/constructor/__proto__` 被误认成合法 effort 并使目录选档抛错。
- **[回归测试]**: 新增统一 resolver 测试，覆盖五档、固定/参数/变体、未知能力、原型属性输入、不规则 ID、默认和缺档。目录测试覆盖 groupedModels、默认值、虚假成员过滤、参数能力优先和磁盘恢复；网关验证连续切换模型、显式成员、家族重定向、Chat effort 与无目录透传。

### 🧠 Design Intent (Why)
- 模型变体与传输枚举属于不同语义。11 月 13 日的核查记录已确认官方 CLI 在选定具体变体后清除透传 effort，见 `20261113-1044-agy-four-reasoning-levels.md`。因此不能把所有变体都转换成传输枚举，再仅对最高档作特殊处理。
- 请求 Hydrogen 的 xhigh 应选择 `gemini-4-hydrogen-xhigh`；不支持的档位不再近似成其他档位。不支持的 effort 与未提供 effort 一致使用默认变体。Orchestrator、GPT-OSS 等固定预算模型不注入思考级别；不能将“可思考”混同为“可调整参数”。
- 官方选择器分组及反向映射的静态证据、默认规则和已知边界补充到上游调研 §5.6；执行计划为 `agy-reasoning-roundtrip.md`。协议结构来自描述符，Go 函数体已去符号，未宣称完整反汇编或真实推理验证。

### 📊 Change Stats
> 来自当前任务相对 HEAD 的 `git diff --shortstat` 与 `git diff --numstat`：已跟踪文件为 8 files changed, 532 insertions(+), 102 deletions(-)。另计未跟踪的 `agy-reasoning.test.ts` 128 行；不含本历史文件及执行计划。

- **Files changed:** 9
- **Insertions:** +660
- **Deletions:** -102

| File | +Added | -Removed |
| --- | ---: | ---: |
| `docs/antigravity-cli-upstream-research.md` | +69 | -0 |
| `packages/agy/README.md` | +14 | -0 |
| `packages/agy/src/catalog.ts` | +190 | -52 |
| `packages/agy/src/index.ts` | +9 | -14 |
| `packages/agy/src/request.ts` | +8 | -13 |
| `test/agy-catalog.test.ts` | +140 | -10 |
| `test/agy-gateway.test.ts` | +84 | -5 |
| `test/agy-request.test.ts` | +18 | -8 |
| `test/agy-reasoning.test.ts`（新增） | +128 | -0 |

### 📁 Files Modified
- `packages/agy/src/catalog.ts`
- `packages/agy/src/request.ts`
- `packages/agy/src/index.ts`
- `test/agy-catalog.test.ts`
- `test/agy-gateway.test.ts`
- `test/agy-request.test.ts`
- `test/agy-reasoning.test.ts`
- `packages/agy/README.md`
- `docs/antigravity-cli-upstream-research.md`

### ✅ Verification
- 先新增回归断言，在修复前复现 5 项失败：三处变体枚举错误及两处原型属性误识别；修复后 AGY 目录、请求、网关与协议定向测试 81 项全部通过。
- `bun run check` 中 lint、包边界、完整构建与类型检查通过；沙箱内全量测试因本地临时端口监听失败而未通过，随后在允许监听的环境重跑 `bun run test`：1381 项通过，0 项失败（测试脚本保留 60 秒超时）。
- 独立只读审查通过；未调用真实推理、读取凭据、修改本机配置或重启服务。
- 移除 catalog 转导出后，AGY 包类型检查、catalog 的 ESLint 与 diff 空白检查通过；仅删除无调用方的转导出，未重复运行全量测试。
- max 精确映射与取消邻近选档后，AGY 目录、请求、网关与协议定向测试 82 项通过。
- max 精确映射阶段 `bun run check` 全部通过：lint、包边界、构建、类型检查与全量 1382 项测试（0 失败）。
- xhigh 同名直传并消除重复枚举后，包构建、AGY 类型检查、受影响文件 ESLint 与 82 项 AGY 定向测试通过；未执行真实上游推理。
- groupedModels 和统一模型还原重写后，最终 `bun run check` 全部通过：lint、包边界、构建、类型检查及 1399 项测试（99 个测试文件，0 失败，测试脚本保留 60 秒上限）。
- 合并回 catalog.ts 并升级缓存修订至 11 后，再次执行 `bun run check`：全部静态检查、构建、类型检查与 1399 项测试通过；无 tiers.ts 文件或源码引用残留。
- 合并后独立只读复核通过，无循环依赖或可触发的新问题；执行计划已归档至 completed。
- 移除默认中档占位后，AGY 目录、请求、网关与还原函数的 78 项定向测试通过，包含 Orchestrator HTTP 目录无默认字段断言及 v10/v11 缓存拒绝测试。
- 本轮最终 `bun run check` 全部通过：lint、包边界、构建、类型检查及 1400 项测试（99 个测试文件，0 失败）。
