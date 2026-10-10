# Web UI i18n 迁移：引入 i18next / react-i18next 替换自研词典

状态：已完成（2026-10-10）
创建日期：2026-10-10

## 目标

用 `i18next` + `react-i18next` 替换 `src/ui/i18n.tsx` 的自研词典（152 键 × zh/en 平铺、手写 `formatTemplate` replace 插值）：文案迁到按命名空间拆分的 zh/en 资源文件（实施中由 JSON 改为 `as const` 的 `.ts` 模块，见决策记录），插值、键名、变量名全部交给 i18next（`{{var}}` 原生插值 + TypeScript 资源类型推导），复数用 i18next 内建 plural 规则；删除自研 `DICT`/`formatTemplate`/手工 `t` 实现，组件只保留一层薄适配 hook。UI 行为零变化（词条治理产生的文案变化除外，见 M4）。

## 范围

- 包含：
  - **M1 包安装与基建**：安装 `i18next` + `react-i18next`（以安装时最新稳定版为准）；新建 `src/ui/i18n/index.ts`——`i18n.createInstance`（resources 全量内联打包、无后端加载、无 Suspense）、`interpolation: { escapeValue: false }`（React 自带转义）、语言持久化沿用 localStorage 键 `ccp-ui-lang`；`src/ui/i18n/i18next.d.ts` 模块扩充（`CustomTypeOptions`）让 `t` 的键名与插值变量名都获得类型推导（tsc 需 `resolveJsonModule`，若未开启则一并启用）。
  - **M2 词典与调用点迁移**：自研 DICT 迁为 `src/ui/i18n/locales/{zh,en}/{common,config,logs,models}.json`（命名空间 = 页面归属：common=Header/App/TextView/TokenPrompt、config=ConfigPage、logs=LogsPage、models=ModelPicker），键名加命名空间前缀（如 `config.descReqLogging`）；`useI18n` 改为薄适配层（`t` 直接转发 react-i18next 类型化 `TFunction`，`lang`/`setLang` 同步 `i18n.changeLanguage`），组件调用面（`const { t } = useI18n()`）不动，仅改键名字符串；调用点替换分两步——ConfigPage（88 处）单独一步，其余页面（59 处）一步。
  - **M3 移除自研实现**：删除 `src/ui/i18n.tsx` 的 `DICT`/`formatTemplate`/手写 `t`；插值占位符从 `{var}` 迁移为 `{{var}}`（现仅 `pagerStatus`、`excludedGroupPlaceholder` 两条）；确认无残留 import。
  - **M4 词条治理与测试**：双语混写词条拆为各语言自然文案；Header 语言切换按钮（「中」/「EN」硬编码）入词典；`pagerStatus` 英文侧改用 i18next plural（`total_one`/`total_other`）消除 "1 files" 瑕疵；新增 `test/ui-i18n.test.ts`——zh/en 各命名空间键集合一致（防 i18next 静默 fallback 掩盖缺键）、两条插值词条在两语言下渲染正确、词典无 `" / "` 双语混写回归断言。
  - 验证收尾：全量 check、浏览器双语冒烟、历史记录、计划归档。
- 不包含：
  - 不引入 `i18next-http-backend` / 语言检测插件（资源内联、语言由既有按钮切换，避免多余依赖与网络加载）。
  - 不做 CLI、网关错误信息、README 等非 Web UI 文案的 i18n。
  - 不新增第三种语言、不做按语言懒加载拆包（单文件内联 HTML 无加载维度）。
  - 不改语言切换交互与 localStorage 键；不涉及 `schemas/gateway-config.schema.json` 与 GatewayConfig 字段。
  - 暂不启用 i18next 的格式化能力（日期/数字 `Intl`），词典无此需求。

## 背景

- 相关代码路径：
  - `src/ui/i18n.tsx`（~340 行）：`DICT = { zh, en } as const` 152 键、`formatTemplate`（`{name}` replace 插值）、`t(key, vars?)`、`useI18n`（均 2026-10-10 新增变量签名，[历史](../histories/2026-10/20261010-1052-ui-excluded-boxes-polish.md)）——本计划将其整体替换。
  - `t()` 调用分布：ConfigPage 88、LogsPage 23、ModelPicker 22、App 7、TextView 4、Header 3，与四个命名空间的拆分粒度对应。
  - `src/ui/Header.tsx:46`：语言切换按钮「中」「EN」硬编码。
  - 构建链：`src/ui/` → Vite → 单文件内联 `dist/ui/index.html`（~296KB）；JSON 资源 import 由 Vite 内联，改后须 `bun run build:ui`（含在 `bun run check`）。
