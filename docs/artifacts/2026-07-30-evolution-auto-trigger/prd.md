# PRD: 自进化系统自动触发与 Skill 进化能力补充

## 背景

当前 `xai-grok-evolution` 自进化系统存在两个核心缺陷：

1. **经验沉淀非自动触发，且保存频繁失败**：`EvolutionService::on_turn_end` 虽然在 turn 结束时被调用，但仅当 `SessionSignalsDelta` 中包含失败类信号（ToolFailure、TestFailure 等）时才会产生信号并入队。成功完成的 turn 不会触发任何经验沉淀。此外，经验保存路径存在多处静默失败点（artifact 写入、SQLite 投影、content hash 校验），缺乏重试和错误上报机制。

2. **触发条件过窄，缺少 Skill 自进化逻辑**：当前 `SignalType` 和 `TriggerType` 枚举仅覆盖失败场景（ToolFailure、TestFailure、Timeout、Panic 等）和用户纠正。没有：
   - 成功完成后的正向经验提取（"什么策略有效"）
   - Skill 执行结果的观察与反馈闭环
   - Skill 自身质量的衰减检测与自动更新触发

## 目标与成功标准

### 业务目标
- 自进化系统能在无人工干预的情况下，自动从成功和失败中学习并沉淀可复用经验
- Skill 的执行效果能被观察、评估，并驱动 Skill 自身的迭代进化

### 成功标准
1. 后台经验沉淀自动触发率 > 90%（不再依赖手动 `run_manual`）
2. 经验保存成功率从当前水平提升到 > 95%（加入重试 + 错误诊断）
3. 新增 Skill 进化闭环：Skill 执行 → 效果观察 → 信号生成 → 经验提取 → Skill 更新
4. 端到端 E2E 测试覆盖新增的自动触发路径和 Skill 进化路径

## 用户故事

### US-1: 自动触发经验沉淀
**作为**系统运维者，**我希望**自进化系统在每个 turn 结束后自动判断是否需要沉淀经验（包括成功经验），**以便**积累的知识不完全依赖失败场景驱动。

**验收标准：**
- 成功 turn 中如果包含可泛化的策略（turn 步骤 ≥ 3 且涉及工具 ≥ 2 种），自动生成 `PositiveOutcome` 信号
- 成功信号采样率默认 30%（可配置），避免 pipeline 过载
- `PositiveOutcome` 信号走 `solidify_observational` 轻量路径（跳过 mutate/execute/validate）
- 信号生成后自动入队 evolution pipeline，无需手动触发
- 对于没有学习价值的简单 turn（纯问答、单步操作），不产生信号（避免噪音）
- `try_send` 队列满时 emit `tracing::warn` + telemetry counter（可观测，不阻塞）

### US-2: 经验保存可靠性
**作为**系统运维者，**我希望**经验保存失败时有明确的错误诊断和自动重试，**以便**不会静默丢失有价值的经验。

**验收标准：**
- 整个 `solidify` 阶段（文件发布 + DB 写入）失败后自动重试最多 3 次（指数退避：100ms / 500ms / 2000ms）
- DB 写入使用 `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` 确保幂等，重试安全
- SQLite 写入失败（锁竞争、磁盘满）有明确日志和 telemetry 上报
- 经验保存全路径有 `tracing::error` 级别的失败日志，可追溯到具体阶段
- 重试在 consumer 线程内异步执行，不阻塞主 session 线程

### US-3: Skill 执行效果观察
**作为**系统运维者，**我希望**Skill 执行后自动收集效果信号，**以便**系统能判断哪些 Skill 工作良好、哪些需要改进。

**验收标准：**
- 新增 `SignalType::SkillSuccess` 和 `SignalType::SkillIneffective` 信号类型
- `SessionSignalsDelta` 新增 `injected_experiences: Vec<InjectedExperienceRef>` 字段，记录当前 turn 实际注入了哪些经验
- Skill Observer 维护 in-memory 环形缓冲（`VecDeque`，session 生命周期绑定），记录最近 N 次注入及后续 turn 结果
- Skill 执行完成后，在归因窗口（3 个 turn）内根据后续结果自动推断效果
- 单 Skill 注入场景正常归因；多 Skill 协同场景标记为 `Neutral`（首期不做多因归因）
- 效果观察存入 `ReuseObservation`，与现有经验生命周期状态机对齐

### US-4: Skill 自进化触发
**作为**系统运维者，**我希望**当某个 Skill 的效果指标持续下降时，自动触发该 Skill 的更新进化流程，**以便**Skill 库不会随时间退化。

