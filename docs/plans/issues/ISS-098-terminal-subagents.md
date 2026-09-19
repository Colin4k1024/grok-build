> Epic: #128 (ISS-069) · 批次: B4 · 标签: `parity-slice` `terminal` `agent` `right-panel` `priority/P1` `frontend` `backend`
> 规格来源: 差距文档 §A4/A5 §F11 §G(Terminal/Subagents)；实物模块 `terminal-panel` `terminal-tab` `background-terminal` `xterm-output-panel` `local-conversation-background-terminal-tab` `terminal-workspace-warning-state` `subagent-panel` `subagent-row` `chatgpt-subagents-panel` `local-conversation-subagents-panel-tab` `agent-activity-item` `agent-activity-units`；文案 `codex.localConversation.backgroundAgents.*`(6) `backgroundTerminals.*`(4) `backgroundTasks.*`(2)

## 目标

把只读回显的终端升级为**真实交互式 PTY 终端**（多 tab、可输入、后台终端、底部面板承载），并把 subagent 面板从"工具名猜测"换成 agent 真值（列表/详情/消息/取消）。

## 范围

1. **PTY 接线**：`x.ai/terminal/pty/{create,input,resize,load}` + `x.ai/terminal/{create,output,list,background,kill,release,wait_for_exit}`；capabilities 声明 `terminal:true`（当前 `false`）
2. **Terminal panel**：xterm.js（已在依赖）+ FitAddon + WebLinksAddon；**可输入**（移除 `disableStdin:true`）；多 tab（`terminal-tab`）；字体缩放（现有 ⌘+/⌘- 保留）；`xterm-output-panel` 输出面板；`terminal-workspace-warning-state`（工作区告警）
3. **底部面板承载**：终端作为 bottom panel 的首个 tab（ISS-091 提供容器），`toggleBottomPanel`(⌘J)、命令 `toggleTerminal`
4. **后台终端**：`background-terminal` + `local-conversation-background-terminal-tab`；`codex.localConversation.backgroundTerminals.{defaultLabel,stop,cleanError}`（Stop all background terminals）
5. **消息流内的 exec 输出**：`exec-shell-container` 语义 —— 工具执行的 shell 输出在轮内可展开（与 ISS-095 的 turn items 协同），支持增量输出（`x.ai/incrementalBashOutput`、`x.ai/bashOutputNoColor`）
6. **Subagents 面板**：`x.ai/subagent/{list_running,get,message,cancel}` 替换 `useAcpSession.ts:8-13` 的工具名猜测；`subagent-panel` + `subagent-row` + `chatgpt-subagents-panel` + `local-conversation-subagents-panel-tab`；状态机 `spawning/running/done/failed` 来自 agent 真值；`backgroundAgents.{activeLabel,collapsedWorkingCount,collapsedDoneCount,modelTooltip,openSummary}`
7. **Agent 活动时间线**：`agent-activity-item` + `agent-activity-units`（side panel 或轮内展开，与 ISS-095 turn items 复用组件）
8. **Background processes**：`backgroundTasks.title.{subagents,backgroundProcesses}` + `x.ai/task/{list,kill}` + `x.ai/task_backgrounded`
9. 删除假数据路径：`useAcpSession.ts` 的 `SUBAGENT_TOOLS` 猜测逻辑

## 非目标

- 云端/远程终端、remote hosted PiP、computer use（OUT）
- 完整终端复用器（tmux 类）能力、终端 profile 管理
- 终端内运行 agent 的交互式 TUI（不提供"在桌面里跑 grok TUI"）
- Chrome tabs / browser 终端（OUT）

## 依赖

- ISS-087（terminal/subagent/task 扩展域 + capabilities）
- ISS-091（bottom panel + side panel tab 容器）
- ISS-095（turn items 中的 exec 输出渲染）
- 原生模块：若需本地 node-pty 则属新增依赖 —— **优先用 agent 的 pty 扩展**，避免在 Electron 内编译原生模块

## 回滚

flag `terminal.pty`；回滚 = 恢复只读回显终端（`run_command` 一次性输出）。subagent 回滚 = 恢复工具名猜测（仅作降级，需在 checklist 标记为未达标）。PTY 会话是易失的，回滚不需数据迁移。

## 验收标准

### 状态机不变量
- 每个终端 tab 恰对应一个 agent 侧 pty id；关闭 tab ⟹ `pty/kill` 或 `release` 被调用，无孤儿 pty（`x.ai/terminal/list` 校验）
- 终端状态：`creating → ready → (busy) → exited/killed`；`exited` 后输入被禁用并显示退出码
- resize 后 agent 侧 pty 尺寸 == xterm 尺寸（行列一致断言）
- subagent 状态只能由 agent 事件驱动；UI 不得自行推断（`SUBAGENT_TOOLS` 猜测代码必须删除，grep 可验证）
- `list_running` 结果与面板显示集合一致；cancel 后该 subagent 必进入 `done|failed`
- 后台终端计数 == agent 侧计数；"Stop all" 后计数为 0

### 负向场景
- pty 创建失败（agent 不支持 / 权限 / cwd 不存在）→ 明确错误 + 回退到只读输出模式并标注降级
- 输入到已退出 pty → 无副作用 + 提示
- 超大输出（>10MB）/ 高频输出（编译日志）→ 有节流与滚动上限，不卡死渲染进程
- ANSI/256 色/光标控制/交替屏幕（vim 类）→ 渲染正确或有明确不支持提示
- `x.ai/subagent/cancel` 失败 → 面板保留原状态 + 错误提示，不显示假 done
- `x.ai/task/list` 为空 / 失败 → 空态 / 错误态

### 并发 / 崩溃 / 恢复
- 多个终端 tab 同时输出 → 事件按 pty id 路由，零串台
- 终端运行中切 tab / 打开 detached window → 输出不丢（`pty/load` 回放缓冲）
- kill agent → 所有 pty 视为 exited；重连后可新建，旧 tab 显示明确断开态
- app 重启 → 终端 tab 不自动恢复进程（PTY 不可跨进程恢复），但需显示"上次会话已结束"而非空白；后台终端列表从 agent 恢复
- subagent 运行中 app 重启 → 从 `list_running` 恢复显示
- 快速连点新建/关闭终端（20 次）→ 无泄漏（pty 数收敛）、无竞态崩溃

### 外部副作用检查
- **终端可执行任意命令 = 最高风险面**：必须受会话的 sandbox/approval 档位约束；read-only 档位下不得创建可写 pty
- 终端 cwd 必须落在会话 cwd / worktree 内；不得默认以 `/` 或 home 启动
- pty 子进程在 app 退出、thread 关闭、面板关闭三种路径下都被清理（`pgrep` 断言无孤儿）
- 终端输出写入日志时不得包含环境变量全文或密钥
- `task/kill`、`subagent/cancel`、"Stop all background terminals" 属破坏性操作，需确认或可撤销提示

### Parity 勾选项
- [ ] A4 terminal pty 接线（capabilities `terminal:true`）
- [ ] A5 subagent 真值（假数据路径删除）
- [ ] G Terminal tab（多 tab / 可输入 / 输出面板 / 工作区告警）
- [ ] F11 后台终端区块 + Stop all
- [ ] `backgroundAgents.*` 6 条、`backgroundTerminals.*` 4 条、`backgroundTasks.*` 2 条
- [ ] `agent-activity-item` / `agent-activity-units` 时间线
