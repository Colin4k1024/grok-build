# 能力吸收策略：Codex CLI & Claude Code 近期更新

> 基于 2026-08-05 对 Codex CLI v0.146.0 (2026-07-29) 和 Claude Code v2.1.222 (2026-08-04) 的分析

---

## 1. 原有 12 项能力差距：全部完成 ✅

| # | Issue | 状态 | 交付物 |
|---|-------|------|--------|
| #2 | Guardian Safety Layer | ✅ CLOSED | — |
| #3 | Unified Exec Layer | ✅ CLOSED | `xai-grok-exec-layer` |
| #4 | Turn-level Diff Tracker | ✅ CLOSED | — |
| #5 | Fine-grained Network Policy | ✅ CLOSED | — |
| #6 | Realtime Bidirectional Voice | ✅ CLOSED | `xai-grok-voice/realtime/` |
| #7 | Structured Context Manager | ✅ CLOSED | `xai-grok-context-manager` |
| #8 | Windows Sandbox Support | ✅ CLOSED | `xai-grok-sandbox/windows/` |
| #9 | Test Sync Tool | ✅ CLOSED | — |
| #10 | In-turn Sleep Tool | ✅ CLOSED | — |
| #11 | Build Attestation | ✅ CLOSED | `xai-grok-verify` |
| #12 | Command Canonicalization | ✅ CLOSED | — |
| #13 | New Context Window | ✅ CLOSED | `context_window.rs` + `budget_allocator.rs` |

---

## 2. Codex CLI v0.146.0 新增能力（需吸收）

### 2.1 Named Sessions + Thread Pinning（P2）

**能力描述**: `/new`、`/clear` 命名会话，pin 重要线程，side conversations 切换不关闭当前会话。

**grok-build 现状**: 有 `session/fork.rs` 和 session storage，但无命名/pin 功能。

**吸收建议**:
- 在 `xai-grok-shell/src/session/` 中添加 `SessionMeta { name, pinned, created_at }`
- TUI 中添加 `/new <name>`、`/pin`、`/threads` 命令
- 复用现有 `JsonlStorageAdapter` 的 session 索引

**预估工时**: 1-2 周 | **优先级**: P2

### 2.2 Agent Plugins Manifests + Multi-Marketplace（P2）

**能力描述**: Agent Plugin 标准化清单格式，workspace plugin 发布，支持 Amazon Bedrock 和 Claude Code marketplace。

**grok-build 现状**: 有 `xai-grok-plugin-marketplace/` 但功能有限。

**吸收建议**:
- 定义 Plugin Manifest schema（JSON Schema）
- 扩展 marketplace 客户端支持多源（xAI marketplace + Bedrock + Claude Code）
- 添加 workspace plugin 发布命令

**预估工时**: 2-3 周 | **优先级**: P2

### 2.3 Thread Forking with Paginated History（P3）

**能力描述**: Fork 线程带分页历史，支持临时 fork（不出现在列表中）。

**grok-build 现状**: 有 `session/fork.rs`（用户发起的 fork）+ `ContextWindowManager`（agent 发起）。缺分页和临时 fork。

**吸收建议**:
- 在 `ForkConfig` 中添加 `is_temporary: bool` 字段
- session history 查询添加分页支持（offset + limit）
- 临时 fork 在 `session_list()` 中过滤

**预估工时**: 1 周 | **优先级**: P3

### 2.4 Remote Code Mode via WebSocket（P3）

**能力描述**: App-server 通过 WebSocket 连接远程 Code Mode 主机。

**grok-build 现状**: 有 `xai-grok-workspace-client/` 但仅支持本地。

**吸收建议**:
- 在 `WorkspaceOps` 中添加 WebSocket transport 层
- 复用现有 ACP 协议的 WebSocket 实现

**预估工时**: 2-3 周 | **优先级**: P3

### 2.5 Standalone Web Search for Custom Providers（P4）

**能力描述**: 兼容自定义模型提供者的独立 web search。

**grok-build 现状**: 有 `web_search` tool，绑定 xAI Responses API。

**吸收建议**:
- 抽象 `WebSearchProvider` trait
- 添加 DuckDuckGo / Exa 等备选后端

**预估工时**: 1 周 | **优先级**: P4

---

## 3. Claude Code v2.1.219-222 新增能力（需吸收）

### 3.1 Focus View — 工具活动折叠（P2）

**能力描述**: VSCode 中 chat-menu toggle 隐藏工具活动，只显示每轮摘要 + 实时运行指示器。`Ctrl+Alt+F` 切换。

**grok-build 现状**: TUI 中工具输出全量显示，无折叠模式。

**吸收建议**:
- 在 `xai-grok-pager/src/scrollback/` 中添加 `FocusMode`
- 每个 tool turn 折叠为一行摘要（工具名 + 状态 + 耗时）
- 展开/折叠快捷键

**预估工时**: 1-2 周 | **优先级**: P2

### 3.2 Sandbox Credential Masking（P2）

**能力描述**: `mode: "mask"` — 沙箱内命令读取 sentinel 副本，沙箱代理在出口替换真实值。支持 `extract` regex。

**grok-build 现状**: 有 `xai-grok-secrets/` 但无沙箱级 credential masking。

