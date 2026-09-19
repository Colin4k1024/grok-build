# Codex 桌面端 1:1 复刻 — 差距梳理（v2，基于实物逆向）

> 生成日期：2026-09-18
> 对标物：**ChatGPT.app 26.915.31029**（本机 `/Applications/ChatGPT.app`，内含 Codex 桌面端全部渲染层代码）
> 现状物：本仓库 `electron/` + `src/`（Electron 主进程 + React 渲染层，通过 ACP/stdio 驱动 `xai-grok-pager agent stdio`）
> 取代：`ISSUES.md`（v1，2026-09-17 凭 CSS 类名推测的清单，其中大量条目已实现或判断有误）

---

## 0. 结论摘要

三条结论，按重要性排序：

**① 最大差距不在 UI，在协议层。** agent 侧暴露了 **294 个 `x.ai/*` ACP 扩展方法**（git/hunk-tracker/terminal-pty/subagent/review/rewind/scheduler/marketplace/skills/mcp/queue/search/code-nav/pr/auth/usage…），Electron 客户端只用了 **3 个**（`x.ai/ask_user_question`、`x.ai/session/update`、`x.ai/session_notification`）+ 9 个标准 ACP 方法。所有"高级能力"目前都靠主进程 `execFile('git', …)` / `localStorage` 绕过 agent 自己造，因此天然只能做到形似。

**② 相当一部分"已完成"的 UI 是桩或死代码。** 实测：`ComposerEditor`(ProseMirror)、`MentionComplete`、`EditorTabs`、`ActivityBar`、`StatusBar`、`EmojiPicker`、`ProjectList` 共 7 个组件**零引用**；`check_auth_status`/`login` 硬编码 `{authenticated:true,username:"dev"}`；`open_session_window`、`updater_check` 返回 `ok(null)`；CodeBlock 的 Apply 按钮派发的 `grok:apply-code` 事件**无任何监听者**；Automations 是 localStorage cron 而非 agent scheduler；Subagent 靠"工具名包含 task"猜；ThreadSummary 无后端。

**③ App Shell 的骨架方向与 Codex 不一致。** Codex 桌面端是"**多 tab 工作台**"（tab strip 可拖出独立窗口 / pin / bottom panel / side panel 多 tab / hotkey window），本项目在 iss-058 主动删掉了 tab bar 改成"侧栏即切换器"。要 1:1 复刻必须把这个决策翻回来。

Codex 桌面端渲染层实测规模：**5,295 个独立 JS 模块**，其中 458 个是功能命名模块；从 33 个核心模块（43 个 bundle）中抽出 **4,622 条唯一 i18n 文案 id**（`codex.*` 799、`settings.*` 442、`sidebarElectron.*` 285、`composer.*` 239…）。本项目渲染层为 **74 个文件 / 12,760 行**。这是数量级的差距，不是"补几个组件"能收敛的。

---

## 1. 证据来源与复现方法

逆向脚本已落到仓库：[`scripts/codex-ref/`](../../scripts/codex-ref/README.md)（本轮全部数据由它产出，可随时重跑）：

```bash
node scripts/codex-ref/index.mjs                      # 解析 asar 头 → /tmp/codex-ref/index.json
node scripts/codex-ref/get.mjs --list 'thread|composer'  # 列模块
node scripts/codex-ref/get.mjs app-initial app-shared local-conversation-thread \
  thread-side-panel-tab-content composer-utility-bar … # 抽取 bundle → /tmp/codex-ref/out
node scripts/codex-ref/i18n.mjs --summary             # 命名空间直方图 → i18n.tsv
node scripts/codex-ref/i18n.mjs --ns composer         # 按命名空间查看规格
```