- 现状痛点（2026-10-10 盘点）：152 键平铺无命名空间、孤儿键无检测；zh/en 键一致性靠人工同步；插值变量名无类型约束（拼错静默产出 `{page}` 残留）；5 处词条双语混写；英文 "1 files" 复数瑕疵；自研插值与类型推导的维护成本随词条增长。
- 已知约束：
  - AGENTS.md「避免仅服务单一调用点的抽象或依赖」——引入 i18n 包是用户显式决策（见决策记录），服务于全部 147 个调用点，非单一调用点。
  - i18next + react-i18next 运行时增量约 +15KB（gzip 后），单文件内联产物可接受；预算写入验证方式。
  - 仓库无 Web 前端测试基建（UI 逻辑测试均以纯函数模块形式跑 `node:test`，如 `excluded-models-field.ts`），i18n 测试同样以「词典 + i18next 实例」纯数据形态编写，不引入组件测试框架。

## 风险

- 风险：键名与占位符迁移（前缀化 + `{x}`→`{{x}}`）漏改。
  缓解：`i18next.d.ts` 资源类型让 `t("…")` 键名受 tsc 检查；占位符仅 2 条词条，迁移后插值冒烟覆盖；全量 check 兜底。
- 风险：react-i18next 类型推导与现有 `useI18n` 适配层的泛型穿透（`TFunction` 泛型在薄适配层被拓宽为宽类型，丢失键名检查）。
  缓解：适配 hook 直接把 `TFunction` 作为返回类型（不手工包装 `t` 的参数类型），M1 先用一个调用点验证类型穿透有效；若适配层确实丢失类型，则组件直接 `useTranslation()` 并把 `lang`/`setLang` 拆到独立小 hook，调用面改动可控（机械替换）。
- 风险：i18next 缺键/缺语言时静默 fallback（返回键名或回退语言），线上不易察觉。
  缓解：`test/ui-i18n.test.ts` 键集合一致性测试双保险；`fallbackLng` 设为 `zh` 并在测试中断言两语言各自完整解析。
- 风险：包体积与内联产物增长。
  缓解：验证方式中记录 `dist/ui/index.html` 前后体积，预算 +20KB 以内；不引入 backend/detector 插件。
- 风险：`resolveJsonModule` / Vite JSON import 与现有 tsconfig 的兼容。
  缓解：M1 落地时以 `bun run typecheck` + `bun run build:ui` 验证；不兼容时退路是词典用 `.ts` 导出对象（i18next resources 同样接受）。

## 里程碑

1. **M1 包安装与基建**：
   - [x] `bun add i18next react-i18next`（实际安装 i18next@26.4.2 + react-i18next@17.0.16）；`src/ui/i18n/index.ts` 创建实例并接线（`initReactI18next`、内联 resources、`escapeValue: false`、localStorage 持久化）。
   - [x] `i18next.d.ts` 资源类型 + `CustomTypeOptions`；`resolveJsonModule` 已开启（后因插值推导退至 `.ts` 词典，见决策记录）；试点调用点（Header + 临时 @ts-expect-error 试点文件）验证键名与变量名类型检查均穿透适配层生效。
   - [x] `useI18n` 薄适配层：`t: TFunction<typeof UI_NAMESPACES>` 直接转发，键名/插值变量检查经试点验证保留；`LangProvider` 移除（react-i18next 自带语言变化重渲染，`<html lang>` 与持久化改由实例的 `languageChanged` 监听同步）。
2. **M2 词典与调用点迁移**：
   - [x] `locales/{zh,en}/{common,config,logs,models}.ts` 落盘（键前缀化迁移；调用形态 `t("config:descReqLogging")`）。
   - [x] ConfigPage 88 处调用点替换，check 全绿。
   - [x] 其余页面 58 处替换（实测共 146 处调用：ConfigPage 88、LogsPage 22、ModelPicker 22、App 7、TextView 4、Header 3），check 全绿。
3. **M3 移除自研实现**：
   - [x] 删除 `src/ui/i18n.tsx`（`DICT`/`formatTemplate`/手写 `t`/`LangProvider` 一并移除，适配层并入 `src/ui/i18n/index.ts`）；`{{var}}` 占位符迁移确认无 `{var}` 残留、无 `./i18n.tsx` 残留 import。
