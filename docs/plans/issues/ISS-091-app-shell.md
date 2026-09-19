> Epic: #128 (ISS-069) · 批次: B2 · 标签: `parity-slice` `app-shell` `priority/P1` `frontend`
> 规格来源: 差距文档 §B(B1–B5,B10–B12) §7.3；实物模块 `thread-app-shell-chrome` `tab-panel` `thread-tab-route-checkpoint` `unrestored-thread-tab-route`；文案 `appShell.*`(22) `codex.tabs.*`(7)
> **翻案 iss-058（#106）/ iss-064（#112）**：恢复 tab strip 与常驻面板区

## 目标

把 App Shell 从"单线程视图 + 侧栏切换"重构为 Codex 的**多 tab 工作台**：tab strip（拖拽重排 / 拖出成独立窗口 / pin / 右键菜单）、bottom panel、side panel 多 tab、布局状态机驱动，并在重启后完整恢复。

## 范围

1. **Tab strip**：chat tab + content tab 统一条带（`kind:'chat'|'content'`）；右键菜单 `close` / `closeOtherTabs` / `closeTabsToTheRight` / `pinToSidebar` / `unpinFromSidebar` / `rename`；拖拽重排 + 四向投放提示（`dragMoveLeftCue`/`RightCue`/`BottomCue`/`ChatCue`/`NewChatCue`）；拖出窗口（`dragNewWindowCue`）与拖回还原（`restoreToTab`）；`reopenClosedTab`(⌘⇧T)
2. **Detached window**：`open_session_window` 真实实现（当前 `main.ts:194` 返回 `ok(null)`）；独立窗口加载 `index.html?session=<id>`；窗口菜单 `Keep window on top` / `Focus chat`（`appShell.detachedWindow.*`）；与主窗共享 per-thread scope（ISS-088）+ 事件按窗口订阅广播
3. **Bottom panel**：`toggleBottomPanel`(⌘J)；tab 化容器（首个 tab = Terminal，由 ISS-098 填内容）；`thread.bottomPanel.{openTab,hide,close}`
4. **Side panel 多 tab**：从固定 4+4 tab 改为**可新开/关闭/重命名的多实例 tab**；`toggleSidePanel`(⌘⌥B)、`toggleMaximizeSidePanel`（全屏展开 `codex.rightPanel.expandFullWidth/restoreWidth`）、`thread.sidePanel.{toggle,openTab,openNewTab}`；tab 内容容器按 id 懒加载（Review/Terminal/Sources/Subagents/Plan/Automation/MCP/Summary/Goal）
5. **布局状态机接线**：`stepWorkspaceLayout`(⌘⇧B) 循环、`showWorkspaceTabView`(⌘⇧F)、`mode: full|split` + `contentSide` + `focus` 全部由 `workspaceLayout` store 驱动（ISS-088）；持久化 + 重启恢复
6. **tab route checkpoint**：重启恢复 tabs/activeTab/布局；不可恢复的会话走 `unrestored-thread-tab-route` 提示
7. **渲染错误边界**：`appShell.tabPanelRenderError.{title,retry}` —— 单个 tab 内容渲染失败不影响整个 shell
8. 恢复 `EditorTabs.tsx`（现为死代码）或重写；删除 `ActivityBar.tsx`/`StatusBar.tsx` 死代码（若确认不用）

## 非目标

- 不做 Browser tab（OUT）、Artifact/Image/Entity tab（OUT）
- 不实现各 side panel tab 的**内容**（Review=ISS-094、Terminal/Subagents=ISS-098、Sources/Summary/Goal=ISS-095、Automation=ISS-101、MCP=ISS-100）—— 本 issue 只提供容器与注册机制
- 不做 tray / 原生菜单 / 单实例（ISS-104）
- 不做 unified tab strip 的 flag 灰度切换（直接以统一条带为默认）

## 依赖

