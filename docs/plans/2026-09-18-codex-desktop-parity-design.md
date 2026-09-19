# Codex 桌面端 1:1 复刻（第二批）— 实施设计

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-18 |
| 仓库 | `/Users/jiafan/Desktop/poc/grok-build`（远端 `Colin4k1024/grok-build`） |
| 业务目标 | 桌面端能力与交互体验 1:1 复刻 Codex 桌面端（ChatGPT.app 内的 Codex surface） |
| 范围 | `docs/design/codex-desktop-parity-gap.md` §6.1 IN（112 条差距项）；方案 1「契约先行 + 垂直切片」 |
| 非目标 | 同文档 §6.2 OUT（云端/远程/浏览器/Artifacts/实时语音/Pets/Codex Micro/Billing/企业 policy/connector 触发器/移动配对，共 23 项） |
| 约束 | 见 §1.4（实测得出，待确认） |
| 前置产物 | 差距分析 `docs/design/codex-desktop-parity-gap.md`（592 行，14 域 / 135 条差距 / 附录 A 桩清单）；规格抽取工具 `scripts/codex-ref/` |
| 状态 | 设计待评审；**未修改任何业务代码** |

---

## 1. 当前事实（只读调研结论，全部可复核）

### 1.1 代码基线

| 事实 | 证据 |
|---|---|
| 渲染层 `tsc --noEmit` 通过 | 本次实测 exit 0 |
| Electron 主进程 `tsc -p electron/tsconfig.json --noEmit` 通过 | 本次实测 exit 0 |
| 渲染层规模：74 个文件 / 12,760 行 | `find src -name '*.ts*' \| xargs wc -l` |
| 主进程规模：5 个文件 / 1,811 行 | `wc -l electron/*.ts` |
| IPC：59 个 `ipcMain.handle`，事件仅 3 处 `webContents.send` | `grep -c 'ipcMain.handle(' electron/main.ts` |
| **事件只发 `mainWindow`** → detached window 收不到任何事件 | `electron/main.ts:165,180,213` |
| 每个会话 spawn 一个 `grok agent stdio` 进程，且**以会话 cwd 作为子进程 cwd** | `electron/acp-session.ts:222-228` |
| 客户端只声明 `fs:{read,write}`、`terminal:false` | `electron/acp-session.ts:255-259` |
| 使用的 ACP 面：9 个标准方法 + 3 个 `x.ai/*` | `grep -oE '"x\.ai/[^"]+"' electron/*.ts` |
| agent 侧可用 `x.ai/*` 扩展方法：**294 个** | `grep -rhoE '"x\.ai/[^"]+"' crates/codegen/xai-grok-shell/src crates/codegen/xai-acp-lib/src \| sort -u \| wc -l` |
| agent 是**单机 leader-follower**（`~/.grok/leader.sock`），`grok agent stdio` 是其客户端 | `crates/codegen/xai-grok-shell/src/leader/mod.rs:1-40`、`xai-grok-pager/src/acp/mod.rs:322` |
| 一个 agent 进程可驻留**多个 session** | `agent/mvp_agent/session_lifecycle.rs:604 session_registry.resident_count()`、`acp_agent.rs:950/963` |
| 桩/假实现/死代码 **21 处** | 差距文档附录 A（含 7 个零引用组件、`login` 硬编码 dev、`open_session_window`/`updater_check` 返回 null、`grok:apply-code` 无监听者） |
| `target/debug/xai-grok-pager` 已构建 → 本地 smoke 可跑 | `ls target/debug/` |

### 1.2 测试与 CI

