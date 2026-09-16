# Grok Build → Codex Desktop 1:1 复刻 Issue 清单

> 对标 Codex 桌面端 (ChatGPT.app) 的完整功能差距分析。
> 优先级：P0 = 基础框架必须 / P1 = 核心体验 / P2 = 增强功能 / P3 = 锦上添花

---

## 一、App Shell & 布局架构

### ISS-001: macOS 原生交通灯集成 [P0]
TitleBar 当前是自绘的，缺少 macOS 原生红黄绿交通灯按钮的拖拽区域。Codex 的 TitleBar 使用 `env(titlebar-area-*)` 实现 PWA 式原生标题栏融合。
- 需要配置 Tauri `decorations: false` + 自定义拖拽区域
- 左侧预留交通灯空间（macOS），右侧预留最小化/关闭
- 标题栏需支持 `-webkit-app-region: drag`

### ISS-002: Home / 落地页 [P0]
当前没有 home 页。Codex 启动后显示一个居中的 composer（输入框）+ 历史会话预览，而非空白。
- 新建 `pages/Home.tsx`
- 居中显示大型 composer 输入框
- 下方显示最近会话列表（缩略）
- composer-mode-toggle：切换 Chat / Agent 模式

### ISS-003: App Shell 三栏布局重构 [P0]
当前三栏布局（Sidebar + Main + RightPanel）结构基本对，但缺少 Codex 的 `AppShell` 概念：
- 左栏：SessionList 需支持搜索框 + 项目分组
- 中栏：ThreadScrollLayout 需有 top-fade / bottom-fade 渐隐遮罩
- 右栏：需支持多 Tab（Context / Todo / Subagent / Diff Review）
- 中栏顶部需有 thread context bar（当前 model + token usage 紧凑显示）

### ISS-004: 多窗口 / Detached Window 支持 [P1]
Codex 支持将单个会话弹出为独立窗口。当前 `detached-window.html` 仅在 Tauri 层有骨架。
- 实现 `openSessionInNewWindow` 的前端 UI
- detached window 的独立路由
- 窗口间状态同步

---

## 二、对话管理 (Conversation Management)

### ISS-005: Session 列表搜索 [P0]
当前 SessionList 无搜索功能。Codex 在侧栏顶部有搜索框。
- 添加搜索 input
- 按会话标题 / 内容模糊搜索
- 搜索结果高亮匹配文本

### ISS-006: 按项目/CWD 分组会话 [P1]
当前会话列表是扁平的。Codex 按 worktree/project 分组。
- 按 `cwd` 分组会话
- 显示项目名（取自 git remote 或目录名）
- 可折叠的项目组

### ISS-007: 会话右键菜单增强 [P1]
当前 TabBar 有右键菜单（Rename/Fork/Export/Close），但 SessionList 的会话项缺少。
- Pin 置顶
- Rename
- Fork（分支会话）
- Export as Markdown
- Open in new window
- Delete
- 复制会话链接

### ISS-008: Thread 标签页恢复 [P1]
Codex 使用 `thread-tab-route-checkpoint` 在重启后恢复之前的标签页。当前重启后标签页全丢。
- 持久化当前打开的 tabs 列表
- 启动时恢复未关闭的 tabs
- `unrestored-thread-tab-route` 处理已失效的会话

### ISS-009: 会话内搜索 [P2]
Codex 有 `thread-user-message-navigation-rail` — 右侧边缘的会话内导航。
- 搜索当前会话的所有消息
- 跳转到匹配消息
- 右侧边缘显示 marker/bookmark 导航条

### ISS-010: 会话摘要面板 [P2]
Codex 有 `toggle-thread-summary-panel` — AI 生成的会话摘要侧面板。
- 显示 AI 生成的会话摘要
- 关键决策 / 代码变更列表
- 可折叠

### ISS-011: 会话溢出菜单 [P2]
Codex 的 `thread-overflow-menu` 在标题栏区域。
- More 按钮（⋯）
- 会话设置 / 权限 / 模型 / 导出 / 删除

---

