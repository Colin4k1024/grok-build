> Epic: #128 (ISS-069) · 批次: B3 · 标签: `parity-slice` `conversation` `messages` `priority/P1` `frontend`
> 规格来源: 差距文档 §F(F1–F8,F10–F15,F17)；实物模块 `local-conversation-thread`(380KB) `local-conversation-thread-turn-entries` `thread-virtualizer` `thread-scroll-layout` `thread-user-message-navigation-rail-app` `turn-preview-body-items` `latest-turn-preview`；文案 `codex.localConversation.*`(107) `codex.userMessage.*`(3) `codex.threadFindBar.*`(8) `thread.navigationRail.*`(2) `localConversation.*`(111) `markdown.*`(68)

## 目标

把消息流从"平铺的 user/assistant/tool 三类消息"重构为 Codex 的**按轮聚合 + 虚拟化 + 导航栏**结构，并补齐轮内聚合区块（sources / outputs / created tasks / environment / git / plan / usage）、编辑上一条、从旧轮 fork、自动审批复核。

## 范围

1. **Turn entries 结构**：一轮 = `{ userMessage, items:[reasoning|commentary|toolCall|mcpToolCall|diff|message|outputs…], status, duration }`（实物：`type:'work'` 聚合块 + `type:'message'`）；替换现在"ToolCall 与 ToolResult 是两条独立消息"的模型；每轮可折叠、折叠状态持久化
2. **虚拟化 + 滚动**：`thread-virtualizer` + `thread-scroll-layout`（top/bottom fade 遮罩、自动吸底、用户上滚时暂停吸底、`scrollTo(edge|pixels|pages)` 语义）
3. **用户消息导航栏**：`thread-user-message-navigation-rail-app` —— 右侧边缘 marker、跳转（`jumpAriaLabel`）、书签（`bookmarkTurn`/`removeBookmark`）、输出类型缩略（`fileOutput`/`imageOutput`/`commitOutput`/`pullRequestOutput`/`websiteOutput`/`appOutput`/`reviewOutput`/`loadingPreview`/`previewUnavailable`/`moreOutputs`/`noContent`）、`ariaLabel`
4. **Thread 内查找**：`codex.threadFindBar.*` 8 条（placeholder/label/results `{active} / {matches}`/noResults/next/previous/close/unavailable）+ 命令 `findInThread`(⌘F)
5. **用户消息操作**：`codex.userMessage.{showMore,showLess,implementPlan}`（"Yes, implement this plan" 一键回复）
6. **轮内聚合区块**（`codex.localConversation.*`，仅本地范围）：`sources.{title,add,addFilesAndFolders,usePlugins,webSearch,showAll}`、`outputs.{title.v2,recentFiles,noMatches}`、`createdTasks.{title,untitled,status.*}`（本地后台任务）、`environmentSummary.{title,copyBranchName}`、`gitSummary.*`（本地部分：branchChangesLabel/thisBranchLabel/compareBranch/createPullRequest/copyPullRequestLink/existingPullRequest/prCodeChanges/prStatus/prSummary）、`plan.title`、`usage.title` + `usage.creditsAndDollarAmountsEstimateDisclaimer`（不含账单）、`backgroundTasks.title.{subagents,backgroundProcesses}`、`backgroundTerminals.*`、`sideChats.title`
7. **工具调用卡片增强**：图标、耗时、输入/输出分栏、折叠记忆（同工具记住展开态）、success/failure 色彩；MCP 工具卡（`codex.mcpTool.*` 75 条，接 ISS-100 的 MCP 状态）
8. **消息内 diff / patch 卡**：`code-diff` + `diff-summary` + `diff-preview-tooltip`，与 ISS-094 共享 diff 渲染组件
9. **编辑上一条 / 从旧轮 fork**：`localConversation.editLastMessageFailed`、`forkFromOlderTurnDialog`(7 条) → `x.ai/session/fork`、`x.ai/rewind/{points,execute}`
10. **自动审批复核 / 被拒动作**：`localConversation.automaticApprovalReview`(20 条)、`deniedActionsCount`/`deniedActionsTooltip`
11. **状态文案**：`localConversation.{working,workingFor,workedFor,userStoppedAfter,reconnectingToCodex,loadingTask,historyLoadFailed,retryHistoryLoad,turnRenderError}`
12. **Markdown 渲染**：对齐 `markdown.*` 68 条（代码块复制/语言标签/折叠/行号、mermaid 用仓库已 vendor 的栈）
13. **Code Apply 真落地**：接 `grok:apply-code`（当前无监听者）→ `x.ai/fs/write_file` 或 hunk apply
14. 压缩标记 + 回滚保留（现有 `CompactionMarker` 已可用），reactions 保留但接线 `EmojiPicker`（当前死代码）

## 非目标