**验收标准：**
- 新增 `TriggerType::SkillDecay` 触发类型
- 当 Skill 的近 10 次效果观察中，`Ineffective` 比例超过 40%（可配置），自动触发进化 run
- 进化 run 的 `VariantGenerator` 能基于 Skill 历史执行记录和失败模式，提出 Skill 改进方案

## 范围

### In Scope
- `SignalType` 枚举扩展：`PositiveOutcome`、`SkillSuccess`、`SkillIneffective`
- `TriggerType` 枚举扩展：`PositiveExperience`、`SkillDecay`
- `SessionSignalsDelta` 扩展：新增 `turn_step_count`、`tools_used`、`injected_experiences` 字段
- `DefaultSignalCollector` 改造：支持从成功 turn 中提取信号（纯规则 + 采样率控制）
- 经验保存路径可靠性加固：solidify 阶段整体重试、DB 幂等写入、错误日志、telemetry
- `try_send` 队列满告警
- Skill 效果观察模块（新增 `skill_observer.rs`）
- Skill 衰减检测与自动触发逻辑
- `xai-grok-shell` 侧 delta 构造改动（填充 `turn_step_count`、`tools_used`、`injected_experiences`）
- E2E 测试覆盖

### Out of Scope
- Skill 文件的自动写入/更新（本期只生成改进提案，不自动修改 SKILL.md）
- UI/TUI 展示层变更
- Rollout 策略变更（复用现有 RolloutController）
- 跨 workspace 的 Skill 共享
- 多 Skill 协同场景的精确归因（首期标记为 Neutral）

## 设计约束（挑战会确认）

| 项目 | 确认值 |
|------|--------|
| 成功信号判定规则 | 纯规则：turn 步骤 ≥ 3 且工具 ≥ 2 种 |
| 成功信号采样率 | 默认 30%，可配置 |
| PositiveOutcome pipeline 路径 | `solidify_observational`（轻量，跳过 mutate/execute/validate） |
| Skill 效果归因窗口 | 3 个 turn |
| SkillDecay 触发阈值 | 近 10 次中 ≥ 40% ineffective，配置化 |
| 经验保存重试范围 | 整个 solidify 阶段（文件 + DB），非仅 atomic_publish |
| 重试退避策略 | 100ms / 500ms / 2000ms，异步不阻塞主路径 |
| DB 写入幂等 | INSERT OR IGNORE / ON CONFLICT DO NOTHING |
| 归因状态存储 | in-memory VecDeque，session 生命周期绑定 |
| 多 Skill 场景处理 | 标记为 Neutral，不做精确归因 |

## 风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| 成功信号噪音过大，导致 evolution pipeline 过载 | 队列满、CPU 占用高 | 30% 采样率 + 步骤/工具阈值过滤 + observational 轻量路径 |
| Skill 效果归因不准确（多 Skill 协同时无法区分贡献） | 错误触发 Skill 更新 | 首期仅观察单 Skill 执行场景，多 Skill 场景标记为 `Neutral` |
| 经验保存重试引入延迟 | consumer 线程阻塞后续 run | 重试总耗时 <3 秒，仅阻塞 consumer 不影响主线程 |
| SQLite 并发写入瓶颈 | 高频 turn 场景下丢信号 | 保持现有 `sync_channel(64)` 背压 + 队列满告警 |
| shell 侧 delta 构造改动引入兼容性问题 | 旧版 shell 与新版 evolution 不兼容 | 新字段使用 `#[serde(default)]`，缺失时 fallback 到空/零值 |

## 挑战会记录

**日期**: 2026-07-30  
**参与者**: tech-lead / architect / backend-engineer

### 关键质疑与结论

1. **Pipeline 过载风险**（architect）：纯规则阈值可能过宽 → 增加 30% 采样率 + observational 轻量路径
2. **Skill 归因缺乏因果链**（architect）：delta 需新增 `injected_experiences` 字段作为 Observer 输入前提
3. **重试范围不足**（backend-engineer）：修正为覆盖整个 solidify 阶段，DB 需幂等
4. **上游 shell 需同步改动**（backend-engineer）：PRD In Scope 补充 `xai-grok-shell` 侧改动
5. **队列满无告警**（backend-engineer）：`try_send` 失败增加 warn + metrics

### 门禁状态

```
Pre-flight: ✅ 挑战会完成、待确认项已确认
Revision:   ✅ 已全部写入 PRD
Escalation: 无
Abort:      ✅ 无阻塞
```