- ISS-088（布局状态机、per-thread scope、多窗口广播 —— **detached window 强依赖 G4 修复**）
- ISS-089（tab 相关命令与快捷键）
- ISS-087（会话 fork/close 走 agent；detached window 需共享 session registry）

## 回滚

Feature flag `isUnifiedTabStripEnabled`（实物即有此 flag）关闭时退回单线程视图 + 侧栏切换（保留旧路径一个批次）。布局持久化 key 独立命名，回滚不污染旧 `gb-session-tabs`。detached window 回滚 = `open_session_window` 恢复为 no-op。

## 验收标准

### 状态机不变量
- `mode==='full'` ⟺ content tab 区不可见；`bottomPanelOpen===false` ⟹ tab 不可投放到底部（投放被拒且提示）
- `tabs.length===0` ⟹ `activeTabId===null` ⟹ 视图为 Home；关闭最后一个可丢弃 tab ⟹ `split→full`
- pin 的 tab 恒在 strip 的固定区且不参与 `closeOthers`/`closeToRight`
- detached window 打开期间，主窗对应 tab 显示 `appShell.tabs.detachedDescription`，且**同一 thread 不得同时在两处处于可编辑流式状态**（一方为只读镜像或明确同步）
- 任一时刻 `activeTabId ∈ tabs`；投放/重排动画中途取消不得留下幽灵 tab
- tab 内容渲染失败 ⟹ 只该 tab 显示 error boundary，shell 其余部分可交互

### 负向场景
- 拖出窗口时目标 thread 已关闭 → 明确失败提示（`appShell.tabs.windowMoveFailed`），不产生空白窗口
- 还原 tab 失败 → `appShell.tabs.windowRestoreFailed`，原窗口保持可用
- 恢复的 tab 指向已删除会话 → `unrestored-thread-tab-route` 提示 + 可关闭，不静默丢弃
- 窗口置顶切换失败 → `appShell.detachedWindow.pinFailed`
- `Focus chat` 时源 thread 已不存在 → `appShell.detachedWindow.focusSourceFailed`
- 极窄窗口（<800px）：strip 溢出可横向滚动/折叠，不遮挡交通灯；side/bottom panel 有最小宽度且不把 chat 挤到 0
- 拖拽到非法投放区（如 bottom 未开）→ 视觉拒绝 + 无状态变更

### 并发 / 崩溃 / 恢复
- 主窗 + 2 个 detached window 同时打开：三处事件广播无重复消费、无消息重复渲染
- detached window 打开时 kill agent → 两处同时进入可恢复态；重连后均恢复
- detached window 强杀（关闭窗口）→ 主窗 tab 状态回落正确，thread 不被误关
- app 重启：tabs + activeTab + mode/contentSide/bottomPanelOpen/side panel tabs + pin 状态 + detached window 布局（是否恢复独立窗口需明确策略并测试）全部恢复
- 快速拖拽重排 + 同时 streaming：流不中断、tab 顺序最终一致
- 渲染进程崩溃后 reload：shell 从持久化恢复，不丢 tab

### 外部副作用检查
- 新建 BrowserWindow 必须继承安全配置（`contextIsolation:true`、`nodeIntegration:false`、白名单 preload）；`webSecurity` 不得关闭
- detached window 的 URL 参数只接受内部 threadId，不得被用来加载外部 URL（`setWindowOpenHandler` 已 deny http，需覆盖 `?session=` 注入）
- 关闭 app 时所有窗口与子进程被清理，无孤儿进程
- 持久化只写 localStorage；不写 `~/.grok`

### Parity 勾选项
- [ ] B1 tab strip（拖出/pin/右键 6 项/重排）
- [ ] B2 detached window（置顶/Focus chat/失败提示）
- [ ] B3 bottom panel
- [ ] B4 side panel 多 tab + 全屏
- [ ] B10 chrome 保持（hiddenInset + 交通灯让位）
- [ ] B12 `stepWorkspaceLayout` / `showWorkspaceTabView`
- [ ] `appShell.*` 22 条 + `codex.tabs.*` 7 条文案全覆盖
