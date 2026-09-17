# Desktop ↔ Codex 对齐（Electron 端）

> 2026-09-17：桌面端能力与色彩向 Codex 对齐的第二批工作（第一批见 `3112df0a`）。

## 能力对齐

| 能力 | Codex 行为 | 桌面端实现 |
|---|---|---|
| 线程恢复 (resume) | `/resume` / 点击线程恢复完整上下文 | `session_resume` IPC → ACP `session/load`，agent 重放完整转录（`_meta.isReplay` 标记，前端重建 user/assistant 双侧消息且不触发 streaming 指示） |
| 线程列表 | 首页/侧栏列出全部历史线程 | `session_list_history` 读 `~/.grok/sessions/*/*/summary.json`；Home "Recent threads" + 侧栏 "Threads" 入口（原 SessionPicker 无入口，已接通） |
| 重启连续性 | 线程跨重启存活 | tab 持久化 `acpSessionId`，启动时对已死 tab 逐个 `session/load` 重绑（`rebindTabId`），无法恢复的才修剪 |
| 只读转录 | — | `session_get_history` 优先解析 `updates.jsonl`（与 replay 同源的权威流），降级 `chat_history.jsonl`；作为 resume 失败时的后备显示 |
| 线程删除 | `/delete` 永久删除 | `session_delete_history` 删除会话目录 + Threads 选择器删除按钮 |
| MCP 管理 | `~/.codex/config.toml` `[mcp_servers]` | `electron/mcp-config.ts` 外科手术式编辑 `~/.grok/config.toml` 的 `[mcp_servers.*]` 段（其余内容逐行原样保留），支持 stdio/http、env 子表、enabled 开关 |
| Worktree | git worktree 管理 | `git_worktree_list/add/remove`、`git_list_branches`（execFile 参数数组，无 shell） |
| 自启动 | 登录启动 | `app.setLoginItemSettings` |
| GROK_HOME | 环境变量覆盖 | `session-history.ts` / `mcp-config.ts` / key store 均支持 `GROK_HOME` 覆盖，与 agent 行为一致 |

## 色彩对齐

依据 `codex-rs/tui/styles.md`（选择/状态=cyan、成功=green、错误=red、Codex 品牌=magenta、避免 blue/yellow）与 `codex-rs/tui/src/style.rs`（user_message_bg = 暗底白 12% / 亮底黑 4%）：

| Token | 值（暗） | 用途 |
|---|---|---|
| `--gb-bg` | #212121 | Codex TUI 暗色底 |
| `--gb-accent` | **#22d3ee (cyan)** | 选中/状态/链接（原 #4a9eff 蓝已废弃——styles.md 明确避免蓝） |
| `--gb-brand` | **#d946ef (magenta)** | Codex 品牌 ✻ 标记（TitleBar / Home） |
| `--gb-green/red` | #34d399 / #f87171 | 成功/新增、错误/删除 |
| `.gb-user-bubble` | 白 12% / 黑 4% | 用户消息气泡，精确复刻 `user_message_bg` |

另：Diff/Terminal 从 GitHub 暗色（#0d1117）换成 Codex 中性色（#1c1c1c/#d6d6d6）；修复未定义的 `rounded-gb`/`dropdown-shadow`/`hover-lift` 空操作类。

## 验证

- `npm run build` + `bash electron/build.sh` 通过
- `scripts/test-mcp-config.mjs`：MCP 段编辑 round-trip（解析/开关/新增/删除，无关段逐字保留）
- `scripts/test-session-resume.mjs`：真实 agent `session/load` 端到端（replay 事件带 `replay:true`，UserMessage 回放正确）
- Electron 冒烟启动 12s 无报错