| 事实 | 证据 |
|---|---|
| **无任何 JS/TS 测试**：无 `test` script、无 `*.test.*`/`*.spec.*`、无 vitest/jest/playwright/testing-library | `grep -E '"test' package.json`、`find src electron -name '*.test.*'` |
| 仅 2 个手工 harness，需真实 agent + 真实 sessionId 才能跑 | `scripts/test-mcp-config.mjs`、`scripts/test-session-resume.mjs` |
| **CI 只有一个 workflow，且构建的是 Tauri 而非 Electron** | `.github/workflows/release.yml`：`npx tauri build`，产物取自 `src-tauri/target/**/bundle/` |
| CI 触发条件只有 tag `v*` 与 `workflow_dispatch` → **PR/push 无门禁** | 同上 `on:` 段 |
| `goal-state.json` 声称「每个 PR 都跑 npm run build + electron/build.sh 绿」→ 那是**人工执行**，非 CI | `goal-state.json:tests` |
| Rust 侧有测试（AUDIT.md：1,106 文件含 `#[cfg(test)]`），但**桌面端一行都没有** | `AUDIT.md` |
| Rust 侧存在已知阻塞：protobuf 工具链导致 `cargo check -p xai-grok-shell` 无法验证 | `docs/memory/backlog.md`、`docs/memory/project-context.md` |

### 1.3 历史 Issue / ADR / 约定

| 事实 | 证据 |
|---|---|
| Issue 总数 148：**115 CLOSED + 33 OPEN**；CLOSED 最大编号 ISS-068，**OPEN 已占用 ISS-069–ISS-085** | `gh issue list --state all --limit 200`（本文初版误记为"全部 CLOSED、0 open"，已纠正） |
| **存在并行会话**：33 个 OPEN issue 于 2026-09-18 14:54–15:08 UTC（本地 22:54–23:08，即本调研进行期间）由 `Colin4k1024` 创建；其产物 `docs/artifacts/codex-desktop-parity-round2/` 未提交，且**改动了 `package.json`/`package-lock.json`**（新增 vitest/jsdom/@testing-library） | `gh issue list --json createdAt,author`、`git status --short`、`git diff package.json` |
| 该并行会话把 16 张子 issue **创建了两遗**：#129–#144（孤儿副本）与 #145–#160（Epic #128 实际链接的副本） | `diff` 两者 body 仅 3 行差异；`gh issue view 128` 子任务清单指向 #145–#160 |
| 命名约定：`ISS-0NN: 标题`；分支 `iss-0NN-slug`；PR `feat(iss-0NN): desc`；合并即关 issue | `gh pr list`、`git log` |
| 标签体系存在**两套优先级**（`priority/P1..P4` 与 `P0..P3`）+ 域标签（`app-shell` `composer` `conversation` `messages` `right-panel` `terminal` `plugins` `settings` `command-palette` `permissions` `onboarding` `mcp` `automation` `project` `agent`）+ `capability-gap` `architecture` `security` `backend` `frontend` `phase-1..5` | `gh label list` |
| 无 milestone | `gh api repos/.../milestones` → `[]` |
| **无 ADR**（AUDIT.md 明确列为缺点）；`docs/design/*.md` 是设计文档，`docs/memory/*` 是任务记忆（内容均为 Rust agent 侧，与桌面端无关） | `AUDIT.md` §缺点 7、`docs/memory/backlog.md` |
| 前序 Epic **#105 = ISS-057「桌面端交互重设计 — 与 Codex App Desktop 完全对齐」已关闭**，含 11 个子 issue（#106-#116） | `gh issue view 105` |

**⚠️ 关键发现：前序 Epic 的基准是错的。** #105 的调研结论写死了三条与实物相反的断言，直接导致 iss-058/063/064 三个错误决策：

