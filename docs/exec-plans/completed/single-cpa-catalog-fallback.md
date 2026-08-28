# 单一 CPA 目录与官方降级

## 目标

只保留运行时原始 CPA catalog；split 在 `/v1/models` 响应时添加前缀，CPA-only 直接通过 `model_catalog_json` 使用同一文件。CPA catalog 缺失、损坏或合并失败时返回官方目录。

## 范围

- 包含：路径、catalog 生成、动态合并、官方降级、模式切换、测试与文档。
- 不包含：CPA 内部账号路由和 Realtime 专用路径。

## 验证方式

- `bun run check`
- 验证 split 动态加前缀、CPA-only 静态使用原始 ID。
- 验证 CPA 文件缺失/损坏时 `/v1/models` 返回官方目录。

## 进度记录

- [x] 删除第二份 catalog 与模式标记。
- [x] 将前缀移动到 `/v1/models` 合并阶段。
- [x] 增加官方目录降级并完成验证。