4. **M4 词条治理、测试与收尾**：
   - [x] 双语混写清理（实际 18 处而非盘点时的 5 处，对照表见进度记录）；Header 语言按钮入词典（`common:langZh`/`common:langEn`，值保留语言自称「中」/「EN」不随语言翻译）；`pagerStatus` 英文 plural 化（`pagerStatus_one`/`pagerStatus_other`，zh 单键）。
   - [x] `test/ui-i18n.test.ts`（键一致含复数归一、两语言全量解析、插值与复数精确断言、混写回归）。
   - [x] 浏览器冒烟：zh↔EN 走查 TokenPrompt/Config/Logs/Header；插值（排除分组 placeholder 五组示例）与分页文案（"Page 1/1 · 100 files" / 「第 1/1 页 · 共 100 条」）正确。
   - [x] 历史记录、计划移至 `completed/`。

## 验证方式

- 命令：`bun run typecheck && bun test test/ui-i18n.test.ts && bun run check`（全部通过；`bun run check` = typecheck + 829 tests + build 全绿）。
- 手工检查：`/ui` 中英文各走查一遍（令牌页、配置页全部字段行与排除分组 placeholder、日志页分页、Header 按钮）——经 Vite dev（8322，代理既有 UI 后端 8321）完成；`grep -rn '[一-龥]' src/ui/*.tsx` 确认组件内无词典外中文字符串（命中均为 JSX 注释，符合「注释除外」）。
- 观测检查：`dist/ui/index.html` 303,141B → 353,095B，原始增量 +49,954B（超出验证预算行的原始字节口径），gzip 88,843B → 104,677B，增量 +15.5KB——与决策记录「运行时增量约 +15KB（gzip 后）」的估算口径一致、在 +20KB 预算内；原始增量超预算已向用户如实汇报，属 i18next 运行时的固有成本（本地回环单文件内联，无网络传输 gzip 后尺寸）；typecheck 耗时与迁移前持平。

## 进度记录

- [x] M1：包安装（i18next@26.4.2 + react-i18next@17.0.16）、i18n 实例、类型扩充、试点调用点验证（键名 + 插值变量名检查均穿透适配层）。
- [x] M2：词典 `.ts` 落盘；ConfigPage 迁移；其余页面迁移（146 处调用点全部带 `ns:` 前缀，typecheck 兜底无漏改）。
- [x] M3：自研实现删除（`src/ui/i18n.tsx` 移除），占位符迁移完成。
- [x] M4：词条治理对照表记录于此；测试落地（4 例全绿）；浏览器冒烟通过（zh↔EN、TokenPrompt、插值、分页复数）；历史记录与归档。

### 词条治理对照表（双语混写清理，实际 18 处，迁移前 zh/en 同值混写）

| 键 | 迁移前（zh/en 同值） | zh | en |
| --- | --- | --- | --- |
| common:logsBtn | 日志 / Logs | 日志 | Logs |
| common:backToConfig | 返回配置 / Back | 返回配置 | Back |
| common:prevMatch | 上一个 / Previous | 上一个 | Previous |
| common:nextMatch | 下一个 / Next | 下一个 | Next |
| common:closeFind | 关闭 / Close | 关闭 | Close |
| config:saveBtn | 保存 / Save | 保存 | Save |
| config:card1Title | 运行行为 / Runtime | 运行行为 | Runtime |
| config:card2Title | 安装配置 / Install-managed | 安装配置 | Install-managed |
| config:modalTitle | 确认保存配置？ / Confirm Save | 确认保存配置？ | Confirm Save |
| config:modalTitleModels | 保存模型选择？ / Save Model Selection | 保存模型选择？ | Save Model Selection |
| config:cancel | 取消 / Cancel | 取消 | Cancel |
| config:confirm | 确认保存 / Confirm | 确认保存 | Confirm |
| config:savedRestarting | 已保存，网关重启中 / Saved. Gateway restarting | 已保存，网关重启中 | Saved. Gateway restarting |
| logs:refreshTail | 刷新文本 / Refresh tail | 刷新文本 | Refresh tail |
| logs:refreshList | 刷新目录 / Refresh list | 刷新目录 | Refresh list |
| logs:splitterTitle | 拖动调整宽度 / Drag to resize | 拖动调整宽度 | Drag to resize |
| logs:previewTruncated | 仅显示末尾 64KB / Showing last 64KB | 仅显示末尾 64KB | Showing last 64KB |
| logs:logTruncated | 仅显示末尾 256KB / Showing last 256KB | 仅显示末尾 256KB | Showing last 256KB |

