> Epic: #128 (ISS-069) · 批次: B4 · 标签: `parity-slice` `app-shell` `conversation` `priority/P1` `frontend`
> 规格来源: 差距文档 §C(C1–C11)；实物模块 `sidebar-panel` `sidebar-customization` `sidebar-onboarding-checklist.electron` `sidebar-{projects,tasks,plugins,search,new-chat,more,library,images}-icon`；文案 `sidebarElectron.*`(285) `codex.localTaskRow.*`(9) `codex.sidebarBulkContextMenu.*`(3) `appUndo.*`(15) `sidebar.*`(50)

## 目标

侧栏从"pinned + 按 cwd 分组 + archive（localStorage）"升级为 Codex 的完整信息架构：priority threads、自定义分区、排序/分组菜单、项目 hover card、批量操作、全局 undo、丰富行内状态、归档区管理、稳定 worktree 入口、onboarding checklist。

## 范围

1. **分区**（顺序对齐实物）：Priority threads(36 条文案) / Pinned / Projects（本地文件夹 → 展开 threads）/ Chats（无项目线程，对应 AD-7 的 Chat 模式）/ Scheduled task folders / Archived(27 条) / Custom sections(16 条)
2. **排序 & 分组菜单**：`chatsSortMenu.title`（Sort chats by …）、`groupByMenu`、`sortMenu`(5 条)
3. **项目 hover card**（13 条）：`activeCount`/`waitingCount`/`unreadCount`/`chatCount`、`editProject`(+`editProjectActionLabel`/`projectNameAriaLabel`/`renameError`)、`pinProject`/`unpinProject`、`openSource`、`manageConnectionForHost`（本地：打开目录）、`statusSeparator`
4. **批量操作**：多选 → `codex.sidebarBulkContextMenu.{pinChats,unpinChats,archiveChats}`、`archiveSelectedThreads`(6 条)、`archiveProjectThreads`(13 条)、`archiveCustomSectionChats`
5. **全局 Undo**：`appUndo.*` 15 条（`actionUndone`/`chatRenamed`/`chatPinned`/`chatUnpinned`/`projectRenamed`/`projectPinned`/`projectUnpinned`/`projectRestored`/`bulkArchiveRestored`/`sidebarItemMoved`/`sidebarOrderChanged`/`sidebarSectionCreated`/`sidebarSectionDeleted`）+ `undoAppAction`(⌘Z)/`redoAppAction`
6. **行内状态**：`codex.localTaskRow.*` —— `awaitingApproval`/`needsInput`/`automation`(Scheduled task run)/`attachedHeartbeatAutomation`/`voiceChat`(OUT→不显示)/`systemError`/`snoozeInputTimeout`(Snooze)/`confirmArchiveTask`/`archiveTask` + `codex.taskRow.{title,unreadDescription}` + `codex.cloudTaskRow.*`(OUT)
7. **自定义分区**：`sidebarCustomization.*` 15 条（创建/重命名/删除/排序/移动项进出分区）
8. **归档区**：`archivedTasks.*` 27 条（列表/搜索/恢复/删除/空态）；归档走 agent（`x.ai/session/delete` 或归档语义），不再只是前端隐藏
9. **稳定 worktree 入口**：`createStableWorktree`(8 条) + `stable-worktree-status-dialog` + `worktreeGroupTooltip`
10. **用量/上下文告警**：`usageAlert.*` 22 条降级为 **context/token 告警**（无账单数据；OUT 部分不做）
11. **侧栏 onboarding checklist**：`sidebarOnboardingChecklist.*` 34 条（替换现有 5 步弹窗的一部分；与 ISS-103 协调）
12. **搜索入口**：`sidebar-search-icon` + `searchChats`(⌘K) → 会话内容搜索走 `x.ai/session/search`（替换现在只搜标题的 `GlobalSearch`）
13. **产品模式切换**：`productMode`(6 条) —— Chat/Work 分区可见性随 AD-7 模式变化
14. 删除死代码 `ProjectList.tsx`（或接线）

## 非目标

- 云端线程、cloud task row、remote project coachmark（`addRemoteProjectCoachmark` 4 条）、connection group（远程连接）—— OUT
- Luna reserve / internal alpha update banner / workspace agents route nav link（OUT 或另议）
- 侧栏图片/库/财务图标（`sidebar-images-icon`/`sidebar-library-icon`/`sidebar-finances-icon`）—— ChatGPT 平台功能，OUT

