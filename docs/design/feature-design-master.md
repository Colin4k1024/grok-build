# Grok Build Feature Design Master

> 7 个 GitHub Issues 的详细功能设计、架构方案与实施路线图

---

## 目录

1. [架构现状分析](#1-架构现状分析)
2. [#7 Structured Context Manager — 统一上下文生命周期管理](#7-structured-context-manager)
3. [#3 Unified Exec Layer — 统一执行层 + 原子回滚](#3-unified-exec-layer)
4. [#13 New Context Window — Agent 主动开启新上下文](#13-new-context-window)
5. [#6 Realtime Bidirectional Voice — 双向语音对话](#6-realtime-bidirectional-voice)
6. [#8 Windows Sandbox Support — Windows 原生沙箱](#8-windows-sandbox-support)
7. [#11 Build Attestation — 构建产物签名与验证](#11-build-attestation)
8. [实施路线图与优先级](#实施路线图与优先级)

---

## 1. 架构现状分析

### 核心模块拓扑

```
xai-grok-pager (TUI 主入口, 500+ .rs files)
├── xai-grok-agent          # Agent 编排层
├── xai-grok-shell           # Shell 会话管理 (738 files)
├── xai-grok-tools           # 工具实现层 (249 files)
│   ├── implementations/grok_build/    # bash, search_replace, read_file, write...
│   ├── implementations/codex/         # apply_patch, grep_files...
│   ├── registry/                      # 工具注册表
│   └── types/                         # 工具类型定义
├── xai-grok-voice           # 语音 STT 管线 (仅单向)
├── xai-grok-sandbox         # OS 沙箱 (macOS seatbelt / Linux landlock)
├── xai-grok-memory          # 记忆系统
├── xai-grok-hooks           # Hooks 系统
├── xai-grok-mcp             # MCP 集成
└── xai-grok-evolution       # 进化系统 (52 files)

xai-grok-compaction (common crate, 40 files)
├── code_compaction/         # grok-build 全量替换压缩
├── intra_compaction/        # Grok chat 尾部保留
├── inter_compaction/        # Grok chat 分块压缩
├── history/                 # 历史过滤与验证
└── item/token/sampler       # 共享 trait 接口
```

### 关键现状问题

| 问题 | 当前状态 | 影响 |
|------|---------|------|
| 上下文管理分散 | `compaction.rs` + `compaction_segments.rs` + `memory_state.rs` + 独立 crate | Token 预算无统一视图，增量更新缺失 |
| 工具执行无事务 | bash/search_replace/write 各自独立执行，通过 `ToolBridge` → `FinalizedToolset` → `ToolDyn::execute()` 调度 | 无回滚、无 diff 追踪、无原子性 |
| 语音仅单向 | STT 管线 + subprocess 采集 (`VoiceEvent` → pager) | 无语音回复、无中断、无 voice-mode tool use |
| 沙箱仅 Unix | macOS seatbelt + Linux landlock/seccomp | Windows 用户无隔离保护 |

### 核心调度链路（现有）

```
Model → tool_call → SessionActor
  → xai-grok-hooks::dispatch_pre_tool_use (gate: allow/deny)
  → ToolBridge::execute()
    → FinalizedToolset::call()
      → prepare_dispatch() → ToolDyn::execute() → Tool::run()
  → xai-grok-hooks::dispatch_post_tool_use (observe)
  → SessionSignalsDelta → xai-grok-evolution (signal collection)
  → auto-compaction check (Agent::should_auto_compact)
```

**关键 trait**: `xai-tool-runtime::Tool` — 每个工具实现 `run(ctx, args) → Result<Output, ToolError>` 或 `execute(ctx, args) → ToolStream`。Unified Exec Layer 应在此 trait 之上包装，不替换底层调度。

---

## 2. #7 Structured Context Manager — 统一上下文生命周期管理

**优先级**: P3 | **标签**: architecture, capability-gap | **预估工时**: 3-4 周

### 2.1 问题定义

当前上下文管理分散在三处：

1. **`session/compaction.rs`** — 会话级压缩触发逻辑
2. **`session/compaction_segments.rs`** — 压缩分段策略
3. **`xai-grok-compaction/`** — 独立 crate，含 `code_compaction` / `intra_compaction` / `inter_compaction` 三套子系统

缺失的能力：
- 统一的 `ContextManager` 入口
- Token budget 全局感知
- 增量更新（当前仅全量重建）
- 与 evolution signal 的对接

### 2.2 设计方案

#### 2.2.1 核心 Trait: `ContextManager`

```rust
// crates/codegen/xai-grok-context-manager/src/lib.rs

use std::sync::Arc;

/// 统一上下文管理器 trait — 所有上下文操作的唯一入口
pub trait ContextManager: Send + Sync {
    /// 获取当前上下文的完整消息历史
    fn history(&self) -> &[ContextMessage];

    /// 追加一条新消息到上下文尾部
    fn push(&mut self, msg: ContextMessage) -> ContextResult<()>;

    /// 增量更新：替换指定 range 的消息（而非全量重建）
    fn patch(&mut self, range: std::ops::Range<usize>, msgs: Vec<ContextMessage>) -> ContextResult<()>;

    /// 获取当前 token 消耗量
    fn token_usage(&self) -> TokenUsage;

    /// 获取 token 预算配置
    fn token_budget(&self) -> &TokenBudget;

    /// 触发 compaction（返回压缩前后的 diff 摘要）
    fn compact(&mut self, strategy: CompactionStrategy) -> ContextResult<CompactionReport>;

    /// 正则化：去重、合并相似消息、清理无效内容
    fn normalize(&mut self) -> ContextResult<NormalizeReport>;

    /// 创建子上下文窗口（对应 #13）
    fn fork(&self, config: ForkConfig) -> ContextResult<Box<dyn ContextManager>>;

    /// 从子上下文合并结果摘要
    fn merge_summary(&mut self, child: &dyn ContextManager, max_tokens: usize) -> ContextResult<()>;
}
```

#### 2.2.2 数据模型

```rust
/// 上下文消息 — 统一消息表示
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMessage {
    pub id: MessageId,
    pub role: MessageRole,
    pub content: MessageContent,
    pub token_count: Option<usize>,     // 懒计算
    pub metadata: MessageMetadata,
    pub compaction_state: CompactionState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool { call_id: String },
    Compaction,  // 压缩产生的摘要消息
}

/// 消息元数据 — 支持增量更新和追踪
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MessageMetadata {
    pub turn_id: Option<TurnId>,
    pub source: Option<MessageSource>,       // user_input, tool_result, compaction, subagent
    pub is_compacted: bool,
    pub original_range: Option<(usize, usize)>,  // 压缩前的原始 range
    pub evolution_signal: Option<String>,     // 对接 evolution 系统
}

/// Token 使用量
#[derive(Debug, Clone, Default)]
pub struct TokenUsage {
    pub total: usize,
    pub by_role: HashMap<MessageRole, usize>,
    pub compacted_tokens: usize,      // 被压缩掉的 token 数
    pub summary_tokens: usize,        // 摘要占用的 token 数
}

/// Token 预算配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBudget {
    pub max_total: usize,              // 上下文窗口上限
    pub auto_compact_threshold: f64,   // 自动压缩阈值 (0.0-1.0)
    pub reserve_for_response: usize,   // 为模型回复预留的 token
    pub sub_budget: SubBudgetAllocation,
}

/// 子预算分配（对应 #13 New Context Window）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubBudgetAllocation {
    pub child_max_ratio: f64,          // 子上下文最多占父上下文的比例
    pub summary_injection_max: usize,  // 子上下文摘要回注的最大 token 数
}
```

#### 2.2.3 增量更新引擎

```rust
/// 增量更新操作
#[derive(Debug, Clone)]
pub enum ContextPatch {
    /// 追加新消息
    Append(Vec<ContextMessage>),
    /// 替换指定 range
    Replace { range: Range<usize>, messages: Vec<ContextMessage> },
    /// 删除指定 range
    Remove(Range<usize>),
    /// 标记为已压缩（保留引用但压缩内容）
    Compact { range: Range<usize>, summary: ContextMessage },
}

/// 增量更新引擎 — 核心差异化能力
pub struct IncrementalEngine {
    /// 消息索引（支持 O(1) 查找）
    index: HashMap<MessageId, usize>,
    /// Dirty range 追踪（仅对 dirty 区域重新计算 token）
    dirty_ranges: Vec<Range<usize>>,
    /// Token 缓存
    token_cache: TokenCache,
}

impl IncrementalEngine {
    /// 应用 patch 并仅重新计算 dirty 区域的 token
    pub fn apply_patch(&mut self, messages: &mut Vec<ContextMessage>, patch: ContextPatch) -> Result<()> {
        // 1. 标记 affected range 为 dirty
        // 2. 应用 patch 到 messages
        // 3. 仅对 dirty range 重新计算 token（而非全量）
        // 4. 清除 dirty 标记
        // 5. 更新 index
        // 性能目标: < 全量重建的 20% 开销
    }
}
```

#### 2.2.4 与现有 Compaction 的集成

```
┌─────────────────────────────────────────────────┐
│              ContextManager (新)                  │
│  ┌─────────────┬──────────────┬────────────────┐ │
│  │  History     │  Token Budget │  Incremental   │ │
│  │  Manager     │  Manager      │  Engine        │ │
│  └──────┬──────┴──────┬───────┴───────┬────────┘ │
│         │             │               │           │
│  ┌──────▼─────────────▼───────────────▼────────┐ │
│  │         Compaction Adapter Layer             │ │
│  │  (封装现有 code_compaction / intra / inter)  │ │
│  └──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
  xai-grok-compaction    session/memory_state
  (保持不变)             (逐步迁移到新接口)
```

**迁移策略**：不重写 `xai-grok-compaction`，而是通过 Adapter 模式接入。`ContextManager` 持有 `Arc<dyn CompactionAdapter>`，内部委托给现有 compaction 子系统。

#### 2.2.5 新 Crate 结构

```
crates/codegen/xai-grok-context-manager/
├── Cargo.toml
└── src/
    ├── lib.rs                  # ContextManager trait + re-exports
    ├── types.rs                # ContextMessage, TokenUsage, TokenBudget
    ├── engine.rs               # IncrementalEngine
    ├── normalize.rs            # 正则化逻辑（去重、合并）
    ├── compaction_adapter.rs   # 接入现有 compaction 子系统
    ├── fork.rs                 # 子上下文 fork/merge（对接 #13）
    ├── token_cache.rs          # Token 计算缓存
    └── history.rs              # 历史过滤与索引
```

### 2.3 验收标准映射

| 验收标准 | 实现方案 |
|---------|---------|
| ContextManager 统一管理消息历史 | `trait ContextManager` + `history()` / `push()` / `patch()` |
| Token budget 可配置并自动触发 compaction | `TokenBudget.auto_compact_threshold` + 自动检查 hook |
| 增量更新 < 全量重建的 20% 开销 | `IncrementalEngine` 仅对 dirty range 重新计算 |
| 现有 compaction 测试不退化 | Adapter 模式 + 回归测试套件 |

### 2.4 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Token 计算缓存一致性 | 缓存过期导致预算判断错误 | 引用计数 + dirty 标记双保险 |
| 与现有 session 状态的竞争 | 并发访问 ContextManager | `parking_lot::RwLock` 分段锁 |
| Compaction Adapter 抽象泄漏 | 不同 compaction 策略的差异被暴露 | 统一输入输出格式 + 测试矩阵 |

---

## 3. #3 Unified Exec Layer — 统一执行层 + 原子回滚

**优先级**: P2 | **标签**: architecture, capability-gap | **预估工时**: 4-5 周

### 3.1 问题定义

当前 `bash`、`search_replace`、`write` 是独立 tool，各自执行，无统一事务语义。对比 Codex CLI 的 `unified_exec` 模块，缺失：

- Pre-state snapshot 自动记录
- Per-operation 回滚
- 统一的 exec 结果格式化
- Diff 追踪

### 3.2 设计方案

#### 3.2.1 核心 Trait: `UnifiedExecutor`

```rust
// crates/codegen/xai-grok-exec-layer/src/lib.rs

/// 统一执行层 — 所有文件/命令操作的唯一入口
pub trait UnifiedExecutor: Send + Sync {
    /// 执行 bash 命令（自动记录 pre-state snapshot）
    fn exec_bash(&self, cmd: BashRequest) -> ExecResult<BashOutput>;

    /// 执行文件编辑（自动记录 pre-state snapshot）
    fn exec_edit(&self, edit: EditRequest) -> ExecResult<EditOutput>;

    /// 执行文件写入（自动记录 pre-state snapshot）
    fn exec_write(&self, write: WriteRequest) -> ExecResult<WriteOutput>;

    /// 回滚最后一次操作
    fn undo_last(&self) -> ExecResult<UndoReport>;

    /// 回滚指定操作（按 operation_id）
    fn undo(&self, op_id: OperationId) -> ExecResult<UndoReport>;

    /// 获取当前事务的 diff 摘要
    fn diff_summary(&self) -> DiffSummary;

    /// 获取操作历史
    fn history(&self) -> &[OperationRecord];
}
```

#### 3.2.2 操作记录与快照

```rust
/// 操作记录 — 每次 exec 的完整元数据
#[derive(Debug, Clone)]
pub struct OperationRecord {
    pub id: OperationId,
    pub op_type: OperationType,
    pub timestamp: Instant,
    pub pre_state: PreState,
    pub post_state: Option<PostState>,  // None = 执行失败
    pub duration: Duration,
    pub diff: Option<FileDiff>,
}

#[derive(Debug, Clone)]
pub enum OperationType {
    Bash { command: String },
    Edit { file: PathBuf, old_content_hash: String },
    Write { file: PathBuf, existed: bool },
}

/// Pre-state — 自动记录，用于回滚
#[derive(Debug, Clone)]
pub enum PreState {
    /// Bash 命令：记录当前工作目录和环境变量快照
    Bash { cwd: PathBuf, env_snapshot: HashMap<String, String> },
    /// 文件编辑/写入：记录文件内容快照（或 hash + 增量）
    File { path: PathBuf, snapshot: FileSnapshot },
}

#[derive(Debug, Clone)]
pub enum FileSnapshot {
    /// 小文件（< 1MB）：完整内容
    Full(Vec<u8>),
    /// 大文件：SHA-256 hash + 仅记录变更 chunk
    Incremental { hash: String, changed_chunks: Vec<ChunkDiff> },
    /// 文件不存在（新建场景）
    NonExistent,
}

/// File diff — 用于 diff summary 展示
#[derive(Debug, Clone)]
pub struct FileDiff {
    pub path: PathBuf,
    pub hunks: Vec<DiffHunk>,
    pub stats: DiffStats,
}

#[derive(Debug, Clone)]
pub struct DiffStats {
    pub additions: usize,
    pub deletions: usize,
    pub files_changed: usize,
}
```

#### 3.2.3 回滚引擎

```rust
/// 回滚引擎 — 管理操作栈和回滚执行
pub struct RollbackEngine {
    /// 操作栈（LIFO）
    ops: Vec<OperationRecord>,
    /// 文件锁管理器（防止并发回滚冲突）
    file_locks: FileLockManager,
    /// 最大快照内存限制
    max_snapshot_memory: usize,
    /// 当前快照内存使用量
    current_snapshot_memory: usize,
}

impl RollbackEngine {
    /// 记录操作的 pre-state
    pub fn record_pre_state(&mut self, op: &mut OperationRecord) -> Result<()> {
        match &op.op_type {
            OperationType::Edit { file, .. } | OperationType::Write { file, .. } => {
                let snapshot = self.capture_file_snapshot(file)?;
                self.current_snapshot_memory += snapshot.memory_size();
                op.pre_state = PreState::File {
                    path: file.clone(),
                    snapshot,
                };
            }
            OperationType::Bash { .. } => {
                op.pre_state = PreState::Bash {
                    cwd: std::env::current_dir()?,
                    env_snapshot: self.capture_env_snapshot(),
                };
            }
        }
        // 内存压力管理：超过阈值时将旧快照降级为 hash-only
        self.evict_if_needed();
        Ok(())
    }

    /// 执行回滚 — 只恢复被修改的文件，不影响其他文件
    pub fn rollback(&self, op: &OperationRecord) -> Result<UndoReport> {
        match &op.pre_state {
            PreState::File { path, snapshot } => {
                // 获取当前文件锁
                let _lock = self.file_locks.acquire(path)?;
                match snapshot {
                    FileSnapshot::Full(content) => {
                        std::fs::write(path, content)?;
                    }
                    FileSnapshot::Incremental { .. } => {
                        // 应用反向 patch
                        self.apply_reverse_patch(path, snapshot)?;
                    }
                    FileSnapshot::NonExistent => {
                        std::fs::remove_file(path)?;
                    }
                }
                Ok(UndoReport { restored_files: vec![path.clone()] })
            }
            PreState::Bash { .. } => {
                // Bash 回滚：仅回滚文件 side-effects，不回滚进程状态
                Err(ExecError::BashNotReversible)
            }
        }
    }
}
```

#### 3.2.4 统一结果格式

```rust
/// 统一 exec 结果
#[derive(Debug)]
pub struct ExecOutput<T> {
    pub operation_id: OperationId,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub diff_summary: Option<DiffSummary>,
    pub duration: Duration,
    pub data: T,
}

/// Diff summary — 统一格式化
#[derive(Debug, Clone)]
pub struct DiffSummary {
    pub files_changed: Vec<FileDiff>,
    pub total_additions: usize,
    pub total_deletions: usize,
    pub formatted: String,  // 预格式化的 diff 文本
}
```

#### 3.2.5 与现有工具的集成

```rust
// 包装现有 bash tool
pub struct BashToolAdapter {
    executor: Arc<dyn UnifiedExecutor>,
}

impl BashToolAdapter {
    pub async fn execute(&self, params: BashParams) -> ToolResult {
        let result = self.executor.exec_bash(BashRequest {
            command: params.command,
            timeout: params.timeout,
            workdir: params.workdir,
        })?;
        // 格式化为现有 tool output 格式
        ToolResult {
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            diff_summary: result.diff_summary.map(|d| d.formatted),
        }
    }
}
```

#### 3.2.6 新 Crate 结构

```
crates/codegen/xai-grok-exec-layer/
├── Cargo.toml
└── src/
    ├── lib.rs              # UnifiedExecutor trait + re-exports
    ├── types.rs            # OperationRecord, PreState, FileSnapshot, DiffSummary
    ├── executor.rs         # DefaultUnifiedExecutor 实现
    ├── rollback.rs         # RollbackEngine
    ├── snapshot.rs         # 文件快照捕获（Full vs Incremental）
    ├── diff.rs             # Diff 计算与格式化
    ├── file_lock.rs        # 文件锁管理
    └── adapters/
        ├── mod.rs
        ├── bash.rs         # 现有 bash tool adapter
        ├── search_replace.rs
        └── write.rs
```

### 3.3 验收标准映射

| 验收标准 | 实现方案 |
|---------|---------|
| bash + edit 通过统一 exec 层调度 | `BashToolAdapter` / `EditToolAdapter` / `WriteToolAdapter` |
| 每次 write/edit 操作可回滚到 pre-state | `RollbackEngine` + `FileSnapshot` |
| 回滚不影响其他文件的修改 | `FileLockManager` 分文件锁 + 独立恢复 |
| exec 层 overhead < 5ms per call | `FileSnapshot::Incremental` + lazy hash |

### 3.4 性能预算

| 操作 | 目标延迟 | 实现策略 |
|------|---------|---------|
| Pre-state 快照 (小文件 < 100KB) | < 1ms | 内存 mmap + lazy clone |
| Pre-state 快照 (大文件 > 1MB) | < 3ms | SHA-256 hash + 仅记录变更 chunk |
| Diff 计算 | < 2ms | 增量 diff (仅 dirty range) |
| 回滚执行 | < 5ms | 直接 write back snapshot |
| 内存 overhead per operation | < 50KB 平均 | 大文件降级为 hash-only |

### 3.5 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Bash 命令不可逆 | 网络请求、进程创建无法回滚 | 文档化不可逆操作 + 预检查 |
| 快照内存压力 | 长会话中快照累积 OOM | 内存上限 + LRU 降级策略 |
| 并发回滚冲突 | 多 tool 同时修改同一文件 | 文件锁 + 操作队列 |

---

## 4. #13 New Context Window — Agent 主动开启新上下文

**优先级**: P4 | **标签**: capability-gap, enhancement | **预估工时**: 2-3 周

### 4.1 问题定义

当前 `session/fork.rs` 是用户发起的 session fork，agent 无法自主决定开新上下文。Codex CLI 的 `handlers/new_context_window.rs` 允许 agent 主动 fork 子上下文处理独立子任务。

### 4.2 设计方案

#### 4.2.1 Agent Tool 定义

```rust
/// Agent tool: NewContextWindow
/// 允许 agent 主动开启独立子上下文
pub struct NewContextWindowTool;

impl Tool for NewContextWindowTool {
    fn name(&self) -> &str { "new_context_window" }

    fn description(&self) -> &str {
        "Open a new isolated context window for an independent subtask. \
         The child context inherits a configurable subset of the parent's history. \
         Results are summarized and injected back into the parent context."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "task_description": {
                    "type": "string",
                    "description": "What this subtask should accomplish"
                },
                "inherit_policy": {
                    "type": "string",
                    "enum": ["none", "system_only", "recent_n", "full"],
                    "description": "How much parent context to inherit",
                    "default": "system_only"
                },
                "max_tokens": {
                    "type": "integer",
                    "description": "Token budget for this child context",
                    "default": null
                },
                "summary_max_tokens": {
                    "type": "integer",
                    "description": "Max tokens for the result summary injected back",
                    "default": 500
                }
            },
            "required": ["task_description"]
        })
    }
}
```

#### 4.2.2 子上下文生命周期

```
Parent Context
    │
    ├── Agent decides: "need a subtask"
    │       │
    │       ▼
    │   NewContextWindow tool call
    │       │
    │       ▼
    │   ┌─────────────────────────────┐
    │   │  Child Context (isolated)    │
    │   │  - Inherits per policy      │
    │   │  - Independent token budget │
    │   │  - Runs agent loop          │
    │   │  - Produces result          │
    │   └──────────────┬──────────────┘
    │                  │
    │                  ▼
    │   Summary Generator (≤ 500 tokens)
    │                  │
    │                  ▼
    │   Inject summary into parent as tool_result
    │
    ▼
Parent continues with summary as context
```

#### 4.2.3 Token 预算分配

```rust
/// Token 预算分配器
pub struct BudgetAllocator {
    parent_budget: TokenBudget,
    /// 已分配给子上下文的 token 数
    allocated_to_children: usize,
}

impl BudgetAllocator {
    /// 为子上下文分配 token 预算
    pub fn allocate_for_child(&mut self, requested: Option<usize>) -> Result<TokenBudget> {
        let available = self.parent_budget.max_total
            - self.parent_budget.reserve_for_response
            - self.allocated_to_children;

        let child_max = requested
            .unwrap_or((available as f64 * self.parent_budget.sub_budget.child_max_ratio) as usize)
            .min(available);

        if child_max < MIN_CHILD_BUDGET {
            return Err(ContextError::InsufficientBudget { available, requested: child_max });
        }

        self.allocated_to_children += child_max;

        Ok(TokenBudget {
            max_total: child_max,
            auto_compact_threshold: self.parent_budget.auto_compact_threshold,
            reserve_for_response: child_max / 4,
            sub_budget: SubBudgetAllocation {
                child_max_ratio: 0.5,  // 子上下文不能再嵌套太多
                summary_injection_max: self.parent_budget.sub_budget.summary_injection_max,
            },
        })
    }

    /// 子上下文结束后回收 token 预算
    pub fn reclaim(&mut self, child_budget: &TokenBudget) {
        self.allocated_to_children = self.allocated_to_children
            .saturating_sub(child_budget.max_total);
    }
}
```

#### 4.2.4 与 Subagent 的区分

| 特性 | NewContextWindow | Subagent |
|------|-----------------|----------|
| 进程隔离 | 同进程，上下文隔离 | 独立进程 |
| 启动开销 | < 10ms | 100ms+ |
| 工具访问 | 继承父上下文工具 | 独立工具集 |
| 结果回注 | 摘要 ≤ 500 tokens | 完整输出 |
| 适用场景 | 独立子推理、搜索、分析 | 独立文件编辑、构建 |

### 4.3 验收标准映射

| 验收标准 | 实现方案 |
|---------|---------|
| Agent 可自主开启子上下文 | `NewContextWindowTool` + agent loop 集成 |
| 子上下文 token 预算独立 | `BudgetAllocator.allocate_for_child()` |
| 子上下文结果摘要 < 500 tokens 回注 | Summary Generator + token 限制 |
| 父上下文不因子上下文膨胀 | `BudgetAllocator.reclaim()` + 摘要注入 |

---

## 5. #6 Realtime Bidirectional Voice — 双向语音对话

**优先级**: P2 | **标签**: capability-gap, enhancement | **预估工时**: 6-8 周

### 5.1 问题定义

当前 `xai-grok-voice` 仅实现单向 STT（speech-to-text）管线：

```
用户说话 → mic capture (subprocess) → streaming STT → transcript → prompt box
```

缺失：
- Agent 语音回复（TTS）
- 双向实时对话
- Barge-in（用户中断 agent 正在说的内容）
- Voice turn 中的 tool use

### 5.2 设计方案

#### 5.2.1 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                    Voice Session Manager                   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ Audio Input  │  │  Voice Engine │  │  Audio Output    │ │
│  │ (existing)   │  │  (new)        │  │  (new)           │ │
│  │ mic → STT    │  │  ┌──────────┐│  │  TTS → speaker   │ │
│  │              │  │  │ xAI      ││  │                  │ │
│  │              │  │  │ Realtime ││  │                  │ │
│  │              │  │  │ API      ││  │                  │ │
│  │              │  │  └──────────┘│  │                  │ │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘ │
│         │                 │                    │           │
│  ┌──────▼─────────────────▼────────────────────▼────────┐ │
│  │              Voice Turn Controller                    │ │
│  │  - Barge-in detection                                │ │
│  │  - Tool use within voice turns                       │ │
│  │  - Transcript + audio sync                           │ │
│  └────────────────────────┬──────────────────────────────┘ │
│                           │                                │
│  ┌────────────────────────▼──────────────────────────────┐ │
│  │              TUI Integration Layer                     │ │
│  │  - Voice indicator (🎙️ / 🔊)                         │ │
│  │  - Live transcript display                            │ │
│  │  - Interruption feedback                              │ │
│  └───────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

#### 5.2.2 核心模块

```rust
// crates/codegen/xai-grok-voice/src/realtime/mod.rs

/// Voice 会话管理器
pub struct VoiceSessionManager {
    /// xAI Realtime API 连接
    connection: RealtimeConnection,
    /// 音频输入管线（复用现有 STT）
    audio_input: AudioInputPipeline,
    /// 音频输出管线（新增 TTS）
    audio_output: AudioOutputPipeline,
    /// Voice turn 控制器
    turn_controller: VoiceTurnController,
    /// Barge-in 检测器
    barge_in_detector: BargeInDetector,
    /// 事件分发
    event_tx: broadcast::Sender<VoiceSessionEvent>,
}

/// Voice turn — 一次完整的语音交互
pub struct VoiceTurn {
    pub turn_id: TurnId,
    pub user_audio: Option<AudioChunk>,
    pub user_transcript: String,
    pub agent_response: Option<AgentVoiceResponse>,
    pub tool_calls: Vec<ToolCall>,
    pub interrupted: bool,
}

/// Agent 语音回复
pub struct AgentVoiceResponse {
    pub text: String,
    pub audio_stream: AudioStream,
    pub is_complete: bool,
}

/// Barge-in 检测器
pub struct BargeInDetector {
    /// VAD (Voice Activity Detection) 阈值
    vad_threshold: f32,
    /// 用户开始说话到触发中断的最小持续时间
    min_speech_duration: Duration,
    /// 当前 agent 是否在说话
    agent_speaking: AtomicBool,
}

impl BargeInDetector {
    /// 检测是否应该中断 agent
    pub fn should_interrupt(&self, audio_chunk: &AudioChunk) -> bool {
        if !self.agent_speaking.load(Ordering::Relaxed) {
            return false;
        }
        // VAD 检测用户语音活动
        let energy = audio_chunk.rms_energy();
        let duration = audio_chunk.duration();
        energy > self.vad_threshold && duration > self.min_speech_duration
    }
}
```

#### 5.2.3 xAI Realtime API 集成

```rust
/// Realtime API 连接管理
pub struct RealtimeConnection {
    /// WebSocket 连接
    ws: WebSocketStream,
    /// 配置
    config: RealtimeConfig,
    /// 消息队列
    message_tx: mpsc::Sender<RealtimeMessage>,
    message_rx: mpsc::Receiver<RealtimeMessage>,
}

/// Realtime API 消息类型
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RealtimeMessage {
    // 输入
    #[serde(rename = "input_audio_buffer.append")]
    InputAudioAppend { audio: String },  // base64 PCM
    #[serde(rename = "input_audio_buffer.commit")]
    InputAudioCommit,
    #[serde(rename = "conversation.item.create")]
    ConversationItemCreate { item: ConversationItem },
    #[serde(rename = "response.create")]
    ResponseCreate { response: ResponseConfig },

    // 输出
    #[serde(rename = "response.audio.delta")]
    ResponseAudioDelta { delta: String },  // base64 PCM
    #[serde(rename = "response.audio_transcript.delta")]
    ResponseTranscriptDelta { delta: String },
    #[serde(rename = "response.done")]
    ResponseDone { response: ResponseResult },
    #[serde(rename = "input_audio_buffer.speech_started")]
    SpeechStarted,
    #[serde(rename = "input_audio_buffer.speech_stopped")]
    SpeechStopped,

    // Tool use
    #[serde(rename = "response.function_call_arguments.done")]
    FunctionCallDone { call_id: String, name: String, arguments: String },
}
```

#### 5.2.4 TUI 集成

```rust
/// TUI 语音状态指示器
pub struct VoiceIndicator {
    state: VoiceState,
    waveform: Option<WaveformData>,
    transcript_buffer: TranscriptBuffer,
}

#[derive(Debug, Clone)]
pub enum VoiceState {
    Idle,
    Listening,        // 🎤 等待用户说话
    Processing,       // ⏳ agent 思考中
    Speaking,         // 🔊 agent 正在说话
    Interrupted,      // ⚡ 被用户中断
    ToolExecuting,    // 🔧 agent 在执行工具
}

/// 实时 transcript 缓冲区
pub struct TranscriptBuffer {
    /// 用户正在说的内容（实时识别中）
    partial_user: String,
    /// 用户已确认的 transcript
    confirmed_user: Vec<String>,
    /// Agent 正在说的内容
    agent_speaking: String,
    /// 最大显示行数
    max_lines: usize,
}
```

#### 5.2.5 新模块结构

```
crates/codegen/xai-grok-voice/src/
├── lib.rs                    # (现有)
├── audio/                    # (现有，扩展)
│   ├── capture.rs
│   ├── output.rs             # 新增：音频输出
│   └── ...
├── stt/                      # (现有)
├── realtime/                 # 新增：双向语音
│   ├── mod.rs
│   ├── connection.rs         # xAI Realtime API WebSocket
│   ├── session.rs            # VoiceSessionManager
│   ├── turn.rs               # VoiceTurnController
│   ├── barge_in.rs           # Barge-in 检测
│   ├── messages.rs           # RealtimeMessage 定义
│   └── tool_bridge.rs        # Voice turn 中的 tool use
├── tui/                      # 新增：TUI 集成
│   ├── mod.rs
│   ├── indicator.rs          # 语音状态指示器
│   └── transcript.rs         # 实时 transcript
└── pipeline.rs               # (现有，扩展为双向)
```

### 5.3 验收标准映射

| 验收标准 | 实现方案 |
|---------|---------|
| 用户可通过麦克风与 agent 对话 | `VoiceSessionManager` + 现有 STT |
| Agent 回复通过扬声器播放 | `AudioOutputPipeline` + TTS |
| 中断响应延迟 < 200ms | `BargeInDetector` + 本地 VAD |
| Tool use 在语音模式下正常工作 | `tool_bridge.rs` + 异步 tool dispatch |

### 5.4 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| xAI Realtime API 可用性 | 依赖外部服务 | Fallback 到本地 TTS (piper/whisper) |
| 音频延迟 > 200ms | 中断体验差 | 本地 VAD + jitter buffer |
| 多平台音频差异 | macOS/Linux/Windows 行为不一 | 抽象 AudioBackend trait + 平台适配 |
| 与 TUI 渲染冲突 | 音频线程影响 TUI 帧率 | 独立音频线程 + channel 通信 |

---

## 6. #8 Windows Sandbox Support — Windows 原生沙箱

**优先级**: P3 | **标签**: capability-gap, security | **预估工时**: 3-4 周

### 6.1 问题定义

当前 `xai-grok-sandbox` 仅支持：
- **macOS**: Seatbelt (sandbox-exec)
- **Linux**: Landlock + seccomp + bwrap

Windows 用户无任何隔离保护。

### 6.2 设计方案

#### 6.2.1 统一 Sandbox Trait

```rust
/// 跨平台沙箱 trait — 所有平台实现的统一接口
pub trait SandboxBackend: Send + Sync {
    /// 平台名称
    fn platform(&self) -> &'static str;

    /// 是否支持当前系统
    fn is_supported(&self) -> SandboxSupportInfo;

    /// 应用沙箱配置（不可逆）
    fn apply(&self, config: &ResolvedSandboxConfig) -> Result<()>;

    /// 获取当前沙箱状态
    fn status(&self) -> SandboxStatus;

    /// 验证文件访问权限
    fn check_file_access(&self, path: &Path, mode: AccessMode) -> bool;
}

/// 平台支持信息
pub struct SandboxSupportInfo {
    pub supported: bool,
    pub backend: &'static str,
    pub details: String,
    pub requires_elevation: bool,
}
```

#### 6.2.2 Windows 实现方案

Windows 提供两种沙箱机制，按优先级选择：

**方案 A: Windows Sandbox API (AppContainer)**

```rust
// crates/codegen/xai-grok-sandbox/src/windows_sandbox.rs

use windows::Win32::Security::{
    AppContainer, CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};

pub struct WindowsSandboxBackend {
    profile_name: String,
    /// AppContainer SID
    sid: Option<SID>,
    /// 配置的文件访问策略
    file_policy: WindowsFilePolicy,
}

impl SandboxBackend for WindowsSandboxBackend {
    fn platform(&self) -> &'static str { "windows/appcontainer" }

    fn is_supported(&self) -> SandboxSupportInfo {
        SandboxSupportInfo {
            supported: cfg!(target_os = "windows") && Self::check_appcontainer_available(),
            backend: "AppContainer",
            details: "Windows AppContainer isolation".into(),
            requires_elevation: false,
        }
    }

    fn apply(&self, config: &ResolvedSandboxConfig) -> Result<()> {
        // 1. 创建 AppContainer profile
        // 2. 配置文件系统 ACL（read-only / deny）
        // 3. 配置网络隔离策略
        // 4. 以 AppContainer 身份启动子进程
    }
}

/// Windows 文件访问策略
pub struct WindowsFilePolicy {
    /// 允许读写的目录
    rw_paths: Vec<PathBuf>,
    /// 只读目录
    ro_paths: Vec<PathBuf>,
    /// 完全拒绝的路径
    deny_paths: Vec<PathBuf>,
}

impl WindowsFilePolicy {
    /// 将 sandbox.toml 配置转换为 Windows ACL
    pub fn to_acl_entries(&self) -> Result<Vec<AclEntry>> {
        // 1. rw_paths → GENERIC_READ | GENERIC_WRITE
        // 2. ro_paths → GENERIC_READ only
        // 3. deny_paths → 拒绝所有访问
        // 4. 工作区外默认 deny
    }
}
```

**方案 B: Windows Job Object (降级方案)**

```rust
/// Job Object 降级方案 — 当 AppContainer 不可用时
pub struct WindowsJobObjectBackend {
    job_handle: HANDLE,
}

impl WindowsJobObjectBackend {
    /// 创建 Job Object 并限制：
    /// - 进程内存上限
    /// - CPU 时间限制
    /// - 子进程创建限制
    /// - UI 访问限制
    fn create_restrictive_job(&self) -> Result<()> {
        use windows::Win32::System::JobObjects::*;
        // ConfigureJobObject with limits
    }
}
```

#### 6.2.3 网络隔离

```rust
/// Windows 网络隔离策略
pub struct WindowsNetworkPolicy {
    /// 允许的域名（agent 需要访问 LLM API）
    allowed_domains: Vec<String>,
    /// 允许的 IP 范围
    allowed_cidrs: Vec<String>,
    /// 是否允许本地回环
    allow_loopback: bool,
}

impl WindowsNetworkPolicy {
    /// 使用 Windows Filtering Platform (WFP) 配置网络策略
    pub fn apply_wfp_filter(&self) -> Result<()> {
        // 1. 创建 WFP provider
        // 2. 添加允许规则（LLM API endpoint）
        // 3. 默认拒绝所有其他出站连接
    }
}
```

#### 6.2.4 平台分发

```rust
// crates/codegen/xai-grok-sandbox/src/lib.rs (修改)

/// 创建平台适配的沙箱后端
pub fn create_sandbox_backend(profile: &ProfileName) -> Box<dyn SandboxBackend> {
    #[cfg(target_os = "macos")]
    { Box::new(MacOSSeatbeltBackend::new(profile)) }

    #[cfg(target_os = "linux")]
    { Box::new(LinuxLandlockBackend::new(profile)) }

    #[cfg(target_os = "windows")]
    {
        if WindowsSandboxBackend::check_appcontainer_available() {
            Box::new(WindowsSandboxBackend::new(profile))
        } else {
            Box::new(WindowsJobObjectBackend::new(profile))
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    { Box::new(NoopSandboxBackend) }
}
```

#### 6.2.5 新/修改文件清单

```
crates/codegen/xai-grok-sandbox/src/
├── lib.rs                    # 修改：添加 SandboxBackend trait + 平台分发
├── types.rs                  # 修改：添加 SandboxBackend 相关类型
├── profiles.rs               # 修改：跨平台 profile 解析
├── windows/                  # 新增
│   ├── mod.rs
│   ├── appcontainer.rs       # AppContainer 实现
│   ├── job_object.rs         # Job Object 降级方案
│   ├── file_policy.rs        # Windows ACL 文件策略
│   ├── network_policy.rs     # WFP 网络策略
│   └── read_grants.rs        # Scoped read access
├── linux/                    # 重构现有 Linux 代码
│   ├── mod.rs
│   └── ... (从现有文件迁移)
└── macos/                    # 重构现有 macOS 代码
    ├── mod.rs
    └── ...
```

### 6.3 验收标准映射

| 验收标准 | 实现方案 |
|---------|---------|
| Windows 上 bash tool 在沙箱内执行 | AppContainer / Job Object |
| 文件 write 受限于 workspace 目录 | `WindowsFilePolicy` + ACL |
| 网络访问受 policy 控制 | `WindowsNetworkPolicy` + WFP |
| 跨平台 Sandbox trait 统一 | `trait SandboxBackend` |

---

## 7. #11 Build Attestation — 构建产物签名与验证

**优先级**: P4 | **标签**: capability-gap, security | **预估工时**: 2-3 周

### 7.1 问题定义

当前无构建产物签名/验证机制。用户无法验证下载的 binary 来源可信。

### 7.2 设计方案

#### 7.2.1 架构概览

```
┌─────────────────────────────────────────────────────┐
│                    CI Pipeline                        │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Build    │→ │ Generate     │→ │ Sign with      │ │
│  │ Binary   │  │ SBOM         │  │ Sigstore/cosign│ │
│  └──────────┘  └──────────────┘  └────────────────┘ │
│                                      │               │
│                               ┌──────▼──────────┐   │
│                               │ Upload           │   │
│                               │ .sig + .cert +   │   │
│                               │ .intoto.jsonl    │   │
│                               └─────────────────┘   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              User Verification                        │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │ grok-build verify │→ │ Download .sig + .cert    │ │
│  │                   │  │ Verify with Sigstore     │ │
│  │                   │  │ Check transparency log   │ │
│  └──────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

#### 7.2.2 SBOM 生成

```yaml
# .github/workflows/release.yml (新增步骤)

- name: Generate SBOM
  uses: anchore/sbom-action@v0
  with:
    artifact-name: sbom-${{ matrix.target }}.spdx.json
    output-file: sbom.spdx.json
    format: spdx-json

- name: Attest build provenance
  uses: actions/attest-build-provenance@v2
  with:
    subject-path: 'target/release/grok-build*'
```

#### 7.2.3 验证命令

```rust
// crates/codegen/xai-grok-verify/src/lib.rs

/// 验证命令实现
pub struct VerifyCommand;

impl VerifyCommand {
    /// `grok-build verify <binary_path>`
    pub fn run(binary_path: &Path) -> Result<VerifyReport> {
        // 1. 下载对应的 .sig 和 .cert 文件
        let sig_url = Self::attestation_url(binary_path, "sig")?;
        let cert_url = Self::attestation_url(binary_path, "cert")?;

        // 2. 使用 sigstore 验证签名
        let verification = SigstoreVerifier::new()
            .verify(VerifyRequest {
                artifact: binary_path,
                signature: &download(&sig_url)?,
                certificate: &download(&cert_url)?,
                trusted_roots: Self::trusted_roots()?,
            })?;

        // 3. 检查 Rekor transparency log
        let log_entry = RekorClient::new()
            .get_entry(&verification.log_index)?;

        // 4. 验证 SBOM
        let sbom = Self::verify_sbom(binary_path)?;

        Ok(VerifyReport {
            binary: binary_path.display().to_string(),
            signature_valid: true,
            signer_identity: verification.subject.to_string(),
            build_timestamp: log_entry.integrated_time,
            transparency_log_index: log_entry.log_index,
            sbom: Some(sbom),
        })
    }
}

/// 验证报告
#[derive(Debug, Serialize)]
pub struct VerifyReport {
    pub binary: String,
    pub signature_valid: bool,
    pub signer_identity: String,
    pub build_timestamp: DateTime<Utc>,
    pub transparency_log_index: u64,
    pub sbom: Option<SbomSummary>,
}

/// SBOM 摘要
#[derive(Debug, Serialize)]
pub struct SbomSummary {
    pub format: String,     // "spdx-json"
    pub component_count: usize,
    pub license_summary: Vec<String>,
}
```

#### 7.2.4 Attestation Metadata 格式

```json
{
  "predicateType": "https://slsa.dev/provenance/v1",
  "predicate": {
    "buildDefinition": {
      "buildType": "https://actions.github.io/buildtypes/workflow/v1",
      "externalParameters": {
        "workflow": { "ref": "main", "repository": "Colin4k1024/grok-build" }
      }
    },
    "runDetails": {
      "builder": { "id": "https://github.com/actions/runner" },
      "metadata": {
        "invocationId": "github-run-12345",
        "startedOn": "2026-08-05T12:00:00Z"
      }
    }
  },
  "subject": [
    {
      "name": "grok-build-x86_64-apple-darwin",
      "digest": { "sha256": "abc123..." }
    }
  ]
}
```

#### 7.2.5 新 Crate 结构

```
crates/codegen/xai-grok-verify/
├── Cargo.toml
└── src/
    ├── lib.rs              # VerifyCommand + re-exports
    ├── sigstore.rs         # Sigstore/cosign 验证逻辑
    ├── sbom.rs             # SBOM 解析与验证
    ├── rekor.rs            # Rekor transparency log 客户端
    ├── report.rs           # VerifyReport 类型
    └── cli.rs              # CLI 子命令定义
```

### 7.3 验收标准映射

| 验收标准 | 实现方案 |
|---------|---------|
| Release binary 附带 attestation 文件 | GitHub Actions attestation step |
| `grok-build verify` 可验证 binary 签名 | `VerifyCommand` + Sigstore |
| CI 自动生成 SBOM | anchore/sbom-action |

---

## 实施路线图与优先级

### 依赖关系图

```
                    #7 Context Manager
                           │
                    ┌──────┼──────┐
                    │      │      │
                    ▼      │      ▼
            #13 New Context│  #3 Unified Exec Layer
               Window      │
                    │      │
                    │      ▼
                    │  #6 Bidirectional Voice (独立)
                    │
                    ▼
              (未来: 更智能的上下文策略)

         #8 Windows Sandbox (独立)
         #11 Build Attestation (独立)
```

### 推荐实施顺序

| 阶段 | Issue | 优先级 | 预估工时 | 前置依赖 | 理由 |
|------|-------|--------|---------|---------|------|
| **Phase 1** | #7 Context Manager | P3 | 3-4 周 | 无 | 基础架构，#13 的前置依赖 |
| **Phase 2** | #3 Unified Exec Layer | P2 | 4-5 周 | 无 | P2 优先级 + 独立可交付 |
| **Phase 2** | #13 New Context Window | P4 | 2-3 周 | #7 | 依赖 Context Manager |
| **Phase 3** | #6 Bidirectional Voice | P2 | 6-8 周 | 无 | P2 但工作量大，可并行开发 |
| **Phase 3** | #8 Windows Sandbox | P3 | 3-4 周 | 无 | 独立模块，可并行 |
| **Phase 4** | #11 Build Attestation | P4 | 2-3 周 | CI pipeline | 独立，依赖 CI 配置 |

### 里程碑建议

```
M1 (Week 1-4):  Context Manager MVP
                - ContextManager trait + 基本实现
                - Token budget 管理
                - 与现有 compaction 集成

M2 (Week 3-7):  Unified Exec Layer MVP
                - UnifiedExecutor trait + 基本实现
                - Pre-state snapshot + 回滚
                - bash/edit/write adapter

M3 (Week 5-9):  New Context Window
                - Agent tool 实现
                - Budget allocator
                - 与 Context Manager 集成

M4 (Week 6-12): Bidirectional Voice Alpha
                - xAI Realtime API 连接
                - 基本双向对话
                - Barge-in 检测

M5 (Week 8-11): Windows Sandbox
                - AppContainer 实现
                - 文件/网络策略
                - 跨平台 trait 统一

M6 (Week 10-12): Build Attestation
                 - SBOM 生成
                 - Sigstore 验证
                 - CLI verify 命令
```

---

## 附录：技术选型汇总

| 技术领域 | 选型 | 理由 |
|---------|------|------|
| Token 计算 | `tiktoken-rs` (现有) | 已在 compaction crate 中使用 |
| 文件快照 | `mmap` + SHA-256 | 零拷贝 + 增量 hash |
| Diff 计算 | `similar` crate | Rust 原生，支持多种 diff 算法 |
| 音频采集 | `cpal` (macOS/Win) + subprocess (Linux) | 现有方案扩展 |
| TTS | xAI Realtime API | 统一 STT/TTS，减少外部依赖 |
| VAD | `webrtc-vad` | 低延迟，成熟实现 |
| 沙箱 (Win) | AppContainer + WFP | Windows 原生，内核级隔离 |
| 签名 | Sigstore / cosign | 行业标准，无密钥管理负担 |
| SBOM | SPDX + anchore/sbom-action | GitHub 原生支持 |