混写回归断言采用「CJK 与拉丁字母分列 ` / ` 两侧」的检测式（`[\u4e00-\u9fff]\s+\/\s+[A-Za-z]` 或反向），「监听地址 / 端口」「install / models」等同语言内分隔符不受影响。

### 其他词条变更

- 孤儿键删除（在 DICT 定义但无任何调用）：`running`、`gatewayRestarted`、`logsTitle`（混写词条）、`refresh`、`filterPlaceholder`，共 5 个。
- `copyUrl` 原为孤儿键，ConfigPage 上游地址行硬编码 `title="Copy URL"` 改为 `t("config:copyUrl")` 接线；同行的 `title="Copy Path"` 硬编码也改为 `t("config:copyPath")`。两键 zh/en 值保持 "Copy URL"/"Copy Path"（迁移前两语言即显示英文硬编码，零行为变化；zh 本地化留作后续词条治理）。
- `pagerStatus` 变量名 `{{total}}` → `{{count}}`（对齐 i18next 复数惯例，en 侧启用 `_one`/`_other`）。
- 新增 `common:langZh`/`common:langEn`（Header 语言切换按钮入词典，值保留语言自称）。

## 决策记录

- 2026-10-10：**引入 `i18next` + `react-i18next` 替换自研词典（用户决策，推翻同日早前「不引包」的初步结论）**。理由：插值、类型化键名、复数、命名空间由库承担，停止维护手写 `formatTemplate` 与类型推导；i18next 是事实标准、资源可全量内联（无需 backend），运行时增量约 +15KB 在内联单文件预算内。备选 @lingui（编译期提取更省运行时，但需构建链改造与宏依赖）与 react-intl（ICU 格式，偏重）不采用。
- 2026-10-10：**插值占位符采用 i18next 语法 `{{var}}`**，`escapeValue: false`（React 已转义），缺失变量行为交由 i18next 默认值策略；不再保留任何自研 replace 逻辑。
- 2026-10-10：**键名加命名空间前缀 + JSON 资源文件**（`config.descReqLogging` 形态、按页面四个命名空间）：与 i18next namespace 机制对齐，tsc 经 `CustomTypeOptions` 保留键名检查；备选嵌套对象不采用（调用处书写啰嗦、类型工具复杂）。
- 2026-10-10：**复数使用 i18next 内建 plural**（`pagerStatus` 英文侧 `total_one`/`total_other`），不再用措辞规避——引包后 plural 为零成本能力。
- 2026-10-10（实施）：**词典文件由 JSON 改为 `as const` 的 `.ts` 模块**（触发风险 5 的预授权退路）。实测（tsc 5.9 + i18next 26）：JSON 导入的字符串值被 TS 统一拓宽为 `string`，键名检查可用、但 `{{var}}` 插值变量名无法推导（直连 `useTranslation` 亦然，与适配层无关）；M1 里程碑要求「键名与插值变量名都获得类型推导」，且旧实现「拼错变量名静默残留」正是本计划要消除的痛点，故启用计划风险节预授权的 `.ts` 退路。`.ts` 模块结构同构于 JSON（default export + `as const`），Vite 内联与 i18next resources 行为不变；键集合一致性测试仍以词典对象为数据源，不受影响。
- 2026-10-10（实施）：**`LangProvider` 移除、`useI18n` 适配层并入 `src/ui/i18n/index.ts`**。react-i18next 的 `useTranslation` 自带语言变化重渲染（无需 Provider）；`<html lang>` 同步与 localStorage 持久化改由 i18n 实例的 `languageChanged` 监听承担（初始语言在模块加载时同步写一次）。组件调用面 `const { t } = useI18n()` 不变，仅 import 路径 `./i18n.tsx` → `./i18n/index.ts`。node:test 环境下（`test/model-picker.test.ts` 经 ModelPicker 传递引入本模块）DOM 访问加 `typeof document/window` 保护，与旧实现模块级无 DOM 访问的兼容性一致。
- 2026-10-10（实施）：**调用形态统一 `t("ns:key")` 全前缀**（含 common 命名空间，如 `t("common:brandBadge")`）：与「键名加命名空间前缀」决策一致，调用处自解释且规避 defaultNS 有无前缀的类型差异。
