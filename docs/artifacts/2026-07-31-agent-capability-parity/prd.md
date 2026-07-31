# PRD: Agent Capability Parity — 补齐与 Claude Code 的 6 项能力差距

## 背景

经过逐项代码验证，grok-build 在 30 项核心 coding agent 能力中已实现 24 项，与 Claude Code 基本对等。
剩余 6 项为确认缺失，需补齐以达到完全功能对等，同时保持沙箱和自进化方面的差异化领先。

**触发原因**: 竞品对标分析 → 代码验证 → 收敛为 6 项真实差距。

**当前约束**: 纯 Rust 实现，无外部运行时依赖；遵循现有 tool/sampler/shell 分层架构。

---

## 目标与成功标准

| 目标 | 成功指标 |
|------|---------|
| 与 Claude Code 工具集达到功能对等 | 6 项能力全部可在 grok session 中被模型调用 |
| 不破坏现有工具稳定性 | 现有测试套件 pass rate 不下降 |
| 可独立开关 | 每项新能力有 feature flag 或 config 控制 |

---

## 用户故事

### US-1: SendMessage — 代理间实时通信

**作为**编排代理，**我需要**在 subagent 运行中向其发送消息（指令、补充上下文），**以便**实现多代理协作流中的动态协调，而非仅等待其完成。

**验收标准**:
- `SendMessage({to: "agent-name", message: "..."})` 可被模型调用
- 消息传递到目标 subagent 的 interjection buffer
- 支持 `to: "main"` 向父 session 回传
- 目标不存在时返回结构化错误

---

### US-2: ReportFindings — 结构化代码审查输出

**作为**代码审查代理，**我需要**以类型化列表形式输出审查发现（文件、行号、类别、严重性、场景），**以便**宿主 UI 能渲染为可交互的 findings 面板。

**验收标准**:
- `ReportFindings({findings: [...], level: "high"})` 可被模型调用
- 每个 finding 包含: file, line, summary, failure_scenario, category
- 支持 verdict（CONFIRMED/PLAUSIBLE）和 outcome（fixed/skipped）
- 空 findings 列表有效（表示审查通过）

---

### US-3: NotebookEdit — Jupyter Notebook cell 级编辑

**作为**数据科学工作者，**我需要**直接插入、替换、删除 .ipynb 文件中的 cell，**以便**修改 notebook 时不需要手动编辑 JSON。

**验收标准**:
- `NotebookEdit({notebook_path, cell_id, new_source, edit_mode, cell_type})` 可被模型调用
- 支持 replace / insert / delete 三种模式
- insert 时 cell_type (code/markdown) 为必填
- 操作后 notebook JSON 保持有效（output cells 保留）

---

### US-4: CodeGraph 工具化 — 符号图查询暴露为 tool

**作为**代码探索代理，**我需要**通过 tool 调用查询当前项目的符号图（定义、引用、调用链），**以便**一次调用获取精确上下文，减少 grep/read 循环。

**验收标准**:
- `CodeGraphExplore({query: "symbol names or question"})` 可被模型调用
- 返回匹配符号的完整源码（带行号）+ 调用路径
- 无 `.codegraph/` 索引时优雅降级（返回提示而非错误）
- 支持 maxFiles 参数限制输出规模

---

### US-5: ScheduleWakeup — 动态 loop 自适应调度

**作为**自治代理，**我需要**在 `/loop` 动态模式下自主决定下次唤醒时间，**以便**根据等待目标（CI 完成、外部状态变化）自适应调整轮询间隔。

**验收标准**:
- `ScheduleWakeup({delaySeconds, prompt, reason})` 可被模型调用
- delaySeconds 限制在 [60, 3600] 范围
- `stop: true` 终止 loop
- reason 字段显示给用户（解释为什么等待）
- 与现有 Scheduler crate 集成，不新建独立调度器

---

### US-6: Computer Use 集成 — 接入 tool dispatch

**作为**全栈开发代理，**我需要**截图、点击、输入文本来验证 UI 变更或操作本地应用，**以便**完成端到端的 UI 验证闭环。

**验收标准**:
- `ComputerUse({action: "screenshot"})` 返回 base64 PNG
- `ComputerUse({action: "click", coordinate: {x, y}})` 执行点击
- `ComputerUse({action: "type", text: "..."})` 输入文本
- 注册为 `ToolKind::ComputerUse`，在 tool dispatch 中可调用
- 支持 browser (headless CDP) 和 desktop (OS-native) 两种后端

---

## 范围

### In Scope

- 6 个新 tool 的实现和注册
- 每个 tool 的单元测试
- Cargo.toml / workspace 配置更新
- 工具定义的 system prompt 描述文本

### Out of Scope

- UI/TUI 变更（findings 面板等在后续迭代）
- 与 Claude Code 的 API 兼容层（不做协议兼容）
- 生产部署配置（仅本地开发验证）

---

## 风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| SendMessage 需要 interjection 机制修改 | 中 | 复用现有 `pending_interjections` buffer |
| Computer Use 依赖 Chrome 可用性 | 低 | 优雅降级 + 错误提示安装 |
| CodeGraph 索引可能不存在 | 低 | 检查 `.codegraph/` 后决定是否启用 |
| NotebookEdit 需正确处理 cell outputs | 中 | 仅修改 source，保留 outputs 不变 |

---

## 待确认项

1. SendMessage 是否需要限制目标必须是当前 session 的 subagent（安全边界）？
2. ReportFindings 的 UI 渲染是否纳入本轮？
3. CodeGraph tool 是否复用 `xai-codebase-graph` 还是走 MCP？
4. Computer Use 的 browser 后端是否需要支持 Playwright（除 CDP 外）？

---

## 实施优先级

| 顺序 | 能力 | 依赖 | 工作量 |
|------|------|------|--------|
| 1 | ReportFindings | 无 | 1 天 |
| 2 | NotebookEdit | 无 | 1-2 天 |
| 3 | CodeGraph 工具化 | xai-codebase-graph | 1 天 |
| 4 | SendMessage | interjection 系统 | 2-3 天 |
| 5 | ScheduleWakeup | Scheduler crate | 1-2 天 |
| 6 | Computer Use 集成 | xai-grok-computer-use | 1-2 天 |

**总计**: 8-12 天

---

## 参与角色

| 角色 | 职责 |
|------|------|
| `tech-lead` | 优先级裁定、架构审批 |
| `backend-engineer` | 全部 6 项 tool 实现 |
| `qa-engineer` | 集成测试验证 |
