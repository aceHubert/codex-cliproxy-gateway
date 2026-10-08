# install --manual-codex-config：手动管理 Codex config.toml

状态：已完成（2026-10-02 实施完毕并验证；历史记录见 `docs/histories/2026-10/20261002-1530-manual-codex-config-install-flag.md`）

## 目标

为 `install` 新增布尔参数 `--manual-codex-config`（默认 false）：为 true 时 codex-cliproxy 全程不改写 `~/.codex/config.toml`，所有原本会代写的受管键改为「warning 提示 + 设置方法打印」交给用户手动配置。static（`--upstream-only`）与该参数同时出现时不报错也不中止：以 warning + 询问「是否修改 codex 配置」交给用户选择——YES 直接托管写入（该参数本次不生效），NO 走手动模式并在装完后打印配置方法。

## 范围

- 包含：
  - `install`：新参数、与 `--upstream-only` 的冲突确认流程、手动模式分支（不写 config.toml、不做纯净备份、托管→手动切换时还原受管键）。
  - `uninstall` / `restart` / `models --sync` / `status`：依据 state 标记尊重手动模式，需要改写处一律 warning + 打印设置方法。
  - `test/manual-codex-config.test.ts` 新增测试；README、CLI usage 文案同步。
  - `docs/histories` 历史记录与 `bun run check` 全量验证。
- 不包含：
  - Web UI 开关（`/ui` 不暴露该模式，遗留为技术债）。
  - gateway `config.json` 字段变更（本方案不新增 config.json 字段，`schemas/gateway-config.schema.json` 无需同步）。
  - 非 macOS 平台的安装流程（维持现状，仅 macOS）。

## 背景

- 相关代码路径（写入 `~/.codex/config.toml` 的全部 4 处，均在 `src/cli.ts`）：
  - `install`：`applyModelCatalogToml`（model_catalog_json 增删）+ `managedCodexServiceToml`（openai_base_url 与 2 个 realtime 键）+ `backupConfig` 纯净备份 + `state.installedConfigHash`。
  - `uninstall`：hash 匹配整文件还原纯净备份，否则仅还原受管键。
  - `restart`（controlGateway）：补写漂移的受管键。
  - `models --sync`：static 切换时写/删 `model_catalog_json`。
- 受管键清单（`MANAGED_CONFIG_KEYS`）：`openai_base_url`、`model_catalog_json`、`experimental_realtime_ws_base_url`、`experimental_realtime_webrtc_call_base_url`。
- 已知约束：
  - static（`--upstream-only`）目录依赖 config.toml 的 `model_catalog_json` 指向目录文件（static manager 不请求 `/models`，见 `src/codex-version.ts` 注释）；手动模式下该键必须由用户手动添加，否则 static 不生效。
  - 托管关系记录在 `state.json`（InstallState）而非 gateway config：`configBackup` + `installedConfigHash` 已在此，新增手动模式标记放同处，避免触碰 config.json schema。
  - 旧 state 兼容：新字段缺省必须等价于「托管」，老安装升级后行为不变。
  - 测试隔离：darwin 上 `uninstall` 会真实调用 `security delete-generic-password`（account 取自 `$USER`），测试必须把 `process.env.USER` 覆盖为哨兵值，防止误删本机真实 Keychain 条目。

## 方案设计（确认对象）

### 1. 参数与接入

- `--manual-codex-config`：布尔 flag，仅 `install` 接受（`COMMAND_OPTIONS.install` 白名单、`parseArgs` 布尔列表、`usage()` 文案）；其他命令传入报 `Unknown option`。
- 默认 false：不带该参数时所有命令行为与现状完全一致。

### 2. install：冲突（`--manual-codex-config` + `--upstream-only`/`--cpa-only`）处理

不报错、不中止安装。在任何文件被改动之前先解决冲突：

1. 打印 warning 与问题（问题即用户指定的语义）：
   - `WARNING: --upstream-only requires managed config.toml keys (model_catalog_json) in ~/.codex/config.toml, which --manual-codex-config does not write.`
   - `Modify ~/.codex/config.toml directly? [N/y]`（upstream-only 必须修改 codex 配置，是否修改？）
2. 按用户选择继续安装（两种结果都完成安装）：
   - **y（托管）**：直接写好 config.toml（受管键 + 纯净备份 + hash），本次 `--manual-codex-config` 不生效，state 按托管记录（`codexConfigManaged: true`），等效于不带该参数的普通 static 安装。
   - **N（默认，手动）**：不改写 config.toml，按手动模式完成 static 安装（目录重建、网关配置照常），安装完成后打印如何手动配置（见第 3 节成功输出）。