## 依赖

- ISS-087（`x.ai/session/{search,list,delete,rename}`、`x.ai/session_summaries/{session_list,workspace_list,workspace_list_recent}`、`x.ai/sessions/changed`、`x.ai/scheduled_task_*`）
- ISS-088（per-thread 状态 → 行内指示；undo 栈需要状态层支持）
- ISS-091（tab 与侧栏 pin 联动：`codex.tabs.contextMenu.pinToSidebar`）
- ISS-089（`archiveThread`⌘⇧A、`markThreadUnread`⌘⇧U、`togglePriorityFilter`⌘⌥U、`clearAllUnreads`⇧Esc、`undo/redo`）

## 回滚

侧栏是纯渲染层 + 状态；回滚 = 恢复 `ThreadTree.tsx` 现有版本（保留至本 issue 稳定）。localStorage 键（`gb-pinned-sessions`/`gb-archived-threads`/`gb-triage-read`）保持可读，新增键独立命名；分区/排序等新增用户数据在回滚后被忽略而非损坏。

## 验收标准

### 状态机不变量
- 一个 thread 恰好出现在一个分区（priority/pinned/project/chat/archived 互斥，优先级顺序确定）
- archived ⟹ 不出现在任何活跃分区；unarchive ⟹ 回到原分区（或确定的默认分区）
- pinned 集合与 priority 集合独立；`togglePriorityFilter` 开启时只显示 priority 项且计数一致
- unread 计数守恒：`clearAllUnreads` 后全部为 0；新事件只增加对应 thread 的 unread
- undo/redo 栈：每个可撤销动作产生一条逆操作；undo 后状态 == 动作前状态（逐字段断言）；redo 反之；栈深度有界
- 行内状态与 agent 真值一致：`awaitingApproval` ⟺ 该 session 有未决 permission 请求；`working` ⟺ `streaming[threadId]`
- 自定义分区删除 ⟹ 其内项回落到默认分区，不丢

### 负向场景
- 会话历史目录缺失/损坏、`summary.json` 字段缺失 → 该行降级显示（标题=未命名，时间=未知），不整栏失败
- 项目目录被删/无权限 → hover card 与展开给出错误态，`projectsError` 文案
- 搜索无结果 / 搜索后端失败 → 空态 + 重试
- 批量归档部分失败 → 报告成功/失败数，且 undo 只回滚成功项
- 重命名为空/超长/含非法字符 → 校验失败提示（`renameError`）
- 1000+ 会话时展开/折叠/搜索仍可用（虚拟化或分页）

### 并发 / 崩溃 / 恢复
- agent 推送 `x.ai/sessions/changed` 与用户正在拖拽/多选并发 → 不丢失用户选择，不产生重复行
- 侧栏操作（archive/pin/rename）与同一 thread 正在 streaming 并发 → 状态指示不错乱，archive 需按实物语义确认（`archiveConfirmRunning*` 由 ISS-097 承担）
- app 重启 → 分区顺序、自定义分区、折叠态、pinned、排序/分组选择、priority 集合恢复
- undo 栈跨重启的策略明确（保留或清空，二者之一并测试）
- 主窗与 detached window 同时改侧栏状态 → 最终一致
- 快速连续拖拽排序（含中途取消）→ 顺序最终一致，无重复/丢失项

### 外部副作用检查
- archive/delete 是**破坏性**操作：删除必须走 agent 且二次确认；不得直接 `rm -rf` 会话目录（现 `session_delete_history` 需审计）
- rename/pin/分区写 agent 侧（`x.ai/session/rename`）而非仅本地，避免与 TUI 看到不同标题
- 不修改项目文件、不执行 git 命令
- hover card 的 "Open source" 只 `shell.openExternal`/`openPath` 白名单路径

### Parity 勾选项
- [ ] C1 分区全集；C2 排序/分组菜单；C3 hover card(13)；C4 批量(3+6+13)
- [ ] C5 undo(15)；C6 自定义分区(15)；C7 用量告警降级为 context 告警(22 中 IN 部分)
- [ ] C8 行内状态(9)；C9 稳定 worktree(8)；C10 归档区(27)；C11 onboarding checklist(34)
- [ ] `sidebarElectron.*` 285 条中 IN 部分全覆盖（OUT 项在 checklist 标注）
