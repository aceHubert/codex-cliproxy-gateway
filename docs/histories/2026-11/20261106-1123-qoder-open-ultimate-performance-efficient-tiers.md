## [2026-11-06 11:23] | Task: 放开 Qoder 计费档位，仅保留 Auto 排除

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan/GLM-5.3)`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 截图中 Qoder 客户端的「极致 2× / 快速 0.8× / 经济 0.3×」是配置排除还是代码写死？把极致、快速、经济这三个放开，确认 label 显示的是中文还是英文、倍率是多少。（后续追加：smodel/cmodel 也放开，可选性由服务端 enable 控制）

### 🛠 Changes Overview
**Scope:** packages/qoder、test

**Key Actions:**
- **[档位放行]**: `QODER_TIER_MODEL_KEYS` 由 `["auto", "ultimate", "performance", "efficient", "smodel", "cmodel"]` 缩减为 `["auto"]`：极致（ultimate）、快速（fast）、经济（efficient）、Sonus（smodel）、Cantus（cmodel）全部放行，可选性交由服务端目录 `enable`/`disabled` 开关控制（`parseQoderCatalogData` 原有逻辑）；仅 Auto（自动选型档）仍以 key 名单硬排除。
- **[纠正死 key]**: 旧名单中的 `performance` 在线上目录不存在，「快速」的真实 key 为 `fast`（旧名单从未包含它，即旧代码下 fast 本不被拦截，此前未出现仅因账号目录未返回该条目）。
- **[缓存修订号]**: `CACHE_REVISION` 4 → 5，旧名单缓存失效重建，防止含旧过滤结果的落盘目录继续生效。
- **[测试更新]**: `test/qoder-catalog.test.ts` 断言五档位放行、Auto 仍排除的过滤边界。

### 🧠 Design Intent (Why)
* 聚合档位按倍率计费、由服务端动态选型，原实现整体硬排除；用户确认这些档位本身就是产品可选能力，且服务端目录的 `enable` 开关已控制账号可用性，本地硬编码名单冗余（还写错过 performance/fast），故放开并仅保留 Auto 排除。
* 线上目录（国际版，2026-11-06 实拉）证实档位元数据均为英文 display_name：`ultimate`=`Ultimate`（×2）、`fast`=`Fast`（×0.8）、`efficient`=`Efficient`（×0.3）、`smodel`=`Sonus`（×8）、`cmodel`=`Cantus`（×4）、`auto`=`Auto`（×0.5，保持排除）。客户端界面的「极致/快速/经济」是客户端本地化；放行后网关展示名为 `Qoder-INTL/Ultimate (x2)`、`Qoder-INTL/Fast (x0.8)` 等（缓存样例格式佐证 `Qoder-INTL/Qwen3.8-Flash (free)`）。
* 国内版桌面登录已过期（`com.qodercn.app.stable`），本次未能核实国内版目录，行为与国际版一致由代码保证。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区，未提交）。

- **Files changed:** 2
- **Insertions:** +14
- **Deletions:** -11

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/qoder/src/catalog.ts` | +6 | -7 |
| `test/qoder-catalog.test.ts` | +8 | -4 |

### 📁 Files Modified
- `packages/qoder/src/catalog.ts`
- `test/qoder-catalog.test.ts`

### ✅ Verification
- `bun test test/qoder-catalog.test.ts`：14 pass / 0 fail。
- `bun run typecheck`：通过。
- 一次性脚本（/tmp，已删除）实拉国际版目录确认档位元数据；不打印凭据。
- 备注：用户另有指示「不用更新（网关），签名有问题」，运行中的网关服务未重启、未重建，改动待下次构建部署生效；部署后各账号是否能看到某档位由服务端 enable 决定。