| #105 的断言 | 实物证据（ChatGPT.app 26.915.31029） |
|---|---|
| 「**没有浏览器式 TabBar**，侧栏线程树是唯一切换入口（openai/codex#10886 明确确认该范式）」 | `appShell.tabs.*` 22 条（拖出成独立窗口/拖回还原/pin/四向拖拽提示）、`codex.tabs.contextMenu.*` 6 条（close/close others/close to the right/pin to sidebar）、`thread-tab-route-checkpoint`、命令 `reopenClosedTab`(⌘⇧T)、`closeOtherTabs`(⌘⌥W)、`nextTab`/`previousTab` |
| 「Home 的 Chat/Agent 模式 toggle 是自创概念，Codex 用审批模式」 | `composer.home.modeToggle.chat`="Ask questions and explore ideas"、`.work`="Get tasks done with your files and apps"、`workOnlyModeEnabled`、`workModeSurfaceAvailable`、`default_new_chats_to_work` |
| 「底部 StatusBar + ContextBar 常驻状态条 —— Codex 无」 | `appShell.header.bottomPanel`、`thread.bottomPanel.{openTab,hide,close}`、命令 `toggleBottomPanel`(⌘J) |
| 依据来源：`openai/codex#26856`、`#10886`、`developers.openai.com/codex/app/*` | 本轮改为**解包本机 ChatGPT.app 渲染层**：5,295 个模块、4,622 条 i18n id、127 条命令注册表 |

→ 本批工作必须**显式翻案**这三条，且新 Epic 要声明 supersede #105，否则下一个人还会照 #105 的结论改回去。

### 1.4 约束（实测得出，**待你确认/补充**）

| 类别 | 约束 | 来源 |
|---|---|---|
| 兼容性 | 不得破坏现有会话持久化（`localStorage["gb-session-tabs"]`、`~/.grok/sessions/**`）；升级后旧 tab 必须能恢复或明确降级 | `sessionStore.ts:persist`、`electron/session-history.ts` |
| 兼容性 | `~/.grok/config.toml` 的 `[mcp_servers.*]` 编辑必须保持"外科手术式"（无关行逐字保留） | `electron/mcp-config.ts` + `scripts/test-mcp-config.mjs` |
| 兼容性 | 与 CLI/TUI 共存：同一个 leader 下桌面与 `grok` TUI 会看到彼此的 session，不得互相踢掉 | `leader/mod.rs`、`roster_merge.rs` |
| 构建 | **`electron/build.sh` 的 sed 只重写 `require("./x")`（正则 `[a-zA-Z0-9_-]+`，不含 `/` 和 `.`）→ 任何子目录结构都会静默断链**（本次实测验证）。新目录结构前必须先换打包方式 | `electron/build.sh:12`；实测 `require("./agent/ext/git")` 未被改写 |
| 构建 | `electron/tsconfig.json` 的 `include` 只有 `main.ts`/`preload.ts`，其余文件靠传递引用编译 → 新增未引用模块不会报错也不会产出 | 同文件 |
| 构建 | `package.json` `"type":"module"` → 主进程产物必须是 `.cjs` | `package.json:5` |
| 平台 | macOS 为主（`titleBarStyle:hiddenInset` + `trafficLightPosition`）；Windows/Linux 需保持可构建但本轮不做视觉打磨 | `electron/main.ts:643-651`、`package.json:build` |
| 依赖 | 可用 `esbuild 0.21.5`（vite 传递依赖，已在 `node_modules/.bin`）替换 sed 打包 | 实测 `npx esbuild --version` |
| 依赖 | 新增运行时依赖需最小化：已选定的状态库是 zustand（不引入 jotai） | 设计决策 A1 |
| 安全 | `contextIsolation:true` / `nodeIntegration:false` / `sandbox:false`；preload 暴露**通用** `invoke(channel,…)` → 任意 channel 可被渲染层调用，需要白名单 | `electron/main.ts:653-657`、`electron/preload.ts` |
| 安全 | Full Access 模式必须保留 Codex 的三段式风险确认（Files/Internet/Terminal） | `composer.mode.agentMode.fullAccessConfirm.*` |
| 安全 | `git_*` / `run_command` 必须继续用 `execFile` 参数数组（无 shell 注入） | `electron/main.ts:367-455` |
| 流程 | 只读调研阶段**不改业务代码**；GitHub Issue 创建属外部写操作，需明确授权 | 本次指令 |
| 交付 | 无 CI 门禁 → 若不先补 CI，"每 PR 绿"仍靠人工，回归风险高 | §1.2 |

