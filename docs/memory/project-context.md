# Project Context

| 项目 | 内容 |
|------|------|
| 项目名 | grok-build |
| Tech Stack | Rust, Cargo workspace, xai-grok-evolution (lib), xai-grok-shell (binary) |
| 当前任务 | 2026-07-30-evolution-auto-trigger |
| 阶段 | closed |

## 风险

- protobuf 工具链问题阻塞 xai-grok-shell 编译验证（unrelated to evolution changes）
- pre-existing test failure: `autonomous_mode_cannot_bypass_runtime_preflight_at_startup`

## 依赖

- xai-grok-tools-api（protobuf codegen — currently broken build.rs）
- uuid crate（signal ID generation）
- blake3（content-addressed hashing）

## Next Steps

- 修复 protobuf 工具链后完成 `cargo check -p xai-grok-shell` 验证
- 修复 pre-existing test failure `autonomous_mode_cannot_bypass_runtime_preflight_at_startup`
- 考虑为 SkillTracker 添加 LRU eviction（MEDIUM，非阻塞）
- 考虑为 `positive_sample_rate` / `skill_decay_*` 添加 config validate（LOW）
