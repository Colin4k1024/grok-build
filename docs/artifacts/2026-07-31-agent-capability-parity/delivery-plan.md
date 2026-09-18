# Delivery Plan: Agent Capability Parity

## 版本目标

- **里程碑**: v0.2.0-alpha — 工具集与 Claude Code 达到功能对等
- **范围**: 6 项确认缺失能力的实现与集成
- **放行标准**: 全部 6 个 tool 可在 grok session 中被模型调用 + 现有测试不回归

---

## 需求挑战会结论

| 假设 | 质疑 | 结论 |
|------|------|------|
| SendMessage 复用 interjection buffer 即可 | interjection 是单向的（user→agent），agent→agent 需要新通道 | 在 SubagentCoordinator 中增加 `send_to_child` 通道，复用 interjection 序列化格式 |
| NotebookEdit 只改 source 不碰 output | 部分 cell 的 output 依赖 execution_count 顺序 | 保持 outputs 不变，仅在 source 字段操作；insert 时 outputs 为空数组 |
| CodeGraph 复用 xai-codebase-graph | 该 crate 是库，不是 tool；需要 bridge | 在 xai-grok-tools 中添加 `codegraph_explore` implementation，调用 crate API |
| Computer Use 的 CDP stub 足够 | 实际 CDP 需要 WebSocket 连接管理 | 首版用进程调用 Chrome CLI screenshot，后续再加完整 CDP client |

---

## Story Slices

### Slice 1: ReportFindings (无依赖，最快出手)

| 字段 | 内容 |
|------|------|
| **目标** | 实现结构化代码审查输出 tool |
| **验收** | `ReportFindings({findings: [...], level})` 可调用，findings 含 file/line/summary |
| **owner** | backend-engineer |
| **文件** | `xai-grok-tools/src/implementations/grok_build/report_findings/` |
| **依赖** | 无 |
| **工作量** | 0.5 天 |

### Slice 2: NotebookEdit (无依赖)

| 字段 | 内容 |
|------|------|
| **目标** | cell 级 .ipynb 编辑（insert/replace/delete） |
| **验收** | 操作后 notebook JSON 有效，outputs 保留 |
| **owner** | backend-engineer |
| **文件** | `xai-grok-tools/src/implementations/grok_build/notebook_edit/` |
| **依赖** | 无 |
| **工作量** | 1 天 |

### Slice 3: CodeGraph 工具化 (依赖 xai-codebase-graph)

| 字段 | 内容 |
|------|------|
| **目标** | 将符号图查询暴露为 tool |
| **验收** | 传入符号名返回行号化源码 + 调用路径 |
| **owner** | backend-engineer |
| **文件** | `xai-grok-tools/src/implementations/grok_build/codegraph_explore/` |
| **依赖** | xai-codebase-graph crate |
| **工作量** | 1 天 |

### Slice 4: ScheduleWakeup (依赖 Scheduler crate)

| 字段 | 内容 |
|------|------|
| **目标** | 动态 loop 自适应调度 |
| **验收** | delaySeconds [60,3600] 范围有效，stop=true 终止 loop |
| **owner** | backend-engineer |
| **文件** | `xai-grok-tools/src/implementations/grok_build/scheduler/` (扩展) |
| **依赖** | 现有 Scheduler actor |
| **工作量** | 1 天 |

### Slice 5: SendMessage (依赖 SubagentCoordinator 修改)

| 字段 | 内容 |
|------|------|
| **目标** | 命名代理间实时消息传递 |
| **验收** | 消息到达目标 subagent interjection，to="main" 回传父 session |
| **owner** | backend-engineer |
| **文件** | `xai-grok-tools/src/implementations/grok_build/send_message/`, `xai-grok-shell/src/agent/subagent/coordinator.rs` |
| **依赖** | SubagentCoordinator channel 扩展 |
| **工作量** | 2 天 |

### Slice 6: Computer Use 集成 (依赖 xai-grok-computer-use)

| 字段 | 内容 |
|------|------|
| **目标** | 将 computer-use crate 接入 tool dispatch |
| **验收** | screenshot 返回 base64 PNG，click/type 可执行 |
| **owner** | backend-engineer |
| **文件** | `xai-grok-tools/src/implementations/grok_build/computer_use/` |
| **依赖** | xai-grok-computer-use crate (已创建) |
| **工作量** | 1 天 |

---

## 执行顺序与并行化

```
Day 1:  [Slice 1: ReportFindings] + [Slice 2: NotebookEdit]  ← 并行
Day 2:  [Slice 3: CodeGraph] + [Slice 4: ScheduleWakeup]     ← 并行
Day 3-4: [Slice 5: SendMessage]                               ← 需 coordinator 改动
Day 5:  [Slice 6: Computer Use 集成]                          ← 接入已有 crate
Day 6:  集成测试 + 回归验证
```

**总工期**: 6 天（单人），可压缩至 4 天（若 Slice 1-4 全并行）

---

## 风险与依赖

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| SubagentCoordinator 修改引入 race condition | 中 | 高 | SendMessage 走独立 mpsc channel，不复用 command channel |
| xai-codebase-graph 索引不存在时用户困惑 | 低 | 低 | 返回 "run `grok index` first" 提示 |
| NotebookEdit 破坏 cell metadata | 中 | 中 | 仅操作 `source` 和 `cell_type`，其余字段透传 |
| Chrome 不可用导致 Computer Use 失败 | 低 | 低 | 返回安装指引，不 crash |

---

## 角色分工

| 角色 | 职责 |
|------|------|
| `tech-lead` | 方案审批、Slice 5 架构决策 |
| `backend-engineer` | 全部 6 slice 实现 |
| `qa-engineer` | 集成测试（Day 6） |

---

## 检查节点

| 时间点 | 检查内容 |
|--------|---------|
| Day 2 完成 | Slice 1-2 可 cargo test，tool 注册验证 |
| Day 4 完成 | Slice 3-5 可 cargo test |
| Day 5 完成 | 全部 6 tool 可在 grok session 中调用 |
| Day 6 完成 | 回归测试通过，PR 可合并 |

---

## Implementation Readiness

- [x] PRD 已冻结
- [x] 需求挑战会结论已记录
- [x] 无前端变更，无 UI 证据要求
- [x] 无企业治理约束
- [x] 所有 slice 有明确 owner 和验收标准
- **状态: handoff-ready**
