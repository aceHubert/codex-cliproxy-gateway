# 技术债完成情况复核（2026-11-09）

## 核查口径与结果

本轮逐项检查开始时清单中的 34 条债务，对照当前源码、回归测试、关联完成计划及后续历史记录。删除 1 条已被替代的旧入口债务，缩减或纠正另外 6 条；剩余 33 条继续跟踪。清单中原有的线程容量与测试隔离改动保持原样，它们正在其他任务中实施，本轮不据此宣告完成。

完成计划只证明其约定范围通过验收；明确延后的能力、未覆盖的渠道和后续新增风险仍需保留。发现后续实现或勘误时，以后续证据和当前代码为准，不沿用旧计划的结论。

本轮仅修改技术债清单与本核查报告，没有修改业务代码，也没有发起真实账号请求。

## 整条移除

### ZCode Anthropic 直通（2026-09-11）

旧债务对应独立 `/zai` 入口，包含 `messages/count_tokens` 原样转发和当时尚未实现的签名流程。该入口已在 [Responses 计划](exec-plans/completed/zcode-responses.md)中被替换，旧实现与测试的删除见 [2026-09-12 历史](histories/2026-09/20260912-1532-zcode-responses.md)。

当前 [网关回归](../test/zcode-gateway.test.ts)明确验证旧 `/zai`、`/zai/v1/messages`、`/zai/v1/messages/count_tokens` 返回 404 且不访问上游。旧入口的验收债务不再适用于当前产品。

签名、握手与 PoW 后来已实现，[2026-09-21 记录](histories/2026-09/20260921-1447-zcode-client-signing.md)包含独立验签测试、API Key 实网 HTTP 200；Coding Plan 的 429 被确认是周配额耗尽。当前 Anthropic 入口的非流式、字符串 content、流式与工具调用，也在 [2026-11-01 记录附二](histories/2026-11/20261101-1554-zcode-start-plan-route-restart.md)中完成四场景实测。

未覆盖渠道和套餐仍归入现有“ZCode 多渠道套餐实网验收”，不因删除旧入口债务而视作全部验收完成。

## 从混合条目中移除的已完成或过时内容

