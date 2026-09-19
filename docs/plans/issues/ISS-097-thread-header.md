> Epic: #128 (ISS-069) · 批次: B4 · 标签: `parity-slice` `conversation` `app-shell` `priority/P1` `frontend`
> 规格来源: 差距文档 §D(D1–D10)；实物模块 `thread-overflow-menu` `thread-pin-shortcut-bridge` `delete-thread-dialog` `codex-thread-report-dialog`；文案 `threadHeader.*`(41) `threadPage.*`(38) `codex.archiveInfo.*`(2)

## 目标

复刻 thread header 的全部会话操作：continue / fork（三态）/ copy（三态）/ archive（差异化确认）/ open in new window / side chat / new chat in worktree / rename / pin / 环境徽标 / 项目 setup coachmark / context bar。

## 范围

1. **溢出菜单**（`thread-overflow-menu` 实物项）：`pin-thread`/`unpin-thread`、`rename-thread`、`archive-thread`、`open-side-chat`、`copy-conversation-markdown`、`copy-deeplink`、`copy-working-directory`
2. **Continue in**（`threadHeader.continueActions`）：`continueIntoLocal`(new chat) / `continueIntoSameWorktree` / `continueIntoWorktree`(new worktree)
3. **Fork**（`threadHeader.forkActions`）：`forkIntoLocal` / `forkIntoSameWorktree` / `forkIntoWorktree` + `forkThreadPending` / `forkThreadError` / `forkThreadRequiresGitRepo` / `forkPendingWorktreeTitle` / `forkPendingWorktreePrompt`；真实 fork 走 `x.ai/session/fork`（替换现在"新建空会话"的假 fork）
4. **Copy**（`threadHeader.copyActions`）：`copyConversationMarkdown`(+Success/Error) / `copyAppLink`(deeplink，本地 URL scheme 由 ISS-104 注册) / `copyWorkingDirectory`(+Success)
5. **Archive 差异化确认**：`archiveConfirm{Title,Subtitle,Cancel,Confirm}`、运行中 `archiveConfirmRunning{Title,Subtitle,Confirm}`、绑定定时任务 `archiveConfirmHeartbeat{Title,SubtitleNamed,SubtitleUnnamed,Confirm}`、`loadingScheduledTask` / `scheduledTaskUnavailable`；归档后 `codex.archiveInfo.{archived,viewLink,undoLink}`
6. **窗口/会话操作**：`openInNewWindow`（依赖 ISS-091 detached window）、`openSideChat`(+`openSideChatError`)、`newChatInWorktree`(+`description`)
7. **删除**：`delete-thread-dialog`（永久删除，走 `x.ai/session/delete`）
8. **环境徽标 / 远程状态**：`threadPage.remoteConnectionStatusBadge.*` 只做 **local agent 连接态**（connected/connecting/disconnected/error/goToSettings）；`installCodex`/`login` 部分由 ISS-103 的 auth 接线
9. **项目 setup coachmark**：`threadPage.environment.setupCoachmark.{title,description,dismiss}`（"Set up this project once / Reuse setup and Run/Test actions across tasks"），联动 ISS-099 的本地环境与 `workspace.environmentAction1-9`
10. **Context bar**：thread 顶部紧凑显示 model + effort + token 用量 + 权限档位 + 运行位置（iss-003 目标；iss-064 曾删除，本 issue 以 header 内紧凑形式恢复，不恢复常驻 StatusBar）
11. **报告/反馈**：`codex-thread-report-dialog` → `x.ai/feedback`（本地可提交部分；云端上传 OUT）
12. `thread-pin-shortcut-bridge`：pin 专属快捷键桥接（命令注册见 ISS-089）

## 非目标

- 云端 fork / cloud worktree / 远程主机（OUT）
- 分享会话到服务（OUT）；deeplink 仅本地 scheme
- `threadHeader` 中的企业 policy 提示（OUT）
- 不恢复常驻 StatusBar（iss-064 的这条保留，只恢复 header 内紧凑 context bar）

## 依赖

