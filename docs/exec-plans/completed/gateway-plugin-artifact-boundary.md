# 网关收口插件落盘产物清单：卸载清理与目录守卫去硬编码

## 目标

网关业务源码不再硬编码任何 agent 插件的落盘产物文件名：各插件包自行导出产物清单声明，业务组合入口（`gateway-composition.ts`）聚合，卸载清理与 `model_catalog_json` 受管守卫消费聚合结果；同时补齐现清单缺失的 agy、qoder、opencode-zen 产物，使卸载不再在 `~/.agent-proxy-gateway` 残留插件缓存。

## 范围

- 包含：
  - 五个插件包（`zcode`、`codebuddy`、`qoder`、`agy`、`opencode-zen`）各导出自己在 `cacheDirectory` 下的产物文件名清单（纯静态声明，不实例化插件）。
  - `gateway-composition.ts` 新增聚合函数，汇总全部已安装插件的产物清单（默认目录为 `resolvePaths().runtimeHome`，可传入实例目录）。
  - `apps/gateway/src/paths.ts` 的 `managedCatalogFiles` 收窄为网关自有目录文件（`cliproxy-catalog.json`、`newapi-catalog.json`、`codex-catalog.json`）。
  - `cli.ts` 的 `removeManagedRuntimeFiles` 与 `model-state.ts` 的 `applyModelCatalogToml` 受管值白名单改用「网关自有 + 插件聚合」清单。
  - 测试更新：`test/paths.test.ts` 的受管目录清单断言迁移；`test/gateway.test.ts` 清理测试补齐五家插件产物与 codebuddy 旧版按地域命名残留。
- 不包含：
  - 插件缓存读写逻辑本身（仍封装在各包内部，读写行为与文件名语义不变）。
  - `default-install-migration.ts` 的旧目录迁移白名单：现行实现按文件名模式匹配，白名单同时覆盖插件目录缓存（含 codebuddy 旧版产品×地域命名），实测迁移会把插件缓存与网关自有文件一并复制到新目录；本次不改造该模块，残留的「网关源码持有插件产物名模式」知识记录在 [tech-debt-tracker](../tech-debt-tracker.md)。
  - 模型 ID 前缀命名空间（`zcode/`、`qoder-cn/` 等）与日志 namespace 在网关侧的引用：这些是插件契约层面的命名空间约定（`excludedModels` 是网关配置、namespace 定义于 `plugin-api`），不属于落盘产物知识，维持现状。
  - 插件凭据文件（存放在各产品自身目录，不在 runtimeHome，卸载本就不触碰）。

## 背景

- 相关文档：`AGENTS.md`（「插件只由业务组合入口显式装配」；`packages/plugin-api` 最小插件契约边界）、`docs/exec-plans/completed/codex-gateway-monorepo.md`（monorepo 迁移确立的资源边界）。
- 相关代码路径：
  - 泄漏点：`apps/gateway/src/paths.ts` 的 `managedCatalogFiles`（`paths.ts:138`）硬编码 `zcode-catalog.json`、`codebuddy-catalog.json`、`workbuddy-catalog.json`。
  - 消费点一（卸载清理）：`apps/gateway/src/cli.ts` 的 `removeManagedRuntimeFiles`（`cli.ts:610`），对清单逐项 `fs.rmSync`。
  - 消费点二（受管值守卫）：`apps/gateway/src/model-state.ts` 的 `applyModelCatalogToml`（`model-state.ts:57`）用清单判定 `config.toml` 的 `model_catalog_json` 是否受管，非受管值拒绝覆盖。
  - 插件产物全集（各包内 `atomicWrite` 到 `cacheDirectory` 的文件，缺省 `cacheDirectory` 即 runtimeHome）：
    - zcode：`zcode-catalog.json`（`packages/zcode/src/index.ts:97`）。
    - codebuddy：`codebuddy-catalog.json`、`workbuddy-catalog.json`（`packages/codebuddy/src/catalog.ts:71`）；旧版按产品×地域命名 `{codebuddy|workbuddy}-{cn|intl}-catalog.json` 共 4 个残留文件（`catalog.ts:82`，现版本写入新产品文件时清理，但已卸载机器上的旧文件只能靠卸载清理兜底）。
    - qoder：`qoder-cn-catalog.json`、`qoder-intl-catalog.json`（`packages/qoder/src/catalog.ts:253`）。
    - agy：`agy-catalog.json`（`packages/agy/src/catalog.ts:352`）。
    - opencode-zen：`opencode-zen-catalog.json`、`opencode-zen-metadata.json`（`packages/opencode-zen/src/catalog.ts:358-359`）。