**吸收建议**:
- 在 `xai-grok-sandbox` 中添加 `CredentialMask` 层
- 沙箱启动时注入 sentinel 文件
- 网络出口代理替换 sentinel → real value

**预估工时**: 2 周 | **优先级**: P2

### 3.3 `sandbox.network.strictAllowlist` 设置（P3）

**能力描述**: 拒绝非 allowlist 主机的沙箱命令，不弹确认框。

**grok-build 现状**: 有 `NetworkPolicy` 但无 strict allowlist 模式。

**吸收建议**:
- 在 `SandboxConfig` 中添加 `strict_allowlist: bool`
- 与现有 `WebsitePolicy` 集成

**预估工时**: 3 天 | **优先级**: P3

### 3.4 `DirectoryAdded` Hook（P3）

**能力描述**: `/add-dir` 或 SDK `register_repo_root` 后触发 hook。

**grok-build 现状**: 有 hooks 系统但无 `DirectoryAdded` 事件。

**吸收建议**:
- 在 `xai-grok-hooks/src/event.rs` 中添加 `DirectoryAdded` 事件
- TUI `/add-dir` 命令触发

**预估工时**: 3 天 | **优先级**: P3

### 3.5 Nested Subagent Forwarding（P3）

**能力描述**: 深度 2+ 的 subagent spawn 在 `--forward-subagent-text` 模式下可见。

**grok-build 现状**: subagent 输出已通过 `send_message` 传递，但嵌套 subagent 的可见性不完整。

**吸收建议**:
- 在 subagent resolution 中添加 depth tracking
- 转发嵌套 subagent 的关键事件到父级

**预估工时**: 1 周 | **优先级**: P3

### 3.6 Auto Mode Permission Classifier（P1）

**能力描述**: `SendMessage` 到其他 agent session 前经 permission classifier 评估。dangerous-rm、background-`&`、suspicious-Windows-path 检查由 classifier 裁决。

**grok-build 现状**: 有 hooks 系统的 gate model（Tool/Stop），但无 auto-mode permission classifier。

**吸收建议**:
- 在 `dispatch_pre_tool_use` 中添加 permission classifier
- 高风险操作（rm -rf、网络请求、文件覆盖）自动拦截
- 复用现有 `xai-grok-hooks` 的 gate 机制

**预估工时**: 1-2 周 | **优先级**: P1

---

## 4. 实施路线图

### Phase A — 安全与体验增强（1-2 周）

| # | 能力 | 优先级 | 工时 |
|---|------|--------|------|
| 3.6 | Auto Mode Permission Classifier | P1 | 1-2w |
| 3.2 | Sandbox Credential Masking | P2 | 2w |
| 3.3 | strictAllowlist | P3 | 3d |

### Phase B — 会话管理升级（2-3 周）

| # | 能力 | 优先级 | 工时 |
|---|------|--------|------|
| 2.1 | Named Sessions + Thread Pinning | P2 | 1-2w |
| 2.2 | Agent Plugins Multi-Marketplace | P2 | 2-3w |
| 2.3 | Thread Forking + Pagination | P3 | 1w |

### Phase C — UI 与远程能力（2-3 周）

| # | 能力 | 优先级 | 工时 |
|---|------|--------|------|
| 3.1 | Focus View (TUI 折叠模式) | P2 | 1-2w |
| 3.4 | DirectoryAdded Hook | P3 | 3d |
| 3.5 | Nested Subagent Forwarding | P3 | 1w |
| 2.4 | Remote Code Mode WebSocket | P3 | 2-3w |
| 2.5 | Web Search Multi-Provider | P4 | 1w |

---

## 5. grok-build 领先优势（无需补齐）

| 能力 | Codex/Claude Code 状态 | grok-build 优势 |
|------|----------------------|-----------------|
| Self-Evolution Pipeline | 无 | 8-stage 自进化闭环（signal → trial → validate → solidify） |
| LSP 深度集成 | 基础 | go-to-def, references, call hierarchy, diagnostics |
| Computer Use | 无 | Browser + Desktop GUI 自动化 |
| Image/Video Generation | 无 | 多模态生成集成 |
| Codebase Graph | 无 | 项目级代码知识图谱 |
| Goal-Oriented Planning | 无 | classifier → strategist → planner → evaluator 闭环 |
| Worktree Isolation | 有限 | Git worktree 试验隔离 + 自动合并 |
| Unified Exec Layer | 无 | 原子回滚 + diff 追踪（刚实现） |
| Bidirectional Voice | 无 | Realtime API + Barge-in（刚实现） |

---

## 6. 总结

**当前状态**: 原有 12 项能力差距已全部补齐（100%）。

**新增差距**: Codex CLI v0.146.0 和 Claude Code v2.1.219-222 引入了 **11 项新能力**需要吸收。

**推荐策略**:
1. **安全优先**: Auto Mode Permission Classifier 和 Sandbox Credential Masking 是高优先级
2. **体验跟进**: Named Sessions 和 Focus View 是用户直接感知的能力
3. **生态扩展**: Plugin Multi-Marketplace 和 Remote Code Mode 是平台级能力
4. **保持领先**: Self-Evolution、Codebase Graph、Computer Use 等独有能力继续迭代