---

## 2. 缺口（按严重度）

| 级别 | 缺口 | 影响 |
|---|---|---|
| **G1 阻断** | 会话拓扑错误：每 tab 一个 agent 进程 | 跨 tab 状态、side chat、subagent 可见性、priority threads、recently viewed、崩溃恢复全部无法实现；MCP 重复启动；内存线性增长 |
| **G2 阻断** | 无测试、无 PR CI | 20 个切片的重构没有回归网；`electron/build.sh` 这类静默断链只能靠人肉发现 |
| **G3 阻断** | 打包脚本不支持子目录 | 提议的 `electron/agent/ext/*.ts` 结构会静默失败（require 路径不改写，运行期才崩） |
| **G4 高** | 事件只广播给 `mainWindow` | detached window（B2）功能上不可行 |
| **G5 高** | 状态模型是 `Record<sessionId, …>` 全局平表 | 无法承载 per-thread 面板状态/草稿/tab checkpoint/Review 状态；selector 全量重渲染 |
| **G6 高** | 21 处桩/死代码，其中 7 个组件零引用 | "形似神不似"；接口被假数据占位，接真能力时要重写 |
| **G7 中** | 快捷键与 Codex 有 4 处冲突（⌘G/⌘K/⌘T 错标 + 缺 116 条命令） | 肌肉记忆对不上，"交互体验 1:1"不成立 |
| **G8 中** | 无 i18n 层，中英文混排 | 无法与 4,622 条 Codex 文案 id 逐条对齐验收 |
| **G9 中** | 前序 Epic #105 结论错误且已关闭 | 后来者会照错误基准改回去；必须显式 supersede |
| **G10 低** | 双运行时并存（`src-tauri/` + Electron），CI 还在构建 Tauri | 认知负担 + CI 资源浪费；`lib/tauri.ts` 命名误导 |

---

## 3. 风险

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | **单连接多会话在 `agent stdio` 上不成立**（agent 可能对 stdio 客户端限制单 session，或 per-session cwd/sandbox 与进程 cwd 耦合） | 中 | 极高（G1 的地基） | ISS-071 第一条验收就是 spike：一条连接连开 2 个不同 cwd 的 session 并各自收事件；失败则回退方案 = 每 tab 一进程但共享 leader + 前端加跨进程状态同步层（成本 +30%） |
| R2 | 子进程 cwd 只能是单一目录，而 `session/new` 带 per-session cwd | 高 | 中 | 连接进程用中性 cwd（app path），cwd 全靠 `session/new` 参数；验收含"两个 session 不同 cwd 各自 read-only/workspace-write 生效" |
| R3 | 破坏性重构（`sessionStore.ts` 584 行 + `App.tsx` 859 行）中途不可用 | 高 | 高 | 地基 issue 内采用"新 store 与旧 store 并存 + 逐字段搬迁"，每步保持 `tsc` 绿与冒烟可启动；禁止大爆炸式替换 |
| R4 | 无测试网下重构引入回归 | 高 | 高 | ISS-070 先落地 vitest + PR CI（typecheck/build/unit/smoke），**早于**任何重构 |
| R5 | ChatGPT.app 自更新导致规格漂移 | 中 | 中 | `scripts/codex-ref/` 可重跑；每个切片开工前 diff `i18n.tsv` 与 `commands.tsv` |
| R6 | Rust 侧需要改动时撞上 protobuf 工具链阻塞 | 低 | 高 | 本批**不改 Rust**（agent 能力已足够）；若必须改，先解 `docs/memory/backlog.md` 的 protobuf 项 |
| R7 | 与 TUI 共用 leader 时的会话争用（roster merge / 版本不匹配 `x.ai/leader/version_mismatch`） | 中 | 中 | ISS-071 验收含"桌面与 `grok` TUI 同时打开同一 session 不互踢"；监听 `version_mismatch` 并给出可操作提示 |
| R8 | 范围蔓延（Codex 桌面端 458 个功能模块，容易越做越大） | 高 | 高 | §6.2 OUT 清单写进 Epic 与每张 issue 的「非目标」；parity checklist 只统计 IN 项 |
| R9 | 安全：通用 `invoke` + `sandbox:false` 下新增 channel 可能引入任意路径读写/命令执行 | 中 | 高 | ISS-072 引入 channel 白名单 + 参数校验（路径必须落在受信目录内）；ISS-087 的 Full Access 确认流；每张 issue 的「外部副作用检查」条目 |
| R10 | 交付节奏：20 张 issue 若串行，周期过长 | 中 | 中 | 依赖 DAG（§5）标出可并行轨：F 轨完成后 S1/S2a/S3 可并行；S5-S13 大多可并行 |

