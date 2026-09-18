# xai-grok-evolution 威胁模型

## 1. 系统概述

xai-grok-evolution 实现八阶段经验自进化管道，包含自动代码变异、隔离沙箱执行和经验复用注入。系统涉及在用户机器上执行自动生成的代码修改，安全边界要求极高。

## 2. 资产

| 资产 | 敏感度 | 说明 |
|------|--------|------|
| 源工作树 | Critical | 用户代码，任何未授权修改都是不可接受的 |
| 用户凭据 | Critical | API key、token、私钥等 |
| 经验库 | High | 被注入到后续任务的策略知识 |
| 事件库 | Medium | 执行历史和审计日志 |
| Worker 子进程 | High | 隔离执行环境 |

## 3. 威胁用例与 Fail-Closed 结果

### T1: 路径逃逸

| 项 | 内容 |
|---|------|
| **攻击向量** | Worker 通过绝对路径、`../` 遍历或编码绕过读写源工作树外的文件 |
| **Fail-Closed** | bwrap mount namespace（Linux）/ Seatbelt（macOS）在内核层强制隔离；源仓库以只读挂载；worktree 外路径不可写 |
| **Preflight 验证** | 启动时创建测试文件到源目录，验证写入失败；创建 `../` 路径，验证拒绝 |
| **残余风险** | Linux glob deny 为 best-effort（仅覆盖启动时已存在的文件）；macOS runtime regex 覆盖新文件 |

### T2: 符号链接逃逸

| 项 | 内容 |
|---|------|
| **攻击向量** | 在 evolution worktree 内创建符号链接指向源工作树敏感文件，通过符号链接写入 |
| **Fail-Closed** | bwrap/Seatbelt 不跟随 worktree 外的符号链接；preflight 创建符号链接并验证读取失败 |
| **Preflight 验证** | 启动时创建指向源工作树的符号链接，验证通过该链接的读写操作均失败 |

### T3: IPC 伪造

| 项 | 内容 |
|---|------|
| **攻击向量** | Worker 子进程伪造 stdin/stdout 消息，注入虚假执行结果或绕过验证 |
| **Fail-Closed** | Worker 协议使用版本化 JSON + content_hash 校验；父进程验证所有响应的完整性和合理性 |
| **Preflight 验证** | Worker 无法访问父进程的内存空间；stdin/stdout 是单向管道，不可被外部进程读取 |

### T4: Sandbox 失效

| 项 | 内容 |
|---|------|
| **攻击向量** | Sandbox 机制不可用（bwrap 未安装、Landlock 内核版本不足、Seatbelt 被禁用） |
| **Fail-Closed** | Preflight 必须实际验证 sandbox 机制可用；不可用时拒绝进入 IsolatedAutonomous 模式，降级为 Shadow |
| **Preflight 验证** | 执行 sandbox 状态检查：`bwrap --version`、Landlock ABI 版本、Seatbelt 可用性 |

### T5: 网络绕过

| 项 | 内容 |
|---|------|
| **攻击向量** | Worker 子进程通过网络外泄代码、下载恶意依赖或与外部 C2 通信 |
| **Fail-Closed** | Linux: seccomp BPF 阻断 connect/bind/sendto/sendmsg/listen/accept/accept4 系统调用；macOS: Seatbelt deny network |
| **Preflight 验证** | 启动时在 worker 内尝试 HTTP 请求，验证失败；验证 DNS 解析不可达 |

### T6: Artifact 不一致

| 项 | 内容 |
|---|------|
| **攻击向量** | 两阶段发布中，artifact 文件和数据库记录不一致导致幻影经验或数据丢失 |
| **Fail-Closed** | 先写 staging → blake3 校验 → fsync → 原子 rename → 单 DB 事务；DB 事务失败时 artifact 成为孤儿由 GC 回收 |
| **Preflight 验证** | 启动时扫描 artifacts/ 中无 manifest 引用的孤儿文件并清理 |

### T7: Prompt 注入

| 项 | 内容 |
|---|------|
| **攻击向量** | 恶意经验在 EXPERIENCE_CONTEXT 中嵌入 "ignore previous instructions" 等注入文本 |
| **Fail-Closed** | EXPERIENCE_CONTEXT 只允许结构化字段（ID、步骤、验证配方、禁止动作），不允许自由文本指令；最大长度 1200 tokens 硬限制 |
| **Preflight 验证** | 注入前扫描经验内容中的可疑模式（"ignore"、"override"、"forget"、"disregard"） |

### T8: 凭据泄漏

| 项 | 内容 |
|---|------|
| **攻击向量** | 信号队列、事件库或 evidence bundle 中包含未脱敏的 API key、token 或用户代码片段 |
| **Fail-Closed** | Signal collector 写入时立即调用 `xai-grok-secrets` scrubber；artifact 写入前二次校验 `scrubbed` 字段作为发布门禁 |
| **Preflight 验证** | 对已发布的 artifact 执行批量 scrubbing 检查，验证无新匹配 |

## 4. 平台能力矩阵

| 机制 | Linux | macOS | Windows |
|------|-------|-------|---------|
| 文件系统隔离 | Landlock + bwrap mount namespace | Seatbelt | 无 |
| 网络阻断 | seccomp BPF (per-child) | Seatbelt deny network | 无 |
| 符号链接防护 | bwrap + Landlock | Seatbelt runtime regex | 无 |
| 最高自治模式 | IsolatedAutonomous | IsolatedAutonomous | Shadow |
| Preflight 要求 | 全部 7 项 | 全部 7 项 | N/A（不进入自治） |

## 5. 风险缓解时间线

| 阶段 | 威胁 | 缓解措施 |
|------|------|---------|
| P0 | T1-T8 | 威胁模型定义（本文档）、Fail-Closed 规范 |
| P1 | T6 | Artifact 两阶段发布实现 + 孤儿 GC |
| P2 | T8 | Signal scrubbing 集成 |
| P3 | T1-T5 | Sandbox profile + preflight 实现 |
| P4 | T7 | EXPERIENCE_CONTEXT 注入校验 |
| P5 | — | TUI 安全确认对话框 |
| P6 | T1-T8 | 全量 preflight 演练 + 回放回归 |
