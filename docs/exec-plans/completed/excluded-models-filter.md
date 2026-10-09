# 兼容模型目录排除配置（Excluded Models Filter）执行计划

## 目标

为解决本地多兼容上游（ZCode、CodeBuddy、Qoder、Antigravity/agy 等）接入后本地生成的模型目录（catalog）数量过多、Codex 模型选择器过于冗杂的问题，在网关配置中引入排除模型参数（`excludedModels`）。
网关在所有适配器目录合并后直接统一执行过滤。Web UI 参考 CLIProxy API 风格，提供直观的多行文本输入框（每行一个模型 ID，包含前缀）；命令行提供统一的 `models --exclude` 命令，无参时列出全部兼容模型交互勾选，带参时直接追加排除项，实现极致简洁（KISS）与高效易用。

## 范围

- **包含**：
  - **网关配置与 Schema 扩展**：
    - 在 `GatewayConfig` 和 `schemas/gateway-config.schema.json` 中增加 `excludedModels: string[]`（默认 `[]`）；
    - 支持配置读写校验、去重去空、Schema 校验与 `config-update.ts` 审计。
  - **网关目录合并后统一过滤**：
    - 在 `src/gateway.ts` 中，所有适配器（ZCode、CodeBuddy、Qoder、Agy 等）及上游 catalog 合并完成后，统一依据 `excludedModels` 直接过滤，输出干净的 `/models` 响应；
    - 在网关路由入口对被排除模型的推理请求进行拦截保护（返回规范的 404/400 提示）。
  - **命令行 CLI 支持（`models --exclude`）**：
    - 去除特定厂商的专有 flag（如 `--exclude-codebuddy` 等），保持单一正交的 `--exclude` 命令；
    - **无参数 / 交互模式**（`codex-cliproxy models --exclude`）：拉取/收集当前所有已启用的兼容模型（完整表出模型 ID 与显示名称，含前缀与地域标签），提供终端键盘交互选择器（上下移动、空格勾选排除、回车确认）；
    - **带参数追加模式**（`codex-cliproxy models --exclude <patterns...>`）：直接将指定的模型 ID（含前缀如 `codebuddy-intl/gpt-4o`）或通配符规则（如 `codebuddy-cn/*`、`zcode-*/*`）追加到现有排除列表中；
    - 支持重置/清空排除项（如 `--exclude none` 或 `--exclude ""`）；
    - 更新后自动写盘、记录配置审计、失效 Codex 目录缓存（`invalidateModelsCache`），若 LaunchAgent 在运行则热重启网关。
  - **Web UI 极简多行输入框**：
    - 参考 CLIProxy API 的排除模型配置方式，不引入复杂的交互勾选表单；
    - 在 `/ui` 配置页面中提供简洁的多行文本输入框（Textarea），每行一个排除项（模型 ID 含前缀，支持通配符 `*`）；
    - 读取时将 `excludedModels: string[]` 换行展示，保存时拆分每行、去空白过滤后提交 `excludedModels` 数组；
    - 保存后自动触发写盘、配置审计与目录缓存失效。
  - **测试与验证**：编写规则匹配、网关过滤、CLI 选项解析与 Web UI 读写相关的自动化测试，完成 `bun run check`。
- **不包含**：
  - 不修改各适配器内部的目录拉取与凭据消费逻辑；
  - 不改变官方 Codex ChatGPT OAuth 与第三方 CLIProxy 原有路由协议。

## 背景

- **现有痛点**：当前网关支持同时开启 ZCode、CodeBuddy（国内/国际/WorkBuddy）、Qoder（国内/国际）及 Antigravity（agy）等多个本地适配器，各适配器动态拉取上游目录后在本地合成完整 Codex catalog。随着兼容通道增多，模型总数可达数十甚至上百个，导致 Codex 客户端的模型下拉菜单极度臃肿，且同名模型在不同通道/地域之间容易造成选择困扰。
- **第一性原理与架构决策**：
  1. **网关合并后直接过滤**：所有适配器的 catalog 在 `gateway.ts` 合并完成后，输出给 `/models` 之前统一通过过滤器。无论未来增加多少个新适配器，核心过滤逻辑只需维护一处，代码极其精简健壮。
  2. **显式保留前缀与地域**：必须以完整的模型 ID（如 `codebuddy-intl/gpt-4o` vs `codebuddy-cn/gpt-4o`）和带标签的显示名称（如 `CB-INTL/GPT-4o` vs `CB-CN/GPT-4o`）展示和配置，彻底消除 cn/intl 与不同上游的二义性。
  3. **KISS 原则与交互极简**：
     - Web UI 放弃重型选择表格，采用与 CLIProxy API 一致的多行文本输入框（每行一个），易粘贴、易编辑、代码轻量稳定；
     - CLI 收敛为单一 `--exclude` 参数，交互选择与参数追加合二为一，避免参数泛滥。