---

## 4. 关键依赖

**外部依赖**
- `grok` agent 二进制（`target/{debug,release}/xai-grok-pager` 或 `GROK_AGENT_BIN`）；打包时经 `extraResources` 内嵌
- leader socket `~/.grok/leader.sock`；`GROK_HOME` 可覆盖（`session-history.ts`/`mcp-config.ts`/key store 均已支持）
- ChatGPT.app（仅**规格来源**，运行时不依赖）
- esbuild 0.21.5（已在 node_modules，需提升为显式 devDependency）
- 新增 devDependency：`vitest`（唯一新增运行时依赖：无）

**内部依赖顺序（硬约束）**
```
ISS-070 (构建+CI+测试地基)
   └─> ISS-071 (ACP 单连接多会话 + typed ext client)   ← R1 spike 在此
   └─> ISS-072 (状态 + IPC 契约 + 多窗口广播)
          └─> ISS-073 (命令注册表 + 快捷键 + i18n)
                 └─> ISS-074 (parity 验收工具链)
                        └─> S1..S13 切片（见 §5）
```
`ISS-071` 与 `ISS-072` 可并行（接口先在 `shared/contract.ts` 定死）；`ISS-073` 依赖 072（命令需要 layout/thread store）；`ISS-074` 依赖 073（命令 id 是 checklist 的一部分）。

---

## 5. 能力边界拆分与依赖 DAG

拆分原则：**每张 issue = 一个可独立交付、可独立验收的能力边界**（能单独跑通、单独回滚、单独勾选 parity 项），而不是"改一批文件"。

```
F 轨（地基，必须先做）
  ISS-070 构建·CI·测试地基 ──┬─> ISS-071 ACP 单连接多会话 + x.ai/* typed client
                            └─> ISS-072 状态·IPC 契约·多窗口广播
                                     └─> ISS-073 命令注册表·快捷键·i18n
                                              └─> ISS-074 parity 验收工具链

S 轨（垂直切片，F 轨后可大量并行）
  ISS-075 S1  App Shell 工作区（tab strip / 布局状态机 / bottom panel / side panel 多 tab / detached window）
  ISS-076 S2a Composer 编辑器内核（ProseMirror / 格式工具条 / mention pill / slash 对话框 / 代码块+语言）
  ISS-077 S2b Composer 控件行（权限档位 / 运行位置 / worktree 环境 / 模型+effort / plan·fast / queue·steer·background / Chat·Work）
  ISS-078 S3  Review 面板（源切换 / 文件树 / 虚拟化 diff / hunk revert / diff 评论 / PR）
  ISS-079 S4  Thread 视图（turn entries / 虚拟化 / 导航栏 / find bar / 轮内聚合区块 / 编辑·fork）
  ISS-080 S5  侧栏（priority / 自定义分区 / 排序分组 / hover card / 批量 / undo / 行内状态 / 归档区）
  ISS-081 S6  Thread Header（continue / fork / copy / archive / open in window / side chat / 环境徽标）
  ISS-082 S7  Terminal(pty) + Subagents + 后台进程
  ISS-083 S8  Worktree + 本地环境（生命周期 / 设置页 / onboarding+auto-fix / 会话迁移）
  ISS-084 S9  Plugins + Skills + MCP（市场 / 安装流 / 技能页 / MCP 连接面）
  ISS-085 S10 Automations（scheduler / 频率 / 会话绑定 / 侧面板 tab）
  ISS-086 S11 Settings（分组导航 / 页补齐 / 项级搜索 / Agent Configuration / 快捷键对话框）
  ISS-087 S12 Onboarding + Auth + 外部 agent 导入
  ISS-088 S13 平台集成（tray / 原生菜单 / 更新 / deeplink / 单实例 / 崩溃恢复 / 通知）
  ISS-089 收尾（21 处桩与死代码清除 / Tauri 退役决策 / 总验收）

依赖：
  075 ← 072,073          076 ← 072,073         077 ← 076,071
  078 ← 071,075           079 ← 071,075         080 ← 071,075
  081 ← 075,079           082 ← 071,075         083 ← 071,077
  084 ← 071,086(设置容器)  085 ← 071,075         086 ← 073
  087 ← 071,086           088 ← 072,075         089 ← 全部
```

