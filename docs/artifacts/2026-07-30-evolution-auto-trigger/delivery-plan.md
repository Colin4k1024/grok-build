# Delivery Plan: 自进化系统自动触发与 Skill 进化能力补充

## 版本目标

- **里程碑**: v0.1 — 自进化系统增强（自动触发 + Skill 进化）
- **范围**: PRD 中全部 4 个 US（US-1 ~ US-4）
- **放行标准**: `cargo test` 全绿、新增路径有 E2E 覆盖、`cargo clippy` 无 warning

## 工作拆解

### Phase 1: 类型扩展与信号收集器改造

| 工作项 | 主责 | 依赖 | 说明 |
|--------|------|------|------|
| P1-1: `SignalType` 枚举扩展 | backend-engineer | 无 | 新增 `PositiveOutcome`、`SkillSuccess`、`SkillIneffective` |
| P1-2: `TriggerType` 枚举扩展 | backend-engineer | 无 | 新增 `PositiveExperience`、`SkillDecay` |
| P1-3: `SessionSignalsDelta` 字段扩展 | backend-engineer | 无 | evolution crate 侧新增 `turn_step_count: usize`、`tools_used: Vec<String>`、`injected_experiences: Vec<InjectedExperienceRef>` |
| P1-4: `DefaultSignalCollector` 改造 | backend-engineer | P1-1, P1-3 | 新增正向信号提取逻辑：turn_step_count ≥ 3 且 tools_used.len() ≥ 2 时生成 `PositiveOutcome` 信号 |
| P1-5: `trigger_from_signals` 扩展 | backend-engineer | P1-1, P1-2 | 新增 `PositiveOutcome → PositiveExperience`、`SkillIneffective → SkillDecay` 映射 |
| P1-6: 成功信号采样率控制 | backend-engineer | P1-4 | 在 `on_turn_end` 中对 `PositiveOutcome` 信号应用 30% 采样率（配置化） |
| P1-7: 单元测试 | backend-engineer | P1-1 ~ P1-6 | 覆盖新信号类型收集、采样率过滤、trigger 映射 |

### Phase 2: 经验保存可靠性加固

| 工作项 | 主责 | 依赖 | 说明 |
|--------|------|------|------|
| P2-1: solidify 阶段重试包装 | backend-engineer | 无 | 新增 `retry_solidify` 函数，包裹文件发布 + DB 写入，指数退避 100ms/500ms/2000ms |
| P2-2: DB 写入幂等化 | backend-engineer | 无 | `append_and_project` 中 INSERT 语句改为 `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` |
| P2-3: `try_send` 队列满告警 | backend-engineer | 无 | `on_turn_end` 中 `try_send` 失败时 emit `tracing::warn!` + metrics counter |
| P2-4: 错误日志补全 | backend-engineer | P2-1 | solidify 路径全链路 `tracing::error` 级别失败日志，包含 run_id、stage、具体错误 |
| P2-5: 单元测试 | backend-engineer | P2-1 ~ P2-4 | 模拟 DB 锁竞争、磁盘满场景验证重试行为 |

### Phase 3: Shell 侧适配

| 工作项 | 主责 | 依赖 | 说明 |
|--------|------|------|------|
| P3-1: `evolution_delta_from_turn` 扩展 | backend-engineer | P1-3 | 填充 `turn_step_count`（从 `delta_tool_calls` 计算）、`tools_used`（从 `tools_this_turn`）、`injected_experiences`（从 `evolution_injection`） |
| P3-2: `InjectedExperienceRef` 类型定义 | backend-engineer | P1-3 | 在 evolution crate 新增结构体：`experience_id`、`injection_id`、`skill_name: Option<String>` |
| P3-3: injection 记录传递 | backend-engineer | P3-1, P3-2 | 将当前 `self.evolution_injection` 的信息同时传入 delta，不仅用于 attribution |
| P3-4: 兼容性保证 | backend-engineer | P3-1 | 新字段使用 `#[serde(default)]`，旧版 shell 传空值时 evolution crate fallback 到无正向信号 |

### Phase 4: Skill Observer 模块