## 三、项目管理 (Project / Worktree Management)

### ISS-012: 项目选择器 (Project Selector) [P0]
Codex 在 composer 底部和标题栏有项目选择器。当前完全没有。
- 显示当前活跃项目 / worktree
- 切换项目（打开 worktree 列表）
- 清除当前项目
- 与 `cwd` 绑定

### ISS-013: Worktree 环境下拉 [P1]
Codex 有 `worktree-environment-dropdown` — 选择当前操作的 worktree 环境。
- 列出所有 worktrees
- 显示分支名
- 创建新 worktree
- 切换 worktree（触发新 session）

### ISS-014: Worktree Onboarding [P2]
Codex 有 `worktree-onboarding-banner-controller` 和 `worktree-onboarding-state`。
- 首次使用 worktree 时显示引导横幅
- 自动修复 worktree setup 问题

### ISS-015: Worktree 设置页增强 [P2]
当前 WorktreeManager 基础功能有，但缺少：
- 环境变量配置
- 分支管理
- worktree 健康检查

---

## 四、Composer / 输入区

### ISS-016: ProseMirror 富文本编辑器 [P0]
Codex 使用 ProseMirror 作为 composer 编辑器，支持：
- 富文本格式（粗体、代码、链接）
- Inline mention（@file, @project, @skill）
- Placeholder
- Slash command 自动补全
当前使用普通 `<textarea>`，无法实现这些功能。

### ISS-017: 浮动 Composer (Home 页) [P1]
Codex 的 `unified-floating-composer` 在 Home 页是一个居中的浮动输入区。
- 居中浮动卡片
- 阴影 + 圆角
- 内含项目选择器 + 模型选择器 + 输入框

### ISS-018: Composer 模式切换 [P1]
Codex 有 `home-composer-mode-toggle` — Chat / Agent 模式切换。
- Chat 模式：普通对话
- Agent 模式：自主执行工具
- 可视化切换指示器

### ISS-019: Inline Mention 系统 [P1]
Codex 的 composer 支持 `@` 触发的 inline mention。
- @file → 文件路径补全
- @project → 项目补全
- @skill → 技能补全
- mention 渲染为 pill/chip

### ISS-020: Composer 底部工具栏 [P1]
Codex 的 composer 底部有：
- 项目选择器
- 模型选择器
- 附件按钮
- 语音输入按钮
- 发送按钮
当前布局接近但缺少项目选择器和技能 mention。

---

## 五、消息渲染 (Conversation Blocks)

### ISS-021: 代码块增强 (Code Block) [P0]
Codex 的 `chatgpt-code-block` 有：
- 复制按钮
- 语言标签
- Apply 按钮（直接应用代码变更）
- 折叠/展开
- 行号
当前只有基本的 syntax highlight。

### ISS-022: 消息气泡布局对齐 Codex [P0]
Codex 的 `conversation-blocks` 使用：
- 用户消息：`--user-chat-width: 70%`，superellipse 圆角
- 紧凑模式：`--user-chat-width: min(456px, 100%)`
- 助手消息：无气泡，全宽 markdown
- 消息间 chip/reaction 动画
当前用户/助手都用气泡，需要调整为 Codex 风格。

### ISS-023: Diff / Code Review 内联 [P1]
Codex 有 `code-diff` + `diff-comment-card`。
- 在消息流内显示 inline diff
- 支持 diff comment（行级评论）
- PR tab content（pull request 审查视图）
当前 DiffViewer 存在但未集成到消息流。

### ISS-024: 工具调用卡片增强 [P1]
当前 ToolCallCard 基础功能有，但缺少：
- 工具图标
- 耗时显示
- 输入/输出分栏
- 折叠记忆（同一工具记住展开状态）
- success/failure 状态色彩区分

### ISS-025: 消息 Reaction / Chip [P2]
Codex 有消息级别的 `chip` 和 `reaction`。
- 消息底部可添加标签/chip
- 支持 emoji reaction

---

## 六、Agent / Subagent 管理