**并行建议**：F 轨完成后，`075 / 076 / 086` 三条可同时开工（分别占 shell、composer、settings 三个不相交目录）；`078/079/080/082` 在 075 落地后可并行。

---

## 6. 架构决策（已定，记录理由）

| # | 决策 | 选择 | 理由 / 被否方案 |
|---|---|---|---|
| AD-1 | 会话拓扑 | **单 ACP 连接 + N session（按 sessionId 路由）**；连接进程用中性 cwd | agent 侧 `session_registry` 支持多驻留；否掉"每 tab 一进程"（G1）。R1 为回退保留方案 |
| AD-2 | per-thread 状态 | **每 thread 一个 store 实例**（`Map<threadId, StoreApi<ThreadScope>>` + `useThread(id)`） | 真 scope 隔离、detached window 可复用同 scope、无新依赖；否掉 A2（`Record<id,…>` 平表，G5）与 A3（jotai，新依赖+全量重写） |
| AD-3 | 布局模型 | 显式 `workspaceLayout` 状态机（`mode: full\|split` / `contentSide` / `focus` / `bottomPanelOpen` / `tabs[]` / `activeTabId`），持久化 = tab route checkpoint | 实物原子字段逆向所得（差距文档 §7.3）；否掉现有 `rightPanelCollapsed:boolean` |
| AD-4 | IPC | `shared/contract.ts` 单一类型真源 + **channel 白名单** + 统一注册 + `broadcast.ts` 多窗口广播；**不留兼容层** | preload 已是通用 invoke，改动集中；留兼容层会让两套调用路径并存，验收更难（R9 由白名单缓解） |
| AD-5 | 文案 | `src/i18n/zh-CN.ts`，**key 直接沿用 Codex i18n id** | 可与 4,622 条权威清单逐条 diff 验收；否掉自造 key（无法自动对齐） |
| AD-6 | 命令 | 命令注册表 schema 与 Codex 对齐：`{id,titleIntlId,descriptionIntlId,availableIn,shortcutScope,commandMenuGroupKey,commandMenuFeature,defaultKeybindings}` + flag 门控 + 7 组 + 组内优先级 | 127 条已逆向（`scripts/codex-ref/commands.mjs`）；直接照抄结构可自动验收 |
| AD-7 | Chat/Work 映射 | **M1**：Chat = 无项目会话（不绑 cwd、read-only sandbox、侧栏 Chats）；Work = 项目会话（绑 cwd/worktree、workspace-write、侧栏 Projects） | 与 Codex 自身 `newProjectlessTask`/`canStartProjectlessChat` 同构，能真驱动 agent；否掉 M2（与 plan mode 重叠）、M3（与翻案决议矛盾） |
| AD-8 | 主进程打包 | **esbuild 打包成单文件 `dist-electron/main.cjs`**，替换 sed 改名法 | 实测 sed 不支持子目录（G3）；esbuild 0.21.5 已在 node_modules |
| AD-9 | 测试 | vitest（unit + 契约测试）+ 真实 agent smoke（`GROK_AGENT_BIN`）+ PR CI 四道门（typecheck / build / unit / smoke-launch） | 当前零测试（G2）；smoke 复用现有 harness 模式 |
| AD-10 | Tauri | 本批**不动**，在 ISS-089 单独决策退役；CI 先从 Tauri 切到 Electron | 避免与重构混在一起；`lib/tauri.ts` 更名放到 ISS-089 |
| AD-11 | 验收 | 每切片交付附 parity checklist 勾选（`scripts/parity.mjs` 生成，逐条对应 i18n id / 命令 id / 模块名） | 让"1:1"可度量，而不是主观判断 |

