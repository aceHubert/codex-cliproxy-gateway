# 网关重启后会话恢复验证计划

> 背景：Codex CLI 长时间运行后报 "Automatic reconnect could not restore this session"。
> 排查确认与 v0.22.0 双向上游切换（eb33474）后的瞬态 503 相关，本计划用于闭环验证。

## 背景与结论

- 事故样本：会话 01a1af71-09ce-7f70-96d7-968cb5af1883（2026-11-06 创建，11-09 14:24 resume）。
- 网关 11-09 11:29 重启后内存路由表清空，resume 时子线程请求先于父会话到达，
  网关返回 503「父会话路由尚未就绪」，旧版 CLI 自动重连未恢复成功。
- v0.22.0 已改为按当前请求实时重建路由：根路由由请求模型推导（HTTP 正文优先于握手 hint），
  父子边由请求携带 parentThreadId 登记，official/cliproxy 双向切换，
  冲突帧 1012 关闭下游要求重连。因此无需持久化路由表，也无需扫描 rollout。

## 目标

1. 验证网关重启后 resume 旧会话只出现瞬态 503，父会话首个请求到达后路由重建成功。
2. 验证 CLI/TUI/Desktop 的自动重试能吃掉瞬态 503，不再出现不可恢复报错。
3. 验证双向上游切换在重启场景下子线程正确跟随根路由，无额度误耗。

## 验证步骤

1. 准备：启动网关，创建主会话并派生 side/子代理，确认线程树路由生效。
2. 重启网关进程（模拟 11-09 11:29 场景），立即 resume 该会话。
3. 断言：请求最多经历有限次（建议阈值 3 次）503 重试后返回 200/101。
4. 断言：子线程后续请求沿父链解析到正确根路由（official 或 cliproxy 均各测一轮）。
5. 断言：无「裸模型」请求落到非预期上游（对账网关日志 upstream 字段）。
6. 复测 Desktop/App Server 场景：杀 app-server 守护进程后恢复同一会话。

## 回归测试建议

- test 中新增跨重启集成用例：重启 -> resume -> 断言恢复成功与路由正确。
- 保留现有 thread-routing 单测与 WS 双向重连回归。

## 风险与边界

- 瞬态 503 窗口内客户端若不重试或重试过快，仍可能报恢复失败；需确认 CLI 重试节奏。
- 父链冲突/循环仍会拒绝（设计如此），需提示用户重建会话。

## 参考

- apps/gateway/src/thread-routing.ts（ThreadRoutingState）
- docs/exec-plans/active/responses-thread-tree-route-switch.md
- docs/codex-tui-desktop-traffic-patterns.md
- 网关日志：~/.agent-proxy-gateway/gateway.log（503 与 1012 记录）