- Artifacts / 生成图画廊 / Canvas / 文档·幻灯片·表格（`codex.writingBlock.*` 129 条、`artifact-*`）—— OUT
- Browser / Chrome tabs / remote hosted PiP / computer use（OUT）
- 会话摘要面板的 AI 生成（`summaryPanel` 依赖 agent 能力，若 `x.ai/recap` 可用则做，否则显示不可用而非造假）
- 分享快照（OUT）

## 依赖

- ISS-087（`x.ai/session/fork`、`x.ai/rewind/*`、`x.ai/subagent/*`、`x.ai/task/*`、`x.ai/fs/*`、`x.ai/recap`、`DiffReview`）
- ISS-091（tab / side panel 容器；导航栏与 panel 联动）
- ISS-088（per-thread：折叠态、书签、find 查询、滚动位置）
- ISS-094（共享 diff 渲染组件）

## 回滚

消息模型是破坏性变更 ⇒ 采用**适配器模式**：保留 `ChatMessage[]` 作为 wire 格式，新增 `turnEntries` 派生层（selector），UI 先切派生层；回滚 = UI 指回旧 `MessageItem` 列表。持久化的消息不落新格式（只落 wire 格式），保证降级可读。

## 验收标准

### 状态机不变量
- **轮次不变量**：每个 turn 恰有一个 user message（或明确的 automation/system 来源）；turn 内 items 顺序 == agent 事件顺序；turn 状态机 `pending → working → (awaitingApproval|needsInput) → done|failed|stopped`，无非法跳转
- streaming 中：最后一个 turn 恒为 `working`；`TurnComplete` 后恒为非 working；`finalizeMessages` 后无消息残留 `streaming:true`
- 折叠态、书签、find 结果均 per-thread，切换 tab 不串
- 导航栏 marker 数 == thread 内 user message 数（含 `moreOutputs` 溢出规则）
- viewed/scroll 位置恢复不得改变消息内容或顺序
- Apply code 成功后，被改文件必须出现在 Review 面板的变更集里（UI 间一致性）

### 负向场景
- 历史加载失败 → `historyLoadFailed` + `retryHistoryLoad`，不白屏
- 单轮渲染抛错 → `turnRenderError` 只降级该轮，其余轮可交互
- 回放（session/load）为空 → 回落磁盘 transcript（现有行为保留并加断言）
- 超长消息（>1MB）、含 ANSI 转义、含 RTL 文本、含 mermaid 语法错误 → 各自有确定渲染，不卡死
- find 无结果 / 页面不可搜索 → `noResults` / `unavailable`
- 编辑上一条失败 → `editLastMessageFailed`，原消息保持不变
- fork 需要 git 仓库而不满足 → 明确提示（对齐 `forkThreadRequiresGitRepo`）
- 工具输出为二进制/超大 → 截断 + "查看完整输出"入口，不撑爆 DOM

### 并发 / 崩溃 / 恢复
- 两个 thread 同时 streaming：事件按 sessionId 路由，**零串台**（自动化断言：A 的文本不出现在 B）
- streaming 中切 tab / 折叠 / 搜索 / 打开 detached window → 流不中断、滚动位置与吸底行为正确
- streaming 中 kill agent → `reconnectingToCodex`；重连后该轮以 `failed` 或续传结束，不留永久 working
- app 重启 → 折叠态/书签/滚动位置/find 查询恢复；transcript 从 `session/load` 或磁盘恢复且不重复
- 1000 轮 × 每轮 20 items 的长会话：首屏 <500ms、滚动 60fps、内存有界（虚拟化生效断言）
- 快速连点 Apply / revert / fork → 操作串行化，无重复副作用

### 外部副作用检查
- Apply code 写文件：路径必须落在会话 cwd / worktree 内；穿越（`../`、符号链接）被拒；写前可预览 diff
- reactions / 书签 / 折叠态只写 localStorage 或 agent 侧，不修改项目文件
- markdown 渲染必须 sanitize（不得执行内联 HTML/脚本）；mermaid 渲染在沙箱化 SVG 范围内
- 复制按钮写剪贴板不得包含密钥
- `x.ai/fs/*` 调用受 ISS-087 的目录约束

### Parity 勾选项
- [ ] F1 虚拟化 + fade；F2 turn entries 按轮聚合 + 折叠
- [ ] F3 导航栏（书签 + 输出类型 + 溢出）；F4 find bar（8 条）
- [ ] F5 用户消息 showMore/showLess/implementPlan；F6 code Apply 真落地（死事件清零）
- [ ] F7 MCP 工具卡（75 条）；F8 消息内 diff/patch 卡
- [ ] F10 轮内聚合区块（sources/outputs/createdTasks/environment/git/plan/usage/backgroundTasks/backgroundTerminals/sideChats）
- [ ] F11 后台终端区块；F13 reactions + EmojiPicker 接线；F14 错误/重试/重连文案
- [ ] F15 编辑上一条 + 从旧轮 fork（rewind）；F16 自动审批复核 + 被拒计数；F17 markdown 68 条
