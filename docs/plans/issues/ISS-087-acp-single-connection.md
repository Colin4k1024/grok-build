> Epic: #128 (ISS-069) · 批次: B1 · 标签: `parity-foundation` `architecture` `priority/P1` `backend` `agent`
> 规格来源: 差距文档 §2(A1–A28) §7.1；设计文档 §6(AD-1) §3(R1,R2,R7)

## 目标

把「每 tab 一个 agent 进程」改为「**单 ACP 连接 + N session**」，并建立 typed `x.ai/*` 客户端，使 294 个 agent 扩展方法可按域调用 —— 这是所有跨线程能力（side chat、subagent 可见性、priority threads、recently viewed、崩溃恢复）的前置。

## 范围

1. **Spike（第一优先，决定后续路径）**：一条 `grok agent stdio` 连接上连续 `session/new` 两个**不同 cwd** 的会话，验证：各自 sessionId 独立、事件按 sessionId 正确路由、per-session cwd 生效（在 A 会话读不到 B 会话目录的文件）、两个会话可并发跑 turn
2. `electron/agent/connection.ts`：单连接生命周期（spawn 一次 / JSON-RPC id 命名空间 / 请求超时 / 背压 / stdin EOF 检测 / 自动重连 / 进程存活监护）；连接进程使用**中性 cwd**（app path），项目 cwd 只经 `session/new` 传入
3. `electron/agent/sessions.ts`：session registry（`new`/`load`/`prompt`/`cancel`/`set_model`/`close`），按 sessionId 路由 notification，未知 sessionId 的事件进 dead-letter 并告警
4. `electron/agent/capabilities.ts`：显式声明 fs / terminal / mcp / hooks / hunkTracker / codeNavigation / gitHeadChanged / statusLine 等（对齐 agent 侧 gate；当前只声明 `fs`，`terminal:false`）
5. `electron/agent/ext/*.ts`：typed client，**首批 12 个域**：`commands`(`x.ai/commands/list`)、`session`(`list/info/fork/rename/delete/search/state`)、`git`(`status/diffs/files/branches/commit/stage/unstage/discard/info`)、`hunk`(`get-hunks/get-files/get-summary/hunk-action/file-action/all-action/turn-action`)、`terminal`(`pty/create·input·resize·load`, `create/output/list/background/kill`)、`subagent`(`list_running/get/message/cancel`)、`skills`(`list/add/remove/toggle/config`)、`plugins`(`list/action/reload`)、`mcp`(`list/upsert/delete/toggle/toggle_tool/server_status/auth_status/auth_trigger/elicit/read_resource`)、`scheduler`(`*`, `scheduled_task_*` 通知)、`queue`(`changed/edit/remove/reorder/clear/interject`)、`config`(`config_changed/settings/update/sessionConfig/models/list`)
6. `electron/agent/reverse.ts`：反向请求真实实现 —— `fs/read_text_file`、`fs/write_text_file`（当前返回空内容）、`terminal/*`、`x.ai/hooks/run`、`x.ai/mcp/sdk_call`、`x.ai/folder_trust/request`、`session/request_permission`、`x.ai/ask_user_question`
7. `electron/agent/events.ts`：归一化事件总线（typed union 替代字符串 `type` 判断），保留 `replay` 语义
8. **smoke 脚本**：`scripts/test-agent-connection.mjs`（多会话路由 + 并发 turn + 断线重连 + 12 域各一次真实调用）

## 非目标

- 不做前端 UI 变更（本 issue 只到 IPC 边界；`lib/tauri.ts` 的调用方保持不变或最小适配）
- 不接 A28（cloud/remote task）、不接 `x.ai/evolution/*`、`x.ai/billing`、`x.ai/share_session`（OUT 范围）
- 不改 Rust agent 代码
- 不实现 per-thread 前端状态（ISS-088）

## 依赖

- ISS-086（CI + vitest + esbuild 子目录打包 —— 本 issue 大量新增 `electron/agent/**` 子目录，**强依赖 G3 修复**）
- 本地 `target/{debug,release}/xai-grok-pager` 或 `GROK_AGENT_BIN`
- leader socket `~/.grok/leader.sock`（`GROK_HOME` 可覆盖）

## 回滚

保留 `electron/acp-session.ts` 至本 issue 合入并稳定一个批次；回滚 = 恢复 `main.ts` 的 session 工厂指向旧 `AcpSession`，删除 `electron/agent/`。IPC channel 名与 payload 形状保持不变，故前端无需回滚。

