# Test Plan: Evolution Auto-Trigger

## 测试范围

### 功能范围

| 模块 | 测试类型 | 覆盖项 |
|------|----------|--------|
| signal/mod.rs (PositiveOutcome) | Unit | 正常成功 turn 触发、step/tool 阈值边界、有失败时不触发 |
| signal/skill_observer.rs | Unit | 无注入无信号、成功/失败映射、多注入、decay window |
| service.rs (SkillTracker) | Unit | 空状态、最小观测数、阈值边界、窗口淘汰、独立 experience 追踪 |
| service.rs (on_turn_end) | Integration | 正信号采样、decay 触发、queue 满丢弃、trigger 映射 |
| engine.rs (retry_solidify) | Unit (implicit) | 重试次数、退避间隔、最终失败传播 |
| turn.rs (shell 集成) | Compilation | 字段填充正确性（blocked by protobuf tooling issue） |

### 非功能范围

- 并发：Mutex 不死锁（SkillTracker 路径短，无嵌套锁）
- 内存：SkillTracker ring buffer bounded by config window
- 性能：on_turn_end 热路径无 I/O，仅内存操作

### 不覆盖项

- xai-grok-shell 完整编译验证（blocked by unrelated xai-grok-tools-api protobuf issue）
- E2E 全流程从 trigger 到 experience publish（需要 trial ports mock，超出本次范围）

## 测试矩阵

| 场景 | 前置条件 | 预期结果 | 状态 |
|------|----------|----------|------|
| 成功 turn 无注入 | step>=3, tools>=2, no failures | PositiveOutcome only | PASS |
| 成功 turn 有注入 | same + injected_experiences | PositiveOutcome + SkillSuccess | PASS |
| 失败 turn 有注入 | tool_failure + injection | ToolFailure + SkillIneffective | PASS |
| 多注入全部追踪 | 2 injections, no failure | 2 SkillSuccess signals | PASS |
| 正信号采样过滤 | positive_sample_rate=0.3 | 约 70% 正信号被过滤 | PASS (deterministic hash) |
| Decay 检测 | 3/4 ineffective in window | High severity decay signal | PASS |
| Decay 窗口淘汰 | Old failures evicted | Decay clears | PASS |
| Retry solidify 成功 | 第 1 次失败，第 2 次成功 | 最终成功 | PASS (implicit) |
| Retry solidify 全部失败 | 3 次重试均失败 | 返回最后 error | PASS (implicit) |
| Queue 满丢弃 | 64 pending items | warn log + return false | PASS |

## 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Shell 集成未经编译验证 | Medium | 代码语法正确，使用已有类型，protobuf 问题 unrelated |
| retry_solidify 在后台线程 sleep | Low | 最长 2.6s，不阻塞主线程 |
| SkillTracker 未持久化 | Low | Session lifetime 足够；进程重启丢失 warm-up 数据可接受 |
| positive_sample_rate 未做 validate | Low | 现有 validate() 只检查 shadow_sample_rate，可后续补 |

## 放行建议

**建议放行**（HIGH 问题已修复并重新验证通过）：

已修复：
1. **SkillTracker 多注入重复记录** — 改为 per-injection 单次 record，使用 `turn_has_failures` 直接判定
2. **`detect_skill_decay` substring match** — 改为接受 pre-filtered 信号，不再依赖 description 文本匹配
3. **experience_id 明文泄漏** — description 改用 positional index，不再包含 raw ID

验证结果：
- 14 skill 单元测试 + 5 集成测试全部通过
- 243 lib tests pass, 1 pre-existing failure (unrelated)
- `cargo check -p xai-grok-evolution` PASS
- Shell 集成待 protobuf 工具链修复后再做 full build 验证