- ISS-091（detached window、tab 右键菜单共用动作）
- ISS-095（turn/thread 状态 → archive 运行中确认、fork 需要轮信息）
- ISS-087（`x.ai/session/{fork,rename,delete}`、`x.ai/scheduler/*` 查绑定任务、`x.ai/feedback`）
- ISS-099（worktree fork / new chat in worktree / 环境 setup）
- ISS-104（deeplink scheme 注册，copy deeplink 才有意义）—— 可先复制占位 URL，scheme 由 088 点亮

## 回滚

菜单项逐个 flag；回滚 = 恢复现有 `TitleBar.tsx`（121 行）与 `ThreadTree` 的右键菜单。fork/archive/delete 均走 agent，回滚不产生本地孤儿状态；已归档会话可通过归档区恢复（ISS-096）。

## 验收标准

### 状态机不变量
- fork 后：新 thread 独立 sessionId，源 thread 状态不变；`forkThreadPending` 期间菜单禁用，结束后恰好多一个 thread（不多不少）
- archive 后：thread 从活跃分区消失、出现在归档区；若绑定定时任务，该任务同时被移除（实物语义）且 undo 可恢复两者
- rename 后：侧栏、tab 标题、agent 侧（`x.ai/session/rename`）、窗口标题四处一致
- copy markdown 的内容 == 当前 transcript 的确定序列化（含轮次顺序、代码块语言、diff 块）
- context bar 显示的 model/effort/权限档位 == agent 侧真值（读 `x.ai/sessionConfig`）
- 运行中 archive ⟹ 必须先停止（`archiveConfirmRunning`）；不得出现"已归档但仍在 streaming"

### 负向场景
- fork 在非 git 目录选 "in new worktree" → `forkThreadRequiresGitRepo`，不创建半成品 worktree
- fork 失败（agent 报错）→ `forkThreadError`，无新 thread 残留
- copy markdown 序列化失败 → `copyConversationMarkdownError`，剪贴板不被清空
- archive 时定时任务查询失败 → `scheduledTaskUnavailable`，仍可归档但明确告知
- deeplink scheme 未注册（088 未完成）→ 复制的链接有明确说明或禁用该项，不复制无效链接
- side chat 打开失败 → `openSideChatError`
- 会话已被外部（TUI）删除 → header 操作给出"会话不存在"并可关闭 tab

### 并发 / 崩溃 / 恢复
- fork 进行中再点 fork / 关闭 tab / 切换 thread → 操作串行或明确拒绝，无重复 fork
- archive 进行中 kill agent → 归档要么完成要么回滚，不出现"半归档"（活跃区与归档区都没有）
- 两个窗口对同一 thread 同时 rename → 最终一致，最后写入胜出且有事件通知
- app 重启 → pin/rename/archive 状态从 agent 侧恢复（不依赖仅本地存储）
- streaming 中执行 copy markdown → 内容一致性有确定语义（截止到当前已收到的 items）

### 外部副作用检查
- **delete 是永久破坏性操作**：二次确认 + 走 agent + 审计日志；不得直接删目录
- archive 移除定时任务属跨资源副作用：必须在同一操作中报告两者结果
- copy working directory 写剪贴板的是路径（可能敏感）→ 仅在用户显式点击时写入
- feedback 提交不得携带 transcript 全文或密钥（明确 payload 白名单）
- 不修改项目文件、不执行 git 写操作（fork worktree 除外，且经 agent）

### Parity 勾选项
- [ ] D1 continue 三态；D2 fork 三态（真 fork）；D3 copy 三态
- [ ] D4 archive 差异化确认（含 heartbeat / running）+ archiveInfo undo
- [ ] D5 open in new window / side chat / new chat in worktree
- [ ] D6 rename 四处一致；D7 pin + 快捷键桥；D8 local 连接态徽标
- [ ] D9 setup coachmark；D10 context bar（model/effort/token/权限/运行位置）
- [ ] `threadHeader.*` 41 条 + `threadPage.*` IN 部分全覆盖
