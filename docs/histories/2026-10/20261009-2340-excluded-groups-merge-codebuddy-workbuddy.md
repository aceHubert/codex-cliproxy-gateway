## [2026-10-09 23:40] | Task: 合并 CodeBuddy/WorkBuddy 排除框并统一输入框样式

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `glm-5.3-flash`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> 把 codebuddy/workbuddy 的这两个框合并成一个，自动补充2个前缀
> 其它的输入框都设置为100%宽度
> 把输入框标题都修改成排除模型

### 🛠 Changes Overview
**Scope:** config-update / webui / docs

**Key Actions:**
- **[分组结构]**: `ExcludedModelGroupDefinition.prefix` 改为 `prefixes: string[]`；CodeBuddy 与 WorkBuddy 两个分组合并为一个 `codebuddy` 组（endpoint `codebuddy`），`matchPrefixes` 收编双产品全部前缀（workbuddy-intl|cn/、codebuddy-intl|cn/、旧前缀与两个家族通配）。分组总数 6 → 5。
- **[双前缀保存]**: `expandExcludedModelGroups` 按组内每个保存前缀各生成一条规则——同一框里的每条目保存时同时产出 `codebuddy-*/模型名` 与 `workbuddy-*/模型名`；回显侧 `splitExcludedModelsByGroup` 把两个产品的存量规则都拆进同一个框。
- **[UI]**: 输入框标题统一为「排除模型」（删除 6 个按产品命名的 i18n 键，新增 `excludedGroupLabel`）；CSS 由 auto-fit 多列 + 560px 上限改为单列 100% 宽；描述文案说明双前缀语义。
- **[文档]**: README 排除模型章节改为「5 框」并说明 CodeBuddy/WorkBuddy 同框双前缀。

### 🧠 Design Intent (Why)
用户感知上 CodeBuddy 与 WorkBuddy 是同一个开关行的同一族凭据，两个输入框徒增困惑；合并后按双产品语义解释条目（装哪个应用命中哪个，另一侧无模型匹配时自然空转），与「按用户可感知的产品归一」的分组原则一致。作用域谓词、目录过滤、404 拦截不受影响——`isLocalAdapterExclusionPattern` 的权威前缀清单由 matchPrefixes/prefixes 派生，双产品前缀本就在清单内。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作区未提交变更，含上一轮 zen 排除任务）。

- **Files changed:** 12
- **Insertions:** +246
- **Deletions:** -120

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +13 | -13 |
| `schemas/gateway-config.schema.json` | +1 | -1 |
| `src/cli.ts` | +8 | -10 |
| `src/config-update.ts` | +29 | -26 |
| `src/gateway.ts` | +9 | -2 |
| `src/ui/ConfigPage.tsx` | +13 | -24 |
| `src/ui/api.ts` | +5 | -4 |
| `src/ui/i18n.tsx` | +4 | -12 |
| `src/ui/styles.css` | +3 | -3 |
| `test/model-exclude-gateway.test.ts` | +88 | -4 |
| `test/model-exclude.test.ts` | +84 | -18 |
| `test/opencode-zen-gateway.test.ts` | +5 | -4 |

### 📁 Files Modified
- `README.md`
- `schemas/gateway-config.schema.json`
- `src/cli.ts`
- `src/config-update.ts`
- `src/gateway.ts`
- `src/ui/ConfigPage.tsx`
- `src/ui/api.ts`
- `src/ui/i18n.tsx`
- `src/ui/styles.css`
- `test/model-exclude-gateway.test.ts`
- `test/model-exclude.test.ts`
- `test/opencode-zen-gateway.test.ts`

### 🧪 Verification
- `bun run check` 全绿：typecheck 通过，827 tests / 0 fail，UI 重建成功。
- 新增断言：合并组回显（`workbuddy-intl/x` 与 `codebuddy-cn/x` 同框）、展开成对产出双前缀、粘贴任一产品完整 ID 被拒、`workbuddy` 作为独立分组 key 报 Unknown。
- 浏览器实测（临时预览实例 + 截图）：CodeBuddy/WorkBuddy 行单框回显两条存量规则、输入框占满控制区宽度、全部框标题为「排除模型」。
