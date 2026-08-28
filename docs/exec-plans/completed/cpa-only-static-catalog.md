# CPA-only 静态目录与 WebSocket 开关

> 2026-08-27 后续由 `single-cpa-catalog-fallback.md` 收敛：CPA-only 与 split 改为共用 runtime 原始 CPA catalog。

## 目标

删除旧 `--static` 模式；让 `models --sync --cpa-only` 直接生成仅含 CPA 原始模型 ID 的静态目录并配置 `model_catalog_json`，可选 `--websocket` 启用 CPA Responses WebSocket。

## 范围

- 包含：CLI 参数、模式切换、静态目录、网关 HTTP/WS 路由、Schema、文档与测试。
- 不包含：CPA 内部账号粘性、Live/Realtime 专用链路。

## 风险

- 模式切换需要同时更新 gateway 配置、`model_catalog_json` 与 Codex 进程状态。
- CPA-only 不带 `--websocket` 时必须可靠回退 HTTP/SSE。

## 验证方式

- `bun run check`
- 验证 CPA-only 静态目录无官方模型、无 `cliproxy/` 前缀。
- 验证 `--websocket` 只接受 `models --sync --cpa-only --websocket`。

## 进度记录

- [x] 删除 `--static` 并重写目录同步语义。
- [x] 收紧 CPA-only WebSocket 开关。
- [x] 更新测试、文档和历史记录。
