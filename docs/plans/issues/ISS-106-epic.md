> **EPIC 草案（编号 ISS-106）** · 批次: 全部 · 标签: `parity-foundation` `enhancement` `priority/P1` `architecture`
> **Supersedes #105 (ISS-057)** —— 前序 Epic 的基准来自 openai/codex issue 与在线文档，其中三条断言与 ChatGPT.app 实物相反（见下），本 Epic 以实物逆向为准并显式翻案。

## ⚠️ 编号与既有 Epic 的冲突（必读）

GitHub 上**已存在 OPEN 的 Epic #128 = ISS-069**「Codex 桌面端 1:1 复刻第二轮 — 真实化 + 质量基座 + 行为对齐」（另一并行会话于 2026-09-18 22:54 本地时间创建，含 16 张子 issue，且被重复创建两次：#129–#144 为孤儿副本，#145–#160 为 Epic 实际链接的副本）。

因此本草稿有两种处置，**需用户裁决**：
- **方案 X（推荐）**：不新建 Epic。把本草案的 Wave 划分与子 issue（ISS-086…ISS-105）追加进 #128，作为其 "Wave A 架构地基 / Wave B 交互复刻"，并在 #128 中记录 §下方「与 #128 现有 16 张 issue 的关系」。
- **方案 Y**：新建 ISS-106 作为 sibling Epic（本草案原文），与 #128 交叉引用，各自维护 Wave。

## 背景

第一批对齐（#105 / ISS-057，已关闭）以 `openai/codex#10886`、`#26856` 与 developers.openai.com 为依据，得出三条结论并据此实施了 iss-058/063/064：

| #105 的断言 | ChatGPT.app 26.915.31029 实物证据 |
|---|---|
| 「没有浏览器式 TabBar，侧栏线程树是唯一切换入口」 | `appShell.tabs.*` 22 条（拖出成独立窗口 / 拖回还原 / pin / 四向拖拽提示）、`codex.tabs.contextMenu.*` 6 条、`thread-tab-route-checkpoint`、命令 `reopenClosedTab`(⌘⇧T)、`closeOtherTabs`(⌘⌥W)、`nextTab`/`previousTab` |
| 「Home 的 Chat/Agent toggle 是自创概念」 | `composer.home.modeToggle.chat`="Ask questions and explore ideas"、`.work`="Get tasks done with your files and apps"、`workOnlyModeEnabled`、`workModeSurfaceAvailable`、`default_new_chats_to_work` |
| 「Codex 无常驻状态条」 | `appShell.header.bottomPanel`、`thread.bottomPanel.{openTab,hide,close}`、命令 `toggleBottomPanel`(⌘J) |

本轮改为**解包本机 ChatGPT.app 渲染层**取规格：5,295 个 JS 模块、4,622 条唯一 i18n 文案 id、127 条命令注册表（含 defaultKeybindings / commandMenuGroupKey / shortcutScope / availableIn）。工具已入库：`scripts/codex-ref/{index,get,i18n,commands}.mjs`。

## 目标

桌面端（Electron + React + ACP）**1:1 复刻 Codex 桌面端的本地开发者工作流**：能力与交互体验逐条可对照验收。

## 范围（IN，112 条差距项）

见 `docs/design/codex-desktop-parity-gap.md` §6.1：协议层 A1–A27、App Shell B1–B12、侧栏 C1–C11、Thread Header D1–D10、Composer E1–E15/E17–E19、会话流 F1–F8/F10–F15/F17、Side Panel（Review/Terminal/Sources/Subagents/Plan/Automation/MCP/Summary/Goal + 面板机制）、Worktree H1–H5/H7、Plugins·Skills·MCP I1–I6、Automations J1/J3、Settings K1–K6、快捷键 L1–L5、Onboarding·Auth M1–M3、通知/更新/导出 N1–N3/N7。

## 非目标（OUT，不做也不占位）