## 关键决策

1. **配置字段结构与匹配引擎**：
   - 字段命名为 `excludedModels: string[]`，与已有的 `selectedModels: string[]`（CLIProxy 上游筛选）概念对齐。
   - 匹配规则：支持精确匹配（忽略大小写）、前缀匹配（如 `codebuddy-intl/`）以及轻量 Glob 匹配（如 `codebuddy-cn/*`、`zcode*`）。
2. **CLI 命令行操作体验（`models --exclude`）**：
   - `codex-cliproxy models --exclude`：
     - 终端交互模式：收集当前启用的所有本地兼容模型（包含前缀 `slug` 和 `displayName`），复用 `chooseModelsWithKeyboard` 类似交互，空格切换是否排除，确认后保存。
   - `codex-cliproxy models --exclude <patterns>`：
     - 命令行追加模式：支持逗号或空格分隔的模型 ID / 通配符，自动追加到已有的 `excludedModels` 列表中。
     - 特殊值 `--exclude none` 或空串清空排除列表。
   - `codex-cliproxy models`（无 `--exclude` 参数）：
     - 打印当前活跃的模型（含前缀与地域标签），并在末尾列出当前已排除的模型规则与数量。
3. **Web UI 视觉与配置体验**：
   - 在 Web 配置面板的“模型与日志设置”区域中，增加“排除模型（excludedModels）”配置行；
   - 呈现多行输入框（Textarea），占位提示类似：
     ```
     codebuddy-cn/*
     qoder-cn/*
     agy/gemini-2.5-flash
     ```
   - 辅助文字说明：每行一个模型 ID（含前缀，区分 cn/intl，如 codebuddy-intl/ 或 qoder-cn/），支持通配符 `*`。
   - 提交时作为通用配置 patch 的一部分（或独立保存），与其他字段协同生效。

## 风险与缓解

- **风险 1：排除规则误伤正常模型**
  - *缓解方式*：规则匹配以带有斜杠的前缀族或具体 slug 为基准（例如 `codebuddy-intl/`），避免裸通配符造成跨厂商误伤；CLI 提供详细预览与当前状态打印。
- **风险 2：下游客户端仍使用被排除模型的会话**
  - *缓解方式*：在网关路由分发层增加被排除模型判定，若请求指定了已排除的模型，拦截并返回规范的 404/400 提示，而不是向未启用的上游转发。
- **风险 3：Codex 客户端缓存残留旧模型**
  - *缓解方式*：每次排除配置发生变动（无论是通过 CLI 还是 Web UI），均自动调用 `invalidateModelsCache` 重置 Codex 的 `models_cache.json`；CLI 支持 `--restart-codex`，Web UI 提示生效。

## 里程碑

1. **里程碑 1：配置模型与核心过滤引擎**
   - 更新 `src/types.ts` 和 `schemas/gateway-config.schema.json`，支持 `excludedModels: string[]`；
   - 在 `src/catalog.ts` 或独立模块中实现 `compileModelFilter` / `isModelExcluded` 匹配器；
   - 在 `src/config-update.ts` 中实现 `parseExcludedModels` 及配置校验与补丁逻辑。
2. **里程碑 2：网关合并过滤与路由保护**
   - 在 `src/gateway.ts` 中完成 catalog 合并后统一过滤逻辑；
   - 在网关路由入口增加被排除模型拦截处理；
   - 编写网关过滤的单测用例。
3. **里程碑 3：CLI 命令行 `models --exclude`**
   - 在 `src/cli.ts` 的 `models` 命令中支持 `--exclude`（无参交互选择全部兼容模型，有参追加排除规则，支持 none 清空）；
   - 优化 `models` 输出信息，完整表出模型 ID（含前缀）与显示名称（含地域）；
   - 编写 CLI 命令行单测。
