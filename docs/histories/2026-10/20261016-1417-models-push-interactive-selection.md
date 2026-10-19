## [2026-10-16 14:17] | Task: models --push 追加推送前交互勾选

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `feat/model-catalog-push`

### 📥 User Query
> --push 追加了一个选择模型的过程……不加 --select 选择器，--push 过选择，默认全部勾上可以直接回
> 车就好了……只是把不想同步设置的取消勾选再确认，不做 --select 默认选择的过程

### 🛠 Changes Overview
**Scope:** apps/gateway（CLI 推送编排与帮助）、test、docs

**Key Actions:**
- **[交互勾选]**: `runModelsPush` 在采集本地插件模型、应用排除规则后进入 `chooseModels` 勾选列表
  ——全部模型默认勾选，直接回车即全量推送；方向键定位、空格切换（与 `--exclude` 同款交互）。
  不提供 `--select` 或任何跳过勾选的参数（用户裁决）。
- **[守卫顺序]**: 目标名校验与空清单守卫先于选择器（未知目标/无候选不进交互）；空选回车在菜单内
  被 `requireNonEmpty` 拦截（停留菜单，不落定不报错退出）；Ctrl+C 取消、非 TTY 报
  "requires an interactive terminal"且零写入。
- **[多目标共享一次选择]**: 勾选子集对全部目标生效；zcode 目标内的插件剔除与 `deletedModels`
  过滤在目标层继续生效。
- **[测试注入]**: `PushModelsDependencies`（input/output）供 fake TTY 驱动；usage 与 README 同步。

### 🧠 Design Intent (Why)

推送按 ID 全量替换会移除目标侧手动添加的模型，直接执行风险偏高；用户要求推送前有一次
确认机会——但不想引入 `--select` 那样的持久选择语义，只是「把不想同步的取消勾选再确认」。
因此选择结果仅影响本次推送（不落盘、不进 config），默认全选让常用路径保持「一键回车」，
与 `models --exclude` 复用同一勾选器保持交互一致性。

### 📊 Change Stats
> 工作区未提交改动（test/models-push.test.ts 为本任务线新增文件，含前序推送用例）。

- **Files changed:** 4
- **Insertions:** +160（cli.ts +117/-9，README +43/-4）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/cli.ts` | +117 | -9 |
| `apps/gateway/README.md` | +43 | -4 |
| `test/models-push.test.ts` | +296→338（新增交互用例 5 例） | — |
| `docs/exec-plans/completed/models-push-clients.md` | 追加进度勾选与实施落定记录 | — |

### 📁 Files Modified
- `apps/gateway/src/cli.ts`（`runModelsPush` 交互编排、`PushModelsDependencies`、usage）
- `apps/gateway/README.md`（`--push` 手册补交互确认条目）
- `test/models-push.test.ts`（fake TTY 用例：默认回车全量 / 取消个别 / 空选停留 / 非 TTY 报错）
- `docs/exec-plans/completed/models-push-clients.md`（追加小节进度与决策收口）

### ✅ Verification
- `bun run check` 全绿（1179 例测试，含 push 相关 21 例：默认全选回车、取消个别后确认、
  空选回车停留菜单（承诺不落定）、再勾选回车恢复推送、非 TTY 报错）。
- 真机（非 TTY shell）：`models --push dsh` 报 "requires an interactive terminal …" 且
  `~/.dsh`、`~/.zcode` 校验和不变（零写入）；交互按键流由 fake TTY 自动化测试覆盖，
  真机 TTY 下的滚动手感留给用户日常使用验证。
