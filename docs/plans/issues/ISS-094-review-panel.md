> Epic: #128 (ISS-069) · 批次: B3 · 标签: `parity-slice` `right-panel` `priority/P1` `frontend`
> 规格来源: 差距文档 §G(Review) §A2/A3/A17/A18；实物模块 `thread-side-panel-tab-content`(105KB) `code-diff` `diff-comment-card` `review-file-tree-pane` `review-file-source-tab` `review-diff-virtualizer-metrics` `virtualized-file-diff-line-position` `pull-request-code-review` `git-action-review-state` `auto-review-approval-nudge`；文案 `codex.review.*`(99) `codex.hunk.*`(7) `diff.*`(14)

## 目标

把现有简版 Review（all / last-turn + approve/revise 两按钮）升级为 Codex 的完整代码审查面板：**多源 diff、文件树、虚拟化、逐 hunk/文件/区段 revert、行级评论、PR 视图**。

## 范围

1. **Diff 源切换**（`codex.review.source.*`）：`local.lastTurn` / `local.lastTurnV2` / `local.thisBranch` / `local.commit` / `local.commits` / `local.selectedCommit` / `local.all` / `local.allRepositories`；`gitBasedReviewDisabled` 提示；数据源 = `x.ai/git/{diffs,status,files,branches,current_commit,checkout_commit}` + `x.ai/hunk-tracker/*`
2. **Stage 过滤**：`codex.review.stageFilter.staged` + 未 staged；`x.ai/git/{stage,unstage,stage/content}`
3. **文件树 pane**：`review-file-tree-pane` / `review-file-tree-side-pane` / `review-file-source-breadcrumb` / `review-file-source-item`；`codex.review.header.{showFiles,hideFiles}`
4. **虚拟化 diff**：`review-diff-virtualizer-metrics` + `virtualized-file-diff-line-position`（大文件/大 diff 不卡）；`codex.review.largeDiff.banner` + `previousFile`/`nextFile`；`codex.review.diffTooLarge.{title,description}`
5. **Viewed 标记**：`codex.review.fileDiff.{markAsViewed,markAsUnviewed,markedAsViewed}`（持久化 per thread）
6. **Revert**：file / hunk / section 三级，走 `x.ai/hunk-tracker/{file-action,hunk-action,all-action,turn-action}` + `apply-review-section-changes`；成功/部分成功/失败各自 toast（`codex.review.revert.{file,hunk,section}.{success,partialSuccess,error}`、`codex.hunk.patch.{success,partialSuccess,missing,error,revertSuccess,revertError,notGitRepo}`）；确认弹窗 `codex.review.revertDialog.{title,message,confirm,cancel,skip}`
7. **Copy git apply command**：`codex.review.copyGitApplyCommand.toast`
8. **Find**：`codex.review.find.loadMore`（diff 内搜索 + 分页加载）
9. **空态与错误态**：`codex.review.noDiff`（+ `baseDescription` / `reverted` / `revertedOrCommitted` / `orNoLongerAvailable`）、`noDiff.gitRepoRequired.{title,description}`、`noDiff.gitInit.{createRepository,creating,error}`、`emptyState.viewBranchDiff`、`fileWatchLimited.{message,refresh}`、`refreshGitQueries.inProgress`
10. **行级评论**：`diff-comment-card` + `use-conversation-diff-comments` + `use-code-diff-context-menu` → `x.ai/review/comment`、`x.ai/review/comment/delete`
11. **PR 区**：`codex.review.pullRequests.{label,branches,draftBranches,empty,loading,error,retry}` + `pull-request-code-review{,-navigation}` + `x.ai/pr/status`；`gitSummary.repair{,Checks,Comments,MergeConflicts,Everything}`（本地可执行部分）
12. **agent 主动推送的 diff review**：接 `SessionUpdate::DiffReview`（当前被丢弃）+ `auto-review-approval-nudge`
13. Triage/队列语义保留（iss-067 已实现的 worktree 审阅队列 + `gb-triage-read`）并整合进新面板

## 非目标

- 云端 review 源（`codex.review.source.cloud` 仅显示不可用）、cloud PR 创建流程中依赖平台的部分
- `editor-diff-page`（独立编辑器页）、`pdf-preview-diff`、`docx-preview` 等文档类 diff（OUT）
- Git blame 的编辑器内联显示（`git.toggleBlame` 依赖文件编辑器，本轮无编辑器页 → 命令注册但不实现）
- 不做 diff 的 AI 总结生成（除非 agent 提供）