| 工作项 | 主责 | 依赖 | 说明 |
|--------|------|------|------|
| P4-1: `skill_observer.rs` 骨架 | backend-engineer | P1-1, P3-2 | 新增模块文件，定义 `SkillObserver` struct + trait 接口 |
| P4-2: 观察缓冲实现 | backend-engineer | P4-1 | in-memory `VecDeque<SkillObservation>`，容量 100，session 生命周期绑定 |
| P4-3: 效果推断逻辑 | backend-engineer | P4-2, P1-3 | 根据注入后 3 个 turn 的 delta 推断 Success/Ineffective/Neutral |
| P4-4: 信号生成集成 | backend-engineer | P4-3, P1-4 | Observer 产出 `SkillSuccess` / `SkillIneffective` 信号，注入 `DefaultSignalCollector` 输出 |
| P4-5: 单元测试 | backend-engineer | P4-1 ~ P4-4 | 覆盖单 Skill 归因成功、失败、中性；多 Skill 标记 Neutral |

### Phase 5: Skill 衰减检测与自动触发

| 工作项 | 主责 | 依赖 | 说明 |
|--------|------|------|------|
| P5-1: 衰减检测逻辑 | backend-engineer | P4-2 | 在 `SkillObserver` 中实现：近 10 次观察中 Ineffective ≥ 40% 触发 decay 信号 |
| P5-2: `SkillDecay` trigger 集成 | backend-engineer | P5-1, P1-2, P1-5 | decay 信号入队 evolution pipeline，trigger_type = `SkillDecay` |
| P5-3: 配置化阈值 | backend-engineer | P5-1 | `EvolutionConfig` 新增 `skill_decay_window: usize`（默认 10）和 `skill_decay_threshold: f64`（默认 0.4） |
| P5-4: 单元测试 | backend-engineer | P5-1 ~ P5-3 | 覆盖阈值边界、窗口不足时不触发 |

### Phase 6: E2E 测试与集成验证

| 工作项 | 主责 | 依赖 | 说明 |
|--------|------|------|------|
| P6-1: 正向信号 E2E | backend-engineer | Phase 1, 3 | 模拟成功 turn → 验证 PositiveOutcome 信号生成 → observational solidify 完成 |
| P6-2: 可靠性 E2E | backend-engineer | Phase 2 | 模拟 solidify 首次失败 → 验证重试成功 → 经验最终持久化 |
| P6-3: Skill Observer E2E | backend-engineer | Phase 4, 5 | 模拟 Skill 注入 → 后续 turn 失败 → 验证 SkillIneffective 信号 → 达到阈值触发 SkillDecay |
| P6-4: 采样率验证 | backend-engineer | P1-6 | 统计多次成功 turn 中实际入队比例，验证接近 30% |

## 风险与缓解

| 风险 | 影响 | 缓解 | Owner |
|------|------|------|-------|
| Phase 1 类型变更导致大量 match 穷举报错 | 编译失败 | 新增 variant 后全局搜索 `match.*SignalType` / `match.*TriggerType`，逐一补全 | backend-engineer |
| Shell 侧 `evolution_injection` 生命周期在 delta 构造时已被 `take()` | 数据丢失 | P3-3 中先 clone 再 take，或重构为 peek + take 两阶段 | backend-engineer |
| Skill Observer 内存泄漏（长 session） | OOM | VecDeque 硬上限 100 + session 结束时 drop | backend-engineer |
| 新增字段破坏旧版序列化 | 向后不兼容 | 全部新字段 `#[serde(default)]` | backend-engineer |

## 节点检查

| 节点 | 完成条件 |
|------|----------|
| 方案评审 | 本 delivery plan 被 tech-lead 确认 |
| Phase 1 完成 | 新枚举编译通过 + 信号收集器单测绿 |
| Phase 2 完成 | 重试逻辑单测绿 + clippy 通过 |
| Phase 3 完成 | shell 侧编译通过 + delta 填充正确 |
| Phase 4 完成 | Observer 单测全绿 |
| Phase 5 完成 | 衰减检测单测全绿 |
| Phase 6 完成（放行） | E2E 全绿 + `cargo clippy -- -D warnings` 通过 |

## 实现优先级与依赖图

```
Phase 1 (类型 + 收集器)
    ├── Phase 2 (可靠性加固) [无依赖，可并行]
    ├── Phase 3 (Shell 适配) [依赖 P1-3]
    │       └── Phase 4 (Skill Observer) [依赖 Phase 3]
    │               └── Phase 5 (衰减检测) [依赖 Phase 4]
    └── Phase 6 (E2E) [依赖全部 Phase]
```

**关键路径**: Phase 1 → Phase 3 → Phase 4 → Phase 5 → Phase 6

**可并行**: Phase 2 与 Phase 3 可并行开发（Phase 2 不依赖 Phase 1 的正向信号，只加固现有 solidify 路径）
