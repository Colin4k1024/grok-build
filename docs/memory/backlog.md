# Backlog

> 跨任务 backlog 真相源。

## 快照信息

| 项目 | 内容 |
|------|------|
| 来源任务 | 2026-07-30-evolution-auto-trigger |
| 更新时间 | 2026-07-30 |
| 更新角色 | tech-lead |

## 未完成项

| 优先级 | 事项 | 触发条件 | 建议处理阶段 |
|--------|------|----------|-------------|
| P1 | protobuf 修复后验证 `cargo check -p xai-grok-shell` | protobuf 工具链修复时 | 下次 shell 发布 |
| P2 | SkillTracker 添加 LRU key eviction | 长运行进程内存增长 | 性能优化迭代 |
| P2 | config validate 补 `positive_sample_rate` / `skill_decay_*` | 下次 config 变更 | config 维护 |

## 技术债

| 项目 | 风险 |
|------|------|
| `signal_id` 缺少 `turn_id`，同 session 多 turn 可能冲突 | Low — dedup by context_hash 兜底 |
| `retry_solidify` 同步阻塞 consumer thread | Low — bounded queue 为 backstop |
| pre-existing test failure `autonomous_mode_cannot_bypass_runtime_preflight_at_startup` | Medium — 需独立排查 |

## 下一阶段候选

- E2E 全流程测试（trigger → experience publish，需 trial ports mock）
- SkillTracker 持久化（跨进程重启保留 warm-up 数据）
- `detect_skill_decay` 改为从 store 查询历史信号做离线分析
