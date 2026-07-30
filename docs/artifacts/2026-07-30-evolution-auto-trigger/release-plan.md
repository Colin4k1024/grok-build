# Release Plan: Evolution Auto-Trigger

## 发布信息

| 项目 | 内容 |
|------|------|
| 发布对象 | xai-grok-evolution crate（library） |
| 发布方式 | 合并 `codex/complete-self-evolution` → `main` |
| 计划时间 | 2026-07-30 |
| 发布负责人 | devops-engineer |
| 观察窗口 | 7 天 |

## 变更范围

- 8 个文件修改，2 个新文件
- +400 / -63 行变更（含 HIGH 修复）
- 影响范围：`xai-grok-evolution` crate + `xai-grok-shell` 集成点（1 文件）
- 无 schema 迁移，无外部依赖变更

## 风险评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| Shell crate 编译未验证 | Medium | evolution crate 独立编译通过；protobuf issue unrelated |
| SkillTracker 内存增长 | Low | Ring buffer bounded；HashMap key 无 eviction 但单 entry 极小 |
| retry_solidify 阻塞 consumer | Low | 最长 2.6s；bounded queue 为 backstop |
| 进程重启丢失 warm-up | Low | By design；session lifetime 足够 |

## 执行步骤

### Phase 1: Pre-release Verification

1. ✅ `cargo check -p xai-grok-evolution` — PASS
2. ✅ `cargo test -p xai-grok-evolution` — 243 pass, 1 pre-existing fail
3. ✅ `cargo test -p xai-grok-evolution --test skill_evolution` — 5 pass
4. ⏳ `cargo check -p xai-grok-shell` — BLOCKED (protobuf, unrelated)

### Phase 2: Merge

1. 确认 protobuf 工具链修复后 shell 编译通过
2. PR from `codex/complete-self-evolution` → `main`
3. Squash merge（保留 commit history 在 PR description）

### Phase 3: Post-merge Validation

1. CI green on main
2. 监控 evolution signal queue 丢弃日志
3. 观察 SkillDecay 触发频率是否合理

## Go / No-Go 判断

| 检查项 | 状态 |
|--------|------|
| 代码评审通过 | ✅ HIGH 已修复，无阻塞 |
| 安全评审通过 | ✅ experience_id 已去标识化 |
| 测试验证 | ✅ 248 tests pass, 0 new failures |
| Launch acceptance | ✅ 允许上线 |
| 向后兼容 | ✅ serde(default) 覆盖 |
| Shell crate 编译 | ⏳ 待 protobuf 修复 |

**结论：Go（conditional）** — 合并时机取决于 protobuf 工具链修复。

## 放行结论

允许发布。条件：
1. protobuf 工具链修复后 `cargo check -p xai-grok-shell` 通过
2. 发布后 7 天内关注 queue 满丢弃日志和 decay signal 频率

## 回滚方案

| 项目 | 内容 |
|------|------|
| 触发条件 | crash、queue 满丢弃 > 5%、decay 频率明显异常 |
| 回滚路径 | `git revert <merge-commit>` + 重编译 |
| 回滚验证 | 编译通过 + 基础测试通过 |
| 数据回滚 | 无需（新 signal types 被旧版本 ignore） |
