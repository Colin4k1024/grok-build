# Lessons Learned

## 2026-07-30 — SkillTracker N² 记录 Bug

**场景**：在 `on_turn_end` 中为 SkillTracker 记录观测值时，遍历 signals 并在每个 signal 内部遍历所有 injections，导致 N 个 injection × N 个 signal = N² 条记录。

**问题**：多注入场景下 ring buffer 膨胀，虚假触发 decay 事件。

**建议**：当观测逻辑只需要"turn 是否有 failure"这个布尔值时，直接从 delta 派生结果（`turn_has_failures`），不要间接通过已生成的 signals 推断。避免 signal iteration × injection iteration 的嵌套循环。

## 2026-07-30 — 避免将内部 ID 写入 free-text description

**场景**：`experience_id` 被 format 进 signal description 字段，后续 `detect_skill_decay` 又通过 `description.contains(id)` 做匹配。

**问题**：信息泄漏到持久层；匹配逻辑脆弱（子串碰撞、sanitization 截断）。

**建议**：内部标识符只放在结构化字段（`source`、`context_hash`）。description 只描述人可读的事件摘要，不承载机器匹配职责。需要按 ID 过滤信号时，使用结构化字段或让调用方预过滤。