见 §6.2：Cloud tasks / cloud environments / cloud browser / Remote computers / Browser use / Computer use / Chronicle / Artifacts（文档·幻灯片·表格·站点·生成图画廊·Canvas）/ Realtime voice / Pets / Codex Micro / Billing·Usage center·rate limit·upgrade·referral / 企业 policy（managed·admin·restricted·requirements.toml）/ 消费者设置页（parental·trusted contact·time management·ads·analytics·personalization·profile-account）/ connector 触发器订阅 / 分享快照与云端分享 / 移动端配对 / Appshots / 内部调试面。

**本批不修改 Rust agent 代码**（agent 侧 294 个 `x.ai/*` 扩展已足够）；若发现必须改，另开 issue 并先解 `docs/memory/backlog.md` 的 protobuf 工具链阻塞。

## 关键事实与阻断项（详见 `docs/plans/2026-09-18-codex-desktop-parity-design.md`）

- **G1 会话拓扑错误**：`electron/acp-session.ts:222` 每 tab spawn 一个 `grok agent stdio`；而 agent 侧是单机 leader-follower（`xai-grok-shell/src/leader/mod.rs`）且一个进程可驻留多 session（`session_lifecycle.rs:604`）。跨 tab 状态、side chat、subagent 可见性、priority threads、崩溃恢复全部被此阻断。
- **G2 零测试 + 无 PR CI**：无 `test` script、无 `*.spec.*`、无 vitest/jest；`.github/workflows/release.yml` 只在 tag 触发且构建的是 **Tauri**（`npx tauri build`），而运行时已是 Electron。
- **G3 打包脚本不支持子目录**：`electron/build.sh:12` 的 sed 正则 `[a-zA-Z0-9_-]+` 不含 `/`，实测 `require("./agent/ext/git")` 不被改写 → 任何新目录结构会静默断链。
- **G4 事件只发 mainWindow**（`main.ts:165,180,213`）→ detached window 不可行。
- **G6 21 处桩/死代码**：7 个零引用组件（含 328 行 ProseMirror `ComposerEditor`）、`login` 硬编码 `username:"dev"`、`open_session_window`/`updater_check` 返回 `ok(null)`、CodeBlock Apply 派发的 `grok:apply-code` 无监听者、Automations 为 localStorage cron、Subagent 靠工具名猜、PluginManager 是硬编码 MCP catalog。
- **G7 快捷键 4 处冲突**：⌘G 应为 `searchChats`=⌘K；⌘K 现被命令面板占用；`CommandPalette.tsx:39` 标注 ⌘T（Codex 中 ⌘T=`openBrowserTab`，范围外）；缺 ~116 条命令。已对齐的：⌘N/⌘⇧O、⌘B、⌘O、⌘J、⌘,、⌘1-9、⌘⇧[ ]。

## 子 Issue 与依赖顺序

**F 轨 · 地基（必须先做）**

| Issue | 内容 | 批次 |
|---|---|---|
| ISS-086 | 构建·CI·测试地基（esbuild 打包替换 sed、PR 四道门、vitest） | B0 |
| ISS-087 | ACP 单连接多会话 + `x.ai/*` typed client + capabilities + 反向请求 + 事件总线 | B1 |
| ISS-088 | 状态·IPC 契约·多窗口广播（workspaceLayout 状态机 + per-thread scoped store + channel 白名单） | B1 |
| ISS-089 | 命令注册表（127 条）+ 快捷键归位 + i18n 层（key 用 Codex id） | B1 |
| ISS-090 | parity 验收工具链（`scripts/parity.mjs` → `docs/parity/*.md`） | B1 |

依赖：`070 → {071, 072}`（071/072 可并行，接口先在 `shared/contract.ts` 定死）`→ 073 → 074`

**S 轨 · 垂直切片（F 轨后大量可并行）**