---

## 7. 验收体系（核心验收逻辑，所有 issue 通用）

每张 issue 的「验收标准」必须包含以下四类，缺一不予关闭：

### 7.1 状态机不变量
- **布局**：`mode==='full'` ⟺ content tabs 不可见；`bottomPanelOpen===false` ⇒ 任何 tab 不可投放到底部；`tabs.length===0` ⇒ `activeTabId===null` 且视图落 Home；关闭最后一个可丢弃 tab ⇒ `split→full`
- **会话**：一个 `threadId` 任一时刻至多绑定一个 `sessionId`；`rebindTabId` 前后 `messages` 不丢；`streaming[threadId]===true` ⇒ 不允许静默切换 cwd（必须先 cancel 或用户确认）
- **审批**：`approvalMode==='full-access'` ⇒ 不产生 pending 卡片且自动选 `allow*`；`'read-only'` ⇒ 自动选 `reject*`；任何模式下 `pendingPermissions[threadId]` 与 agent 侧未决请求数一致
- **Review**：revert 成功后对应 hunk 必须从 `get-hunks` 结果消失（不允许 UI 乐观更新与 agent 状态分叉）
- **命令**：任一快捷键至多命中一个命令；命令可见性 = `availableIn` ∧ flags ∧ 当前 scope

### 7.2 负向场景
- 项目目录被删/无权限/不是 git 仓库 → 明确错误态，不白屏
- `session/new` 失败、`session/load` 回放为空、agent 进程启动即退出 → 有错误提示 + 可重试
- 权限请求被拒 / 用户取消 / 超时 → 状态回落正确，不卡在 streaming
- 搜索无结果、mention 无匹配、slash 无匹配、diff 过大、二进制文件、未跟踪文件 → 各自空态文案（对齐 Codex `*.noResults`/`*.empty`/`diffTooLarge`）
- Full Access 确认弹窗点 Cancel → 不得降档为静默放行
- MCP server 启动失败 / OAuth 未完成 / 工具被禁用 → 面板显示原因（`plugin-disabled-reason` 语义）

### 7.3 并发 / 崩溃 / 恢复
- 同时 2+ 线程跑 turn：事件不串台（按 sessionId 路由的强断言测试）
- 多窗口：主窗 + detached window 同时订阅同一 thread，状态一致且无重复发送
- 中途 kill agent 进程：前端进入可恢复态；重连后 tab 保留、transcript 不丢
- app 重启：tabs + activeTab + 布局（mode/contentSide/bottomPanel/side panel tabs）完整恢复；已失效会话走 `unrestored-thread-tab-route` 语义提示而非静默丢弃
- 与 `grok` TUI 同时连同一 leader：不互踢；`x.ai/leader/version_mismatch` 有可操作提示
- 快速连点（新建/关闭/切换/拖拽）无竞态崩溃；拖拽 tab 到各投放区在动画中途取消不残留幽灵 tab

