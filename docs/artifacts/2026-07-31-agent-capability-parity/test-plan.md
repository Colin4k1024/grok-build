# Test Plan: Agent Capability Parity

## 测试范围

| 工具 | 测试类型 | 覆盖 |
|------|---------|------|
| ReportFindings | 编译验证 + 类型正确性 | ✅ |
| NotebookEdit | 编译验证 + insert/replace/delete 路径 | ✅ |
| CodeGraphExplore | 编译验证 + 无索引降级 | ✅ |
| ScheduleWakeup | 编译验证 + delay clamping + stop | ✅ |
| SendMessage | 编译验证 + validate + format | ✅ |
| ComputerUse | 编译验证 + action validate 全覆盖 | ✅ |

## 测试结果

- `cargo check -p xai-grok-tools`: **0 errors**
- `cargo test -p xai-grok-tools`: **2823 passed, 43 failed (pre-existing), 0 from new tools**
- 新增 6 个模块无编译警告
- mod.rs 正确注册所有模块

## 非功能范围

- 不覆盖 tool dispatch 集成（需要 shell session 环境）
- 不覆盖 browser CDP WebSocket（Computer Use 为 stub）
- 不覆盖 xai-codebase-graph 索引查询（CodeGraph 为 stub）

## 风险

| 风险 | 等级 | 处理 |
|------|------|------|
| NotebookEdit 可能破坏复杂 notebook metadata | 中 | 仅操作 source 字段，透传其余 |
| SendMessage delivery 未实际连接 coordinator | 低 | validate + format 层完整，delivery 由上层负责 |
| 43 个 pre-existing test failures | 信息 | 不阻塞本次交付（与本次变更无关） |

## 放行建议

**建议放行**。6 个新 tool 模块编译通过、类型正确、验证逻辑完整。
Pre-existing failures 为 opencode/grep 相关，与本次变更无关联。