- 已知约束：
  - 卸载路径不得依赖插件实例化：插件构造有凭据读取、目录探测等副作用，失败会让 uninstall 本身不可用，因此清单必须是包级静态导出，不能走运行时注册。
  - `model-state.ts` 是叶子模块（被 `model-composition.ts` 同时与 `gateway-composition.ts` 引用），不得为聚合清单新增对 `gateway-composition.ts` 的 import；清单经参数注入。
  - 守卫白名单是兼容性承诺：历史上 `model_catalog_json` 可能指向过插件目录文件，聚合清单必须覆盖全部历史文件名（含 legacy 地域命名），否则旧机器 install 会误报「unmanaged」。
  - 清单是删除白名单：只允许 runtimeHome 直系文件，不允许目录与 `..` 穿越；`paths.test.ts` 现有「全部文件 dirname === runtimeHome」断言模式必须保留并扩展到聚合清单。

## 风险

- 风险：聚合清单遗漏或写错文件名 → 卸载漏删残留，或（更严重）守卫误把用户自管值当受管值覆盖。
  缓解方式：清单由各包在写缓存的同一源码位置导出（文件名常量与 `atomicWrite` 目标共用同一来源，不再两处维护）；守卫测试覆盖历史受管值全集。
- 风险：`managedCatalogFiles` 签名收窄后，未排查到的隐藏消费方编译失败或行为漂移。
  缓解方式：仓库内全量检索消费点（当前仅 `removeManagedRuntimeFiles` 与 `applyModelCatalogToml` 两处），逐个改造后 `bun run typecheck` 全量兜底。
- 风险：五个公开包各扩大一个导出，破坏包导出契约或打包检查。
  缓解方式：`bun run pack:check` 验证八个产品包的依赖版本与 exports。
- 风险：循环引用（model-state ↔ gateway-composition）。
  缓解方式：聚合函数只放 `gateway-composition.ts`；`applyModelCatalogToml` 增加清单参数，调用方（`cli.ts` / `model-composition.ts` 转发层）负责传入。

## 里程碑

1. 调研与方案收敛：复核五家产物全集（含 `cacheDirectory` 覆盖场景：`serve --config` 显式实例目录与 `CODEX_CLIPROXY_HOME`）；确定导出形态（建议：各包导出 `export const <PKG>_RUNTIME_ARTIFACTS: readonly string[]`，文件名为不含目录的字符串，由聚合方拼接 runtimeHome）。
2. 分阶段实现：
   a. 五个插件包导出产物清单常量（codebuddy 的 legacy 命名并入其清单）。
   b. `gateway-composition.ts` 聚合已安装插件的清单；`paths.ts` 的 `managedCatalogFiles` 收窄为网关自有文件。
   c. 改造两个消费点：`removeManagedRuntimeFiles` 并入聚合清单；`applyModelCatalogToml` 守卫白名单改为参数注入的完整清单。
3. 验证、交付与收尾：测试补齐、`bun run check` 与 `bun run pack:check`、手工卸载演练、历史记录归档（`docs/histories/`）、计划移至 `completed/`。

## 验证方式

- 命令：`bun run check`、`bun run pack:check`。
- 手工检查：
  - 临时 `HOME` 布置全部 10 个插件产物文件 + codebuddy 4 个 legacy 地域命名残留 + 一个用户自建文件（如 `notes.txt`），触发卸载清理路径，断言插件产物全删、用户文件保留、网关自有目录文件（cliproxy/newapi/codex-catalog.json）同样被清理。
  - `grep -rnE '"[a-z0-9_-]*-(catalog|metadata)\.json"' apps/gateway/src/` 复核：除组合入口的聚合函数、网关自有文件名与 `default-install-migration.ts` 迁移白名单的既有模式匹配（本次未改造，见 tech-debt-tracker）外，不再出现插件产物文件名。