3. 免交互场景取默认答案 N（不修改，尊重显式传入的 `--manual-codex-config`）：
   - `--yes`：跳过提问，按 N 处理（手动模式 + 打印配置方法）。
   - 非 TTY（脚本/CI）：无法提问，按 N 处理。
4. 冲突解决逻辑抽为可注入提问的独立函数（如 `resolveCodexConfigConflict`），便于单测覆盖 y/N/非 TTY/--yes 四个分支。

### 3. install：手动模式主流程

- config.toml 全程只读：跳过 `model_catalog_json` 守卫与写入、跳过 `managedCodexServiceToml` 补写、不创建 `.bak-cliproxy-gateway-*` 纯净备份。
- **托管→手动**（已有托管安装，带参数原地更新）：先按 uninstall 同一语义还原受管键（hash 匹配 → 整文件还原纯净备份；被手改过 → 仅还原 4 个受管键，用户其余内容保留），此后 config.toml 交还用户；该还原逻辑抽为共享函数 `restoreManagedCodexToml()`。失败回滚时写回尝试前内容，保持「现有安装不动」承诺。
- **手动→托管**（已有手动安装，不带参数重装）：重新取纯净备份、重置 hash，托管周期从当前 config.toml 重新起算。
- state 写入：`codexConfigManaged: false` 并删除 `configBackup` / `installedConfigHash` 字段；切回托管时重建这两个字段。
- 成功输出（warning + 设置方法；仅实际处于手动模式时输出——冲突时选了 YES 的安装按托管输出，无手动指引）：
  - split 模式：`WARNING` + 需手动添加的 3 个服务键及确切值（= 网关地址），并说明 uninstall 不会再动 config.toml。
  - static 模式：追加 `model_catalog_json = "<catalogFile 绝对路径>"` 与「未添加该键 Codex 不会加载静态目录」的 warning。
  - 从 static 切回 split 且用户 toml 里仍留有 `model_catalog_json`：warning 提示手动删除。
- 失败回滚：手动模式首装失败不还原 config.toml（本就未写）；托管→手动切换失败写回尝试前内容。

### 4. models --sync：手动模式

- **不再拦截 `--upstream-only`**：static 切换照常完成（`upstreamOnly=true`、拉目录、`requireNonEmpty` 选择、重建 static 目录、写网关配置、按既有逻辑重启网关），但 config.toml 逐字节不动（不写 `model_catalog_json`、不清理 legacy 目录文件、不推进 hash、不产生 config.toml 审计条目）。
- 同步完成后按需打印（只在有需要时输出，避免刷屏）：
  - 切入 static 且用户 toml 缺失/指向别处 `model_catalog_json`：warning + `model_catalog_json = "<catalogFile>"` + 「添加后需完全退出并重开 Codex」。已正确指向则不打印。
  - 切回 split（或 `--select none`）且用户 toml 中存在 `model_catalog_json`：warning + 「手动删除该键以退出 static」。
- split 模式且无需变更 config.toml 的普通同步：不打印任何 warning（本就不涉及 config.toml）。

### 5. restart：手动模式

- 跳过受管键补写与 hash 更新，仅重启网关。
- 只读漂移检查：若 config.toml 的服务键与当前网关地址不一致（本应补写的场景），warning + 打印期望的键值；一致则静默。

### 6. uninstall：手动模式

- 完全跳过 config.toml 还原与 legacy 目录文件清理（配置属于用户，还原反而会毁掉手改）。
- 完成提示区分手动模式：说明 config.toml 未被触碰，并列出如不再需要网关时应手动移除的受管键清单。

### 7. status

- JSON 输出新增 `codexConfigManaged` 字段：手动安装为 `false`，托管为 `true`，未安装为 `null`。

### 8. state 与类型

- `InstallState`：新增 `codexConfigManaged?: boolean`（缺省 = true，兼容旧 state，无迁移）；`configBackup`、`installedConfigHash` 放宽为可选。
- 新增 `isCodexConfigManaged()` 辅助与共享还原函数 `restoreManagedCodexToml()`（uninstall 与托管→手动共用；缺备份时给出含键清单的可执行错误信息）。

## 风险

