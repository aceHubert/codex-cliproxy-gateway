## [2026-08-17 20:56] | Task: 实现官方 Realtime 代理

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 读取指定会话，完成 Realtime `/live` 问题；有疑问时对照 OpenCodex/Codex 实现。

### 🛠 Changes Overview
**Scope:** 官方 Realtime 配置、call-create 和 WebSocket transport

**Key Actions:**
- **配置接入**: 安装与同步托管 `experimental_realtime_ws_base_url`，卸载恢复原值，status 输出当前值。
- **HTTP 适配**: ChatGPT multipart 转 backend JSON，移除 `session.id`；raw SDP 和 OpenAI API 形态原样转发。
- **WebSocket 桥**: 区分普通连接、Frameless sideband 和 V1 sideband，转发受控认证头、文本、二进制与关闭事件。
- **安全边界**: 16 MiB HTTP/帧上限、1 MiB 握手队列、120 秒 HTTP 超时、手动 redirect。

### 🧠 Design Intent (Why)
Codex 的 WebRTC sideband 默认绕过 `openai_base_url`。只有同时托管 Realtime WS 基址，并按 Codex 源码区分普通连接和 sideband，完整链路才会进入 gateway。

### 📊 Change Stats
> 按本任务补丁统计；重叠文件中既有未提交改动不计入本任务。

- **Files changed:** 8
- **Insertions:** +725
- **Deletions:** -27

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/realtime.ts` | +324 | -0 |
| `test/realtime.test.ts` | +305 | -0 |
| `src/cli.ts` | +10 | -1 |
| `src/gateway.ts` | +25 | -3 |
| `test/gateway.test.ts` | +4 | -4 |
| `README.md` | +2 | -2 |
| `docs/official-realtime-proxy-plan.md` | +7 | -17 |
| `docs/exec-plans/completed/official-realtime-proxy.md` | +48 | -0 |

### 📁 Files Modified
- `src/realtime.ts`
- `test/realtime.test.ts`
- `src/cli.ts`
- `src/gateway.ts`
- `test/gateway.test.ts`
- `README.md`
- `docs/official-realtime-proxy-plan.md`
- `docs/exec-plans/completed/official-realtime-proxy.md`
