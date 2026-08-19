# Capability Absorption Deep Design — Phase 4 补充

> 基于 Codex CLI v0.146.0 和 Claude Code v2.1.219-222 的 11 项新能力详细设计

---

## 目录

- [Phase A: 安全与沙箱增强](#phase-a)
  - [A1. Auto Mode Permission Classifier](#a1)
  - [A2. Sandbox Credential Masking](#a2)
  - [A3. strictAllowlist](#a3)
- [Phase B: 会话管理升级](#phase-b)
  - [B1. Named Sessions + Thread Pinning](#b1)
  - [B2. Agent Plugins Multi-Marketplace](#b2)
  - [B3. Thread Forking + Pagination](#b3)
- [Phase C: UI 与远程能力](#phase-c)
  - [C1. Focus View (TUI 折叠模式)](#c1)
  - [C2. DirectoryAdded Hook](#c2)
  - [C3. Nested Subagent Forwarding](#c3)
  - [C4. Remote Code Mode WebSocket](#c4)
  - [C5. Web Search Multi-Provider](#c5)

---

<a id="phase-a"></a>
## Phase A: 安全与沙箱增强

<a id="a1"></a>
### A1. Auto Mode Permission Classifier

**优先级**: P1 | **预估工时**: 1-2 周

#### 问题定义

当前 grok-build 的 hooks 系统有 `PreToolUse` gate，但判断逻辑是基于 matcher（工具名匹配）和 hook 脚本返回值。缺少一个**自动模式下的 permission classifier**，能够在不弹出用户确认的情况下，自动裁决高风险操作。

Claude Code v2.1.219 的做法：
- `SendMessage` 到其他 agent session 前经 permission classifier 评估
- `dangerous-rm`、`background-&`、`suspicious-Windows-path` 由 classifier 裁决
- auto mode 下不弹确认框，直接 allow/deny

#### 设计方案

**核心 Trait**: `PermissionClassifier`

```rust
// crates/codegen/xai-grok-hooks/src/classifier.rs

/// 裁决结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// 允许执行
    Allow,
    /// 拒绝执行（记录原因）
    Deny { reason: String },
    /// 需要用户确认（降级到交互模式）
    AskUser { reason: String },
}

/// 操作上下文
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// 工具名称
    pub tool_name: String,
    /// 工具参数
    pub arguments: serde_json::Value,
    /// 当前工作目录
    pub cwd: PathBuf,
    /// 是否在沙箱内
    pub sandboxed: bool,
    /// 会话模式 (auto/interactive)
    pub session_mode: SessionMode,
}

/// 权限分类器 trait
pub trait PermissionClassifier: Send + Sync + std::fmt::Debug {
    /// 对操作进行裁决
    fn classify(&self, action: &ActionContext) -> Verdict;
    
    /// 分类器名称（用于日志）
    fn name(&self) -> &str;
}
```

**默认分类器规则**:

```rust
#[derive(Debug)]
pub struct DefaultPermissionClassifier;

impl PermissionClassifier for DefaultPermissionClassifier {
    fn classify(&self, action: &ActionContext) -> Verdict {
        // 规则 1: 高风险 bash 命令
        if action.tool_name == "bash" {
            if let Some(cmd) = action.arguments.get("command").and_then(|v| v.as_str()) {
                // rm -rf / 或 rm -rf ~
                if is_dangerous_rm(cmd) {
                    return Verdict::Deny {
                        reason: "dangerous rm command detected".into(),
                    };
                }
                // background &
                if cmd.contains(" &") {
                    return Verdict::AskUser {
                        reason: "background process detected".into(),
                    };
                }
                // sudo
                if cmd.starts_with("sudo ") {
                    return Verdict::Deny {
                        reason: "sudo not allowed in auto mode".into(),
                    };
                }
            }
        }

        // 规则 2: 可疑路径写入
        if matches!(action.tool_name.as_str(), "write" | "search_replace") {
            if let Some(path) = action.arguments.get("file_path").and_then(|v| v.as_str()) {
                if is_suspicious_path(path) {
                    return Verdict::Deny {
                        reason: format!("suspicious write path: {path}"),
                    };
                }
            }
        }

        // 规则 3: SendMessage 安全检查
        if action.tool_name == "send_message" {
            // 只允许发送到已知 session
            if action.arguments.get("to").and_then(|v| v.as_str()) == Some("main") {
                return Verdict::Allow;
            }
            return Verdict::AskUser {
                reason: "cross-session message".into(),
            };
        }

        // 规则 4: 文件删除
        if action.tool_name == "kill_command_or_subagent" {
            return Verdict::Allow; // 后台任务管理始终允许
        }

        // 默认: auto mode 下允许，interactive mode 下询问
        match action.session_mode {
            SessionMode::Auto => Verdict::Allow,
            SessionMode::Interactive => Verdict::AskUser {
                reason: "default policy".into(),
            },
        }
    }

    fn name(&self) -> &str { "default" }
}
```

**集成点**: 在 `dispatch_pre_tool_use` 中添加 classifier 调用：

```rust
// crates/codegen/xai-grok-hooks/src/dispatcher.rs (修改)

pub async fn dispatch_pre_tool_use_with_classifier(
    registry: &HookRegistry,
    action: &ActionContext,
    classifier: &dyn PermissionClassifier,
) -> HookDecision {
    // 1. 先过 classifier
    let verdict = classifier.classify(action);
    match verdict {
        Verdict::Deny { reason } => {
            return HookDecision::Deny(reason);
        }
        Verdict::AskUser { .. } if action.session_mode == SessionMode::Auto => {
            // auto mode 下 AskUser 降级为 Allow
        }
        _ => {}
    }
    
    // 2. 再走现有 hooks 链
    dispatch_pre_tool_use(registry, action).await
}
```

**新文件**:
```
crates/codegen/xai-grok-hooks/src/classifier.rs  # PermissionClassifier trait + DefaultPermissionClassifier
```

**测试**:
- 测试 dangerous rm 检测
- 测试 sudo 拒绝
- 测试 suspicious path 检测
- 测试 SendMessage 安全检查
- 测试 auto mode vs interactive mode 差异

---

<a id="a2"></a>
### A2. Sandbox Credential Masking

**优先级**: P2 | **预估工时**: 2 周

#### 问题定义

当前沙箱通过 `deny` 路径阻止读取敏感文件。但某些场景需要在沙箱内访问凭证（如 npm registry token、pypi token），只是需要遮蔽真实值。

Claude Code v2.1.221 的做法：
- `mode: "mask"` — 沙箱内命令读取 sentinel 副本
- 沙箱代理在出口替换 sentinel → real value
- 支持 `extract` regex（只遮蔽文件中的特定 span）

#### 设计方案

**核心类型**:

```rust
// crates/codegen/xai-grok-sandbox/src/credential_mask.rs

/// 凭证遮蔽配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialMask {
    /// 源文件路径（真实凭证位置）
    pub source: PathBuf,
    /// 遮蔽模式
    pub mode: MaskMode,
    /// 提取 regex（可选，只遮蔽匹配的部分）
    pub extract: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MaskMode {
    /// 遮蔽整个文件内容
    Full,
    /// 只遮蔽 regex 匹配的 span
    Extract,
}

/// 凭证遮蔽管理器
pub struct CredentialMaskManager {
    /// 配置的遮蔽规则
    masks: Vec<CredentialMask>,
    /// sentinel 文件目录
    sentinel_dir: PathBuf,
    /// sentinel → real value 映射
    mappings: HashMap<PathBuf, SentinelMapping>,
}

struct SentinelMapping {
    sentinel_path: PathBuf,
    real_path: PathBuf,
    sentinel_value: String,
    real_value: String,
}

impl CredentialMaskManager {
    /// 创建管理器并生成 sentinel 文件
    pub fn new(masks: Vec<CredentialMask>, workspace: &Path) -> Result<Self> {
        let sentinel_dir = workspace.join(".grok").join("sentinel");
        std::fs::create_dir_all(&sentinel_dir)?;
        
        let mut mappings = HashMap::new();
        for mask in &masks {
            let real_content = std::fs::read_to_string(&mask.source)?;
            let sentinel_value = generate_sentinel(&real_content, &mask);
            let sentinel_path = sentinel_dir.join(mask.source.file_name().unwrap());
            
            std::fs::write(&sentinel_path, &sentinel_value)?;
            
            mappings.insert(mask.source.clone(), SentinelMapping {
                sentinel_path,
                real_path: mask.source.clone(),
                sentinel_value,
                real_value: real_content,
            });
        }
        
        Ok(Self { masks, sentinel_dir, mappings })
    }
    
    /// 获取 sentinel 文件路径（沙箱内使用）
    pub fn sentinel_path_for(&self, real_path: &Path) -> Option<&Path> {
        self.mappings.get(real_path).map(|m| m.sentinel_path.as_path())
    }
    
    /// 在网络出口替换 sentinel → real value
    pub fn replace_sentinel_in_output(&self, output: &str) -> String {
        let mut result = output.to_string();
        for mapping in self.mappings.values() {
            result = result.replace(&mapping.sentinel_value, &mapping.real_value);
        }
        result
    }
    
    /// 清理 sentinel 文件
    pub fn cleanup(&self) -> Result<()> {
        std::fs::remove_dir_all(&self.sentinel_dir)?;
        Ok(())
    }
}

/// 生成 sentinel 值
fn generate_sentinel(real_content: &str, mask: &CredentialMask) -> String {
    match mask.mode {
        MaskMode::Full => {
            // 替换为同长度的 sentinel
            format!("__GROK_SENTINEL_{}__", blake3::hash(real_content.as_bytes()))
        }
        MaskMode::Extract => {
            // 只替换 regex 匹配的部分
            if let Some(ref pattern) = mask.extract {
                if let Ok(re) = regex::Regex::new(pattern) {
                    re.replace_all(real_content, |caps: &regex::Captures| {
                        format!("__GROK_SENTINEL_{}__", blake3::hash(caps[0].as_bytes()))
                    }).to_string()
                } else {
                    real_content.to_string()
                }
            } else {
                real_content.to_string()
            }
        }
    }
}
```

**沙箱集成**:

```rust
// 在 SandboxManager::apply() 中注入 sentinel 文件路径映射
// 在网络代理层添加 replace_sentinel_in_output 调用
```

**新文件**:
```
crates/codegen/xai-grok-sandbox/src/credential_mask.rs
```

---

<a id="a3"></a>
### A3. strictAllowlist

**优先级**: P3 | **预估工时**: 3 天

#### 设计方案

在现有 `SandboxConfig` 中添加 `strict_allowlist` 字段：

```rust
// crates/codegen/xai-grok-sandbox/src/profiles.rs (修改)

pub struct SandboxConfig {
    pub profiles: HashMap<String, ProfileConfig>,
    /// 严格白名单模式：非白名单主机直接拒绝，不弹确认
    pub strict_allowlist: bool,
    /// 允许的主机列表
    pub allowed_hosts: Vec<String>,
}
```

在 `NetworkPolicy` 检查中：

```rust
pub fn check_connection(&self, host: &str, config: &SandboxConfig) -> NetworkDecision {
    if config.strict_allowlist {
        if config.allowed_hosts.iter().any(|h| host.ends_with(h)) {
            NetworkDecision::Allow
        } else {
            NetworkDecision::Deny("host not in strict allowlist".into())
        }
    } else {
        // 现有逻辑
        self.default_check(host)
    }
}
```

**配置文件** (`~/.grok/sandbox.toml`):
```toml
strict_allowlist = true
allowed_hosts = ["api.x.ai", "github.com", "crates.io"]

[profiles.workspace]
extends = "workspace"
```

---

<a id="phase-b"></a>
## Phase B: 会话管理升级

<a id="b1"></a>
### B1. Named Sessions + Thread Pinning

**优先级**: P2 | **预估工时**: 1-2 周

#### 设计方案

**扩展 session 元数据**:

```rust
// crates/codegen/xai-grok-shell/src/session/mod.rs (修改)

/// 会话元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    /// 用户定义的会话名称
    pub name: Option<String>,
    /// 是否被 pin
    pub pinned: bool,
    /// 创建时间
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// 最后活跃时间
    pub last_active: chrono::DateTime<chrono::Utc>,
    /// 消息数
    pub message_count: usize,
}
```

**TUI 命令**:

```
/new <name>     — 创建命名会话
/clear          — 清空当前会话（保留名称）
/pin            — Pin/Unpin 当前会话
/threads        — 列出所有会话（pinned 在前）
/switch <name>  — 切换到指定会话
```

**实现要点**:
- `SessionMeta` 存储在 `JsonlStorageAdapter` 的 session header 中
- `/threads` 显示：pinned 标记 + 名称 + 最后活跃时间 + 消息数
- 切换会话不关闭当前会话（side conversation）

---

<a id="b2"></a>
### B2. Agent Plugins Multi-Marketplace

**优先级**: P2 | **预估工时**: 2-3 周

#### 设计方案

**Plugin Manifest Schema**:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "A useful plugin",
  "author": "developer",
  "marketplace": "xai",
  "tools": [
    {
      "name": "my_tool",
      "description": "Does something useful",
      "parameters": { "type": "object", "properties": {} }
    }
  ],
  "permissions": ["network", "filesystem"],
  "min_grok_version": "0.147.0"
}
```

**Marketplace Provider trait**:

```rust
// crates/codegen/xai-grok-plugin-marketplace/src/provider.rs

pub trait MarketplaceProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn search(&self, query: &str) -> Result<Vec<PluginSummary>>;
    async fn get_manifest(&self, plugin_id: &str) -> Result<PluginManifest>;
    async fn download(&self, plugin_id: &str, dest: &Path) -> Result<()>;
}
```

**实现**:
- `XaiMarketplaceProvider` — 现有 xAI marketplace
- `BedrockMarketplaceProvider` — Amazon Bedrock plugins
- `ClaudeCodeMarketplaceProvider` — Claude Code compatible plugins
- `LocalMarketplaceProvider` — 本地 workspace plugins

---

<a id="b3"></a>
### B3. Thread Forking + Pagination

**优先级**: P3 | **预估工时**: 1 周

#### 设计方案

扩展 `ForkConfig`:

```rust
pub struct ForkConfig {
    pub inherit_policy: InheritPolicy,
    pub max_tokens: Option<usize>,
    pub turn_id: Option<TurnId>,
    /// 临时 fork：不出现在会话列表中
    pub is_temporary: bool,
}
```

Session history 查询添加分页:

```rust
pub struct SessionQuery {
    pub offset: usize,
    pub limit: usize,
    pub include_temporary: bool,
}

pub trait SessionStore {
    fn list_sessions(&self, query: SessionQuery) -> Result<Vec<SessionMeta>>;
    fn get_session(&self, id: &str) -> Result<SessionData>;
}
```

---

<a id="phase-c"></a>
## Phase C: UI 与远程能力

<a id="c1"></a>
### C1. Focus View (TUI 折叠模式)

**优先级**: P2 | **预估工时**: 1-2 周

#### 设计方案

在 scrollback 中添加 focus mode:

```rust
// crates/codegen/xai-grok-pager/src/scrollback/focus.rs

pub struct FocusMode {
    enabled: bool,
    /// 每个 tool turn 折叠为一行摘要
    collapsed_turns: HashSet<TurnId>,
}

pub struct ToolTurnSummary {
    pub tool_name: String,
    pub status: ToolStatus,  // Running / Success / Failed
    pub duration_ms: u64,
    pub output_preview: String,  // 前 80 字符
}
```

TUI 渲染:
- **折叠状态**: `🔧 bash — ✅ completed (2.3s)` + 可展开指示器
- **展开状态**: 完整工具输出
- 快捷键: `Ctrl+Alt+F` 切换 focus mode
- 每个 turn 可独立展开/折叠

---

<a id="c2"></a>
### C2. DirectoryAdded Hook

**优先级**: P3 | **预估工时**: 3 天

#### 设计方案

在 hooks event 系统中添加新事件:

```rust
// crates/codegen/xai-grok-hooks/src/event.rs (修改)

// 在 hook_events! 宏中添加:
DirectoryAdded {
    matcher: false,  // 不需要 matcher
    gate: false,     // 非 gate 事件
    hub: true,       // 发送到 hub
}
```

Hook payload:

```rust
pub struct DirectoryAddedPayload {
    pub path: PathBuf,
    pub source: DirectorySource,
}

pub enum DirectorySource {
    UserCommand,      // /add-dir
    SdkRegister,      // SDK register_repo_root
    AutoDetect,       // 自动检测
}
```

配置示例 (`.grok/hooks/on-dir-added.json`):
```json
{
  "hooks": {
    "DirectoryAdded": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "scripts/index-new-dir.sh $GROK_ADDED_DIR"
          }
        ]
      }
    ]
  }
}
```

---

<a id="c3"></a>
### C3. Nested Subagent Forwarding

**优先级**: P3 | **预估工时**: 1 周

#### 设计方案

在 subagent resolution 中添加 depth tracking:

```rust
// crates/codegen/xai-grok-subagent-resolution/src/lib.rs (修改)

pub struct SubagentSpawnRequest {
    pub prompt: String,
    pub subagent_type: String,
    /// 嵌套深度（主 agent = 0，一级 subagent = 1，二级 = 2...）
    pub depth: usize,
    /// 父级 agent ID（用于转发链路）
    pub parent_id: Option<String>,
}
```

转发策略:
- depth 0 → 1: 正常转发（现有行为）
- depth 1 → 2+: 如果 `--forward-subagent-text` 启用，关键事件转发到 TUI
- 转发事件: `Spawned`, `Completed`, `Error`, `Progress`

---

<a id="c4"></a>
### C4. Remote Code Mode WebSocket

**优先级**: P3 | **预估工时**: 2-3 周

#### 设计方案

在 WorkspaceOps 中添加 WebSocket transport:

```rust
// crates/codegen/xai-grok-workspace/src/remote.rs

pub struct RemoteWorkspace {
    ws: tokio_tungstenite::WebSocketStream,
    session_id: String,
}

impl RemoteWorkspace {
    pub async fn connect(url: &str, auth: &str) -> Result<Self>;
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<ToolRunResult>;
    pub async fn read_file(&self, path: &Path) -> Result<Vec<u8>>;
    pub async fn list_dir(&self, path: &Path) -> Result<Vec<DirEntry>>;
}
```

复用 ACP 协议的 WebSocket 实现，通过 `xai-acp-lib` 的 transport 层。

---

<a id="c5"></a>
### C5. Web Search Multi-Provider

**优先级**: P4 | **预估工时**: 1 周

#### 设计方案

抽象搜索提供者:

```rust
// crates/codegen/xai-grok-tools/src/implementations/grok_build/web_search/provider.rs

pub trait WebSearchProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>>;
}

pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}
```

实现:
- `XaiSearchProvider` — 现有 xAI Responses API
- `DuckDuckGoProvider` — DuckDuckGo (privacy-focused)
- `ExaProvider` — Exa neural search (如 MCP 已连接)

---

## 实施优先级汇总

| 阶段 | 能力 | 优先级 | 工时 | 依赖 |
|------|------|--------|------|------|
| **A1** | Permission Classifier | P1 | 1-2w | hooks 系统 |
| **A2** | Credential Masking | P2 | 2w | sandbox |
| **A3** | strictAllowlist | P3 | 3d | sandbox config |
| **B1** | Named Sessions | P2 | 1-2w | session storage |
| **B2** | Plugin Marketplace | P2 | 2-3w | plugin crate |
| **B3** | Thread Forking | P3 | 1w | session + context |
| **C1** | Focus View | P2 | 1-2w | TUI scrollback |
| **C2** | DirectoryAdded Hook | P3 | 3d | hooks system |
| **C3** | Nested Subagent | P3 | 1w | subagent resolution |
| **C4** | Remote Code Mode | P3 | 2-3w | workspace + ACP |
| **C5** | Web Search Providers | P4 | 1w | web_search tool |

**总计**: ~12-16 周，建议 3 个 Phase 分别 4-6 周完成。