- 风险：static + 手动模式下用户忘记添加 `model_catalog_json`，Codex 不加载静态目录、以为安装失败。
  - 缓解：冲突确认、install 成功输出、models --sync 输出三处都以 warning + 确切键值提示；`status` 可对照检查。
- 风险：托管→手动切换的还原逻辑与 uninstall 耦合，行为漂移。
  - 缓解：抽共享函数单测覆盖「未手改整文件还原 / 手改仅还原受管键 / 缺备份报错」三分支。
- 风险：默认路径回归（不带新参数时行为改变）。
  - 缓解：现有 install/uninstall/models --sync/restart 相关测试全量保持通过；手动模式为纯增量分支。
- 风险：测试误删本机 Keychain 真实条目。
  - 缓解：涉及 `deleteApiKey` 的测试统一覆盖 `process.env.USER` 为哨兵值。

## 里程碑

1. 调研与方案收敛（已完成，本文档即产出）。
2. 实现：cli.ts（参数/校验/install/models/uninstall/restart/status/state）→ 测试 → README 与 usage。
3. 验证与收尾：`bun run check` 全量通过、历史记录归档、本计划移至 completed/。

## 验证方式

- 命令：`bun run check`（typecheck + 全部 node:test + build）；`bun test test/manual-codex-config.test.ts`。
- 手工检查（macOS 本机，可选用临时 `HOME` 演练）：
  - `install --manual-codex-config`（非 TTY）冲突分支输出与中止行为；带 `--yes` 后的 warning 输出。
  - 手动安装后 `models --sync --upstream-only --select all` 成功且 config.toml 逐字节不变、打印 `model_catalog_json` 指引。
  - `uninstall` 后 config.toml 保持不动。
- 观测检查：`status` 的 `codexConfigManaged` 字段；gateway.log 配置审计中手动模式不出现 config.toml 条目。

## 测试清单（test/manual-codex-config.test.ts）

1. 冲突解决函数单测（注入提问桩）：交互答 y → 托管；答 N → 手动；非 TTY → 默认 N 手动；`--yes` → 默认 N 手动。另测其他命令传入 `--manual-codex-config` 报 Unknown option。
2. `restoreManagedCodexToml` 单测：未手改整文件还原 / 手改仅还原受管键且保留用户内容 / 缺备份报可执行错误。
3. `models --sync`（darwin）：手动模式 static 切换成功、config.toml 逐字节不变、输出含 `model_catalog_json` 指引、`upstreamOnly: true`、static 目录重建。
4. `models --sync`（darwin）：切回 split 且 toml 存在该键时输出删除提示。
5. `uninstall`（darwin）：config.toml 不变、state 回收、config.json 保留、提示区分手动模式（`process.env.USER` 哨兵隔离 Keychain）。
6. `status`：`codexConfigManaged: false`。

## 进度记录

- [x] 调研完成：写入点、static 约束、state 结构、Keychain 测试风险均已确认。
- [x] 用户确认本可执行文档。
- [x] 实现切片 1：cli.ts 参数接入 + install 手动模式分支。
- [x] 实现切片 2：models/uninstall/restart/status 手动模式分支。
- [x] 实现切片 3：测试、README、usage。
- [x] `bun run check` 通过并记录结果（typecheck 通过；`bun test` 495 pass / 0 fail，含新增 6 例；构建通过）。
- [x] 历史记录写入 `docs/histories/2026-10/`，本计划移至 completed/；Web UI 可见性遗留项登记至 tech-debt-tracker。

## 决策记录

- 2026-10-02：新参数命名 `--manual-codex-config`（语义为「手动配置」，优于 `--no-codex-config` 的「永不动配置」）。
- 2026-10-02：static 与手动模式的冲突由「硬报错」调整为「warning + 交互确认，用户选择为准」（用户拍板）。
- 2026-10-02：手动模式通用规则确立——所有需要改写 config.toml 之处一律 warning + 设置方法打印，代码永不写入（用户拍板）；据此 `models --sync --upstream-only` 放行并打印所需键值。
- 2026-10-02：冲突确认语义修正（用户拍板）：询问「upstream-only 必须修改 codex 配置，是否修改？」，YES → 直接托管写入、本次 `--manual-codex-config` 不生效（state 按托管记录）；NO（默认，含非 TTY 与 `--yes`）→ 手动模式完成安装、装完打印配置方法。两种选择都完成安装，不存在中止分支。
- 2026-10-02：托管关系持久化在 state.json（`codexConfigManaged`），不新增 config.json 字段、不改 gateway-config schema。