4. **里程碑 4：Web UI 多行输入框实现**
   - `src/config-update.ts` 与 `src/webui.ts` 接入 `excludedModels` 读写（多行字符串 ↔ 数组归一化）；
   - 前端 `src/ui/ConfigPage.tsx` 增加多行输入框及 i18n 多语言文案；
   - 运行 `bun run build:ui` 并补充 UI 单测与端到端测试。
5. **里程碑 5：系统集成测试与验证收尾**
   - 运行全量 `bun run check`；
   - 验证各项命令与配置在实际环境中的生效效果。

## 验证方式

- **类型检查**：`bun run typecheck` 严格通过。
- **单元测试**：
  - 测试排除规则匹配器（精确匹配、前缀匹配、glob 通配符）；
  - 测试网关 `/models` 接口在配置 `excludedModels` 后的响应内容，确认合并后模型被精准剔除；
  - 测试 CLI `models --exclude` 交互选择与带参追加的解析、配置落盘与日志审计；
  - 测试 Web UI 读写 `excludedModels` 多行文本的正确性与边界处理。
- **构建测试**：`bun run build:ui` 与 `bun run build` 成功。
- **全流程检查**：`bun run check` 全绿。

## 进度记录

- [x] 方案梳理与执行计划创建（已根据反馈更新）。
- [x] 实现配置字段 `excludedModels` 与 Schema 校验。
- [x] 实现网关合并后过滤与路由拦截。
- [x] 实现 CLI `models --exclude`（交互选择全部兼容模型 / 带参追加）。
- [x] 实现 Web UI 多行输入框（Textarea）与配置读写。
- [x] 全量测试与构建验证（`bun run check` 全绿；网关以 `/v1/models?client_version` 冒烟验收）。

## 决策记录

- 2026-10-08：确定采用“网关合并后统一过滤”的架构原则，不侵入各个适配器内部，以完整包含前缀的模型 ID 作为过滤核心键，彻底避免地域与厂商混淆。
- 2026-10-08（反馈迭代）：简化 CLI 与 Web 交互——CLI 去除厂商专用 flag，统一为 `models --exclude`（无参列出兼容模型交互选择，带参直接追加，支持 none 清空）；Web UI 采用参考 CLIProxy API 的多行输入框（每行一个），极简且易于维护。

- 2026-10-08（实施）：
  - 匹配引擎落在 `src/catalog.ts`（`compileModelFilter` + `filterExcludedModels`）：以 `/` 结尾按前缀族、含 `*` 按轻量 glob、其余精确匹配，全部大小写不敏感；裸 `*` 写入路径直接拒绝（`parseExcludedModels`），运行期读到时按空规则忽略，避免手改配置清空整个目录。
  - 过滤点在 `gateway.ts` `catalogModelsResponse` 的 respond 闭包——所有适配器与上游目录合并之后、两种响应形态（Codex 原始目录 / OpenAI list）之前，`/v1/models?client_version=…` 与无参形态同时生效。
  - 路由拦截覆盖推理类 POST（`/responses`、`/responses/compact`）：适配器分派处与通用路由解码处各一道，命中返回 404 + `x-codex-cliproxy-gateway: model-excluded`，绝不向未启用上游转发；upstream-only 直通分支（非 Responses 路径）不拦截，边界记入 `tech-debt-tracker.md`。
  - CLI 交互勾选只表达「精确模型 ID」规则：仍在目录中的旧精确规则预勾选，前缀族/通配/已下线规则无法用勾选表达、原样保留合并；`--exclude none`/空串清空，带参按逗号或空白拆分追加，全部经 `parseExcludedModels` 归一（去空、大小写去重）。写盘复用 `writeConfigAndRestart`（审计字段白名单补 `excludedModels`），动态路由下失效 `models_cache.json`，支持 `--restart-codex`。
  - `models` 无参输出在原「已选上游模型」之后新增「活跃兼容模型」清单（完整 ID 含前缀 + 显示名含地域标签，来源为 catalogPath 落盘文件与各适配器目录缓存，单来源失败仅告警）与「排除规则」清单。
  - Web UI 把 `excludedModels` 纳入 `/ui/api/config` 的通用 patch 白名单；前端多行文本框按行拆分提交（`src/ui/excluded-models-field.ts` 纯函数），保存命中该字段时服务端失效 Codex 目录缓存并照常调度网关重启。
