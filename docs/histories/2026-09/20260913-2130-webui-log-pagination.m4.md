## [2026-09-13 21:30] | Task: Web UI 请求日志目录分页与三态提示

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan/GLM-5.3)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `codex/codex-api`

### 📥 User Query
> request log 目录应该倒序（最新在最前），而且需要分页——不限制个数会特别多，默认显示 100 条；默认显示第一条（自动预览），没有日志时才显示「点击左侧文件查看内容」；请求日志未开启时提示未开启日志设置。

### 🛠 Changes Overview
**Scope:** codex-cliproxy-gateway（Web UI 前端 `src/ui/` + `/ui/api/logs/requests` 服务端）

**Key Actions:**
- **[服务端分页]**: `requestLogsResponse` 接受 `offset`/`limit`（默认 100、上限 500，非法值回退缺省），mtime 倒序（最新在前）由隐式行为升级为显式 API 契约，响应增加 `total`/`offset`/`limit`/`logging`；`requestLogging` 关闭时**不列目录**（即使有历史文件），只返回 `logging:false` + 空列表。
- **[前端分页条]**: LogsPage 请求日志 tab 增加分页条——上一页/下一页（越界禁用）、`第 n/m 页 · 共 t 条` 状态、每页 50/100/200 选择器；页码越界自动收敛到最后一页；「刷新目录」刷新当前页。
- **[默认选中与三态提示]**: 首次加载目录后自动选中并预览第一条（最新文件，`selectedNameRef` 防闭包竞态）；三态——未开启（列表与预览均显示「请求日志未开启——在配置页打开…或运行 codex-cliproxy config --log on」，服务端不返回文件）、开启但目录空（「开启请求日志后，这里会出现…」）、有文件（「点击左侧文件查看内容」仅作空预览占位，正常路径自动加载第一条）。
- **[测试]**: 分页契约（倒序、offset/limit 切页、缺省 100、limit=0/offset=-5 回退、limit=9999 钳 500）、`logging:false` 时不列历史文件；既有列表测试改用内联字面量路径。

### 🧠 Design Intent (Why)
目录可能积累海量请求日志文件，整表返回既慢又让 DOM 爆炸——分页落在服务端（切片后返回），前端只渲染当前页。「最新在前」是排查日志的第一诉求，作为 API 契约钉死并有测试兜底。「未开启日志」与「开启但还没有文件」是两种不同状态：前者提示用户去开启（且不再浏览历史文件，避免误导「还在记录」），后者提示开启后会有记录。

### 📊 Change Stats
> 数据来自 `git diff`（仅本次任务相关文件；同分支另有并行改动不在统计内）。

- **Files changed:** 6（本任务相关）
- **Insertions:** +170
- **Deletions:** -29

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/ui/LogsPage.tsx` | +73 | -8 |
| `test/webui.test.ts` | +85 | -11 |
| `src/webui.ts` | +36 | -8 |
| `src/ui/styles.css` | +39 | -0 |
| `src/ui/api.ts` | +12 | -2 |
| `src/ui/i18n.tsx` | +10 | -0 |

### 📁 Files Modified
- `src/webui.ts`、`src/ui/api.ts`、`src/ui/LogsPage.tsx`、`src/ui/i18n.tsx`、`src/ui/styles.css`、`test/webui.test.ts`
- （构建产物随 `bun run build` 重新生成）

### ✅ Verification
- `bun run check` 全绿：typecheck + 287 个测试（webui 18 个）+ 构建（472KB UI / 1.34MB 单文件）。
- 冒烟网关（150 个种子日志文件，真实 `dist/index.js`）浏览器实测：
  - 分页：第 1 页 100 条、`第 1/2 页 · 共 150 条`、上一页禁用；下一页 → 第 2 页 50 条、下一页禁用；回到第 1 页状态正确；
  - 排序：第一行为最新文件（`…120150.log`）且**自动选中**，预览立即加载其内容；
  - 未开启：关闭 `requestLogging` 重启后——右侧预览面板与拖拽分隔条**整体不渲染**，左侧提示「请求日志未开启——…」占满全宽，不列 150 个历史文件、无分页条；重新开启后布局恢复（列表+分隔条+预览齐全，第一条自动选中）。
- API 直测：`?offset=100&limit=100` 返回剩余 50 条（首 `…120050.log`，倒序正确）；`logging:false` 时 `total:0 files:[]`。