- 观测检查：`test/paths.test.ts` 聚合清单结构断言（dirname === runtimeHome、无 `..`、无 legacy 地域命名混入 codebuddy 现行文件）；`test/gateway.test.ts` 卸载清理断言覆盖五家产物；守卫测试断言历史 `model_catalog_json` 值仍被识别为受管。

## 进度记录

- [x] 里程碑 1：复核五家产物全集与 `cacheDirectory` 覆盖场景，确定导出形态（包级静态导出 `<PKG>_RUNTIME_ARTIFACTS`，文件名与落盘点同源）。
- [x] 里程碑 2a：五个插件包导出产物清单常量（codebuddy legacy 命名并入其清单，共 12 文件）。
- [x] 里程碑 2b：`gateway-composition.ts` 聚合（`installedPluginArtifactFiles` + `managedRuntimeCatalogFiles`）+ `managedCatalogFiles` 收窄为网关自有文件。
- [x] 里程碑 2c：`removeManagedRuntimeFiles` 与 `applyModelCatalogToml` 改造完成（守卫清单必传注入，`model-composition` 转发层统一注入，webui 自动生效）。
- [x] 里程碑 3：测试补齐（聚合清单结构、守卫受管值全集、卸载清理全集）、`bun run check`（971 测试通过）与 `pack:check` 通过、临时 HOME 手工卸载演练通过、历史记录（`docs/histories/2026-10/20261011-2348-plugin-artifact-boundary.md`）并归档。

## 决策记录

- 2026-10-11：创建计划。初始决策——
  - 清单走「插件包静态导出 + 组合入口聚合」，不采用运行时 HostServices/registry 注册：卸载与守卫路径不得依赖插件实例化（构造副作用含凭据读取，失败会阻断卸载）；该形态同时满足「插件自声明、网关不自持子包产物知识」的边界要求。
  - 聚合位置定在 `gateway-composition.ts`：它是 AGENTS.md 定义的显式装配入口，已是唯一同时 import 五家插件包的业务模块，不新增依赖边。
  - `model-state.ts` 保持叶子模块，`applyModelCatalogToml` 通过参数接收受管清单，由调用方注入，规避循环引用。
  - codebuddy 的 4 个 legacy 地域命名文件并入其导出清单：现行代码只在写入新产品文件时顺手清理旧文件，已停用机器上的残留只能由卸载清理兜底。
- 2026-10-11（实施）：
  - `applyModelCatalogToml` 的 `managedFiles` 设为必传参数而非可选默认：默认值若是窄清单，未来调用方漏传会让守卫静默拒绝历史插件指向；必传让遗漏成为编译错误。
  - `model-composition.ts` 的 `updateCodexModelCatalog` 转发层统一注入 `managedRuntimeCatalogFiles(paths)`：cli 的 models 命令与 webui 的目录更新共用该转发层，注入一次两边生效；`model-state.ts` 的 `updateCodexModelCatalog` 保留 `managedFiles = managedCatalogFiles(paths)` 兜底默认，叶子测试无需感知组合层。
  - 聚合产出两个公开函数：`installedPluginArtifactFiles`（纯插件产物，测试与边界断言用）与 `managedRuntimeCatalogFiles`（自有 + 插件全集，卸载清理与守卫共用），消费点不自行拼接。
- 2026-10-12（验收复核）：独立探针（声明↔写盘点一致性、聚合结构、守卫 16 个历史受管值、22 文件卸载清理、五包真实写盘、迁移白名单实测）全部通过，`bun run check` 971 项与 `pack:check` 复现通过；修正「不包含」条目对迁移白名单现状的错误描述（实测插件缓存会随迁移复制，并非「继续不迁移」），残留的插件产物名模式知识补记入 tech-debt-tracker。