### ISS-026: Agent 活动时间线 [P1]
Codex 有 `agent-activity-item` + `agent-activity-units`。
- 右侧面板显示 agent 执行时间线
- 每步工具调用、思考、结果
- 可展开查看详情

### ISS-027: Agent 菜单 [P1]
Codex 有 `agent-menu` — 管理当前会话的 agent 行为。
- 选择 agent 类型
- 配置 agent 权限
- 查看 agent 状态

### ISS-028: Workspace Agents 页面 [P2]
Codex 有 `workspace-agents-page` + `workspace-agent-detail-page`。
- 独立页面查看所有 agent
- agent 详情页（历史活动、配置）

### ISS-029: Subagent 面板增强 [P1]
当前 SubagentPanel 基础有，但缺少：
- 实时活动流
- subagent 间通信可视化
- 取消/暂停 subagent
- subagent 结果摘要

---

## 七、终端 (Terminal)

### ISS-030: xterm.js 终端集成 [P1]
当前 TerminalView 存在但需确认是否用 xterm.js。
- 使用 @xterm/xterm（已在 package.json）
- @xterm/addon-fit 自适应
- @xterm/addon-web-links 链接可点击
- 支持 xterm-window-zoom（缩放）

### ISS-031: 后台终端 [P2]
Codex 有 `background-terminal` — 后台运行的终端会话。
- 终端可最小化到后台
- 多终端 tab
- 终端输出面板

### ISS-032: Exec Shell Container [P2]
Codex 有 `exec-shell-container` — 执行 shell 命令的容器。
- 在消息流内嵌入终端输出
- 支持交互式输入

---

## 八、插件管理 (Plugin Management)

### ISS-033: 插件市场 UI [P0]
当前 PluginManager 存在但功能不明。Codex 有完整的插件市场。
- 插件列表（按分类）
- 插件详情页
- 安装/卸载按钮
- 已安装/可安装切换
- 搜索

### ISS-034: 插件安装流程 [P1]
Codex 有 `use-plugin-installation` hook。
- 安装进度显示
- 权限确认
- 安装后自动配置
- 卸载清理

### ISS-035: 插件定时任务 [P2]
Codex 有 `use-plugin-scheduled-tasks`。
- 查看/管理插件的定时任务
- 任务执行历史
- 手动触发

---

## 九、设置 (Settings)

### ISS-036: Appearance 设置 [P0]
Codex 有 `appearance-settings` — 主题、字号、缩放。
- 深色/浅色/自动切换
- 字体大小调节
- 窗口缩放
当前 GeneralSettings 需拆分。

### ISS-037: 模型管理增强 [P0]
当前 ModelManager 可增删改模型，但缺少：
- 模型测试连接
- 模型图标/描述
- 按供应商分组
- 导入/导出配置

### ISS-038: 搜索式设置 [P1]
Codex 有 `_virtual_settings-search-documents` — 设置项搜索。
- 设置页全局搜索
- 按关键词过滤设置项

### ISS-039: Agent 设置页 [P1]
Codex 有 `agent-settings` — agent 行为配置。
- 默认 agent 模式
- 工具权限配置
- 信任文件夹管理
- 沙箱模式配置

### ISS-040: Voice 设置 [P2]
Codex 有 `voice-settings`。
- 语音输入语言
- 语音唤醒
- TTS 配置

---

## 十、权限 & 沙箱

### ISS-041: 权限管理 (Boundary) [P0]
Codex 有 `boundary` 模块 — 命令执行权限白名单。
- 可信命令列表
- 命令权限审批记忆
- 每会话/全局权限配置
当前 ApprovalCard 有 UI 但无持久化策略。

### ISS-042: 沙箱模式选择器 [P1]
Codex 支持沙箱/完全访问模式切换。
- 在 composer 或 title bar 显示当前模式
- 一键切换
- 沙箱模式说明

### ISS-043: 信任文件夹管理 [P1]
Codex 有 `trusted_folders.toml`。
- 添加/移除信任文件夹
- 首次访问新文件夹时弹出信任确认

---

## 十一、Command Palette

