# Launch Acceptance: Evolution Auto-Trigger

## 验收概览

| 项目 | 内容 |
|------|------|
| 对象 | xai-grok-evolution 自进化系统改进 |
| 时间 | 2026-07-30 |
| 角色 | qa-engineer / tech-lead |
| 验收方式 | 单元测试 + 集成测试 + 编译验证 |

## 验收范围

### 业务范围

1. 成功 turn 自动触发经验沉淀（positive outcome 信号路径）
2. 注入的经验按 turn 结果生成 SkillSuccess/SkillIneffective 信号
3. 经验衰减滑动窗口检测并自动触发重新进化
4. 经验保存失败时带指数退避重试

### 技术范围

- 7 个文件修改，1 个新文件，1 个新测试文件
- +386 / -63 行变更
- 所有变更限于 evolution crate 和 shell 集成点

### 不在范围内

- Evolution pipeline 的 mutate/execute/validate 阶段不受影响
- 用户可见 UI/TUI 无变化
- 配置文件 schema 向后兼容（新字段全部有 default）

## 验收证据

### 测试结果

| 测试套件 | 结果 |
|----------|------|
| xai-grok-evolution lib tests | 243 pass, 1 pre-existing fail |
| fixtures roundtrip | 18 pass |
| skill_evolution integration | 5 pass |
| worker_process | 2 pass |
| **Total** | **268 pass, 0 new failures** |

### 新增测试覆盖

- `signal::skill_observer::tests` — 8 tests
- `service::skill_tracker_tests` — 6 tests
- `tests/skill_evolution.rs` — 5 integration tests
- **Total new tests: 19**

### 编译状态

- `cargo check -p xai-grok-evolution` — PASS (1 warning: unused var in pre-existing code)
- `cargo check -p xai-grok-shell` — BLOCKED by unrelated xai-grok-tools-api protobuf issue

## 风险判断

### 已满足项

- [x] 所有新代码路径有单元测试
- [x] 信号类型扩展向后兼容（`#[serde(default)]`）
- [x] 无新增 unsafe 代码
- [x] 无新增外部依赖
- [x] 重试机制有上限（3 attempts）

### 阻塞项

无（3 个 HIGH 已修复）。

### 已修复的 HIGH 问题

1. **SkillTracker 多注入时重复记录** — 改为直接使用 `turn_has_failures(delta)` 判定，per-injection 各 record 一次。
2. **`detect_skill_decay` substring match** — 改为接受 pre-filtered 信号切片，不再依赖 description 匹配。
3. **experience_id 泄漏到 description** — description 改用 positional index，decay signal 不再包含 raw ID。

### 可接受风险

- Shell 集成未经 full build 验证（protobuf tooling issue unrelated）
- SkillTracker 在进程重启时丢失 warm-up 数据（by design，可接受）
- `positive_sample_rate` 未在 `validate()` 中显式检查（不影响正确性，越界值被 clamp）
- `retry_solidify` 在 consumer thread 阻塞最长 2.6s（bounded queue 为 backstop，可后续改 async）
- SkillTracker HashMap key 数无上限（单 entry ~200 bytes，长期风险低，可后续加 LRU eviction）

## 上线结论

| 项目 | 结论 |
|------|------|
| 是否允许上线 | **是** |
| 前提条件 | protobuf 工具链修复后完成 shell crate 编译验证 |
| 观察重点 | evolution signal queue 满丢弃的 warn 日志频率 |
| 确认记录 | qa-engineer 确认，2026-07-30（HIGH 修复后重新验证通过） |
