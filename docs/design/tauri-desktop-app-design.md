# Grok Build Tauri 桌面端设计方案

> 用 Tauri + React 替换 ratatui TUI，复用全部 Rust 后端，打造原生桌面 AI 编程助手

---

## 目录

1. [产品定位与目标](#1-产品定位与目标)
2. [架构总览](#2-架构总览)
3. [核心功能模块](#3-核心功能模块)
4. [交互设计](#4-交互设计)
5. [界面布局](#5-界面布局)
6. [技术架构](#6-技术架构)
7. [数据流与通信](#7-数据流与通信)
8. [实施路线图](#8-实施路线图)

---

## 1. 产品定位与目标

### 定位

Grok Build 桌面端是现有 CLI/TUI 的 **原生桌面升级**，不是全新产品。核心价值：

- **保留 TUI 的全部能力**：多模型、多会话、工具执行、MCP、插件、语音、记忆
- **超越终端限制**：富文本渲染、多窗口、原生集成、可视化配置
- **降低使用门槛**：GUI 配置替代 TOML 手写，可视化模型/MCP/插件管理

### 目标用户

| 用户类型 | 核心诉求 |
|----------|----------|
| 已有 CLI 用户 | 更好的渲染体验 + 保留全部命令行能力 |
| 新用户 | 不想学终端操作，要图形界面 |
| 团队协作场景 | 多会话并行、快速切换、会话导出分享 |

### 非目标

- 不做云服务 / 不做 SaaS
- 不替换 agent 后端逻辑（所有推理、工具、沙箱逻辑不变）
- 不做移动端

---

## 2. 架构总览

### 分层架构

```
┌─────────────────────────────────────────────────────┐
│                    Tauri Window                      │
│  ┌───────────────────────────────────────────────┐  │
│  │            Frontend (React + TS)               │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────┐ │  │
│  │  │ Chat View│ │ Settings │ │ Session Mgr   │ │  │
│  │  │ (对话区) │ │ (配置区) │ │ (会话管理区)  │ │  │
│  │  └──────────┘ └──────────┘ └───────────────┘ │  │
│  └──────────────────┬────────────────────────────┘  │
│                     │ Tauri IPC (invoke / event)     │
│  ┌──────────────────┴────────────────────────────┐  │
│  │           Tauri Backend (Rust)                 │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │        ACP Bridge Layer                  │  │  │
│  │  │  (替代 pager 的 ACP 通信，复用 spawn_grok_shell)│  │
│  │  └──────────────┬──────────────────────────┘  │  │
│  └─────────────────┼─────────────────────────────┘  │
└─────────────────────┼───────────────────────────────┘
                      │ ACP (Agent Communication Protocol)
  ┌───────────────────┴───────────────────────────┐
  │         Grok Build Core (现有 Rust crates)      │
  │  xai-grok-shell │ xai-grok-tools │ xai-grok-agent│
  │  xai-grok-config│ xai-grok-models│ xai-grok-mcp  │
  │  xai-grok-voice │ xai-grok-sandbox│ xai-grok-memory│
  └─────────────────────────────────────────────────┘
```

### 核心设计原则

1. **ACP 桥接，不重写后端**：Tauri Rust 后端通过 `spawn_grok_shell` 启动 agent，用 ACP 通道收发消息，与现有 pager 同一通信机制
2. **前端只管渲染和交互**：所有业务逻辑（工具执行、沙箱、模型选择、认证）留在 Rust 后端
3. **TUI 命令映射到 GUI**：TUI 的 40+ slash 命令映射为菜单按钮、快捷键、面板操作
4. **渐进迁移**：先跑通核心对话流，再逐步加功能

---

## 3. 核心功能模块

### 3.1 对话工作区 (Chat Workspace) — 核心模块

**能力**：用户与 agent 的主交互界面

| 功能 | 说明 | 对应 TUI |
|------|------|----------|
| 消息流 | 实时流式渲染 agent 回复（Markdown + 代码高亮） | ratatui scrollback |
| 工具调用展示 | 可折叠的工具调用卡片（bash 输出、diff、文件读取等） | inline tool rendering |
| 图片支持 | 粘贴/拖拽图片发送给 agent，渲染 agent 生成的图片 | prompt_images |
| 输入区 | 多行输入、语法提示、slash 命令自动补全 | prompt textarea |
| 模型切换 | 顶栏下拉切换当前会话模型（DeepSeek/Qwen/GLM） | `/effort` + model picker |
| 推理强度 | 顶栏切换 reasoning effort (high/medium/low) | `/effort` |
| 上下文管理 | 显示 token 用量、手动 compact、上下文预览 | `/compact`, context bar |
| 会话操作 | fork / resume / export / rename / delete | slash commands |
| 子 agent | 展示 subagent 生命周期（spawn/running/done） | subagent pane |
| 计划视图 | `/plan` 产出的 TODO 列表，可勾选、可展开 | todo pane |
| 撤回 | 回退到历史某个消息点重试 | `/rewind` |
| 语音输入 | 按住快捷键语音输入，转文字填入输入框 | `/voice` |

### 3.2 多会话管理 (Session Manager)

**能力**：管理和切换多个并行会话

| 功能 | 说明 |
|------|------|
| 标签页 | 类似浏览器 tab，每个会话一个 tab |
| 侧边栏会话列表 | 按时间/项目分组，搜索、筛选、快速切换 |
| 会话恢复 | 从历史会话恢复（`~/.grok/sessions/`） |
| Dashboard 视图 | 全局俯瞰所有会话和子 agent 状态（对应 TUI dashboard） |
| 跨项目 | 不同工作目录的会话分组管理 |
| 批量操作 | 导出多个会话、清理旧会话 |

### 3.3 设置中心 (Settings)

**能力**：可视化配置，替代手写 `~/.grok/config.toml`

| 配置项 | 说明 | 对应 config |
|--------|------|-------------|
| 模型管理 | 增删改模型、设置默认模型、API Key 管理（DASHSCOPE_API_KEY 等） | `default_models.json` + config |
| API 密钥 | 安全存储 API Key（Tauri keyring / 加密存储） | env_key |
| 沙箱配置 | 网络限制、读写路径策略（strict/workspace/read-only） | `[sandbox]` |
| 工具开关 | 启用/禁用特定工具（bash、web_search、read_file 等） | `[tools]` |
| 子 agent | 配置 subagent 模型映射、角色定义、并发数 | `[subagents]` |
| 外观 | 主题（dark/light/auto）、字体大小、代码主题 | `[appearance]` |
| 语音 | STT 语言选择、自动检测开关 | `[voice]` |
| 记忆 | 查看和管理跨会话记忆条目 | `[memory]` |
| 更新 | 检查更新、切换 release channel（alpha/stable） | `grok update` |

### 3.4 MCP 服务器管理 (MCP Manager)

**能力**：可视化管理 MCP 服务器连接

| 功能 | 说明 |
|------|------|
| 服务器列表 | 展示已配置的 MCP 服务器及其状态（connected/error/disabled） |
| 添加服务器 | 表单填写：name、command/URL、env、capabilities |
| 工具浏览 | 展示每个 MCP 服务器暴露的工具列表 |
| 启停控制 | 一键启停单个 MCP 服务器 |
| 调试 | 查看 MCP 服务器日志、重连 |

### 3.5 插件市场 (Plugin Marketplace)

**能力**：浏览、安装、管理插件和 skills

| 功能 | 说明 |
|------|------|
| 市场浏览 | 按分类/搜索浏览可用插件 |
| 一键安装 | 安装插件及其依赖 |
| 已装管理 | 启用/禁用/卸载/更新已装插件 |
| Skill 查看 | 浏览插件提供的 skills 和 agents |
| 信任管理 | 插件信任链审批 |

### 3.6 Git Worktree 管理

**能力**：可视化创建和管理 git worktree

| 功能 | 说明 |
|------|------|
| Worktree 列表 | 展示当前项目的所有 worktree 及其会话 |
| 创建 worktree | 选择分支 → 创建 worktree → 自动开新会话 |
| 自动 GC | 配置 worktree 自动清理策略（年龄/数量） |
| 会话关联 | 每个 worktree 关联其会话历史 |

### 3.7 系统集成 (System Integration)

**能力**：原生桌面体验

| 功能 | 说明 |
|------|------|
| 系统托盘 | 后台运行、快速打开窗口、通知 |
| 全局快捷键 | 全局唤起窗口 / 新建会话 / 语音输入 |
| 原生通知 | agent 完成回复、工具需要审批时推送系统通知 |
| 文件拖拽 | 拖拽文件到窗口自动发送给 agent |
| 深色模式 | 跟随系统深浅色切换 |
| 自动启动 | 开机自启动选项 |

---

## 4. 交互设计

### 4.1 启动流程

```
App 启动
  │
  ├─ 已登录？ ──否──→ 登录页（OAuth / Device Auth）
  │                    │
  │                   是
  │                    ↓
  ├─ 有活动会话？ ─是──→ 恢复上次会话状态
  │                    │
  │                   否
  │                    ↓
  └─ 显示欢迎页
       ├─ 「新建会话」→ 选择工作目录 → 进入对话工作区
       ├─ 「恢复会话」→ 会话列表 → 选择 → 进入对话工作区
       └─ 「从 Worktree」→ Worktree 列表 → 选择 → 进入对话工作区
```

### 4.2 对话流交互

```
用户输入消息
  │
  ├─ 普通文本 ──→ 直接发送
  ├─ "/" 触发 ──→ Slash 命令补全下拉
  ├─ "@" 触发 ──→ 文件提及补全（当前工作目录文件树）
  ├─ 拖拽文件 ──→ 自动生成文件引用
  └─ 快捷键语音 ──→ 录音 → STT → 填入输入框
       │
       ↓
  Agent 处理中
  ├─ 流式文本实时渲染
  ├─ 工具调用卡片实时展开
  │    ├─ bash: 显示命令 + 输出（可折叠）
  │    ├─ read_file: 显示文件路径 + 内容摘要
  │    ├─ write/edit: 显示 diff 视图
  │    └─ web_search: 显示搜索结果卡片
  ├─ 子 agent: 在侧面板显示子 agent 状态
  ├─ 计划: 在底部面板显示 TODO 进度
  └─ 审批弹窗: 需要用户确认的危险操作
       │
       ↓
  Agent 完成
  ├─ 消息完整渲染
  ├─ 可操作：复制 / 重试 / Fork / 导出 / 撤回
  └─ 如在后台 → 系统通知
```

### 4.3 工具审批交互

当 agent 需要执行工具调用时，根据沙箱策略决定交互方式：

```
工具调用请求
  │
  ├─ 自动批准（always_approve / 安全工具）──→ 直接执行
  │
  ├─ 需要审批（写操作 / 网络请求）
  │    │
  │    ↓
  │  审批卡片（内联在对话流中）
  │  ┌────────────────────────────────────┐
  │  │ 🔧 run_terminal_cmd                 │
  │  │ $ npm run build                     │
  │  │                                      │
  │  │ [批准] [拒绝] [批准并记住]            │
  │  └────────────────────────────────────┘
  │
  └─ 拒绝时 → agent 收到拒绝信号，可选择其他方案
```

### 4.4 快捷键体系

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Cmd/Ctrl+N` | 新建会话 | 打开新 tab |
| `Cmd/Ctrl+T` | 新建会话（同目录） | 复用当前工作目录 |
| `Cmd/Ctrl+W` | 关闭当前会话 | |
| `Cmd/Ctrl+Shift+T` | 恢复最近关闭的会话 | |
| `Cmd/Ctrl+1~9` | 切换到第 N 个会话 tab | |
| `Cmd/Ctrl+,` | 打开设置 | |
| `Cmd/Ctrl+Shift+P` | 命令面板（搜索所有操作） | |
| `Cmd/Ctrl+K` | 聚焦输入框 | |
| `Cmd/Ctrl+L` | 清空当前对话视图 | |
| `Cmd/Ctrl+Shift+V` | 切换语音输入 | |
| `Cmd/Ctrl+Enter` | 发送消息 | |
| `Shift+Enter` | 输入框换行 | |
| `Cmd/Ctrl+Up/Down` | 浏览历史输入 | |
| `Esc` | 中断 agent | 取消当前 turn |
| `Cmd/Ctrl+Shift+A` | 全局唤起窗口 | 系统级 |

### 4.5 会话切换交互

```
会话 Tab 栏
  ┌──────┬──────┬──────┬──────┐
  │ Sess1│ Sess2│ Sess3│  +   │  ← 点击切换，+ 新建
  └──────┴──────┴──────┴──────┘
  
  Tab 右键菜单：
  ├─ 重命名
  ├─ Fork 会话
  ├─ 导出为 Markdown
  ├─ 复制会话 ID
  ├─ 关闭
  └─ 关闭其他
```

---

## 5. 界面布局

### 5.1 主窗口布局

```
┌─────────────────────────────────────────────────────────────┐
│ 标题栏: [模型: DeepSeek V4 Pro ▾] [Effort: High ▾] [⋯]     │
├──────────┬──────────────────────────────┬───────────────────┤
│          │                              │                   │
│  侧边栏   │       对话区 (Chat)           │   右侧面板        │
│          │                              │   (可折叠)        │
│ ┌──────┐ │  ┌──────────────────────┐   │ ┌───────────────┐ │
│ │会话   │ │  │ User: 帮我修复 ...   │   │ │ 子 Agent      │ │
│ │列表   │ │  │                      │   │ │ ├ explore  ✅ │ │
│ │      │ │  │ Agent: 我来查看...   │   │ │ ├ planner 🔄 │ │
│ │ Sess1│ │  │  [🔧 bash]           │   │ │ └ coder    ⏳│ │
│ │ Sess2│ │  │  $ cargo test        │   │ │               │ │
│ │ Sess3│ │  │  ✓ 3 passed          │   │ │ 计划 TODO     │ │
│ │      │ │  │                      │   │ │ ☑ 分析代码    │ │
│ ├──────┤ │  │ Agent: 问题在...     │   │ │ ☑ 写测试      │ │
│ │工作   │ │  └──────────────────────┘   │ │ ☐ 修复 bug   │ │
│ │目录   │ │                              │ │               │ │
│ │/proj  │ │  ┌──────────────────────┐   │ │ Token 用量    │ │
│ │      │ │  │ 输入消息...    [发送] │   │ │ ████████░░ 80%│ │
│ └──────┘ │  └──────────────────────┘   │ └───────────────┘ │
│          │                              │                   │
├──────────┴──────────────────────────────┴───────────────────┤
│ 状态栏: [● 已连接] [worktree: main] [sandbox: workspace]     │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Dashboard 视图（全局俯瞰）

```
┌─────────────────────────────────────────────────────────────┐
│  Agent Dashboard                                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Session 1    │  │ Session 2    │  │ Session 3    │         │
│  │ /my-project  │  │ /api-server  │  │ /frontend    │         │
│  │ DeepSeek V4  │  │ Qwen Max     │  │ GLM-5.1      │         │
│  │              │  │              │  │              │         │
│  │ Agent: 🔄    │  │ Agent: ✅    │  │ Agent: ⏸     │         │
│  │ Tool: bash   │  │ Idle         │  │ Waiting      │         │
│  │              │  │              │  │              │         │
│  │ [打开]        │  │ [打开]        │  │ [打开]        │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                              │
│  子 Agent 活动流:                                             │
│  12:03 explore (sess1) 完成 — 找到 3 个相关文件              │
│  12:05 planner (sess2) 完成 — 生成实施计划                   │
│  12:07 coder (sess1) 运行中 — 修改 src/main.rs              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 设置面板

```
┌─────────────────────────────────────────────────────────────┐
│  设置                                                         │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                    │
│  模型     │  ┌──────────────────────────────────────────┐   │
│  ▸ 模型   │  │ 模型管理                                  │   │
│  ▸ API密钥│  │                                            │   │
│          │  │ 默认模型: [DeepSeek V4 Pro ▾]              │   │
│  工具     │  │                                            │   │
│  ▸ 沙箱   │  │ ┌────────────────────────────────────┐    │   │
│  ▸ 工具开关│  │ │ DeepSeek V4 Pro (百炼)            │    │   │
│  ▸ 子agent│  │ │ base_url: dashscope.aliyuncs.com   │    │   │
│          │  │ │ context: 131072                    │    │   │
│  系统     │  │ │ [编辑] [删除]                      │    │   │
│  ▸ 外观   │  │ └────────────────────────────────────┘    │   │
│  ▸ 语音   │  │                                            │   │
│  ▸ 记忆   │  │ [+ 添加模型]                               │   │
│  ▸ 更新   │  │                                            │   │
│          │  │ API 密钥:                                   │   │
│  集成     │  │ DASHSCOPE_API_KEY: [••••••••••••] [显示]  │   │
│  ▸ MCP    │  │                                            │   │
│  ▸ 插件   │  └──────────────────────────────────────────┘   │
│  ▸ Worktree│                                                  │
│          │                                                    │
└──────────┴──────────────────────────────────────────────────┘
```

---

## 6. 技术架构

### 6.1 技术选型

| 层 | 技术 | 理由 |
|----|------|------|
| 桌面框架 | Tauri 2.x | Rust 原生后端，直接复用 grok-build crates |
| 前端框架 | React 18 + TypeScript | 生态最大、组件库丰富 |
| UI 组件 | Shadcn/UI + Tailwind CSS | 轻量可定制、暗色模式原生支持 |
| 状态管理 | Zustand | 轻量，适合 Tauri 的 event-driven 模型 |
| Markdown 渲染 | react-markdown + rehype/remark 插件 | 代码高亮 + GFM + 数学公式 |
| Diff 渲染 | react-diff-viewer-continued | 工具调用的 diff 展示 |
| 代码高亮 | Shiki | 与 VS Code 一致的语法高亮 |
| 终端模拟 | xterm.js（可选） | 嵌入式终端用于 bash 工具输出 |

### 6.2 Tauri 后端模块

```
src-tauri/
├── Cargo.toml          # 依赖 grok-build workspace crates
├── tauri.conf.json
└── src/
    ├── main.rs          # Tauri 入口
    ├── acp_bridge.rs    # ACP 通信桥（核心）
    ├── commands/        # Tauri invoke 命令
    │   ├── session.rs   # 会话管理（创建/恢复/列表/fork）
    │   ├── config.rs    # 配置读写（config.toml 可视化）
    │   ├── models.rs    # 模型管理（增删改查）
    │   ├── mcp.rs       # MCP 服务器管理
    │   ├── plugin.rs    # 插件管理
    │   ├── voice.rs     # 语音控制
    │   └── workspace.rs # Worktree 管理
    ├── events.rs        # Tauri event 转发（ACP → 前端）
    └── state.rs         # 全局状态（会话池、ACP 连接池）
```

### 6.3 前端模块

```
src/
├── App.tsx              # 路由根
├── pages/
│   ├── Welcome.tsx      # 欢迎/启动页
│   ├── Login.tsx        # 登录页
│   ├── Chat.tsx         # 主对话工作区
│   ├── Dashboard.tsx    # 全局 Dashboard
│   └── Settings.tsx     # 设置中心
├── components/
│   ├── chat/
│   │   ├── MessageList.tsx      # 消息流
│   │   ├── MessageItem.tsx      # 单条消息渲染
│   │   ├── ToolCallCard.tsx     # 工具调用卡片
│   │   ├── DiffViewer.tsx       # diff 展示
│   │   ├── PromptInput.tsx      # 输入区
│   │   ├── SlashComplete.tsx    # slash 命令补全
│   │   └── ApprovalCard.tsx     # 审批弹窗
│   ├── session/
│   │   ├── TabBar.tsx           # 会话标签栏
│   │   ├── SessionList.tsx      # 侧边栏会话列表
│   │   └── SessionPicker.tsx    # 会话选择器
│   ├── panels/
│   │   ├── SubagentPanel.tsx    # 子 agent 面板
│   │   ├── TodoPanel.tsx        # 计划/TODO 面板
│   │   ├── ContextBar.tsx       # token 用量条
│   │   └── StatusBar.tsx        # 底部状态栏
│   ├── settings/
│   │   ├── ModelManager.tsx     # 模型管理
│   │   ├── McpManager.tsx       # MCP 管理
│   │   ├── PluginManager.tsx    # 插件管理
│   │   └── ...
│   └── layout/
│       ├── TitleBar.tsx         # 自定义标题栏
│       ├── Sidebar.tsx          # 侧边栏
│       └── CommandPalette.tsx   # 命令面板 (Cmd+Shift+P)
├── hooks/
│   ├── useAcpSession.ts   # ACP 会话 Hook
│   ├── useSession.ts      # 会话状态 Hook
│   └── useConfig.ts       # 配置 Hook
├── stores/
│   ├── sessionStore.ts    # 会话状态
│   ├── configStore.ts     # 配置状态
│   └── uiStore.ts         # UI 状态
└── lib/
    ├── acp.ts             # ACP 消息类型定义
    └── tauri.ts           # Tauri invoke 封装
```

### 6.4 Workspace 集成

```
grok-build/                    # 现有仓库（Rust workspace）
├── crates/...                 # 现有 crates（不动）
├── src-tauri/                 # 新增 Tauri 后端
│   ├── Cargo.toml             # [dependencies] xai-grok-shell = { path = "../crates/codegen/xai-grok-shell" } ...
│   └── src/...
├── src/                       # 新增前端
│   └── ...
├── package.json               # 前端依赖
├── vite.config.ts             # Vite 构建
└── tauri.conf.json            # Tauri 配置
```

---

## 7. 数据流与通信

### 7.1 ACP 桥接（核心数据流）

Tauri 后端复用 `spawn_grok_shell` 启动 agent，通过 ACP 通道与前端通信：

```
Frontend (React)          Tauri Backend (Rust)         Agent Process
     │                          │                           │
     │ invoke("session_send",   │                           │
     │   {msg, sessionId})      │                           │
     │ ───────────────────────→ │                           │
     │                          │ acp_send(prompt/message)  │
     │                          │ ────────────────────────→ │
     │                          │                           │
     │                          │     ACP notification      │
     │                          │ ←──────────────────────── │
     │                          │                           │
     │ emit("acp_event",        │                           │
     │   {type, data, sessionId})│                          │
     │ ←─────────────────────── │                           │
     │                          │                           │
     │ 渲染消息/工具卡片/审批     │                           │
     │                          │                           │
```

### 7.2 ACP 事件类型映射

| ACP 事件 | 前端处理 |
|----------|----------|
| `session/update` (text delta) | 流式追加到当前消息 |
| `session/update` (tool call) | 渲染工具调用卡片 |
| `session/update` (tool result) | 更新工具卡片状态和输出 |
| `session/notification` (subagent) | 更新子 agent 面板 |
| `session/notification` (plan/todo) | 更新 TODO 面板 |
| `session/notification` (approval) | 弹出审批卡片 |
| `session/update` (image) | 渲染图片消息 |
| `session/update` (usage) | 更新 token 用量条 |
| `session/update` (error) | 渲染错误消息 |

### 7.3 多会话架构

```
Tauri Backend State
┌──────────────────────────────────────┐
│  SessionPool                          │
│  ┌──────────┐ ┌──────────┐ ┌────────┐│
│  │ Session 1│ │ Session 2│ │ Session3││
│  │ ACP Tx/Rx│ │ ACP Tx/Rx│ │ACP Tx/Rx││
│  │ cwd: /a  │ │ cwd: /b  │ │cwd: /c ││
│  │ model:DS │ │ model:QW │ │model:GL││
│  └──────────┘ └──────────┘ └────────┘│
└──────────────────────────────────────┘
         │
    每个 Session 独立 agent 进程
    独立 ACP 通道
    独立工具沙箱
```

### 7.4 配置数据流

```
前端设置面板
  │
  ↓ invoke("config_save", { key, value })
Tauri 后端
  │
  ↓ 写入 ~/.grok/config.toml (xai-grok-config crate)
  │
  ↓ 通知所有活动会话重新加载配置
  │
Agent 进程
  ↓ 配置热更新（现有 config watcher 机制）
```

---

## 8. 实施路线图

### Phase 1: MVP — 核心对话流（2 周）

**目标**：单个会话跑通「输入 → agent 回复 → 流式渲染」

- [ ] Tauri 项目脚手架，链接 grok-build workspace crates
- [ ] ACP Bridge：`spawn_grok_shell` → ACP 通道 → Tauri event 转发
- [ ] 前端：消息流渲染（Markdown + 代码高亮）
- [ ] 前端：输入区 + 发送 + 中断
- [ ] 前端：工具调用卡片（bash 输出、diff）
- [ ] 登录流程（OAuth）
- [ ] 基础窗口布局（标题栏 + 对话区 + 输入区）

### Phase 2: 多会话 + 设置（2 周）

**目标**：多 tab 会话 + 可视化配置

- [ ] 多会话 tab 管理
- [ ] 侧边栏会话列表
- [ ] 会话恢复（历史会话）
- [ ] 设置中心：模型管理、API Key
- [ ] 模型切换（顶栏下拉）
- [ ] Reasoning effort 切换
- [ ] Slash 命令补全

### Phase 3: 高级功能（2 周）

**目标**：工具审批 + 子 agent + 计划 + 语音

- [ ] 工具审批交互（inline approval card）
- [ ] 子 agent 面板
- [ ] 计划/TODO 面板
- [ ] 语音输入（快捷键 + STT）
- [ ] 图片粘贴/拖拽
- [ ] Context bar（token 用量）
- [ ] 手动 compact

### Phase 4: 系统集成 + 生态（2 周）

**目标**：原生体验 + MCP/插件/worktree

- [ ] 系统托盘 + 全局快捷键
- [ ] 原生通知
- [ ] Dashboard 视图
- [ ] MCP 服务器管理 UI
- [ ] 插件市场 UI
- [ ] Worktree 管理 UI
- [ ] 命令面板（Cmd+Shift+P）
- [ ] 深色/浅色主题

### Phase 5: 打磨与分发（1 周）

- [ ] 自动更新（Tauri updater）
- [ ] 安装包打包（macOS DMG / Windows MSI / Linux AppImage）
- [ ] 性能优化（大对话滚动、消息虚拟化）
- [ ] 错误处理与恢复
- [ ] 快捷键完整映射
- [ ] onboarding 教程

---

## 已确认决策

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 前端框架 | **React 18 + TypeScript** |
| 2 | 终端模拟 | **嵌入 xterm.js** — bash 工具输出用内嵌终端渲染，支持 ANSI 色彩/交互 |
| 3 | 多会话模式 | **多 Tab（单窗口为主）** — 每个 tab 一个会话，可拖出分离窗口 |
| 4 | 通信架构 | **ACP 桥接为主** — 通过 `spawn_grok_shell` + ACP 通道，不绕过后端 |
| 5 | 配置同步 | **共用 `~/.grok/config.toml`** — 桌面端与 CLI 共享同一配置文件 |
| 6 | 分发平台 | **Windows + macOS** — DMG / MSI，通过 GitHub Releases 分发 |

### 决策影响分析

**xterm.js 嵌入终端**：
- bash 工具调用不再用纯文本卡片，而是渲染在 xterm.js 实例中
- 保留 ANSI 色彩、光标控制、进度条等终端能力
- 支持 scrollback 滚动、复制选中内容
- 需在 Tauri 后端维护 PTY → xterm.js 的数据流桥接（复用 `ptyctl` crate）
- 其他工具（read_file、diff、web_search）仍用富文本卡片

**多 Tab + 可分离窗口**：
- 默认所有会话在单窗口的 Tab 标签页中
- Tab 可拖出窗口形成独立窗口（Tauri `WebviewWindow` 多窗口）
- 分离窗口的会话仍共享同一个 Tauri 后端 SessionPool
- 窗口关闭时如会话在运行，最小化到托盘而非退出
