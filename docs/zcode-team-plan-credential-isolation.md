# ZCode 团队套餐凭据隔离

## 状态与决策

2026-09-18 评审发现，优先级 P1，尚未修复。用户明确要求团队套餐留作技术债，下轮再解决，本轮保留现有实现。

本项承接 [技术债追踪](exec-plans/tech-debt-tracker.md) 中 ZCode 3.12.3 延迟项的第 ⑦ 项，相关背景见 [读取层最小加固计划](exec-plans/completed/zcode-3.12.3-compat.md)。

## 问题与影响

`src/zcode/config.ts` 的 `readSelection` 将 `individual-coding-plan` 和 `team-coding-plan` 都映射为 `builtin:<family>-coding-plan`，忽略团队的 `productId`、`organizationId`、`projectId`。

缓存仅比较 family/providerID 判断选择是否变化。个人切到团队时，这两个字段不变，无法触发凭据刷新；更换团队项目同样无法被该比较识别。网关可能继续使用个人 Key，请求成功时仍消耗个人额度，不能仅将后果视为 401。

ZCode 3.12.3 的请求鉴权分别通过 `loadIndividualPlanApiKey` 获取个人 Key、通过 `resolveTeamPlanApiKey` 获取团队项目 Key。API 地址相同不代表凭据可以共用。

## 复现证据

本次使用合成配置与虚构 Key 验证，未访问真实凭据或生产接口：

1. 选择 `individual-coding-plan`，在 config 镜像中设置虚构个人 Key，初始化缓存。
2. 将选择改为带 productId/organizationId/projectId 的 `team-coding-plan`。
3. 触发 setting.json 文件事件，等待 180 毫秒使刷新执行，再读取快照。

结果：快照对象未变，仍使用个人 Key，config 读取次数保持为 1。

现有热切换测试将两种套餐都断言为同一个测试 Key，旧快照可立即通过 `eventually` 断言，因而不能证明团队凭据已正确切换。

## 下轮修复方向

- 区分个人与团队凭据，将 kind 和团队上下文纳入选择身份及缓存失效条件。
- 按所选团队项目解析凭据；缺失或不可用时明确报错，禁止回退个人 Key。
- 修正热切换测试，使用不同凭据，并等待选择刷新完成后验证结果。

## 验收要求

- 个人→团队、团队→个人时，上游请求使用对应凭据。
- 团队项目 A→B 时，凭据随项目切换，不沿用旧项目凭据。
- 团队凭据缺失或不可用时，不发出上游请求。
- 测试能识别旧快照未刷新及错误复用个人 Key 的情况。