| 原条目 | 清理内容 | 当前实现及验证证据 |
| --- | --- | --- |
| 四客户端指纹未复验 | ZCode 旧 UA 无后缀组合的待实测项 | [3.17.1 更新记录附三](histories/2026-11/20261101-1554-zcode-start-plan-route-restart.md)：已统一实际客户端 UA 后缀，双端点实测 200；旧组合已被替代。WorkBuddy、Qoder desktop 与 AGY 后续版本复验仍保留。 |
| Zen 指纹时效 | beta 固定 UA、完整 12 工具作为门禁前提的旧描述 | [2026-10-26 换代记录](histories/2026-10/20261026-1506-zen-gate-2026-10-26-refresh-adaptation.md)及当前 [fingerprint.ts](../packages/opencode-zen/src/fingerprint.ts)：当前是模板包含校验、会话新鲜度、动态 UA；[10-30 记录](histories/2026-10/20261030-0340-zen-tool-name-pair-blacklist-gate.md)补充工具名黑名单对。相关原始请求已实网复验。模板时效风险继续保留。 |
| Zen 指纹时效 | counter 固定 1 被列为缺陷的旧推断 | 当前 [session.ts](../packages/opencode-zen/src/session.ts)保持官方 counter 位形状，由时间段及后缀构成标识；[会话回归](../test/opencode-zen-session.test.ts)验证派生、复用和标头选择。[10-15](histories/2026-10/20261015-1532-opencode-zen-session-derivation.md)及 [10-26](histories/2026-10/20261026-1506-zen-gate-2026-10-26-refresh-adaptation.md)均有实际请求成功记录。当前时间段取铸造时间，不能沿用旧“哈希时间段、跨进程完全同 ID”的实现描述。 |
| Zen 指纹时效 | 403 地区/端点不可用都误报指纹失败，以及硬编码 OPENCODE_API_KEY 修复指引 | 当前 [错误归一化](../packages/opencode-zen/src/index.ts)优先透传 message，区分 RegionError、FreeTierError 和 Endpoint unavailable；[修复记录](histories/2026-10/20261014-1339-zen-error-message-passthrough.md)包含定向测试和真实报文回放。401 的机器分类及原生 Chat 流内错误聚合仍保留。 |
| Zen 指纹时效 | “探针保留失效模型”及 cat-jam-free 下线的推断 | 同一 [历史记录的补充验证与勘误](histories/2026-10/20261014-1339-zen-error-message-passthrough.md)明确：该模型处于上新测试阶段，官方客户端得到相同结果，保留为 served 是正确行为；原误登债务已撤销。当前 [探针分类](../packages/opencode-zen/src/catalog.ts)的保守保留策略不能仅凭 403 再认定为缺陷。 |
| AGY 未实证面 | 旧 UA changelist `993434119` | [指纹快照](../packages/agy/src/fingerprint-data.json)已在 10-09 更新为 1.3.1 / 985595000；版本与 changelist 的后续轮换只在“四客户端指纹”条目维护。真实图片、会话及配额机制未因此完成。 |
| Qoder 排队兼容 | 110 秒等待、固定两次尝试、30 秒就绪延迟的旧机制 | [完成计划后续进度](exec-plans/completed/qoder-international-flash-proxy-integration.md)与[排队历史末尾补充](histories/2026-10/20261002-2015-qoder-queue-recovery-and-cn-edition.md)记录替换为 retryAfter 重试和 120 秒总预算，真实拥堵期干净失败、容量恢复后 63 秒成功。[queue.ts](../packages/qoder/src/queue.ts)及[测试](../test/qoder-queue.test.ts)与之吻合；客户端等待反馈和用户配置缺口继续保留。 |
| Qoder 排队兼容 | 仍以 CLI 1.1.65 为现行基线 | [1.1.83 适配](histories/2026-11/20261106-1151-qoder-1.1.83-protocol-auth-adaptation.md)已完成双地域目录、认证重铸和全量 1298 项验证；“自动对照未来 CLI 版本”的缺口仍在，不能把现有单测当作该机制。 |
| ZCode 3.12.3 延迟项 | 个人套餐 key 再生后继续消费旧镜像 Key | [个人项目令牌计划](exec-plans/completed/zcode-individual-project-token.md)已完成在线签发、到期重签、账号隔离及真实目录恢复；当前 [config.ts](../packages/zcode/src/config.ts)禁止有账号身份时回退旧个人 Key。Start Plan 无凭据时的镜像引导回退仍存在。 |
| ZCode 3.12.3 延迟项 | 依赖旧 family API Key selected key 写法的验收项 | [多 Provider 路由计划](exec-plans/completed/zcode-api-provider-routing.md)已改为按 provider_config 枚举并以 provider ID 独立路由；[index.ts](../packages/zcode/src/index.ts)为每个 Provider 传入 apiProviderID，[config.ts](../packages/zcode/src/config.ts)据此直接读取指定 Provider，不依赖旧 family selected key。该旧依赖已被替代；[缓存测试](../test/zcode-cache.test.ts)与[网关测试](../test/zcode-gateway.test.ts)验证当前读取与多 Key 隔离，但不证明旧版客户端实际落盘形态已被实测。 |
| ZCode 上游验收 | 仍宣称只有最初一次实测、未实现服务端搜索或签名 | [搜索实测](histories/2026-09/20260912-1953-zcode-builtin-websearch.md)、[签名验收](histories/2026-09/20260921-1447-zcode-client-signing.md)和[Start Plan 实网验收](histories/2026-11/20261101-1554-zcode-start-plan-route-restart.md)均已完成。条目现只跟踪尚无逐项实网证据的渠道和套餐，不把首期范围说明继续写成现行能力限制。 |

## 保留项的复核依据

下列 27 条未修改；另外 6 条经过缩减后仍有未完成部分。没有仅因关联文档位于 completed 就删除债务。