i18n 抽取正则：``/id:`([^`]+)`(?:,defaultMessage:`((?:[^`\\]|\\.)*)`)?/g``

关键模块清单（Codex 桌面端的功能地图，全部来自 `/webview/assets/`）：

```
app shell      thread-app-shell-chrome, thread-tab-route-checkpoint, unrestored-thread-tab-route,
               tab-panel, control-panel, hotkey-window-home-page, hotkey-window-new-thread-page,
               hotkey-window-thread-page, detached-window.html, new-thread-panel-page
sidebar        sidebar-panel, sidebar-onboarding-checklist.electron, sidebar-customization,
               sidebar-{projects,tasks,plugins,images,library,search,new-chat,more}-icon
thread         local-conversation-thread (380KB, 主视图), local-conversation-thread-turn-entries,
               thread-scroll-layout, thread-virtualizer, thread-context, thread-panel-state,
               thread-right-panel-state, thread-overflow-menu, thread-usage-breakdown,
               thread-user-message-navigation-rail-app, thread-emoji, thread-pin-shortcut-bridge,
               codex-thread-report-dialog, delete-thread-dialog, latest-turn-preview
composer       composer-host, composer-state, composer-utility-bar, composer-overlay,
               composer-action-bar-run-location-dropdown, composer-project-picker-content,
               composer-work-home-plugins-control, composer-banners, composer-tip,
               home-composer-mode-toggle, primary-composer-at-mention-list, right-panel-composer-overlay
review/diff    thread-side-panel-tab-content (105KB), code-diff, diff-comment-card, diff-summary,
               diff-preview-content, file-diff, editor-diff-page, review-file-tree-pane,
               review-file-source-tab, review-diff-virtualizer-metrics, virtualized-file-diff-line-position,
               pull-request-code-review, pull-request-code-review-navigation, git-action-review-state,
               auto-review-approval-nudge, open-thread-pull-request-code-tab
terminal       terminal-panel, terminal-tab, background-terminal, xterm-output-panel,
               local-conversation-background-terminal-tab, terminal-workspace-warning-state
agents         workspace-agents-page, workspace-agent-detail-page, workspace-agent-landing,
               agent-menu, agent-settings, agent-activity-item, agent-activity-units,
               duplicate-agent, subagent-panel, subagent-row, chatgpt-subagents-panel,
               local-conversation-subagents-panel-tab
plugins        plugins-page, plugins-store-page, plugin-detail-page, plugin-installation-content,
               plugin-picker-menu-content, plugin-share-dialog, plugin-skill-preview,
               plugin-request-empty-state, use-plugin-installation, use-plugin-scheduled-tasks,
               mcp-extension-plugin, settings-plugin-selection
automations    automations-page, automation-dialog, automation-frequency-section,
               automation-delete-confirmation-dialog, automation-side-panel-tab,
               cloud-automation-detail-panel, appgen-automations-page
worktree       worktree-environment-dropdown, use-codex-worktrees, worktrees-settings-page,
               worktree-onboarding-banner-controller, worktree-onboarding-state,
               worktree-setup-auto-fix, stable-worktree-status-dialog
settings       settings-page, settings-layout, settings-command-menu-section-items,
               use-visible-settings-sections, _virtual_settings-search-documents,
               keyboard-shortcuts-dialog, keyboard-shortcuts-settings, permission-dropdown,
               permissions-mode-dropdown, create-permissions, hooks-settings, mcp-settings,
               skills-settings, git-settings, code-review-settings, local-environments-settings-page,
               cloud-environments-settings-page, remote-connections-settings, voice-settings…
onboarding     onboarding-page, onboarding-login-content, onboarding-interactive-tools,
               pending-onboarding, external-agent-config-import-flow, external-agent-import-setup,
               run-external-agent-import-command, codex-mobile-setup-flow
```

> ChatGPT.app 会自更新，规格会漂移：每轮对齐前重跑 `scripts/codex-ref/`，diff `i18n.tsv` 即可发现新增/改名的能力。

---

## 2. 差距矩阵

标记说明：✅ 已有且真实 · 🟡 有形无实（桩/假数据/绕过 agent） · ❌ 完全缺失 · 💀 死代码（写了没接）

### A. 协议 / 能力层（ACP bridge）— **P0，其它一切的地基**

| # | Codex 桌面端行为（证据） | 现状（证据） | 差距 | 依赖的 agent 扩展 |
|---|---|---|---|---|
| A1 | 客户端声明完整 capabilities（fs / terminal / mcp / hooks / hunkTracker / codeNavigation / gitHeadChanged / statusLine…） | `electron/acp-session.ts:255` 只声明 `fs:{read,write}`、`terminal:false` | ❌ 大量能力因未声明而被 agent 关闭 | `x.ai/capabilities` |
| A2 | Review 面板可逐 hunk revert/apply（`codex.review.revert.hunk.success`、`apply-review-section-changes`） | RightPanel 只能整文件看 diff | ❌ | `x.ai/hunk-tracker/{get-hunks,get-files,get-summary,hunk-action,file-action,all-action,turn-action}` |
| A3 | Git 状态/分支/提交/丢弃/stage 全走 agent（`codex.localConversation.gitSummary.*`） | `electron/main.ts:367-455` 自己 `execFile('git')` | 🟡 双实现、与 agent 视图不一致（agent 的 worktree/session head 看不见） | `x.ai/git/{status,diffs,files,branches,commit,stage,unstage,discard,stash,checkout,checkout_session_head,current_commit,serialize_changes,info,git_repo_root}` |
| A4 | 真实交互式终端（可输入、后台终端、多 tab） | `TerminalView.tsx:53` `disableStdin:true`，只回显 `run_command` 的一次性输出 | 🟡 只读回显 | `x.ai/terminal/{pty/create,pty/input,pty/resize,pty/load,create,output,list,background,kill,release,wait_for_exit}` |
| A5 | Subagents 面板显示真实子代理（`codex.localConversation.backgroundAgents.*`、`subagent-row`） | `useAcpSession.ts:8` 用"工具名包含 task/subagent/spawn"猜 | 🟡 假数据 | `x.ai/subagent/{list_running,get,message,cancel}` |
| A6 | Slash 命令来自 agent（含参数提示、动态命令） | `src/data/slashCommands.ts` 硬编码 19 条 | 🟡 会与 agent 实际命令漂移 | `x.ai/commands/list` |
| A7 | 技能列表/开关/来源（`skills.*` 100 条文案，`composer.skillMentionList.*`：built-in / project / plugin / local file / admin） | `skills_list` 扫 `~/.grok`+`~/.agents`+`~/.codex`+`~/.claude` 的 SKILL.md（`main.ts:476`） | 🟡 无开关、无来源分类、不走 agent | `x.ai/skills/{list,add,remove,toggle,config,reset,refresh-baseline}` |
| A8 | 插件市场（`plugins-store-page`、`plugin-detail-page`、安装进度、分享、定时任务） | `PluginManager.tsx` 是硬编码的 **MCP catalog**（12 条 npx 命令），不是插件 | 🟡 概念错位 | `x.ai/marketplace/{list,action}`、`x.ai/plugins/{list,action,reload,notify-updates}`、`x.ai/pluginDirs` |
| A9 | MCP：连接状态、工具开关、OAuth、elicit、资源浏览（`settings.mcp.*` 56 条、`mcp-server-elicitation-request-panel`、`codex.mcpTool.*` 75 条） | `electron/mcp-config.ts` 直接文本编辑 `~/.grok/config.toml` 的 `[mcp_servers.*]` | 🟡 改配置≠管连接；无状态/工具/授权 | `x.ai/mcp/{list,upsert,delete,toggle,toggle_tool,server_status,auth_status,auth_trigger,elicit,read_resource,setup,init_progress,tools_changed,servers_updated}` |
| A10 | 自动化/定时任务（`inbox.automations.*`、`automations-page`、云端任务、触发器订阅 `codex.triggers.*`） | `src/lib/automation.ts` localStorage + 前端 cron | 🟡 关掉 app 就不跑；与 agent 无关 | `x.ai/scheduler/*`、`x.ai/scheduled_task_{created,deleted,fired}`、`x.ai/schedulerRevision` |
| A11 | 登录/OAuth/订阅（`onboarding-login-content`、`threadPage.remoteConnectionStatusBadge.login`） | `main.ts:55-60` 硬编码 `authenticated:true, username:"dev"` | 🟡 完全没有认证 | `x.ai/auth/{get_url,submit_code,cancel,info,logout,check_subscription,getBearerToken}` |
| A12 | 用量/额度（`usageCenter.*` 36 条、`composer.mode.rateLimit.*`、`thread-usage-breakdown`） | 仅 `UsageUpdate` 的 token 进度条 | ❌ | `x.ai/session/usage`、`x.ai/usage`、`x.ai/limit`、`x.ai/billing` |
| A13 | Checkpoint / Rewind（回退到某轮） | 无 | ❌ | `x.ai/rewind/{points,execute}`、`x.ai/restore_code` |
| A14 | Fork / Rename / Delete / Search 会话（`threadHeader.fork*`、`sidebarElectron.*`） | Fork = 新建空会话（`App.tsx:handleForkSession` 不带上下文）；rename 只改本地 tab；无内容搜索 | 🟡 | `x.ai/session/{fork,rename,delete,search,list,info,state,import,repair,rehydrate}`、`x.ai/session_summaries/*` |
| A15 | 排队 / 插话 / 引导（`composer.queue`、`composer.steer`、`composer.submitInBackground`、`localConversation.threadHandoff`） | Tab 键入队（前端数组），TurnComplete 后再发 | 🟡 未用 agent 队列，无法 interject/编辑/重排 | `x.ai/queue/{changed,edit,remove,reorder,clear,interject,hold_edit,release_edit}`、`x.ai/interject` |
| A16 | Plan mode（`composer.togglePlanMode`、`codex.localConversation.plan.title`、`plan-side-panel`） | 无（只有 TodoPanel 显示 plan entries） | ❌ | `x.ai/toggle_plan_mode`、`x.ai/exit_plan_mode` |
| A17 | Diff review 请求（agent 主动推送待审 diff） | `notification.rs:501 DiffReview` 事件被 `acp-session.ts` 丢弃 | ❌ | `x.ai/review`、`x.ai/review/comment{,/delete}` + `SessionUpdate::DiffReview` |
| A18 | PR 状态/修复（`gitSummary.repair{Checks,Comments,MergeConflicts,Everything}`） | 无 | ❌ | `x.ai/pr/status` |
| A19 | 文件/内容搜索、@ 补全（`composer.addFiles`、`codex.localConversation.outputs.recentFiles`） | `git_ls_files`（仅 tracked 文件，一次性全量拉进前端 filter） | 🟡 大仓会卡；无内容搜索 | `x.ai/search/{content,fuzzy/open,fuzzy/change,fuzzy/close}`、`x.ai/fs/{list,read_file,index,index/delta}` |
| A20 | 代码导航（`file.goToDefinition`、`file.navigateBack/Forward`） | 无 | ❌ | `x.ai/code/{goto-definition,find-definitions,find-references,goto-references,status}` |
| A21 | Hooks 设置页（`hooks-settings{,-copy,-model,-route}`） | 无（只有 slash 命令） | ❌ | `x.ai/hooks/{list,action,event,run}` |
| A22 | 记忆（`settings.agent.memory`、`codex.command` 相关） | 无 UI | ❌ | `x.ai/memory/{flush,forget,rewrite}`、`x.ai/memoryMode` |
| A23 | 配置热更新 / 多会话广播（`settings-unsaved-changes-dialog`、`appServer.error.*`） | `onConfigChanged` 只刷 models | 🟡 | `x.ai/config_changed`、`x.ai/settings/update`、`x.ai/sessionConfig`、`x.ai/sessions/changed` |
| A24 | 文件夹信任（`trusted_folders`、`create-permissions`） | `TrustedFoldersManager` 读写本地文件，agent 不知情 | 🟡 | `x.ai/folderTrust`、`x.ai/folder_trust/request`、`x.ai/permissions/reset` |
| A25 | fs 反向请求真实实现（agent 让客户端读/写文件，用于"外部文件"编辑与审批展示） | `acp-session.ts:485-493` 两个 handler 都返回空内容 | 🟡 | `fs/read_text_file`、`fs/write_text_file` |
| A26 | 反馈 / 报告（`feedback.*` 25 条、`codex-thread-report-dialog`） | 无 | ❌ | `x.ai/feedback{,/dismiss,/upload-trace,/drafts/*}` |
| A27 | 公告 / 提示（`codex-home-announcements`、`composer-tip`） | 无 | ❌ | `x.ai/announcements/update`、`x.ai/suggest{,Prompt}` |
| A28 | 后台任务 / 云端（`codex.localConversation.createdTasks.*`、`composer.newTask.cloud/remote`） | 无 | ❌（本地优先，云端可判定为超范围） | `x.ai/task/{list,kill}`、`x.ai/task_backgrounded`、`x.ai/cloud/env/*` |

### B. App Shell / 窗口 — **P0**

| # | Codex 行为（证据） | 现状 | 差距 |
|---|---|---|---|
| B1 | Tab strip：多 tab、右键菜单（close / close others / close to the right / pin to sidebar）、拖拽重排、**拖出成新窗口**、拖回还原（`codex.tabs.contextMenu.*`、`appShell.tabs.drag*`、`appShell.tabs.restoreToTab`） | iss-058 删除 tab bar；`EditorTabs.tsx` 💀 零引用 | ❌ 需重建 tab 体系 |
| B2 | Detached window：独立会话窗口、置顶（Keep window on top）、Focus chat 回主窗（`appShell.detachedWindow.*`） | `open_session_window` → `ok(null)` 🟡；`App.tsx` 有 `?session=` 分支但无窗口创建、无 html 入口 | ❌ |
| B3 | Bottom panel（`appShell.header.bottomPanel`、`thread.bottomPanel.*`） | 无（只有右侧面板） | ❌ |
| B4 | Side panel：多 tab + 全屏展开（`codex.rightPanel.expandFullWidth/restoreWidth`、`thread.sidePanel.toggle/openTab/openNewTab`） | `RightPanel.tsx` 有 4 主 tab + 4 附加 tab，但无"新 tab/多实例"、无全屏、宽度固定 | 🟡 |
| B5 | Hotkey window（全局快捷键唤起的迷你输入窗：`hotkey-window-home-page` / `-new-thread-page` / `-thread-page`、命令 `hotkeyWindow`） | 无 `globalShortcut` 注册 | ❌ |
| B6 | Tray + 菜单（`chatgptTemplate.png` 模板图标、tray 通知） | `onTrayAction` 在渲染层监听，主进程**无 Tray** 💀 | ❌ |
| B7 | 原生菜单 / AppleScript（`native-menu-locales` 65 个、`scripting.sdef`） | 无 `Menu` | ❌（macOS 菜单栏缺失，⌘Q/⌘,等无原生入口） |
| B8 | 自动更新（`appUpdate.*` 15 条：下载百分比、安装确认、`appHeader.installUpdate`） | `updater_check` → `ok(null)` 🟡；`useUpdater` 空转 | ❌ |
| B9 | Deeplink（`open-in-codex`、`threadHeader.copyAppLink`、`plugin-mcp-app-deep-link-page`） | 无 protocol handler | ❌ |
| B10 | 窗口 chrome：`titleBarStyle:hiddenInset` + 交通灯让位 | ✅ `main.ts:651`、`Sidebar` 顶部 9px drag 区 | 基本对齐（Codex 用 `env(titlebar-area-*)`） |
| B11 | 单实例 / 崩溃恢复（`appServerCrash.*`：restart、review configuration、send feedback） | 无 `requestSingleInstanceLock`、无崩溃面板 | ❌ |
| B12 | 工作区布局步进（命令 `stepWorkspaceLayout`、`showWorkspaceTabView`、unified tab strip） | 无 | ❌ |

### C. 侧栏 & 会话管理 — **P1**

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| C1 | 分区：Priority threads(36 条文案) / Pinned / Projects / Chats / Archived(27) / Custom sections(16) / Scheduled task folders | `ThreadTree.tsx`：pinned + 按 cwd 分组 + archive（localStorage） | 🟡 无 priority、无自定义分区、无 scheduled 分组 |
| C2 | 排序 & 分组菜单（`sidebarElectron.chatsSortMenu.title`、`groupByMenu`） | 固定排序 | ❌ |
| C3 | 项目 hover card：active/waiting/unread 计数、edit/rename/pin、Open source、Manage connection（13 条） | 无 hover card | ❌ |
| C4 | 批量操作（多选 → pin/unpin/archive：`codex.sidebarBulkContextMenu.*`、`archiveSelectedThreads`） | 无多选 | ❌ |
| C5 | Undo 一切（`appUndo.*` 15 条：renamed/pinned/archived/sidebar moved/section deleted…） | 无 undo | ❌ |
| C6 | 侧栏自定义（`sidebarCustomization.*` 15 条：分区创建/删除/排序） | 无 | ❌ |
| C7 | 用量告警（`sidebarElectron.usageAlert.*` 22 条） | 无 | ❌ |
| C8 | 行内状态：Awaiting approval / Needs input / Unread / Working / Scheduled task run / Voice chat / System error / Snooze（`codex.localTaskRow.*`） | iss-062 有 running/waiting/idle 三点 | 🟡 状态维度不足，无 snooze |
| C9 | 稳定 worktree 创建入口（`createStableWorktree` 8 条、`stable-worktree-status-dialog`） | 无 | ❌ |
| C10 | 归档区管理（`archivedTasks.*` 27 条：恢复/删除/搜索） | archive 只是隐藏 | 🟡 |
| C11 | 侧栏 onboarding checklist（34 条） | `Onboarding.tsx` 是 5 步弹窗 | 🟡 |

### D. Thread Header / 会话操作 — **P1**

| # | Codex 行为（`threadHeader.*` 41 条 + `thread-overflow-menu`） | 现状 | 差距 |
|---|---|---|---|
| D1 | Continue in：new chat / same worktree / **new worktree** | 无 | ❌ |
| D2 | Fork：local / same worktree / new worktree（需 git repo，pending 态） | Fork = 空会话 🟡 | ❌ 真 fork 需 A14 |
| D3 | Copy：deeplink / as Markdown / working directory | 无 | ❌ |
| D4 | Archive（含 running 与 scheduled task 的差异化二次确认文案） | archive 直接隐藏 | 🟡 |
| D5 | Open in new window / New side chat / New chat in this worktree | 无（side chat 在 RightPanel 里有一个简化版） | 🟡 |
| D6 | Rename（inline，`appUndo.chatRenamed`） | ✅ ThreadTree inline rename（仅本地 tab） | 🟡 未同步 agent |
| D7 | Pin/Unpin（`thread-pin-shortcut-bridge`：有专属快捷键） | ✅ localStorage pin | 🟡 |
| D8 | 环境徽标 + 远程连接状态（`threadPage.remoteConnectionStatusBadge.*`：connected/connecting/disconnected/error/Install Codex CLI/Sign in） | 无 | ❌ |
| D9 | 项目 setup coachmark（`threadPage.environment.setupCoachmark.*`） | 无 | ❌ |
| D10 | Thread context bar（model + token 紧凑显示，iss-003 目标） | token 在 composer 里，header 只有标题 | 🟡 |

### E. Composer — **P0（体验核心）**

| # | Codex 行为（`composer.*` 239 条 + 12 个 composer 模块） | 现状（`PromptInput.tsx` 337 行 + textarea） | 差距 |
|---|---|---|---|
| E1 | **ProseMirror 富文本**：format toolbar（bold/italic/H1-3/text/有序无序列表/link + Apply）、rich link popover（edit/open/remove text&url） | 纯 `<textarea>`；`ComposerEditor.tsx`(328行) 💀 零引用 | ❌ 需接线 + 补 toolbar |
| E2 | @-mention 列表：文件/文件夹、技能（来源分类 built-in/project/plugin/local file/admin）、插件、Browser、Computer（`composer.pluginMention.*`、`composer.skillMentionList.*`） | `@` 只补 git tracked 文件名，`$` 只补技能名；无 pill 渲染、无来源分类；`MentionComplete.tsx` 💀 | 🟡 |
| E3 | Slash 命令**对话框**（`composer.slashCommands.dialog*`：可搜索、独立弹层） | 行内下拉 + 硬编码 19 条 | 🟡 |
| E4 | 代码块插入 + 语言选择器（`composer.codeBlock.*`：auto detect、搜索语言、plain text） | 无 | ❌ |
| E5 | 权限下拉 5 档：Ask for approval / Full access / **Approve for me（guardian）** / Custom(config.toml) / Managed（含 disabled by requirements.toml、enterprise policy 提示、Full Access 三段式风险确认弹窗：Files/Internet/Terminal + Cyber model 警告） | 3 档：full-access / ask / read-only（`ApprovalModeSelect`） | 🟡 缺 guardian、custom、managed 与风险确认流 |
| E6 | 运行位置下拉：This computer / Cloud / Remote / **Worktree**（`composer.newTask.*`：环境选择、创建环境、远程电脑列表、离线/禁用态） | `WorkModeSelect`：local / worktree | 🟡 |
| E7 | Worktree 环境下拉：Default environment / Work without environment / Set up project / Environment settings（`composer.worktreeEnvironment.*`） | 无 | ❌ |
| E8 | 模型选择 + reasoning effort **循环/增减**命令（`composer.cycleReasoningEffort`、`increase/decreaseReasoningEffort`、`openModelPicker`） | 有 model+effort 下拉，无键盘增减 | 🟡 |
| E9 | Plan mode / Fast mode 切换（`composer.togglePlanMode`、`toggleFastMode`） | 无 | ❌ |
| E10 | 语音：dictation（starting/transcribing/finishing/retry/abort）、voice mode、realtime voice（29 条）、全局听写（`globalDictationHold/Toggle`） | `useVoiceInput` 浏览器 SpeechRecognition + Ctrl+M hold | 🟡 无 realtime、无全局听写 |
| E11 | 附件：addFiles / addPhotos / **Appshot**（窗口截图，含首次启用说明"包含滚出屏幕的全部文本"） | 图片粘贴/拖拽（`useImagePaste`） | 🟡 无 appshot |
| E12 | Queue / Steer / Submit in background（`composer.queue`、`steer`、`submitInBackground`、`startOutcomeUnknown`） | Tab 入队（前端） | 🟡 需 A15 |
| E13 | Thread goal（`composer.threadGoal.*` + `thread-goal-side-panel-content`） | 无（agent 有 goal 概念，slash `/goal`） | ❌ |
| E14 | 用量/额度就地展示（`composer.mode.rateLimit.*`：分钟/小时/日/周/月/年、可用 reset 数、升级入口） | 无 | ❌ |
| E15 | 建议 & 提示（`composer.suggestionList.*`、`composer-tip`、`home-starter-prompts`、`home-task-suggestions`、ambient suggestions） | 无 | ❌ |
| E16 | Follow-up 位置选择（`composer.cloudFollowUp.*`：Cloud/Local） | 无 | ❌（超范围可判定） |
| E17 | 分支起点选择（`composer.remote.branch*`：local/remote 分支分组、current 标记） | `BranchSelect` 有分支下拉 | 🟡 |
| E18 | Home 模式切换 Chat / Work（`composer.home.modeToggle.*`） | iss-063 决定不做（"codex new-chat 语义无该切换"）— **与实物不符**，实物确有 Chat/Work 切换 | ❌ |
| E19 | 浮动 composer / 覆盖式 composer（`unified-floating-composer`、`right-panel-composer-overlay`、`thread.browser.options.showFloatingComposer`） | Home 有居中卡片；thread 内固定底部；无右面板覆盖 | 🟡 |

### F. 会话流渲染 — **P1**

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| F1 | 虚拟化长列表（`thread-virtualizer`）+ top/bottom fade（`thread-scroll-layout`） | `MessageList.tsx` 95 行，`react-window` 装了但只在别处用；无 fade | 🟡 长会话会卡 |
| F2 | Turn entries / agent activity units（`agent-activity-item`、`agent-activity-units`、`local-conversation-thread-turn-entries`）：每轮可折叠、含工具序列 | `ToolCallCard` 平铺，call 与 result 是**两条独立消息** | 🟡 结构不同，无法按轮折叠 |
| F3 | 用户消息导航栏（`thread-user-message-navigation-rail-app`：书签、跳转、输出缩略类型 file/image/commit/PR/web/app preview/review、`+N more`、audio visualizer） | `ThreadSearchRail.tsx` 136 行（简化版） | 🟡 |
| F4 | Thread 内查找（`codex.threadFindBar.*`：结果计数、上/下一个、不可用态） | 无 | ❌ |
| F5 | 用户消息展开/收起（`codex.userMessage.showMore/showLess`）、"Yes, implement this plan" 快捷回复 | 无 | ❌ |
| F6 | 代码块：Apply（真落地）、copy、语言标签、折叠 | Apply 派发 `grok:apply-code`，**无监听者** 💀 | 🟡 |
| F7 | MCP 工具调用卡片（`codex.mcpTool.*` 75 条） | ToolCallCard 通用渲染 | 🟡 |
| F8 | 消息内 diff / patch 卡片 + diff comment（`code-diff`、`diff-comment-card`、`use-conversation-diff-comments`、`use-code-diff-context-menu`） | `MessageItem` 里 ```diff 围栏 → react-diff-viewer | 🟡 无行级评论、无右键菜单 |
| F9 | Artifacts / 生成图片画廊 / 文档·幻灯片·表格·站点（`codex.writingBlock.*` 129 条、`artifact-*`、`generatedImageGallery`） | 无 | ❌（多为 ChatGPT 侧能力，需判定范围） |
| F10 | Sources / Outputs / Created tasks / Side chats / Environment summary / Git summary / Plan / Usage 等**轮内聚合区块**（`codex.localConversation.*` 107 条） | 无 | ❌ |
| F11 | 后台终端 & 后台进程区块（`backgroundTerminals.*`：stop all、clean error） | 无 | ❌ |
| F12 | 压缩标记 + 回滚（`CompactionMarker`） | ✅ 有组件与 rollback | 基本对齐 |
| F13 | Reactions / emoji（`thread-emoji`、`MessageReactions`） | 组件在，`EmojiPicker` 💀 零引用 | 🟡 |
| F14 | 错误/重试/重连（`localConversation.turnRenderError`、`retryHistoryLoad`、`reconnectingToCodex`、`historyLoadFailed`） | ErrorBoundary + error 条 | 🟡 |
| F15 | 编辑上一条消息 / 从旧轮 fork（`editLastMessageFailed`、`forkFromOlderTurnDialog` 7 条） | 无 | ❌ |
| F16 | 自动审批复核 / 被拒动作计数（`localConversation.automaticApprovalReview` 20 条、`deniedActionsCount/Tooltip`） | 无 | ❌ |
| F17 | Markdown 渲染细节（`markdown.*` 68 条） | react-markdown + gfm + highlight | 🟡 |

### G. Side Panel — **P0**

| Tab（Codex 实物） | 现状 | 差距 |
|---|---|---|
| Review（`thread.sidePanel.diffTab`）：源 = Last turn / This branch / Commit / Selected commit / Cloud / All repositories；staged 过滤；文件树 pane；虚拟化 diff；mark viewed/unviewed；revert file/hunk/section；copy git apply command；大 diff banner（上/下一文件）；find（load more）；git blame 开关；git-based review 开关 | `ReviewPanel`：all / last-turn 两档 + approve/revise 按钮 | ❌ 差距最大的单个面板（`codex.review.*` 99 条文案） |
| Terminal（`terminal-panel`、`terminal-tab`、`xterm-output-panel`、`terminal-workspace-warning-state`） | `TerminalView` 只读回显 | 🟡 需 A4 |
| Browser（`thread.sidePanel.browserTab*` 20 条：多 tab、权限状态、右键菜单、`cloud-browser-*`） | 无 | ❌（可判定超范围） |
| Sources（`chatgpt-sources-side-panel-tab`、`local-conversation-sources-side-panel-tab`） | Context tab（简化） | 🟡 |
| Subagents（`local-conversation-subagents-panel-tab`） | SubagentPanel（假数据） | 🟡 需 A5 |
| Plan（`plan-side-panel`） | TodoPanel | 🟡 |
| Automation（`automation-side-panel-tab`） | 无 | ❌ |
| MCP app（`thread-mcp-app-side-panel-tab`、`mcp-extension-thread-side-panel-tab`、`mcp-extension-side-panel-tab-frame`） | McpManager 只在设置里 | ❌ |
| Summary（`codex.summaryPanel.*`、`local-conversation-summary-panel-*`） | ThreadSummaryPanel（无后端） | 🟡 |
| Goal（`thread-goal-side-panel-content`） | 无 | ❌ |
| Image / Artifact / Entity（`image-side-panel`、`open-artifact-side-panel-tab`、`chatgpt-entity-side-panel-tab`） | 无 | ❌（范围待定） |
| 面板机制：多 tab 可新开/关闭/重命名、拖到底部成 bottom panel、全屏展开 | 固定 4+4 tab，单实例 | ❌ |

### H. Worktree & 环境 — **P1**

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| H1 | Worktree 全生命周期由 agent 管：create / create_from_worktree(_sync) / detach / remove / gc / salvage / resume_session / status / show / apply / clean-artifacts / db(rebuild,stats,path) | `git_worktree_{list,add,remove}` 走 execFile | 🟡 需 A3 |
| H2 | Worktree 设置页（`settings.worktrees.*` 40 条）：自动清理开关 + 二次确认、保留数量上限、创建前 fetch upstream、每 worktree 关联会话列表、"在此 worktree 新建 chat"、删除、刷新、空/错/加载态 | `WorktreeManager.tsx` 176 行：list/add/remove | 🟡 |
| H3 | Onboarding banner + auto-fix（`worktree-onboarding-banner-controller`、`worktree-setup-auto-fix`） | `WorktreeOnboardingBanner` 有 | 🟡 无 auto-fix |
| H4 | Worktree 恢复横幅（`worktreeRestoreBanner.*` 10 条） | 无 | ❌ |
| H5 | 本地环境（`local-environments-settings-page`、`projectSetup.*` 35 条：项目一次性 setup、Run/Test 动作复用） | 无 | ❌ |
| H6 | 云环境（`cloud-environments-settings-page`、`composer.newTask.cloudEnvironment`） | 无 | ❌（范围待定） |
| H7 | 会话在 local ↔ worktree ↔ host worktree 间迁移（`localConversation.moveToLocal/moveToWorktree/moveToHostWorktree` 26 条） | 无 | ❌ |

### I. Plugins / Skills — **P1**

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| I1 | 插件页 + 商店页 + 详情页 + 分区（`plugins-page`、`plugins-store-page`、`plugin-detail-page`、`plugins-page-section`） | `PluginManager` = MCP catalog | ❌ 概念错位（A8） |
| I2 | 安装流（`use-plugin-installation`：进度、权限确认、`plugin-installation-content` 87KB） | 无 | ❌ |
| I3 | 插件定时任务（`use-plugin-scheduled-tasks`） | 无 | ❌ |
| I4 | 插件分享 / 技能预览 / 已连接账号 / 禁用原因 / picker menu | 无 | ❌ |
| I5 | 技能设置页（`skills-settings`，`skills.*` 100 条） | 无独立技能页 | ❌ |
| I6 | MCP 设置页（`mcp-settings`，56 条） | `McpManager` 264 行（文本编辑） | 🟡 |

### J. Automations — **P2**

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| J1 | 定时任务：创建（手动 / 让 Codex 帮你建）、频率区、删除确认、草稿丢弃确认、详情面板、云端任务、空态建议（Daily brief / Follow-up monitor…） | `AutomationsPage` + localStorage cron | 🟡 需 A10 |
| J2 | 触发器订阅（`codex.triggers.*`：chat updates / PR updates / issue updates / page updates / data source updates / new email / messages and edits / compact resources） | 无 | ❌ |
| J3 | 会话与定时任务绑定（`threadHeader.archiveConfirmHeartbeat*`、`localTaskRow.attachedHeartbeatAutomation`、`heartbeatAutomation.nextRun`） | 无 | ❌ |

### K. Settings — **P1**

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| K1 | 导航分组：Personal / Coding / Integrations / Archived（`settings.nav.heading.*`）+ 折叠侧栏 + host 过滤（`clearHostFilter`） | 12 个扁平 tab | 🟡 |
| K2 | 完整页清单（实物）：general-settings、agent(Configuration)、skills、plugins、mcp、worktrees、local-environments、cloud-environments、git-settings、code-review、hooks、import、connections/remote、keyboard-shortcuts、notifications、appearance、personalization、pets、storage、data-controls(归档会话)、security、billing、time-management、trusted-contact、parental-controls、browser-use、computer-use、chronicle、appshots、analytics、debug、codex-micro、ads-controls | models / apikeys / mcp / plugins / worktrees / appearance / permissions / agent / trusted / voice / general / about | 🟡 缺 git、code review、hooks、import、notifications、keyboard、storage、data controls、environments |
| K3 | 设置搜索（`_virtual_settings-search-documents`：把每个设置项做成可搜索文档，命中后跳到具体行） | 只按 tab 名 + 关键词别名过滤 | 🟡 粒度差一级 |
| K4 | Agent(Configuration) 页（`settings.agent.*` 73 条）：approval policy / sandbox mode / network 开关（workspace-write 时）/ web search / model verbosity / reasoning summary / **配置作用域**（managed by admin policy、project=repoName、Open config.toml、只读源、写入失败提示、inline sandbox table 提示）+ Model features（可用 reasoning efforts 多选、Ultra 滑块）+ Codex dependencies（诊断/重装/取消下载/bundle 版本）+ 外部 agent 配置导入 | `AgentSettings.tsx` 110 行 | ❌ 差距很大 |
| K5 | 未保存更改对话框（`settings.unsavedChanges`）、行内编辑（`settings.editRow`）、加载行、disclosure 行 | 直接保存 | 🟡 |
| K6 | 快捷键对话框：分区（App/General/Navigation/Panels/Chat/Project/Skills/Configure）+ 搜索 + 空态 + 加载态 | `ShortcutCheatSheet` 63 行静态表 | 🟡 |

### L. 快捷键 & Command Palette — **P1**

> **已完整逆向命令注册表**：`node scripts/codex-ref/commands.mjs` → **127 个命令**，**7 个分组**（`thread` / `navigation` / `panels` / `app` / `configure` / `skills` / `workspace`，与快捷键对话框的 7 分区一一对应）+ 3 个 scope（`app` / `os-global` / `electron`）。注册表 schema：
> `{id, titleIntlId, descriptionIntlId, availableIn:[…], shortcutScope, commandMenuGroupKey, commandMenuFeature, electron:{defaultKeybindings:[{key}]}}`
>
> 补充两组（上表未列）：
> - `workspace`：`git.commit` / `git.createBranch` / `git.createPullRequest` / `git.createDraftPullRequest` / `git.mergePullRequest` / `git.openPullRequest` / `git.toggleBlame`、`openFolder`（⌘O）、`environmentAction1-9`（项目 setup 的 Run/Test 自定义动作，`environmentAction1`=⌘⇧D）
> - `skills`：`openSkills` / `forceReloadSkills`
> - `panels`（无默认键）：`toggleTerminal` / `toggleReviewTab` / `togglePinnedSummary` / `toggleMaximizeSidePanel`

**Codex 实物快捷键（IN 范围部分，可直接作为验收基准）**：

| 分组 | 命令 | 键位 |
|---|---|---|
| thread | `newTask` | ⌘⇧O / **⌘N** |
| thread | `temporaryChat` | ⌘⇧N |
| thread | `quickChat` | ⌘⌥N |
| thread | `newProjectlessTask` | ⌘⌥O |
| thread | `openSideChat` | ⌘⌥S |
| thread | `archiveThread` | ⌘⇧A |
| thread | `markThreadUnread` | ⌘⇧U |
| thread | `forkThread` / `copyConversationMarkdown` / `composer.{queue,steer,submit,clear,togglePlanMode,toggleFastMode,toggleWorktreeMode,cycleHost,cycleReasoningEffort}` | 无默认键（仅命令面板） |
| navigation | `searchChats` | **⌘K** |
| navigation | `findInThread` | ⌘F |
| navigation | `nextThread` / `previousThread` | ⌘⇧] / ⌘⇧[ （+ Ctrl+PageDown/Up、鼠标侧键） |
| navigation | `nextTab` / `previousTab` | 同上（unified tab strip 时合一） |
| navigation | `recentThread1-5` | ⌘⌥1-5 |
| navigation | `nextRecentThread` / `previousRecentThread` | Ctrl+Tab / Ctrl+⇧Tab |
| navigation | `nextThreadNeedingAttention` | ⌘⌥A |
| navigation | `togglePriorityFilter` | ⌘⌥U |
| navigation | `navigateBack` / `navigateForward` | ⌘[ / ⌘] |
| navigation | `file.goToDefinition` / `navigateBack` / `navigateForward` | Ctrl+] / Ctrl+- / Ctrl+⇧- |
| navigation | `focusMainChat` / `focusSideChat` / `goToLine` | 无默认键 |
| panels | `toggleSidebar` | ⌘⇧S / **⌘B** |
| panels | `toggleSidePanel` | ⌘⌥B |
| panels | `toggleBottomPanel` | **⌘J** |
| panels | `stepWorkspaceLayout` | ⌘⇧B |
| panels | `showWorkspaceTabView` | ⌘⇧F |
| panels | `openReviewTab` | Ctrl+⇧G |
| panels | `reopenClosedTab` | ⌘⇧T |
| panels | `toggleMaximizeSidePanel` | 无默认键 |
| app | `settings` | ⌘, |
| app | `undoAppAction` / `redoAppAction` | ⌘Z / ⌘⇧Z |
| app | `clearAllUnreads` | ⇧Esc |
| app | `showKeyboardShortcuts` | ⌘/ |
| app | `closeOtherTabs` | ⌘⌥W |
| app | `composer.addFiles` | ⌘U |
| app | `composer.openModelPicker` | Ctrl+⇧M |
| app | `composer.openProjectPicker` | ⌘⌥⇧O |
| app | `composer.startDictation` | Ctrl+⇧D |
| app | `composer.submitInBackground` | ⌘↵ |
| app | `approval.approve` / `approval.decline` | Enter / Esc |
| app | `openFolder` | ⌘O |
| app | `thread1-9` | ⌘1-9 |
| app | `feedback` / `logOut` / `manageTasks` / `openControlWindow` | 无默认键 |
| configure | `personalitySettings` | ⌘⇧I |
| configure | `keyboardShortcuts` / `mcpSettings` / `importExternalAgent` | 无默认键 |
| os-global | `hotkeyWindow` / `globalDictationHold` / `globalDictationToggle` / `openAvatarOverlay`(Alt+Space) | 系统级 |

**与现状的冲突/缺失**：

| 项 | 现状 | Codex | 结论 |
|---|---|---|---|
| ⌘N / ⌘⇧O 新会话 | ✅ 一致 | `newTask` | 保留 |
| ⌘B 侧栏 | ✅ 一致 | `toggleSidebar` 双绑 | 保留（补 ⌘⇧S） |
| ⌘O 项目 | ✅ 一致 | `openFolder` | 保留 |
| ⌘J 终端 | ✅ 一致 | `toggleBottomPanel` | 保留（语义改为底部面板，终端是其中一个 tab） |
| ⌘, 设置 / ⌘1-9 / ⌘⇧[⌘⇧] | ✅ 一致 | 同 | 保留 |
| **⌘G 搜索** | 全局搜索 | 无此绑定（`openReviewTab`=Ctrl+⇧G） | ❌ 改为 **⌘K** |
| **⌘K / ⌘⇧P 命令面板** | 命令面板 | `searchChats`=⌘K | ❌ 命令面板需让位给会话搜索，改绑 ⌘⇧P |
| **⌘T** | `CommandPalette.tsx:39` 标注为"新建会话" | `openBrowserTab`（范围外） | ❌ 错标，修正为 ⌘N/⌘⇧O |
| 其余 ≈30 个命令 | 无 | 见上表 | ❌ 全部缺失（archive/temporary/quick/projectless/side chat/unread/attention/priority filter/find in thread/reopen closed/layout step/workspace view/maximize panel/undo-redo/clear unreads/shortcuts dialog/composer 系列） |

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| L1 | 命令注册表（feature-flag 感知：`isAutomationsEnabled`/`isDictationEnabled`/`isHotkeyWindowEnabled`/`isUnifiedTabStripEnabled`/`modeSwitchAvailable`/`browserEnabled`/`fileLanguageFeaturesEnabled`/`allowDebugMenu`/`isPriorityFilterEnabled`/`isRealtimeVoiceCommandEnabled`），按 `commandMenuGroupKey` 分组，组内固定优先级：`newTask > temporaryChat > quickChat > archiveThread > newProjectlessTask > openSideChat`；`availableIn:['electron']` 区分桌面专有命令 | `CommandPalette` 7 个内置 + App 动态注入 | 🟡 无分组/优先级/flag 感知/availableIn |
| L2 | 127 个命令（上表） | 11 条 | ❌ 差 ≈116 条 |
| L3 | Command menu 附加区：Color themes（可搜索）、Recently viewed threads（`{title}, {position} of {count}` 播报） | 无 | ❌ |
| L4 | 快捷键对话框：7 分区（App/General/Navigation/Panels/Chat/Project/Skills/Configure）+ 搜索 + 空态/加载态 | `ShortcutCheatSheet` 63 行静态表 | 🟡 |
| L5 | 全局快捷键（`os-global` scope：hotkeyWindow、全局听写 hold/toggle、Alt+Space） | 无 | ❌ |

### M. Onboarding & Auth — **P1**

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| M1 | 多步 onboarding（`onboarding-page`、welcomeV2、login content、interactive tools、pending-onboarding、侧栏 checklist 34 条） | 5 步纯文案弹窗 | 🟡 |
| M2 | **外部 agent 配置导入**（`electron.onboarding.welcomeV2.externalAgentImport.*` 60+ 条）：检测 Claude Code / Claude Cowork / Cursor，可选项 = Projects / Recent chats / Plugins / Skills / Settings(settings.json→config.toml) / Instructions(CLAUDE.md→AGENTS.md, Cursor rules→AGENTS.md)，支持"保持同步"、后台导入、逐项预览 | 无 | ❌（本项目已有 `xai-grok-foreign-sessions` crate 可对接） |
| M3 | 真实登录（OAuth/设备码 + 订阅校验 + `auth-handoff-page`） | 桩（A11）；`AuthHandoff.tsx` 无 invoke 💀 | ❌ |
| M4 | 移动端配对（`codex-mobile-setup-flow/-dialog`、`codex-mobile-page`） | 无 | ❌（范围待定） |

### N. 其它桌面能力 — **P2**

| # | Codex 行为 | 现状 | 差距 |
|---|---|---|---|
| N1 | 通知：权限审批通知（`codex.notifications.permissionApproval.title`）、turn complete、声音（`codex-notification.wav`） | `notification_send` + `useNotifications` | 🟡 无声音/无分类 |
| N2 | Dock badge | ✅ `set_badge` | 对齐 |
| N3 | Trace recording（`traceRecording.*` 14 条、`toggleTraceRecording`） | 无 | ❌ |
| N4 | Chronicle / computer history（`chronicle-settings-page`、`chronicle-permissions-dialog`、`codex_chronicle` 二进制） | 无 | ❌（范围待定） |
| N5 | Computer use / Browser use / Remote connections / Pets / Codex Micro（硬件） | 无 | ❌（建议判定超范围） |
| N6 | Realtime voice（29 条） | 无 | ❌（范围待定） |
| N7 | 分享（`shareDialog.*` 13 条、`codex.sharedSnapshot.*` 31 条、`x.ai/share_session`） | 无 | ❌ |

---

## 3. 根因分析

**根因 1：桥接层是"最小可用"而非"能力对齐"。**
`electron/acp-session.ts` 624 行，只翻译了 9 个标准 ACP 方法 + 3 个扩展。而 agent 侧 `crates/codegen/xai-grok-shell/src/extensions/` 有 52 个扩展模块、294 个方法。**每缺一个方法，前端就得用 localStorage 或 execFile 造一个假的**，于是产生根因 2。

**根因 2：UI 先于能力落地，导致"形似神不似"。**
Automations/Subagents/Summary/Plugins/Permissions/Apply-code 六处均为前端自造。这类实现的问题是：与 agent 状态不一致、关 app 即失效、无法测试、且**挡住**了后续接真能力的路（接口已被假数据占位）。

**根因 3：App Shell 决策与 Codex 相反。**
iss-058（删 tab bar）、iss-064（删 status bar）、iss-063（Home 不做 Chat/Work 切换）三个决策都与实物不符。实物证据：`appShell.tabs.*` 22 条（含拖出窗口/pin/close others）、`codex.tabs.contextMenu.*` 6 条、`composer.home.modeToggle.{chat,work}` 明确存在。

**根因 4：无规格来源，靠猜。**
v1 的 `ISSUES.md` 用 CSS 类名推测功能，导致 56 条里既有已实现的（ISS-005/009/030/044/050…），也有判断错误的（ISS-018 说"codex 无 chat/agent 切换"）。本轮改为**从 asar 抽 i18n 文案 + 模块名**，规格可验证、可复现、可随 ChatGPT.app 升级重跑。

---

## 4. 建议路线（待确认后细化为实施计划）

| 阶段 | 目标 | 内容 | 前置 |
|---|---|---|---|
| **P0-a** | 桥接层能力对齐 | 建 `electron/agent-client.ts`：统一 `x.ai/*` 请求/通知封装 + capabilities 声明 + 反向请求（fs/terminal/hooks/mcp sdk_call）。首批接：`commands/list`、`skills/*`、`git/*`、`hunk-tracker/*`、`terminal/pty/*`、`subagent/*`、`session/{fork,rename,delete,search}`、`queue/*`、`auth/*` | 无 |
| **P0-b** | 拆掉假实现 | Automations→scheduler、Subagents→subagent/*、Slash→commands/list、Plugins→marketplace+plugins、Apply-code→fs/write+hunk-tracker、Login→auth/* | P0-a |
| **P0-c** | App Shell 翻案 | 恢复 tab strip（拖出/pin/右键菜单/拖拽重排）、detached window、bottom panel、side panel 多 tab + 全屏、tray、原生菜单、单实例、deeplink | 无（可与 P0-a 并行） |
| **P1-a** | Composer 复刻 | 接线 ProseMirror（E1）+ format toolbar + rich link、mention pill 与来源分类、slash 对话框、代码块+语言选择、5 档权限（含 Full Access 风险确认）、运行位置/worktree 环境、plan/fast mode、queue/steer/background | P0-a |
| **P1-b** | Review 面板复刻 | 源切换（last turn/branch/commit/cloud）、文件树、虚拟化 diff、viewed 标记、file/hunk/section revert、copy git apply、大 diff banner、find、diff comments、PR 状态与 repair | P0-a（hunk-tracker/git/review/pr） |
| **P1-c** | Thread 视图复刻 | turn entries 按轮聚合 + 折叠、虚拟化、导航栏（书签/输出类型）、find bar、user message 展开、编辑上条 / 从旧轮 fork、自动审批复核、轮内聚合区块（sources/outputs/tasks/environment/git/plan/usage） | P0-a/b |
| **P1-d** | 侧栏 & Header | priority/自定义分区/排序分组/hover card/批量/undo/用量告警/行内状态扩展；header 的 continue/fork/copy/archive/open-in-window/side chat/环境徽标 | P0-a |
| **P2** | Settings & 快捷键 & Onboarding | 设置分组 + 页补齐（git/code review/hooks/import/notifications/keyboard/storage/data controls/environments）+ 设置项级搜索 + Agent(Configuration) 页；命令注册表（分组优先级 + flag 感知）+ 快捷键对话框分区搜索；多步 onboarding + 外部 agent 导入 | P0/P1 |
| **P3** | 增强 & 范围外评估 | 通知声音/分类、trace recording、分享、rewind UI、artifacts/图片画廊、realtime voice、browser/computer use、chronicle、pets、codex-micro | 需先做范围判定 |

**范围判定**：已确认采用方案 A，逐条判定见 §6。

---

## 5. 待确认问题

1. ~~**范围边界**~~ → **已确认：方案 A**（本地开发者工作流 100% 复刻，云端/硬件/平台能力不做），逐条判定见 §6。
2. **粘贴内容缺失** — `[Pasted text #2 +15 lines]` 仍未收到，请重贴（很可能是验收标准/优先级约束）。
3. ~~**App Shell 翻案**~~ → **已确认：全部翻案**。恢复 tab strip（拖出独立窗口 / pin / 右键菜单 / 拖拽重排）+ bottom panel + Home Chat/Work 切换。iss-058/063/064 三个决策作废；具体实现见 §7.2（Chat/Work 语义）与 §7.3（布局状态机）。
4. **运行时** — `src-tauri/` 与 Electron 双壳并存。复刻只针对 Electron（`package.json` main 已指向 `dist-electron/main.cjs`），Tauri 侧是否可以直接删？
5. **验收方式** — 是否接受"以 ChatGPT.app 抽取出的 i18n 文案 id + 模块清单"作为逐条验收依据（我可以生成一份可勾选的 parity checklist，每条附实物证据）？

---

## 6. 范围决议（Scope A，2026-09-18 确认）

**原则**：本地开发者工作流 100% 复刻；依赖 ChatGPT 平台/云端/硬件的能力**不做也不占位**（不留假入口，避免 v1 那种"形似神不似"）。
判定依据：该能力是否能仅靠 **本机 agent（`xai-grok-pager`）+ 本机 git/fs/pty + 本地配置** 完整实现。

### 6.1 IN — 必须 1:1 复刻

| 域 | 范围 |
|---|---|
| A 协议层 | A1–A27 全部（capabilities、hunk-tracker、git、terminal pty、subagent、commands/list、skills、marketplace/plugins、mcp 管理、scheduler、auth、usage(token 维度)、rewind、session fork/rename/delete/search、queue/interject、plan mode、DiffReview、pr/status、search/fs、code-nav、hooks、memory、config 热更新、folderTrust、fs 反向请求、feedback、announcements）。**A28 除外**（云端/远程任务） |
| B App Shell | B1 tab strip（拖出/pin/右键/重排）、B2 detached window（置顶/Focus chat）、B3 bottom panel、B4 side panel 多 tab+全屏、B5 hotkey window、B6 tray、B7 原生菜单、B8 自动更新、B9 本地 deeplink、B10 chrome、B11 单实例+崩溃恢复、B12 布局步进 |
| C 侧栏 | C1–C11 全部（priority/pinned/projects/archived/custom sections、排序分组、hover card、批量、undo、行内状态、stable worktree、归档区、onboarding checklist）。C7 用量告警降级为 **context/token 告警**（无账单数据） |
| D Thread Header | D1–D10 全部（continue/fork 三态、copy deeplink+markdown+cwd、archive 差异化确认、open in new window、side chat、new chat in worktree、rename 同步 agent、pin、环境徽标、setup coachmark、context bar）。D8 只做 **local agent 连接态**，不做远程 |
| E Composer | E1–E15、E17–E19 全部（ProseMirror+格式工具条+rich link、mention pill 与来源分类、slash 对话框、代码块+语言选择、权限档位、运行位置=本机/worktree、worktree 环境、model+effort 增减、plan/fast mode、本地听写、文件/图片附件、queue/steer/background、thread goal、建议与提示、分支起点、Home Chat/Work 切换、浮动+覆盖式 composer）。**E16 除外**（cloud follow-up） |
| F 会话流 | F1–F8、F10–F15、F17（虚拟化+fade、turn entries 按轮聚合、导航栏+书签、find bar、用户消息展开、code apply 真落地、MCP 工具卡、diff/patch 卡+行级评论、轮内聚合区块 sources/outputs/tasks/env/git/plan/usage、后台终端、压缩标记+回滚、编辑上条/从旧轮 fork、自动审批复核+被拒计数、markdown、**mermaid**——仓库已 vendor Mermaid 栈）。**F9 除外**（artifacts/文档幻灯片/生成图画廊） |
| G Side Panel | Review（全量，含 hunk revert / diff comments / PR）、Terminal（真 pty + 后台终端）、Sources、Subagents、Plan、Automation、MCP、Summary、Goal + 面板机制（多 tab/新开/关闭/重命名/拖到底部/全屏）。**Browser、Artifact、Entity tab 除外**；Image tab 降级为本地图片预览 |
| H Worktree | H1–H5、H7（agent 管全生命周期、设置页 40 条文案对齐、onboarding+auto-fix、恢复横幅、本地环境/项目 setup、local↔worktree↔host worktree 迁移）。**H6 除外**（云环境） |
| I Plugins/Skills | I1–I6 全部（插件页/商店页/详情页/分区、安装流+进度+权限确认、插件定时任务、分享=本地导出、技能预览、禁用原因、picker menu、skills 设置页、mcp 设置页含 OAuth/elicit/资源浏览） |
| J Automations | J1、J3（本地 scheduler：创建/频率/删除确认/草稿丢弃/详情面板/空态建议/与会话绑定）。**J2 触发器订阅除外**（依赖 connector 平台）；云端定时任务除外 |
| K Settings | K1–K6（分组导航 Personal/Coding/Integrations、折叠、页补齐：general/agent(Configuration)/skills/plugins/mcp/worktrees/local-environments/git/code-review/hooks/import/notifications/keyboard/appearance/storage/data-controls(归档)/sandbox-security、**设置项级搜索**、未保存对话框、行内编辑、快捷键对话框分区+搜索+空/加载态）。Agent 页含：approval/sandbox/network/web search/verbosity/reasoning summary/**配置作用域**（project vs user vs 只读源、Open config.toml、写失败提示）、Model features、agent 依赖诊断/重装、**外部 agent 配置导入** |
| L 快捷键/Palette | L1–L5（命令注册表 + 分组优先级 `newTask>temporaryChat>quickChat>archiveThread>newProjectlessTask>openSideChat` + flag 感知、命令 id 对齐、color themes / recently viewed 附加区、修 ⌘T 标注错误、全局快捷键） |
| M Onboarding/Auth | M1、M2、M3（多步 onboarding + 侧栏 checklist、**外部 agent 导入**（Claude Code/Cursor → AGENTS.md/config.toml/skills/plugins/projects/chats，可对接已有 `xai-grok-foreign-sessions` crate）、真实登录 `x.ai/auth/*`）。**M4 除外**（移动端配对） |
| N 其它 | N1 通知（分类+声音）、N2 dock badge、N3 trace recording、N7 本地导出（Markdown / 会话快照文件）。**N4/N5/N6 除外** |

### 6.2 OUT — 不做、不占位

| 能力 | 实物证据 | 判定理由 |
|---|---|---|
| Cloud tasks / cloud environments / cloud browser / cloud automation | `composer.newTask.cloud*`、`cloud-environments-settings-page`、`cloud-browser-*`、`restricted.cloudV2` | 需 OpenAI 云端执行面 |
| Remote computers / remote connections / 远程 Codex CLI 安装 | `composer.newTask.remote*`、`remote-connections-settings`、`threadPage.remoteConnectionStatusBadge.installCodex` | 需远程主机编排 |
| Browser use / Computer use / Chronicle（computer history） | `browser-use-settings`、`computer-use-settings`、`chronicle-*`、`cua_node` 二进制 | 平台/系统级代理能力，agent 无对应 |
| Artifacts：文档/幻灯片/表格/站点、生成图画廊、Canvas、image playground | `codex.writingBlock.*`(129)、`artifact-*`、`generatedImageGallery` | ChatGPT 创作侧能力 |
| Realtime voice / voice chat / voice session | `realtimeVoice.*`(29)、`voice-session` | 需实时语音服务（本地听写仍 IN） |
| Pets / Codex Micro / mini-games / joystick | `pets-settings-route`、`codex-micro-*`、`codex-pet-assets` | 硬件与娱乐外设 |
| Billing / Usage center / rate limit / upgrade / referral / premium / auto-topup | `usageCenter.*`(36)、`composer.mode.rateLimit.*`、`codex.referralInviteModal.*`(49) | 无账单体系 |
| 企业 policy：managed / admin / restricted / requirements.toml | `composer.permissionsDropdown.managed.*`、`restricted.*`(28)、`settings.agent.configuration.*.managed` | 无企业控制面（权限档位保留 ask/full/guardian/custom 四档） |
| 消费者设置页：parental controls / trusted contact / time management / ads / analytics / personalization / profile-account | `settings.nav.*` 对应条目 | ChatGPT 账号体系 |
| Connector 触发器订阅（email / calendar / page / data source / issue 更新） | `codex.triggers.*`(11) | 需 connector 平台（PR/issue 更新可由 git+MCP 本地近似，不在本轮） |
| 分享快照 / deeplink 分享到服务 / 移动端配对 | `codex.sharedSnapshot.*`(31)、`shareDialog.*`(13)、`codex-mobile-*` | 需云端分享面（本地 Markdown 导出仍 IN） |
| Appshots（窗口全文截图附件） | `composer.appshotCapture.*`、`appshots-settings` | 系统级屏幕采集；对编码代理非核心，如后续需要再单独立项 |
| 内部/调试面：consumer-view、debug menu、trace 上传到服务、employee-only | `settings.nav.chatGptInternalSettings`、`toggleDebugModal`、`codex.debug.*` | 内部工具（本地 trace recording 仍 IN） |

### 6.3 判定后的规模估计

135 条差距项中：**IN ≈ 112 条**，OUT ≈ 23 条（多为整块能力，如 artifacts/billing/browser）。IN 部分的关键量化：

- 需新建/接线的 agent 扩展方法：**≈ 120 个**（294 个中扣除云端/远程/平台相关）
- 需新建的渲染层模块：**≈ 60–75 个**（对标 Codex 458 个功能模块中 IN 范围的部分）
- 需替换的桩/死代码：**21 处**（附录 A）
- 需翻案的历史决策：**3 个**（iss-058 tab bar、iss-063 Home Chat/Work、iss-064 status bar）

---

## 7. 架构层新发现（决定实施方案，优先级高于任何 UI 工作）

### 7.1 Agent 进程拓扑：现在是"每 tab 一个 agent 进程"，应该"单连接多会话"

**agent 侧实物**：
- `crates/codegen/xai-grok-shell/src/leader/mod.rs:1-40` — **leader-follower 架构**：每台机器一个 leader 进程持有 agent 状态，多客户端（TUI / IDE / headless / 桌面）通过 Unix socket `~/.grok/leader.sock` 接入；`connect_or_spawn` 负责连或拉。
- `crates/codegen/xai-grok-shell/src/agent/app.rs:215 run_stdio_agent` — `grok agent stdio` 是一个 **ACP 客户端/代理进程**（它自己再 `connect_or_spawn` 接 leader，见 `xai-grok-pager/src/acp/mod.rs:322`）。
- `agent/mvp_agent/session_lifecycle.rs:604` — `session_registry.resident_count()`：**一个 agent 进程可同时驻留多个 session**（`acp_agent.rs:950 new_session` / `:963 load_session`）。

**现状**：`electron/acp-session.ts:222` 每个会话 `spawn(bin, ["agent","stdio"])` — N 个 tab = N 个中间进程，每个都：启动一套 MCP server、注册一套 skills watcher、建一条 leader 连接、拉一份 models 缓存。

**后果（直接卡死多个 IN 范围能力）**：
- 跨 tab 的会话列表/状态无法共享 → C1 priority threads、C8 行内状态、L3 recently viewed 做不了
- side chat / subagent / 后台任务 / 定时任务无法跨线程可见 → D5、G Subagents、J3
- MCP 重复启动 → I6 的"连接状态/工具开关"每 tab 不一致
- 内存/CPU 随 tab 线性上升，B11 崩溃恢复无法做（一个 tab 挂 = 一个进程挂）

**结论**：复刻前必须先改成 **一个 ACP 连接 + N 个 session（按 sessionId 路由）**，否则 P1 之后每个跨线程特性都要返工。这也顺便激活 `x.ai/sessions/list`、`x.ai/sessions/changed`（全局会话变更广播）。

### 7.2 Chat / Work 模式的真实语义（影响 E18 怎么做）

逆向结论：`home-composer-mode-toggle` 本身只是 `value:'chat'|'work'` 的展示组件，真正语义在 `app-initial` 的状态原子与路由里：

| 证据 | 含义 |
|---|---|
| `fU(e,t){t===\`chat\`&&e.get(xy)\|\|e.set(Ssa,t)}` + `workOnlyModeEnabled` | work-only 安装下 Chat 不可选 |
| `e.get(XG)===\`work\`` 门控 `cloudThreadsAllowed`/`localThreadsAllowed`/侧栏线程集 | **两种模式看到不同的侧栏内容** |
| `CODEX_EXPANDED_SIDE_PANEL_PRODUCT_SURFACE_CHAT` vs `..._WORK` | 产品 surface 分开 |
| `routeKind==='home' && homeOrigin==='work' ? 'tpp' : null` | Work 走 task/project page 路由，Chat 走 `/` + `chatGptProjectId` |
| `workModeSurfaceAvailable`/`workRequiresUpgrade`/`requiresUpgradeSuffix` | Work 需订阅（Free/Go 锁定） |
| `default_new_chats_to_work`（gate `809615575`） | 可配置默认落在 Work |
| 命令 `newProjectlessTask`（⌘⌥O）、`canStartProjectlessChat`、`localConversation.pendingProjectless` | Codex 本身就有"无项目会话"概念 |

即：在 ChatGPT.app 里 **Chat = ChatGPT 对话 surface（无 agent），Work = Codex agent surface（文件/worktree/终端/云任务）**。

**对 grok-build 的映射**（grok 只有 agent，没有非-agent 对话 surface）：

| 方案 | Chat 模式 | Work 模式 | 评价 |
|---|---|---|---|
| **M1（推荐）** | **无项目会话**：不绑定 cwd、read-only sandbox、不建 worktree、侧栏归入 "Chats" | **项目会话**：绑定 cwd/worktree、workspace-write、完整工具链、侧栏归入 "Projects" | 与 Codex 的 `newProjectlessTask`/`canStartProjectlessChat` 同构，能真驱动 agent（cwd + sandbox_mode），不是装饰 |
| M2 | Plan mode（只讨论不动手） | 执行模式 | 与 E9 plan/fast mode 重叠，且丢失"无项目"语义 |
| M3 | 不做切换 | — | 与"全部翻案"决议矛盾 |

### 7.3 工作区布局状态机（B1/B3/B4/B12 的底层模型）

从 `app-initial` 抽出的布局状态（实际原子字段，非猜测）：

```
layout = {
  mode: 'full' | 'split',          // chat 全屏，或 chat + content 分屏
  contentSide: 'left' | 'right',   // content 区在哪侧
  focus: 'main' | 'right-panel',   // 焦点区
  bottomPanelOpen: boolean,        // 底部面板（终端/输出）
  tabs: [{ tabId, kind:'chat'|'content', dndId, hasExternalFocus(), onDiscardIfEmpty() }],
  activeTabId
}
```

行为规则（实物）：
- `stepWorkspaceLayout`（⌘⇧B）循环布局；`showWorkspaceTabView`（⌘⇧F）切到工作区视图
- tab 可拖到 left / right / bottom / new-window / chat 五个投放区（`appShell.tabs.dragMove*Cue`）
- `bottom` 投放受 `bottomPanelOpen` 门控：`if(n===\`bottom\`&&!e.get(xhi))return!1`
- 只剩一个 tab 且可丢弃时，关闭它会把 `split` 退回 `full`；恢复时 `restoreFullWidthOnNextOpen`

**结论**：当前 `rightPanelCollapsed: boolean` 的单布尔模型无法承载，必须引入显式 `workspaceLayout` store（持久化，对应 `thread-tab-route-checkpoint` / `unrestored-thread-tab-route`）。

---

## 附录 A：现状死代码 / 桩清单（可直接删或必须接线）

| 位置 | 类型 | 说明 |
|---|---|---|
| `src/components/chat/ComposerEditor.tsx` (328行) | 💀 | ProseMirror composer，零引用 |
| `src/components/chat/MentionComplete.tsx` (144行) | 💀 | mention 弹层，零引用（PromptInput 内联了一份简版） |
| `src/components/layout/EditorTabs.tsx` (66行) | 💀 | tab 条，零引用（iss-058 删除） |
| `src/components/layout/ActivityBar.tsx` (65行) | 💀 | 零引用 |
| `src/components/layout/StatusBar.tsx` | 💀 | 零引用（iss-064 删除） |
| `src/components/chat/EmojiPicker.tsx` (115行) | 💀 | 零引用 |
| `src/components/session/ProjectList.tsx` (125行) | 💀 | 零引用 |
| `electron/main.ts:55-60` | 🟡 | `check_auth_status`/`login`/`logout` 硬编码 dev |
| `electron/main.ts:194` | 🟡 | `open_session_window` → `ok(null)` |
| `electron/main.ts:634` | 🟡 | `updater_check` → `ok(null)` |
| `electron/acp-session.ts:485-493` | 🟡 | `fs/read_text_file`、`fs/write_text_file` 返回空内容 |
| `electron/acp-session.ts:255-259` | 🟡 | capabilities 只声明 fs，`terminal:false` |
| `src/components/chat/MessageItem.tsx:23` | 💀 | `grok:apply-code` 事件无监听者（CodeBlock Apply 无效） |
| `src/lib/automation.ts:22-30` | 🟡 | localStorage cron，非 agent scheduler |
| `src/hooks/useAcpSession.ts:8-13` | 🟡 | 子代理靠工具名猜 |
| `src/data/slashCommands.ts` | 🟡 | 硬编码 19 条，非 `x.ai/commands/list` |
| `src/components/settings/PluginManager.tsx:16-…` | 🟡 | 硬编码 MCP catalog 冒充插件市场 |
| `src/components/panels/ThreadSummaryPanel.tsx` | 🟡 | 无后端 |
| `src/hooks/useUpdater.ts` | 🟡 | 主进程无对应实现 |
| `src/lib/tauri.ts:onTrayAction` | 💀 | 主进程无 Tray |
| `src/components/layout/CommandPalette.tsx:39` | 🟡 | 标注 ⌘T，实际注册 ⌘N/⌘⇧O |

## 附录 B：Codex 桌面端 i18n 命名空间分布（4,622 条唯一 id，仅列 ≥10）

> 复现：`node scripts/codex-ref/i18n.mjs --summary`

```
codex 799 (writingBlock 129 / localConversation 107 / review 99 / mcpTool 75 / referralInviteModal 49
           / chatgpt 40 / sharedSnapshot 31 / profileDropdown 26 / visualization 24 / command 19
           / rateLimitResetPromptModal 19 / profileFooter 17 / logout 13 / triggers 11 / localTaskRow 9
           / threadFindBar 8 / tabs 7 / hunk 7 / diff 7 / commandMenu 6 …)
settings 442 (general 79 / agent 73 / nav 63 / mcp 56 / worktrees 40 / section 34 / automations 27
           / localEnvironments 14 / dataControls 13 …)
sidebarElectron 285 (priorityThreads 36 / archivedTasks 27 / usageAlert 22 / customSections 16
           / projectHoverCard 13 / archiveProjectThreads 13 …)
chatgptConversations 265 · composer 239 · chatgpt 180 · inbox 112 · localConversation 111
skills 100 · electron 88 · markdown 68 · thread 54 · sidebar 50 · threadHeader 41 · threadPage 38
plugins 38 · usageCenter 36 · projectSetup 35 · sidebarOnboardingChecklist 34 · browserSidebar 31
realtimeVoice 29 · artifactTemplate 28 · restricted 28 · feedback 25 · appShell 22 · safetyBuffering 17
appgen 16 · appUndo 15 · appUpdate 15 · sidebarCustomization 15 · diff 14 · notifications 14
traceRecording 14 · shareDialog 13 · keyboardShortcutsDialog 12 · pullRequestDetail 11
worktreeRestoreBanner 10 · externalAgentConfig 10 · profile 10
```