## 依赖

- ISS-087（`x.ai/git/*`、`x.ai/hunk-tracker/*`、`x.ai/review/*`、`x.ai/pr/status`、`DiffReview` 事件）
- ISS-091（side panel tab 容器 + 多实例）
- ISS-088（per-thread review 状态：源选择、viewed 集合、find 查询）

## 回滚

新面板以 side panel tab 内容形式接入，flag `review.v2`；回滚 = 恢复现有 `RightPanel.tsx` 的 `ReviewPanel` 组件（保留至本 issue 稳定一个批次）。viewed 标记与评论存于 agent 侧/独立 key，回滚不破坏 git 工作区。

## 验收标准

### 状态机不变量
- **UI 与 git/hunk 真值一致**：revert 成功后该 hunk 必须从 `x.ai/hunk-tracker/get-hunks` 结果消失（禁止乐观更新与 agent 状态分叉）；失败/部分成功必须回滚 UI 选择态
- 源切换 ⟹ 文件树、diff、find 结果、viewed 集合同时重置为该源的视图（不得残留上一源的选中文件）
- `viewed` 集合 ⊆ 当前源的文件集合
- stage 过滤：`staged` 视图只含已 stage 的变更；stage/unstage 后两侧计数守恒
- 存在未决 revert 操作时，禁止并发第二个 destructive 操作（串行化 + 禁用态）
- diff 为空 ⟹ 显示对应空态而非空白面板；非 git 仓库 ⟹ `gitRepoRequired` 而非崩溃

### 负向场景
- 非 git 仓库 / `.git` 损坏 / detached HEAD / 无 upstream 分支 → 各自明确态（`notGitRepo`、`noDiff.gitRepoRequired.*`）
- 二进制文件、超大文件、被 .gitignore 忽略的未跟踪文件、符号链接、CRLF/LF 混合 → 有确定渲染策略，不卡死
- revert 冲突（文件已被外部修改）→ `partialSuccess`/`error` + 可重试，且不得静默覆盖用户改动
- `x.ai/pr/status` 无网络/无 GitHub 远端 → `pullRequests.error` + `retry`，不影响本地 review
- diff 过大 → `diffTooLarge.{title,description}` + `largeDiff.banner` 的上一/下一文件导航仍可用
- 文件监听受限 → `fileWatchLimited.{message,refresh}`，手动 refresh 可用
- 评论提交失败 → 草稿保留 + 错误提示

### 并发 / 崩溃 / 恢复
- agent 正在改文件（turn 进行中）时打开 Review：内容随 `x.ai/gitHeadChanged` / `x.ai/fs_notify` 增量刷新，不整页抖动、不丢滚动位置
- revert 进行中 kill agent → 操作以错误结束，git 工作区不处于半应用状态（依赖 agent 的原子性；需验证并记录）
- 两个窗口同时 Review 同一 thread：一侧 revert 后另一侧刷新，viewed 集合合并策略确定
- app 重启 → 源选择、viewed 集合、find 查询、展开的文件恢复（per-thread 持久化）
- 快速连续切源（10 次/秒）→ 只渲染最后一次结果，无过期响应覆盖新结果（请求竞态防护）

### 外部副作用检查
- **destructive 操作**（revert file/hunk/section、discard、stage/unstage）必须二次确认（`revertDialog`）；`skip` 语义正确
- 所有 git 操作走 agent 扩展，不得在渲染层/主进程直接拼 shell（继续 `execFile` 参数数组或 agent 调用）
- `copy git apply command` 写入剪贴板的内容不得包含密钥；命令本身可安全粘贴执行（不含 `rm -rf` 类）
- 评论写入 agent 侧存储，不修改项目文件
- 面板不得写入会话 cwd 之外

### Parity 勾选项
- [ ] `codex.review.*` 99 条文案对应行为全覆盖（OUT 项除外并在 checklist 标注）
- [ ] `codex.hunk.*` 7 条 + `diff.*` 14 条
- [ ] A2 hunk-tracker 接线、A3 git 走 agent、A17 DiffReview 事件、A18 PR 状态
- [ ] 虚拟化：1 万行 diff 滚动 60fps（性能断言）
