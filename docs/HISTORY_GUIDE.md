# 代码变更历史记录规范

`docs/histories/` 用来记录已经完成的代码变更任务。纯问答、调研、分析类任务默认不需要记 history，除非最后确实改了仓库内容。

## 基本要求

- 每个完成的代码变更任务，都应该对应一份 history 文件，或补充到同一任务既有的 history 文件里。
- 用户原始诉求可以适当压缩，但要保留关键信息。
- 不要把敏感信息、本地路径、密钥或原始日志细节直接写进去。
- 同一个任务跨多轮推进时，继续维护同一个 history，不要重复建文件。

## 目录与命名

- 目录：`docs/histories/YYYY-MM/`
- 文件名：`YYYYMMDD-HHmm-task-slug.md`
- 模板：`docs/histories/template.md`

示例：

```text
docs/histories/
  2026-05/
    20260513-1650-bootstrap-template.md
```

## 应该写什么

- 用户诉求原文，或者压缩后的脱敏版本。
- 本次主要代码与文档改动。
- 设计动机，以及为什么这么做。
- 最关键的受影响文件。
- 改动规模统计（见下）。

## Git User 与 Change Stats 的填写方式

模板里的 `Git User` 和 `Change Stats` 是为了让 history 能被自动化工具或后续审阅者快速关联到真实的提交作者与影响面。建议按下面的方式取值：

- **Git User**：使用 `git config user.name` 与 `git config user.email` 的组合，例如 `hubert <hubert@example.com>`；如果该任务由多位作者接力，可以列多行。
- **Branch**：当前分支名，可以用 `git rev-parse --abbrev-ref HEAD` 获取。
- **Change Stats**：以本次任务涉及到的提交为范围，执行：

  ```bash
  # 总计
  git diff --shortstat <base>..HEAD

  # 逐文件行数
  git diff --numstat <base>..HEAD
  ```

  将 `--shortstat` 的结果抄进顶部的 Files changed / Insertions / Deletions，将 `--numstat` 的结果整理成表格，`-` 开头的二进制文件可以在 `+Added / -Removed` 列里写 `bin`。

如果本次记录只针对一次提交，可以把 `<base>..HEAD` 换成 `HEAD~1..HEAD`。对于多次提交组成的任务，`<base>` 通常是任务分支与目标分支的共同祖先（例如 `origin/master`）。