| 条目或相邻条目组 | 仍需保留的原因 |
| --- | --- |
| 线程路由容量、Gateway 测试隔离 | 复核时仍在实施，后续已通过 1351 项全量回归并[归档计划](exec-plans/completed/thread-routing-capacity-and-gateway-test-isolation.md)。目录隔离债已解决，线程容量已有限额，真正回收仍保留为后续债务。 |
| 原生 Responses 非流式工具身份 | [request.ts](../packages/llm-bridge/src/request.ts)的 registerIdentity 按裸名存储，[events.ts](../packages/llm-bridge/src/events.ts)的 Responses 工具事件未保留 namespace。跨协议安全名测试不覆盖这个冲突路径。 |
| AI SDK 升级面、配置/UI 插件化 | 前者仍是现有引擎的升级兼容约束；后者被 [monorepo 计划](exec-plans/completed/codex-gateway-monorepo.md)明确留待独立需求，没有实现配置声明或 UI 动态装配。 |
| Web UI i18n、debug 开关 | [中文词条](../apps/gateway/src/ui/i18n/locales/zh/config.ts)仍有 Copy URL/Copy Path；[配置 patch](../apps/gateway/src/config-update.ts)仍未开放 debug。 |
| CodeBuddy 缓存身份、多账号路由、token 刷新 | [目录缓存键](../packages/codebuddy/src/catalog.ts)仍只含 profile/accountUid/enterpriseId；凭据仍按 profile 选最新登录，未提供同地域多账号独立 slug 或网关专用刷新链路。 |
| Zen 元数据实时化残留 | [response.ts](../packages/opencode-zen/src/response.ts)仍未聚合 reasoning_content；元数据整体不可用时仍采用保守少示，未完成全部模型窗口与 effort 实证。 |
| excludedModels Web 地域粒度、upstream-only 直通 | 产品级分组仍不能表达单地域；[gateway.ts](../apps/gateway/src/gateway.ts)仅对已识别推理 endpoint 解码模型，images 等直通路径的排除缺口仍在。 |
| 提示词残留、四客户端指纹复验 | [提示词计划](exec-plans/completed/agent-system-prompt-conversion-layer.md)明确保留四家整体替换语义；WorkBuddy 缺样本、Qoder desktop 实流及快照维护没有全部闭环。 |
| Qoder 长上下文/长期运行、桌面凭据边界 | 模拟测试不证明 950k 实际输入、长期续期恢复、Linux 桌面钥匙串路径；现有成功短请求不覆盖这些验收。 |
| install 回滚与 UI 自动化 | [回滚测试](../test/install-rollback.test.ts)和实例测试仍未覆盖 bootstrap 成功/kickstart 失败后真实 launchctl 恢复链；保存失败后重试缺浏览器组件自动化。 |
| Linux 服务管理、Windows 适配 | credentials.json 后端完成不代表 systemd、Windows 交互与权限语义已交付；安装平台门槛和未实证范围仍在。 |
| z.ai 工具配额、ZCode 图片指纹、搜索形状 | 尚无共享配额耗尽降级、webReader 完整适配；图片续跑请求体仍未逐腿记入交换日志，多图反查与私有搜索形状依赖仍存在。 |
| Codex 目录必填字段 | [catalog.ts](../apps/gateway/src/catalog.ts)的 minimalModelEntry 仍未含 supported_reasoning_levels，厂商预设补字段不能覆盖任意合成条目。 |
| guardian classifier、CLIProxy 内部跨 provider 增量恢复 | [线程切换计划](exec-plans/active/responses-thread-tree-route-switch.md)未解决无 parent classifier 的可信归属；官方与 CLIProxy 双向切换不等于 CLIProxy 内部 provider 变化的恢复。 |
| Realtime provider 门控、Realtime 上游选择 | 当前只覆盖 live 全树和 realtime 根/calls 子树；sessions 等周边路径及 CLIProxy 完整 Live 链路选择仍未交付。 |

## 本轮验证

在临时用户主目录中执行以下 6 个文件，保留仓库测试脚本 60 秒上限：

```sh
bun run test -- test/opencode-zen-session.test.ts test/opencode-zen-gateway.test.ts test/qoder-queue.test.ts test/zcode-signing.test.ts test/zcode-cache.test.ts test/zcode-gateway.test.ts
```

结果：160 通过、1 跳过、0 失败，共 161 项。跳过项为实际 fs.watch 原子替换测试，宿主返回 EMFILE；该项不作为本轮移除条目的完成证据。其余原生事件边界不因本轮文档清理被宣告通过。

本轮未重新调用真实模型；实网结论仅引用上述已有验收记录。构建、定向测试与文档相对链接校验用于确认当前证据；不以本轮测试替代仍未完成的全渠道或长期运行验收。