**若 Spike 失败**（agent stdio 不支持多 session）：不改本 issue 目标，改走回退方案 —— 每 tab 一进程但共享 leader + 主进程侧加会话注册表与跨进程事件合并层（成本约 +30%），并在 Epic 上记录 R1 已兑现。

## 验收标准

### 状态机不变量
- **进程数不变量**：打开 N 个 tab（N≥3）后 `pgrep -f 'agent stdio' | wc -l` == 1
- 一个 `threadId` 任一时刻至多绑定一个 `sessionId`；`session/load` 重绑后旧 sessionId 的事件必须被丢弃（不进 UI）
- 连接状态机：`idle → connecting → ready → (degraded → reconnecting → ready) → closed`；`ready` 前所有 `ext.*` 调用必须排队或明确拒绝，不得静默丢
- 每个 request 有唯一 id 且响应/超时一一对应；pending map 在连接重建后必须清空并 reject 全部在途请求
- capabilities 未声明的扩展方法，调用必须返回明确 `MethodNotSupported`，不得静默成功

### 负向场景
- agent 二进制缺失 / 无执行权限 / 启动即退出 → 三种错误各自有可区分的错误码与用户可操作提示
- `session/new` 传相对路径 → 明确报错（agent 侧 "Path is not absolute"），前端不崩
- `session/load` 一个不存在的 sessionId → 错误透传，tab 不被静默创建
- cwd 不存在 / 无读权限 / 不是 git 仓库（调 `x.ai/git/status`）→ 各自错误态
- 反向请求 `fs/write_text_file` 目标在受信目录外 → 必须拒绝（不允许 agent 借客户端越界写）
- 请求超时（agent 卡住）→ 超时后 pending 清理，后续请求仍可发出（连接不被一个卡死请求拖垮）

### 并发 / 崩溃 / 恢复
- 两个 session 同时跑 turn：事件**零串台**（断言：A 的 TextDelta 绝不出现在 B 的消息流）
- 一个 session `cancel` 不影响另一个正在跑的 session
- `kill -9` agent 进程：前端进入 `degraded`；重连后已存在 tab 保留、transcript 不丢；在途 prompt 以错误结束而非永久 pending
- app 重启：对每个持久化 tab 走 `session/load`；回放事件带 `replay:true` 且不触发 streaming 指示（沿用现有语义并加断言）
- 与 `grok` TUI 同时连同一 leader：双方 session 列表互相可见、不互踢；收到 `x.ai/leader/version_mismatch` 时给出可操作提示而非静默失败
- 100 条快速连续 `ext.*` 调用（含 10 个并发 turn）无死锁、无 id 冲突、无内存无界增长

### 外部副作用检查
- 子进程清理：app 退出后无孤儿 `agent stdio`（`pgrep` 断言）；连接进程 parent-death binding 生效
- `fs/write_text_file` 只允许写入 会话 cwd / 关联 worktree / `GROK_HOME` 之内；路径穿越（`../`、符号链接、绝对路径越界）必须被拒 —— 单测覆盖
- 不新增网络出口：所有调用经 agent 子进程；主进程不得直接 `fetch` 模型 API
- 日志不得打印 API key、完整 prompt 内容或文件正文（只打 id/长度/摘要）
- `GROK_HOME` 覆盖全链路生效（connection / sessions / ext / reverse 均不得硬编码 `~/.grok`）

### Parity 勾选项
- [ ] A1 capabilities 声明完整（对齐 agent gate）
- [ ] A2 `x.ai/hunk-tracker/*` 可调通（为 ISS-094 铺路）
- [ ] A3 `x.ai/git/*` 取代 `execFile('git')`（`main.ts:367-455` 的 8 个 handler 改为转发）
- [ ] A4 `x.ai/terminal/pty/*` 可调通（为 ISS-098 铺路）
- [ ] A5 `x.ai/subagent/*` 可调通
- [ ] A6 `x.ai/commands/list` 可调通
- [ ] A7/A9 `x.ai/skills/*`、`x.ai/mcp/*` 可调通
- [ ] A10 `x.ai/scheduler/*` + `scheduled_task_*` 通知可调通
- [ ] A14/A15/A23 `x.ai/session/*`、`x.ai/queue/*`、`x.ai/config_changed` 可调通
- [ ] A25 反向 fs 请求返回真实内容
- [ ] G1 关闭（单进程多会话）
