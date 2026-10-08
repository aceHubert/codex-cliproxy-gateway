# Web UI 手动模式可见性：--manual-codex-config 状态与设置方法展示

状态：已完成（2026-10-02 实施完毕并验证；历史记录见 `docs/histories/2026-10/20261002-1614-webui-manual-codex-config-visibility.md`）

## 目标

Web UI 显示当前安装对 `~/.codex/config.toml` 的管理模式（托管 / 手动）；当处于手动模式（`--manual-codex-config`）时，把需要手动配置的键与值**展开显示**出来（含每个键在用户 config.toml 里的当前状态），与 CLI 的 warning + 设置方法指引对齐。原「Web UI 手动模式可见性」技术债条目已从 tracker 移除，由本计划承接实现。

## 范围

- 包含：
  - `src/webui.ts`：`GET /ui/api/config` 的 `readonly` 增加管理模式状态；手动模式时附带 `manualCodexConfig` 指引块（期望键值 + 用户 config.toml 当前值与匹配状态）。
  - `src/ui/api.ts`：`UiConfig.readonly` 类型同步。
  - `src/ui/ConfigPage.tsx`、`src/ui/i18n.tsx`（、必要时 `styles.css`）：只读卡片新增「Codex 配置」行与手动模式展开块。
  - `test/webui.test.ts`（或新文件）覆盖 API 新字段。
  - 重跑 `bun run build:ui`（`bun run check` 内含）；历史记录追加。
- 不包含：
  - Web UI 修改/接管 config.toml 的任何写路径（UI 保持只读展示）。
  - gateway `config.json` 字段与 schema 变更（无）。
  - CLI 侧行为变化（上一计划已交付，不再改动）。

## 背景

- 相关代码路径：
  - `src/webui.ts` `configResponse()`：现返回 `editable` / `detected` / `readonly` 三组；`readonly` 已含 `routerMode`、`catalogPath`、`host/port/mountPath`。
  - `src/ui/ConfigPage.tsx`：card2「安装配置 / Install-managed」只读卡片（routerMode/upstream/host/prefix/catalogPath 行），已有 `CopyButton`、pill 徽章样式可复用。
  - 管理模式持久化在 `state.json` 的 `codexConfigManaged`（缺省 = 托管）；static 目录激活条件 `upstreamOnly && selectedModels.length > 0`。
- 已知约束（红线）：
  - **webui 依赖树不得反向引用 `cli.ts`**：`codexConfigManaged` 的读取在 `webui.ts` 内实现（读 state.json 字段），不 import cli.ts。
  - `/ui/api/*` 响应中的 URL 一律过 `sanitizeUrlValue`（只留 origin + 路径）；UI 进程只做本地只读探测，不新增任何外呼或写文件路径。
  - UI 源码改动后必须重跑 `bun run build:ui`。
  - `instanceOnly`（`serve --config` 临时实例）没有安装语义：state 缺失时按托管展示、不显示手动块。

## 方案设计（确认对象）

### 1. API（`GET /ui/api/config` 的 `readonly` 扩展）

- `readonly.codexConfigManaged: boolean`：读 `ctx.paths.stateFile` 的 `codexConfigManaged`，缺省/文件缺失/解析失败一律 `true`（与 CLI 的兼容语义一致）。
- 手动模式（`codexConfigManaged === false`）时额外返回 `readonly.manualCodexConfig`：

```jsonc
{
  "gatewayBaseUrl": "http://127.0.0.1:8320/v1",   // sanitizeUrlValue 处理后
  "staticCatalogActive": true,                     // upstreamOnly && selectedModels 非空
  "removeModelCatalogJson": false,                 // 非 static 且用户 toml 仍留有 model_catalog_json
  "keys": [
    { "key": "openai_base_url", "expected": "http://127.0.0.1:8320/v1",
      "current": "http://127.0.0.1:8320/v1", "matches": true },
    { "key": "experimental_realtime_ws_base_url", "expected": "...", "current": null, "matches": false },
    { "key": "experimental_realtime_webrtc_call_base_url", "expected": "...", "current": null, "matches": false },
    // staticCatalogActive 时追加：
    { "key": "model_catalog_json", "expected": "<catalogPath>", "current": null, "matches": false }
  ]
}
```

