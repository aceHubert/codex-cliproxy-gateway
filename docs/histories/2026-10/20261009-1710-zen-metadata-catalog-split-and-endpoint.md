## [2026-10-09 17:10] | Task: Zen 目录缓存拆双文件 + 转发 endpoint 改由元数据确认

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> 把 opencode-zen-catalog.json 重命名为 opencode-zen-metadata.json
> 转发上游的endpoint 通过metadata 确认
> opencode-zen-catalog.json 就可以直接给 /v1/models 进行合并了，不需要在运行时再处理model_catalog
> 现在是6个小时更新1次对吗，那就是要同时更新 opencode-zen-metadata.json 生成 opencode-zen-catalog.json 2个文件

### 🛠 Changes Overview
**Scope:** `src/opencode/catalog.ts`、`src/opencode/index.ts`、`test/opencode-zen-catalog.test.ts`、`docs/fingerprint-data.md`

**Key Actions:**
- **[拆双文件]**: 单文件缓存拆为两个，职责分离：
  - `opencode-zen-metadata.json`：原始数据（动态 ids + 官方元数据 + 探针裁决）。ids 按
    10 分钟目录 TTL 刷新，元数据按 6 小时 TTL 刷新，裁决 24 小时；不再内嵌成品条目。
  - `opencode-zen-catalog.json`：由上述数据生成的**成品目录**（`base_instructions` 与
    `model_messages` 模板已在生成时替换），每次元数据刷新后同步重新生成；
    `/v1/models` 只读合并这一份，serve 路径零加工。
  - 读盘优先 metadata.json，缺失时回退旧版单文件 catalog.json（只取原始字段、成品重新
    合成）并补写成新双文件格式，升级不丢 last-good。
- **[endpoint 由元数据确认]**: `parseZenMetadataResponse` 新增提取 provider 级
  `api`（baseURL，校验必须 http(s)）；store 暴露 `endpoint(id)`；`forward()` 与
  `forwardResponses()` 两个转发入口的 baseURL 改为 `store.endpoint(model) ?? 配置端点`，
  元数据缺失时回退 `ZEN_DEFAULT_ENDPOINT`。`/v1/models` 拉取与探针仍走配置端点
  （冷启动无元数据可用）。
- **[协议映射澄清]**: `@ai-sdk/mistral` 等 OpenAI 兼容 SDK 本就经缺省分支落到 chat
  （Mistral chat completions 与 OpenAI 同构），不新增协议类型。
- **[测试]**: 新增「刷新同时写 metadata.json 与成品 catalog.json，serve 只读缓存」用例，
  断言双文件内容分工、成品提示词/模板已替换、`endpoint()` 的元数据确认与回退语义；
  旧版单文件兼容用例沿用旧文件名继续覆盖迁移路径。

### 🧠 Design Intent (Why)
用户明确点出两层设计：元数据（6 小时级）与成品目录（随元数据生成）是不同生命周期的数据，
混在一个文件里既说不清职责，也让「serve 时还要再加工」有存在空间。拆开后 catalog.json
就是可以直接合并的终态，metadata.json 是可独立刷新频率的原始层。endpoint 走元数据
`provider.api` 则让上游地址与官方客户端同源，官方换域名时网关无需改代码。

### 📊 Change Stats
> `src/opencode/` 未纳入版本控制，`git diff` 取不到该目录；下表为本次触碰文件的手工计数
（test 与 docs 部分可用 git 核对）。

- **Files changed:** 4
- **Insertions:** +175
- **Deletions:** -70

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/opencode/catalog.ts` | +120 | -60 |
| `src/opencode/index.ts` | +10 | -6 |
| `test/opencode-zen-catalog.test.ts` | +45 | -2 |
| `docs/fingerprint-data.md` | +12 | -2（另追加两行更新记录） |

### ✅ Verification
- `bun run check` 全绿（tsc + 742 测试 + UI/CLI 构建）。
- 网关重启实测（先删旧 catalog.json 走全新生成路径）：
  - 两个文件都生成：`opencode-zen-metadata.json`（87 ids / 120 元数据模型 / 无内嵌
    models）与 `opencode-zen-catalog.json`（11 个成品条目）；
  - 元数据 `provider.api` = `https://opencode.ai/zen/v1` 已进入缓存并被 endpoint() 解析；
  - 成品条目 `base_instructions` 与 `instructions_template` 11/11 正确，官方提示词零残留；
  - 线上 `/v1/models` 的 11 个 zen 条目与磁盘 catalog.json 完全一致（slug 集合相同）。
- 探针/协议映射未动：npm 分布 `(继承) 55 / @ai-sdk/openai 32 / @ai-sdk/anthropic 24 /
  @ai-sdk/mistral 1 / @ai-sdk/google 8`，mistral 经缺省分支走 chat。

### 📌 Notes
- 升级路径：旧版单文件（无论是否带 models）都会被读为原始数据并补写成双文件格式，
  有测试覆盖（`旧版缓存文件兼容读取` 用例）。
- 遗留项不变：元数据不可用时无后缀零计费模型暂不示、探针成本、透传策略未穷举
  （技术债台账 2026-10-09 行）。
