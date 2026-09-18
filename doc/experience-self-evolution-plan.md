# 在 grok-build 中构建“经验自进化”能力

## 1. 总体方案

### 目标

借鉴 [Oris 进化管道](https://github.com/Colin4k1024/Oris/blob/main/crates/oris-evolution/src/pipeline.rs) 的 `Detect → Select → Mutate → Execute → Validate → Evaluate → Solidify → Reuse` 闭环，在 grok-build 内实现原生、可审计、可回放的经验自进化系统。

V1 的自治边界确定为：

- 系统可自动生成代码或策略变异。
- 所有变异只能在专用隔离 worktree 中执行。
- 验证通过后自动固化为后续任务可复用的经验。
- 不自动 merge、push、创建 PR 或修改用户原工作树。
- 默认关闭，按 `Off → Shadow → IsolatedAutonomous → ReuseEligible` 分阶段放量。
- V1 同时交付完整 TUI：进化时间线、经验谱系、证据详情和放量控制台。

### Oris 概念映射

| Oris | grok-build 中的设计 | 说明 |
|---|---|---|
| Gene | `ExperienceRevision` | 不可变、版本化的策略经验 |
| Capsule | `EvidenceBundle + TrialOutcome` | 一次验证成功的真实执行证据 |
| EvolutionEvent | `EvolutionEvent` | 追加写入、可重放的事实事件 |
| EvolutionPipeline | `EvolutionEngine` | 八阶段状态机 |
| Governor | `EvolutionGovernor` | 风险、预算、晋级、隔离和熔断 |
| Confidence | `ConfidenceState` | Active、衰减、重验、隔离、撤销 |
| Replay | `ExperienceReuse` | 在后续任务中注入并观测效果 |

不直接依赖整个 Oris workspace。若复制或改写具体 MIT 源码，更新 `THIRD-PARTY-NOTICES` 和对应版权声明。

---

## 2. 架构与公共接口

### 2.1 新增独立领域内核

新增 `xai-grok-evolution` crate，保持为不依赖 shell、pager 和具体模型客户端的领域层。由于根 `Cargo.toml` 是生成产物但仓库内没有生成器，新 crate 接入时允许更新该 workspace 清单和 `Cargo.lock`，并将其视为必要的生成产物更新。

核心接口：

```rust
trait SignalCollector;
trait ExperienceStore;
trait ExperienceSelector;
trait VariantGenerator;
trait TrialRunner;
trait Validator;
trait TrialEvaluator;
trait EvolutionGovernor;
```

核心入口：

```rust
EvolutionEngine::submit_signals(...)
EvolutionEngine::run_trial(...)
EvolutionEngine::search_experiences(...)
EvolutionEngine::record_reuse(...)
EvolutionEngine::inspect_run(...)
EvolutionEngine::rebuild_projection(...)
```

公共数据类型统一携带 `schema_version`：

- `EvolutionRun`：一次完整进化运行。
- `EvolutionSignal`：归一化的问题、成功或反馈信号。
- `ExperienceCandidate`：尚未验证的候选经验。
- `ExperienceRevision`：不可变、有父版本关系的经验。
- `Contraindication`：带适用范围、TTL 和反证条件的负面经验。
- `TrialSpec`：允许路径、工具、预算、验证配方。
- `TrialOutcome`：执行事实，不包含模型主观结论。
- `EvidenceBundle` / `EvidenceRef`：可校验的证据及引用。
- `ReuseObservation`：后续任务实际复用结果。
- `AdoptionDecision`：`Reject | Quarantine | PublishCandidate | EligibleForReuse`。

经验生命周期：

```text
Candidate → Active → Decaying → Revalidating
    │          │                       │
    └──────────┴────→ Quarantined → Revoked
```

### 2.2 与现有系统的职责边界

- [xai-grok-memory](../crates/codegen/xai-grok-memory/src/lib.rs) 继续保存事实、会话摘要和普通知识，现有 `memory_search/get` 保持兼容。
- 进化经验使用独立事件库；只有 `Active` 经验会渲染为只读索引文档，供普通语义搜索发现。
- 普通知识相关性和经验置信度不直接相加；是否影响行动只能由 `ExperienceSelector` 和 `EvolutionGovernor` 决定。
- `xai-grok-shell` 负责 session 信号适配、模型调用、worktree、worker 生命周期和验证编排。
- `xai-grok-pager` 只通过 ACP DTO 查询 shell，不直接访问 SQLite。

### 2.3 数据流

```mermaid
flowchart LR
    A["Session、工具、反馈、Diff 信号"] --> B["Detect / 归一化"]
    B --> C["Select / 经验过滤与排序"]
    C --> D["Mutate / 生成结构化变异"]
    D --> E["隔离 Evolution Worktree"]
    E --> F["Validate / 基线与候选对照"]
    F --> G["Evaluate / 安全门与质量评分"]
    G --> H["Solidify / 经验与证据固化"]
    H --> I["Reuse / 后续任务注入"]
    I --> J["ReuseObservation / 置信度反馈"]
    J --> C
```

---

## 3. 八阶段闭环设计

### Detect：信号提取

接入现有：

- `SessionSignalsDelta` 中的工具失败、耗时、取消、重试、负评分和撤销。
- 工具结果、编译错误、测试失败、panic 和超时。
- `feedback.jsonl`、用户纠正和 stop-hook 反馈。
- hunk tracker、checkpoint、git commit/PR 以及测试成功证据。
- 模型成本、token、执行耗时和修改范围。

确定性规则负责分类、去重和严重度；LLM 只负责摘要和任务类型推断。敏感原文不进入经验正文，只保存脱敏后的 `EvidenceRef`。

### Select：经验选择

依次执行：

1. 按仓库、任务类型、信号类型和环境指纹过滤。
2. 排除未过期的 `Contraindication`。
3. 排除 `Quarantined`、`Revoked` 和环境漂移经验。
4. 按语义匹配、置信度、近期复用结果和时间衰减排序。
5. 每次自治运行只选择一个主经验，保证结果可归因；最多附带三个只读参考经验。

只有 `Active` 经验可以影响普通任务。

### Mutate：生成变异

模型必须返回版本化 JSON：

- 变异目标和触发信号。
- 适用前置条件。
- 允许修改的文件或目录。
- 禁止动作。
- 预期收益。
- 验证命令和成功谓词。
- 父经验版本。

拒绝空信号、no-op、越界修改、删除测试和缺少验证配方的提案。历史 patch 只能作为证据，不能直接重放。

### Execute：隔离执行

采用父进程编排、无网络 worker 执行：

1. 父进程完成所有模型调用。
2. 使用现有 worktree 能力，从记录的 commit 和 dirty snapshot 创建 evolution worktree。
3. 启动专用 `evolution-worker` 子进程，通过 stdin/stdout 交换版本化 JSON。
4. worker 只能读写 evolution worktree 和专属临时目录。
5. 工具白名单仅包含受限的 read、search、edit、patch 和 validator execution。
6. 禁止 MCP、网络工具、凭据读取、push、PR、源工作树路径和任意外部写入。
7. worker 返回结构化执行结果；父进程可根据结果生成下一轮变异，但受最大轮次和预算限制。

平台策略：

- Linux：bwrap/mount namespace 将源仓库只读挂载、trial worktree 可写，并使用独立 network namespace 和 seccomp 双重阻断网络。
- macOS：使用 Seatbelt 专用 worker profile，拒绝网络和 worktree 外写入。
- Windows 或无法证明隔离有效的平台：最多运行 Shadow，不允许进入自治模式。
- Preflight 必须实际验证源目录写入失败、网络连接失败、符号链接逃逸失败和 worktree 外路径不可写。

### Validate：验证与对照

在同一 source snapshot 上分别记录基线和候选结果：

- `fmt --check` 等非重写检查。
- 与触发失败直接相关的 targeted test。
- 根据修改文件和 `cargo metadata --no-deps` 计算受影响 package 与反向依赖。
- 对受影响 crate 运行 check/test。
- 检测测试删除、错误抑制、秘密信息、依赖锁变更和越界 diff。
- 项目配置可以补充可信 validator，但必须保存为 argv 数组，禁止 shell 字符串拼接。

验证命令缺失、超时、证据不全、基线不可比较或 sandbox 状态未知时，一律不能晋级。

### Evaluate：评估

确定性安全门先执行，任何模型都不能覆盖阻塞结果。

通过安全门后，独立 critic 评估：

- 信号是否被真正解决。
- 语义正确性。
- 泛化能力。
- 测试覆盖增量。
- 复杂度和修改范围。
- token、时间和执行成本。

模型最多建议 `NeedsReview/PublishCandidate`，不能把确定性 `Reject` 提升为可复用。

### Solidify：经验固化

- 成功运行生成不可变 `ExperienceRevision` 和 `EvidenceBundle`。
- 失败运行可以生成带 TTL、上下文指纹和反证条件的 `Contraindication`。
- 默认需要三个环境兼容且相互独立的成功观测，Candidate 才进入 Active。
- 连续两次复用失败、用户撤销或明显质量回退，立即进入 Quarantined。
- toolchain、lockfile、配置或仓库结构变化触发 `Revalidating`，重验前不得自动复用。

### Reuse：后续任务复用

首轮 prompt 构建时最多注入一条 Active 经验，使用独立的 `EXPERIENCE_CONTEXT`：

- 经验 ID 和版本。
- 适用条件。
- 推荐步骤。
- 禁止动作。
- 验证配方。
- 最近证据摘要。

规则：

- 明确低于 system、用户要求、AGENTS 和安全策略的优先级。
- 最大 1,200 tokens。
- token 不足时先删除证据摘要，再压缩步骤；ID、边界和验证要求不可省略。
- 每轮选择重新读取当前 projection，不长期缓存；经验被隔离后，下一轮立即停止注入。
- 用户撤销、纠正或验证失败后，在当前 turn end 前完成 Quarantine，目标撤销 SLA 为 5 秒以内。

---

## 4. 存储、一致性与配置

### 4.1 事件库与证据

存储位置：

```text
~/.grok/memory/{workspace}/evolution/
├── evolution.sqlite
├── artifacts/
└── staging/
```

`evolution.sqlite` 包含：

- append-only `events`。
- `runs` 投影。
- `experience_projection`。
- `lineage_edges`。
- `reuse_observations`。
- `evidence_manifests`。
- `schema_migrations`。

事件至少包含：

```text
event_id, run_id, causation_id, event_type,
schema_version, timestamp, payload, content_hash
```

事件顺序：

```text
RunStarted
→ SignalsDetected
→ CandidatesRanked
→ VariantProposed
→ TrialStarted / TrialCompleted
→ ValidationCompleted
→ EvaluationCompleted
→ AdoptionDecided
→ RevisionPublished / Quarantined
→ ReuseObserved
→ ConfidenceTransitioned
```

### 4.2 Artifact 原子性

采用“先文件、后数据库”的两阶段发布：

1. 写入 `staging/{run_id}`。
2. 完成脱敏、大小校验、blake3 和 fsync。
3. 原子 rename 到 content-addressed `artifacts/{hash}`。
4. 在单个 SQLite 事务中追加事件、manifest 和投影。
5. 数据库事务失败时，artifact 仅成为不可见孤儿，由 GC 回收。
6. 数据库中绝不允许引用尚未完成 rename 的 artifact。

启动时重放事件、重建投影，并将未完成的 Running run 标记为 `Abandoned`。重试必须使用幂等键，不能重复发布经验。

### 4.3 Schema 与容量策略

- SQLite migration 必须事务化。
- 事件 payload 支持当前版本以及前两个版本的 upcaster。
- 遇到更新版本的数据时以只读方式启动并禁用 evolution，禁止猜测解析。
- projection 可删除重建；重建期间自动降级到 Shadow。
- 默认每 workspace 同时一个 trial、全局最多两个。
- bounded queue 默认 32，单 session 默认最多一次自动 trial。
- 单 trial 默认 20 分钟、三轮变异、50 MB artifact。
- 单 workspace 默认 2 GB/30 天；原始日志可 GC，事件和 evidence manifest 长期保留。

### 4.4 配置与模式

新增独立 `EvolutionConfig`，不依赖 `MemoryConfig`：

```toml
[evolution]
mode = "off"
shadow_sample_rate = 0.1
max_trials_per_session = 1
max_concurrent_trials = 1

[evolution.budget]
max_duration_secs = 1200
max_variant_rounds = 3
max_artifact_mb = 50

[evolution.governor]
max_files_changed = 5
max_lines_changed = 300
promote_after_successes = 3
quarantine_after_failures = 2
```

同时提供：

- `--experimental-evolution`
- `--no-evolution`
- `GROK_EVOLUTION`
- 全局 kill switch
- workspace override

优先级为 force-off CLI/env 最高；TUI 不可覆盖 force-off。

模式语义：

- `Off`：零 DB open、零后台任务。
- `Shadow`：捕获、选择、提案和抽样隔离评估，但不发布、不注入。
- `IsolatedAutonomous`：自动 trial，发布 Candidate/Contraindication，但不影响普通任务。
- `ReuseEligible`：允许 Active 经验自动注入，仍不合并代码。

每次升级必须通过 storage、VCS、sandbox、断网、validator、预算和熔断 preflight。失败保持原模式并返回结构化原因。

---

## 5. TUI、ACP 与 CLI

### TUI `/evolution`

基于现有 modal/effect/notification 架构新增四个页签：

1. `Timeline`
   - 三栏显示触发信号、变异 diff、验证和采用结论。
   - 支持按状态、任务类型、时间和经验过滤。
   - 每个事件可以下钻原始证据。

2. `Lineage`
   - ASCII DAG 展示经验父子关系。
   - 节点显示状态、置信度、成功/失败次数和环境指纹。
   - 大型谱系支持折叠、分页和筛选。

3. `Control`
   - 显示有效模式、配置来源、预算、队列、失败率、熔断状态和 preflight。
   - 只允许逐级升降模式。
   - 进入 `ReuseEligible` 必须二次确认。

4. `Evidence`
   - 展示命令 argv、退出码、测试结果、diff、环境、内容哈希和脱敏日志。
   - 模型解释和结构化事实分区显示，事实优先。

### ACP 接口

- `x.ai/evolution/status`
- `list_runs`
- `inspect_run`
- `lineage`
- `set_mode`
- `retry_trial`
- `export_evidence`

通知：

- `EvolutionRunUpdated`
- `EvolutionModeChanged`
- `EvolutionCircuitBreakerTripped`

### Headless CLI

```text
grok evolution status
grok evolution list
grok evolution inspect <run-id>
grok evolution run
grok evolution export <run-id>
```

全部支持 `--json`，共享 ACP DTO。`run` 只创建隔离 trial。

---

## 6. 实施阶段与完成门

### P0：契约、威胁模型与许可

- 冻结事件 schema、经验 schema、状态机、模式语义和 JSON fixtures。
- 建立路径逃逸、符号链接、IPC 伪造、sandbox 失效、网络绕过、artifact 不一致威胁用例。
- 完成 Oris 概念映射和许可证处理。

完成门：fixtures 可反序列化；非法状态迁移全部拒绝；威胁用例具有明确 fail-closed 结果。

### P1：领域内核和事件库

- 实现核心类型、状态机、SQLite、migration、projection、selector、confidence 和 governor。
- 所有外部能力使用 fake ports。
- 完成 artifact 两阶段发布和 projection 重建。

完成门：事件幂等、崩溃恢复、迁移、投影重建和孤儿 artifact GC 测试通过。

### P2：Shadow 信号链

- 接入 session、工具、反馈、hunk、checkpoint 和 telemetry。
- turn end 只写 bounded queue。
- 完成 signal→candidate→evaluation 链路，但不创建修改。

完成门：普通 turn 延迟无明显回归；memory on/off 均正常；Shadow 不改变 prompt 和工作树。

### P3：隔离 Trial

- 实现 evolution worker、Linux/macOS sandbox、网络阻断和 worker protocol。
- 接入 dirty-copy worktree、变异循环、基线/候选验证和清理。
- 完成受影响 crate 分析。

完成门：源工作树哈希保持不变；写越界、网络、符号链接逃逸全部失败；crash/timeout/disk-full 后 worktree 可回收。

### P4：Solidify 与 Reuse

- 发布 Candidate、Active、Contraindication 和谱系。
- 接入环境漂移、置信度、Quarantine 和 prompt injection。
- 建立固定 replay corpus。

完成门：完整走通 Candidate→三次成功→Active→注入→两次失败→Quarantine，下一轮不再注入。

### P5：ACP、CLI 与完整 TUI

实施顺序固定为：

1. ACP DTO 和查询接口。
2. CLI/JSON golden。
3. Timeline 和 Evidence。
4. Lineage。
5. Control 和模式切换。

完成门：CLI、TUI 和 SQLite 对同一 run 显示一致；旧 shell 不支持接口时 UI 可降级；小终端、断线、空状态和大谱系测试通过。

### P6：分阶段放量

- Shadow 抽样运行。
- 开启 IsolatedAutonomous。
- 达到安全门后开启 ReuseEligible。

进入 ReuseEligible 的门：

- 源工作树污染事件为零。
- sandbox 和 evidence 完整率为 100%。
- 无未解释的网络或越界写入。
- circuit breaker、kill switch 和 Quarantine 演练通过。
- 固定回放集无正确性回归。
- 已建立成功率、首次成功率、重试、token、耗时和撤销率基线。

---

## 7. 测试与最终验收

### 自动化测试

- 单元：schema、事件哈希、幂等、投影、状态迁移、选择器、TTL、衰减、Quarantine、governor、secret scrub。
- 集成：dirty Git/jj、测试失败、超时、崩溃、磁盘满、迁移失败、恶意 validator、sandbox 不可用、网络尝试和路径逃逸。
- E2E：真实临时仓库完成八阶段闭环，验证原仓库、分支和远端未变化。
- UI：四个页签、键鼠、过滤、分页、窄终端、ACP 断线、force-off 和模式确认。
- 回归：memory、dream、flush、普通 agent、workflow replay、worktree resume、headless 和现有 sandbox profiles。
- 性能：Off 路径零成本；Shadow 入队不阻塞；验证 trial 并发、磁盘和 token 上限。

### 用户可见验收场景

1. 一次测试失败自动产生进化 run，在 TUI 中能回答“为什么触发、改了什么、执行了什么、为什么采用或拒绝”。
2. 一条经验通过三次独立试验成为 Active，在下一次匹配任务中被解释性注入，并产生 `ReuseObservation`。
3. 经验造成连续失败或用户撤销后，在 5 秒内进入 Quarantine，下一轮不再注入。
4. 任意 trial 失败、进程崩溃或 sandbox 不可用时，原工作树、当前分支和远端完全不变。
5. 所有结果都可从 append-only events 重建，证据哈希可验证，CLI 与 TUI 展示一致。

### 明确不包含

- 自动 merge、push、PR 或修改用户分支。
- 跨机器经验网络和 Experience Repository。
- 直接执行历史 patch。
- 无证据的全局经验。
- 自定义复杂 DSL。
- 多 worktree 变异锦标赛。
- 在无法证明隔离安全的平台运行自治变异。

## 假设与评审结论

- V1 优先保证闭环完整和安全边界，量化收益作为 `ReuseEligible` 扩量门。
- Git 和现有 jj adapter 纳入支持；其他 VCS 或无 VCS 项目最多运行 Shadow。
- 完整 TUI 是 V1 必交付内容，但必须在内核、ACP 和 CLI 稳定后顺序实施。
- `all-plan` 独立审阅得分 7.7/10，已将其指出的 sandbox 平台边界、artifact 原子性、schema 兼容、复用 token 预算和阶段退出门纳入本计划。