- `current` 用 `readRootTomlString` 从 `paths.configToml` 读取对应键；URL 类键的 `current` 过 `sanitizeUrlValue`；`model_catalog_json` 的值是本地路径原样返回；键缺失时 `current: null`。读不到 config.toml（文件不存在）时全部 `null`。
- 托管模式不返回 `manualCodexConfig` 字段（前端按缺省隐藏整块）。

### 2. UI（ConfigPage card2）

- card2 顶部（routerMode 行之前）新增只读行「Codex 配置 / config.toml」：
  - 托管：绿色 pill「托管 / Managed」+ 说明「由 install / uninstall / models 命令管理」。
  - 手动：琥珀 pill「手动 / Manual」。
- 手动模式下，同卡片内**直接展开**「手动配置方法」块（不折叠）：
  - 逐键列表：键名 + `expected`（code 样式 + 复制按钮）+ 当前状态徽标：`✓ 已配置`（matches）/ `✗ 未配置`（current 为 null）/ `⚠ 不一致`（附当前值）。
  - `staticCatalogActive` 且 `model_catalog_json` 不匹配时：警示行「未配置该键时 Codex 不会加载静态目录」。
  - `removeModelCatalogJson` 为 true 时：警示行「请从 config.toml 删除 model_catalog_json 以退出仅上游模式」。
  - 底部说明：「修改 config.toml 后需完全退出并重开 Codex；卸载不会修改 config.toml」。
- i18n：新增中英文案（`labelCodexConfig`、`badgeCodexManaged`、`badgeCodexManual`、`manualConfigTitle`、`manualKeyOk`、`manualKeyMissing`、`manualKeyMismatch`、`manualStaticNote`、`manualRemoveCatalogKey`、`manualConfigFootnote` 等）。

### 3. 测试（`test/webui.test.ts` 增补）

1. 无 state / `codexConfigManaged: true` → `readonly.codexConfigManaged === true` 且无 `manualCodexConfig` 字段。
2. 手动 state（split）→ `manualCodexConfig` 含 3 个服务键；预写 config.toml 使一键匹配、一键不一致、一键缺失，断言 `current/matches`；`staticCatalogActive === false`。
3. 手动 state + `upstreamOnly: true` 且 selectedModels 非空 → keys 含 `model_catalog_json`（expected = catalogPath）。
4. 手动 state（split）+ config.toml 残留 `model_catalog_json` → `removeModelCatalogJson === true`。
5. URL 类 `current` 值经 sanitize（构造带 query 的值断言只留 origin+路径）。

## 风险

- 风险：暴露 config.toml 内容越界。
  - 缓解：仅读取 4 个受管键并只回显其值（URL 过 sanitize、路径原样），不返回 toml 其他内容；与 provider 探测同样遵守「只读、不回显凭据」边界。
- 风险：webui 反向依赖 cli.ts。
  - 缓解：state 字段读取为 webui.ts 内的本地辅助函数，仅依赖 node:fs。
- 风险：UI 展示与 CLI 指引口径漂移。
  - 缓解：期望值构成规则（3 个服务键 = 网关地址、static 追加 model_catalog_json = catalogPath、离开 static 提示删除）与 CLI 输出同源同条件，测试双端各自断言。

## 验证方式

- 命令：`bun run check`（typecheck + 全部测试 + `build:ui` + 构建）。
- 手工检查（可选）：`codex-cliproxy web` 打开 UI，确认托管/手动徽标切换与展开块渲染、复制按钮可用。

## 进度记录

- [x] 调研完成：API/前端/测试骨架确认；技术债条目已移除。
- [x] 用户确认本可执行文档。
- [x] 实现切片 1：webui.ts API 扩展 + 类型同步 + 测试。
- [x] 实现切片 2：ConfigPage/i18n 展示与展开块。
- [x] `bun run check` 通过并记录结果（typecheck 通过；`bun test` 499 pass / 0 fail，webui 新增 3 例；`build:ui` 已重建）。
- [x] 历史记录追加；本计划移至 completed/。

## 决策记录

- 2026-10-02：按用户要求撤销「Web UI 手动模式可见性」技术债，改为本期直接实现；UI 展示状态，手动模式时展开显示设置方法。
- 2026-10-02：展示为纯只读（不提供 UI 写 config.toml 的路径），保持 Web UI 与模型流量/本机文件的既有安全边界。