### 7.4 外部副作用检查
- **文件系统**：只允许写入会话 cwd / worktree / `GROK_HOME` 之内；越界必须被拒（单测覆盖路径穿越 `../`）
- **进程**：退出时所有子进程被清理（`before-quit` + parent-death binding）；不得残留孤儿 `agent stdio`
- **git**：任何 stage/commit/discard/worktree remove 都必须走 agent 扩展，且 destructive 操作（discard/remove/force）二次确认；不得有 shell 拼接（继续 `execFile` 参数数组）
- **配置**：写 `~/.grok/config.toml` 必须 round-trip 保留无关内容（沿用 `scripts/test-mcp-config.mjs` 断言）
- **网络**：除 agent 自身与 MCP 外，渲染层不得直连外部服务；外链一律 `shell.openExternal`
- **剪贴板/通知/徽章**：写入前有所属会话上下文；通知不含密钥或完整路径以外的敏感内容
- **IPC**：channel 白名单外的调用被拒并记日志；渲染层无法通过 `invoke` 触达未声明能力

---

## 8. 交付节奏建议

| 批次 | 内容 | 出口标准 |
|---|---|---|
| B0 | ISS-070 | PR CI 四道门生效；vitest 就位；esbuild 打包替换 sed；`npm run build` + `electron:pack` 绿 |
| B1 | ISS-071 / 072 / 073 / 074 | 单进程承载 N session（`ps` 验证）；12 个 ext 域 smoke 绿；布局状态机 + per-thread store 上线；127 命令注册；checklist 可生成 |
| B2 | ISS-075 / 076 / 086（三路并行） | App Shell 可拖出窗口；Composer 富文本可用；Settings 新容器就位 |
| B3 | ISS-077 / 078 / 079 | 控件行齐全；Review 面板对齐 99 条 `codex.review.*`；Thread 视图按轮聚合 |
| B4 | ISS-080 / 081 / 082 / 083 | 侧栏与 Header 操作齐全；真 pty 终端 + subagents；worktree 全生命周期 |
| B5 | ISS-084 / 085 / 087 / 088 | 插件/技能/MCP、自动化、onboarding+auth、平台集成 |
| B6 | ISS-089 | 21 处桩清零；Tauri 退役决策；总验收（parity checklist IN 项 100%） |

---

## 9. 未决事项（需你确认）

0. **🔴 最高优先：并行会话与编号冲突** —— 仓库已有 OPEN Epic **#128（ISS-069）**+ 16 张子 issue（ISS-070–085，且被重复创建为 #129–144 / #145–160 两套）。完整的重复检查报告、重叠判定表、排序冲突与裁决项（Q1–Q7）见 **`docs/plans/issues/README.md`**。本草稿已重编号为 **ISS-086–ISS-105** 避冲。**未得到授权前不会在 GitHub 上创建/关闭/编辑任何 issue。**
1. **§1.4 约束表**是否完整？特别是：交付时间窗、是否允许新增 devDependency（vitest / esbuild 显式化）、是否需要支持 Windows/Linux 视觉。
2. **设计决策 AD-1..AD-11** 是否全部认可（尤其 AD-2 per-thread store、AD-4 不留 IPC 兼容层、AD-7 Chat/Work 映射、AD-8 esbuild）。
3. **Issue 编号与粒度** —— 已重编号为 ISS-086…ISS-105（20 张）+ Epic 草案（ISS-106 或并入 #128）；去重后净新增 13 张、建议合并 7 张（明细见 `docs/plans/issues/README.md` §1.4）。
4. **GitHub 提交授权**：issue 草稿已生成在 `docs/plans/issues/`（21 个文件 + README 重复检查报告），创建 Issue/Epic、关闭 16 个孤儿副本、新增标签均属外部写操作，**需你明确授权**后才执行（命令已写在 README §3，未跑）。
5. **标签**：沿用 `priority/P*` + 域标签，并新增 `parity-foundation` / `parity-slice` / `supersedes-105` 三个标签？（新增标签也是外部写操作）