### ISS-044: Command Palette 命令注册 [P0]
当前 CommandPalette 存在但 `commands={[]}` — 空的！
- 注册所有可用命令
- 会话操作（新建/切换/关闭/compact）
- 导航（Settings/Dashboard/Plugins）
- 模型切换
- 模式切换
- 搜索会话

### ISS-045: 设置搜索集成 [P1]
- 在 command palette 中可搜索设置项
- 跳转到对应设置 tab

---

## 十二、Onboarding & Auth

### ISS-046: 多步 Onboarding 流程 [P1]
当前 Onboarding 是单步的。Codex 有 `onboarding-page` 多步引导。
- 欢迎页
- API Key 设置
- 项目选择
- 模型选择
- 完成确认

### ISS-047: Auth Handoff 页面 [P1]
Codex 有 `auth-handoff-page` — OAuth 回调处理。
- 设备码流程 UI
- 等待授权状态显示
- 授权完成自动跳转

---

## 十三、MCP (Model Context Protocol)

### ISS-048: MCP 侧面板 [P1]
Codex 有 `thread-mcp-app-side-panel-tab`。
- 右侧面板新增 MCP Tab
- 显示已连接的 MCP 服务器
- MCP 工具调用历史
- MCP 资源浏览

### ISS-049: WebMCP 工具调用显示 [P2]
Codex 有 `webmcp-tool-calls`。
- 在消息流内显示 WebMCP 工具调用
- 结果渲染

---

## 十四、Right Panel 多 Tab

### ISS-050: 右面板 Tab 系统 [P0]
当前 RightPanel 是单一面板。Codex 有多 Tab：
- Context（当前上下文信息）
- Todo（任务列表）
- Subagents（子代理）
- Diff Review（代码审查）
- MCP（MCP 工具）
- 可切换/可隐藏

### ISS-051: Right Panel Composer Overlay [P2]
Codex 有 `right-panel-composer-overlay` — 右面板覆盖式 composer。
- 右面板展开时 composer 可覆盖在上面

---

## 十五、自动化 (Automation)

### ISS-052: 自动化任务页 [P2]
Codex 有 `automations-page` + `automation-side-panel-tab`。
- 创建定时/触发式自动化任务
- 任务列表
- 执行历史
- 云端自动化详情面板

---

## 十六、其他增强

### ISS-053: 通知系统增强 [P1]
当前 useNotifications hook 存在但需确认：
- 系统通知（权限请求/完成/错误）
- 应用内通知 badge
- Tray 通知

### ISS-054: 更新检查 UI [P2]
当前 useUpdater hook 存在。
- 版本检查
- 更新进度
- 发布说明

### ISS-055: Emoji Picker [P3]
Codex 有 `thread-emoji-picker-content`。
- 会话标题 emoji 选择
- 消息 reaction emoji

### ISS-056: 截图捕获 [P3]
Codex 有 screenshot icon animation。
- 截图工具调用动画
- 截图预览

---

## 实施优先级排序

### Phase 1 — 基础框架 (P0)
ISS-001, ISS-002, ISS-003, ISS-016, ISS-021, ISS-022, ISS-033, ISS-036, ISS-041, ISS-044, ISS-050

### Phase 2 — 核心体验 (P1)
ISS-004, ISS-006, ISS-007, ISS-008, ISS-012, ISS-013, ISS-017, ISS-018, ISS-019, ISS-020, ISS-023, ISS-024, ISS-026, ISS-027, ISS-029, ISS-030, ISS-034, ISS-037, ISS-038, ISS-039, ISS-042, ISS-043, ISS-045, ISS-046, ISS-047, ISS-048, ISS-053

### Phase 3 — 增强功能 (P2)
ISS-009, ISS-010, ISS-011, ISS-014, ISS-015, ISS-025, ISS-028, ISS-031, ISS-032, ISS-035, ISS-040, ISS-049, ISS-051, ISS-052, ISS-054

### Phase 4 — 锦上添花 (P3)
ISS-005, ISS-055, ISS-056