| Issue | 内容 | 依赖 | 批次 |
|---|---|---|---|
| ISS-091 | S1 App Shell 工作区：tab strip / 布局状态机落地 / bottom panel / side panel 多 tab / detached window | 072,073 | B2 |
| ISS-092 | S2a Composer 编辑器内核：ProseMirror 接线 / 格式工具条 / mention pill / slash 对话框 / 代码块+语言选择 | 072,073 | B2 |
| ISS-102 | S11 Settings：分组导航 / 页补齐 / 项级搜索 / Agent(Configuration) / 快捷键对话框 | 073 | B2 |
| ISS-093 | S2b Composer 控件行：权限档位 / 运行位置 / worktree 环境 / 模型+effort / plan·fast / queue·steer·background / Chat·Work | 076,071 | B3 |
| ISS-094 | S3 Review 面板：源切换 / 文件树 / 虚拟化 diff / hunk·file·section revert / diff 评论 / PR | 071,075 | B3 |
| ISS-095 | S4 Thread 视图：turn entries 按轮聚合 / 虚拟化 / 导航栏+书签 / find bar / 轮内聚合区块 / 编辑·从旧轮 fork | 071,075 | B3 |
| ISS-096 | S5 侧栏：priority / 自定义分区 / 排序分组 / hover card / 批量 / undo / 行内状态 / 归档区 | 071,075 | B4 |
| ISS-097 | S6 Thread Header：continue / fork 三态 / copy 三态 / archive 差异化确认 / open in window / side chat / 环境徽标 | 075,079 | B4 |
| ISS-098 | S7 Terminal(真 pty) + Subagents + 后台进程 | 071,075 | B4 |
| ISS-099 | S8 Worktree + 本地环境：生命周期 / 设置页 / onboarding+auto-fix / 会话迁移 | 071,077 | B4 |
| ISS-100 | S9 Plugins + Skills + MCP：市场 / 安装流 / 技能页 / MCP 连接面 | 071,086 | B5 |
| ISS-101 | S10 Automations：scheduler / 频率 / 会话绑定 / 侧面板 tab | 071,075 | B5 |
| ISS-103 | S12 Onboarding + Auth（真 `x.ai/auth/*`）+ 外部 agent 导入 | 071,086 | B5 |
| ISS-104 | S13 平台集成：tray / 原生菜单 / 自动更新 / deeplink / 单实例 / 崩溃恢复 / 通知 | 072,075 | B5 |
| ISS-105 | 收尾：21 处桩与死代码清零 / Tauri 退役决策 / `lib/tauri.ts` 更名 / 总验收 | 全部 | B6 |

## 全局验收标准

- [ ] 所有子 issue 关闭，且每张 issue 的四类核心验收（状态机不变量 / 负向场景 / 并发·崩溃·恢复 / 外部副作用）均有自动化或可复现的手工证据
- [ ] `docs/parity/*.md` 中 IN 范围条目 100% 勾选，每条附实物证据 id（i18n id / 命令 id / 模块名）
- [ ] **一个** agent 进程承载全部 tab（`ps aux | grep 'agent stdio'` 计数 = 1）
- [ ] PR CI 四道门（typecheck / build / unit / smoke-launch）在每张 issue 的 PR 上绿
- [ ] 127 条命令中 IN 范围部分全部注册，快捷键与 `scripts/codex-ref/commands.mjs` 输出逐条一致
- [ ] 21 处桩/死代码（差距文档附录 A）全部接线或删除，`grep` 可验证
- [ ] iss-058/063/064 的三个错误决策已翻案，且 #105 被本 Epic 显式 supersede（避免回改）

## 回滚

Epic 级回滚 = 按批次 revert merge commit。每张子 issue 必须自带独立回滚方案（见各自「回滚」段），保证任一切片可单独退出而不阻塞其余切片。F 轨（070–074）不可回滚到"无地基"状态而不影响 S 轨，因此 F 轨必须先行合入并稳定一个批次。
