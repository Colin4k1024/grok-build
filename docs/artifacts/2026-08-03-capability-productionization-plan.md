# Grok Build 原型能力工程化计划（2026-08-03）

## 目标与完成定义

本计划把“源码存在”与“可用能力”严格分开。只有同时满足以下条件，能力才从原型状态移除：

1. 真实入口可达：在默认或明确配置的产品入口中可启用，不依赖测试专用调用。
2. 真实后端：不返回模拟成功、占位文本或仅做参数校验。
3. 安全边界：读写、进程、桌面和外部网络操作经过现有权限/策略层。
4. 生命周期完整：取消、重连、持久化、恢复和并发路径有明确行为。
5. 可观测且可验证：至少有单元测试和集成测试；高风险能力还需真实入口验收。
6. 失败关闭：缺失依赖时返回明确的不可用原因，不伪装成成功。

## 排序方法

优先级按 `用户价值 × 现有完成度 × 可验证性 ÷ 风险与外部依赖` 排定。P0 是已有功能链路的缺口；P1 是可在本地安全闭环的能力；P2 涉及跨任务协调；P3 涉及桌面控制、私有服务或构建时裁剪。

## 当前执行状态

- **已完成：P0 五项。** SessionActivity 聚合、Evolution 跨轮纠正、GCS `updated` 同步、TodoGate 设置面板和新架构 ReadFile reminders 均已接入。
- **已完成：P1 三项。** ReportFindings、NotebookEdit、CodeGraphExplore 已进入 typed I/O、正式 registry 和默认工具集，并通过工具层、代理层与 shell 编译验证。
- **已完成：P2 两项。** SendMessage 已接入 session-bound coordinator 与 shell interjection；ScheduleWakeup 已复用 scheduler actor，并接入 durable one-shot occurrence receipt。
- **已完成：稳定入口。** Memory 使用 `--memory`，Evolution 使用 `--evolution`，旧 experimental 参数保留为兼容别名；Minimal 已移除实验文案。
- **已完成：P3 ComputerUse。** 浏览器使用真实 CDP WebSocket，桌面后端有严格 capability probe；工具默认关闭，仅由显式 browser/desktop 预设启用，并进入现有高风险权限与审计链路。
- **已完成：P3 外部依赖矩阵。** Git change serialization 已接入本地 libgit2 adapter；Voice 可报告编译与设备/依赖状态；DeployApp、remote restore、Devbox login 因当前源码不含私有 adapter，保持 fail-fast 隔离并返回明确 `not_compiled` 原因。`grok capabilities [--json]` 提供统一检查入口。
- **已完成：Laziness diagnostics。** 默认关闭；可通过 `[diagnostics.laziness]` 显式启用，兼容 `--laziness-debug-log`。版本化 JSONL 只保留分类、计数、耗时、长度和进程加盐的域分离指纹，不落盘原始会话/Todo/模型/证据/输出/错误文本；日志限制为 4 MiB 并保留 3 份归档。

## 能力清单与优先级

| 优先级 | 能力 | 当前缺口 | 工程化交付 | 验收标准 |
|---|---|---|---|---|
| P0 | SessionActivity / idle-unload | 仅检查当前 turn、排队输入和 parked approval | 聚合 turn、通知、monitor、终端后台任务、session 子代理、scheduler；超时保守保活 | 任一后台来源存活时断连不卸载；全部空闲时可卸载；查询失败不误杀 |
| P0 | Evolution 跨轮纠正 | `user_corrections` 固定为空 | 在 Evolution signal 层实现中英文纠正意图检测，并把当前真实用户消息与上一轮 assistant action 关联 | 明确纠正产生一个 UserCorrection；普通追问/新任务不产生；synthetic 消息不触发 |
| P0 | 搜索索引 GCS 同步 | 远端更新时间固定为 0 | 请求 GCS JSON metadata、解析 `updated`、按阈值比较；404 与暂时故障有不同处理 | 远端较新才替换本地；远端缺失不报假错误；metadata 故障不破坏本地索引 |
| P0 | TodoGate 设置入口 | 只有隐藏 CLI flag | 增加持久化 UI 设置、modal action、写盘/回滚和运行时解析；CLI 仍拥有最高优先级 | `/settings` 可切换；写入 config；新 session 生效；失败可回滚；旧 CLI 兼容 |
| P0 | ReadFile reminders | 新架构只渲染普通输出，没有 reminder pipeline 实现 | 注册 ReadFile cross-cutting reminder，覆盖空文件与 offset 越界 | reminder 只在对应成功读场景出现，使用配置的 reminder tag，不污染结构化输出 |
| P1（完成） | ReportFindings | 原型只计数，不进入 typed 工具链 | 完整 typed findings、workspace 文件/行号校验、结构化 ToolOutput 与客户端通用工具结果协议 | 多条 finding 保留路径、行号、严重度；空/越界/不可读输入失败关闭 |
| P1（完成） | NotebookEdit | 原型同步直写，无 Tool/权限/通知/hunk tracking | 注入 FileSystem、同目录原子替换、取消检查、`FileWritten` 通知与写权限声明 | 合法 notebook 精确修改；无效 JSON 不覆写；取消/写失败保持原文件 |
| P1（完成） | CodeGraphExplore | 原型返回 pending 文本 | 直接复用 `xai-codebase-graph` 的进程级去重 IndexManager，支持 definition/reference、上下文排序、取消和结果截断 | 真实项目返回图查询；首次调用等待索引就绪；相同 canonical root 不重复建索引 |
| P2（完成） | SendMessage | 只校验和格式化 | session-bound backend 发往单写 coordinator；精确解析 subagent id/`main`，Shell 统一进入 Interject 队列并返回 message ID | 不存在、初始化中、已完成、自投递分别明确失败；入队可追踪；外国 session 与不存在目标同形失败 |
| P2（完成） | ScheduleWakeup | 只计算 delay | 作为现有 scheduler actor 的 durable one-shot 前台任务；支持 task ID 删除，并在 fire 前持久化 occurrence receipt | 到点只产生一次真实 wake；删除后不触发；正常 fire 清 receipt；恢复时抑制旧任务且不重放不确定 wake |
| P3（完成） | ComputerUse | 工具只校验；browser CDP 返回空数据；crate 未接线 | 已完成真实 CDP transport、隔离 Chrome profile、平台 capability probe、typed I/O、权限/审计与显式预设 | 本机真实 Chrome CDP 截图通过；高风险动作进入权限判定；默认预设不暴露；不支持平台返回明确原因 |
| P3（完成） | DeployApp / remote restore / Devbox login / git change serialization / voice platform | 构建裁剪或依赖私有服务 | 统一 `RuntimeCapabilityStatus`；Git 使用本地 libgit2 收集 commit/dirty/untracked/binary 数据；Voice 做运行时输入探测；三个私有 adapter fail-fast | `grok capabilities --json` 准确报告 compiled-in/available/reason；Git extension 可真实序列化；任何 stub 不返回假成功 |
| P3（完成） | Laziness diagnostics | 一次性 debug path 未接 CLI、明文记录敏感上下文、文件无限增长 | 默认关闭的 `[diagnostics.laziness]`、兼容 CLI、版本化脱敏 schema、串行有界轮转与私有文件权限 | 配置与 CLI 优先级可测；敏感源文本不出现在 JSONL；父目录自动创建；4 MiB/3 归档；保持 observation-only |

## 实验接口稳定化

| 能力 | 迁移方案 | 兼容策略 |
|---|---|---|
| Cross-session Memory | 提供稳定 `--memory` / config 入口，保留关闭开关 | `--experimental-memory` 保留一段版本周期并标记 deprecated |
| Evolution | 完成 P0 信号闭环后提供稳定 `--evolution`，shadow ORIS adapter 不作为生产执行器 | 旧 flag 作为别名；autonomous 模式无 worker 时失败关闭 |
| Minimal TUI | 移除“实验”文案，固定渲染/输入/恢复测试矩阵 | `--minimal` 名称不变 |
| Laziness diagnostics | **已完成。** `[diagnostics.laziness] enabled = true`，可选 `path`；默认写入 `~/.grok/logs/laziness.jsonl` | 旧 `--laziness-debug-log <path>` 保留并优先于配置；能力默认关闭，启用后仍 observation-only |

## 分阶段实施

### 阶段 A：P0 链路闭环

- 实现五项 P0，并为每项新增针对性回归测试。
- 对 idle-unload 使用保守策略：任何异步来源查询超时/失败都视为 busy。
- GCS metadata 与 media download 使用同一对象路径编码；远端对象不存在视为正常首次同步状态。
- TodoGate 的启用优先级固定为：CLI 强制开启 / 用户 UI 显式开启 > remote setting > 默认关闭；UI 关闭表示不做本地强制开启。

### 阶段 B：本地安全工具

- **已完成。** 按 ReportFindings、NotebookEdit、CodeGraphExplore 顺序交付。
- 三项均已进入 typed ToolInput/ToolOutput、正式 registry 和默认工具集；NotebookEdit 通过 Edit/Write capability 与 `FileWritten` 通知接入权限、hunk tracking 和 rewind 链路。
- NotebookEdit 通过注入文件系统原子写入；不支持原子提交的远端 adapter 明确失败关闭。CodeGraph 使用 IndexManager 自带的 canonical-root 去重，不维护第二份索引。
- 验证：`xai-grok-tools` 2875 tests passed、`xai-grok-agent` 577 tests passed，`cargo check -p xai-grok-shell` 通过。

### 阶段 C：协调和定时能力

- **已完成。** SendMessage 复用现有 coordinator 的 session 所有权边界；父到子和子到主均由 SessionCommand::Interject 入队，交付后返回 UUIDv7 message ID。初始化中、已结束、自目标和不可用状态分别失败关闭；一旦确认入队便不提供撤销，后续由既有 session Cancel/Shutdown 语义处理。
- ScheduleWakeup 没有创建第二个计时器系统；它创建 foreground、non-recurring、durable 的 scheduler task，并使用现有 create/delete 命令和版本化通知。
- durable one-shot 在 fire 前将任务移入 occurrence journal 并持久化；确认 fired/removed FIFO 后清除 receipt。恢复只抑制 receipt 对应的复活任务，不重放不确定 fire，从而优先保证不会重复唤醒。
- 验证：`xai-grok-tools` 2884 tests passed、7 ignored；`xai-grok-agent` 577 tests passed；`cargo check -p xai-grok-shell` 通过且无新增 warning。

### 阶段 D：高风险与外部依赖

- **ComputerUse 已完成。** 浏览器后端通过页面级 CDP WebSocket 执行并校验 protocol response，不再返回空数据；每个进程使用临时独立 profile，保持 Chromium sandbox，不读取用户 profile。桌面后端只在 macOS `screencapture + cliclick` 或 Linux/X11 `scrot + xdotool` 和真实屏幕尺寸探测均通过时可用，不再假设 `1920×1080`。
- ComputerUse 进入 typed registry，但 params 默认 `enabled=false`，且不在默认工具集；只有 `grok-build-computer-browser` / `grok-build-computer-desktop` 显式预设设置 `enabled=true`。除 capability probe 外的动作映射到高风险权限路径，审批/审计摘要只记录动作名和目标 host，不记录 typed text 或 key 内容。
- 验证：mock CDP request/response 与错误传播 3 项通过；本机真实 Chrome CDP PNG 截图通过；ComputerUse 工具测试 5 项、权限映射 2 项、显式预设隔离 1 项通过；`xai-grok-tools` 全量 2889 passed、7 ignored；`cargo check -p xai-grok-shell` 无新增 warning。
- **外部依赖矩阵已完成。** 构建裁剪能力统一输出 `RuntimeCapabilityStatus`，区分 `not_compiled`、`not_configured`、`unsupported_platform`、`dependency_missing` 与 `runtime_unavailable`；`grok capabilities` 同时支持人类表格与 JSON。
- Git `serialize_changes` 已从 ACP extension 贯通 `workspace.git_collect_changes`，本地 adapter 收集提交序列、staged/unstaged patch、二进制 blob、未跟踪文件、force-include 文件、repo/upstream 元数据和大小告警。DeployApp、remote restore、Devbox login 的私有实现不在当前源码中，因此在认证、网络或 worktree 副作用前失败关闭；Voice 根据 audio feature 与真实输入设备/系统 recorder 报告状态。
- 验证：`cargo check -p xai-grok-pager-bin` 通过；git collector 2 项、capability 跨 crate 23 项、DeployApp/Devbox 隔离 2 项通过；`grok capabilities --json` 端到端输出五项准确状态。

### 阶段 E：稳定化与发布

- **Laziness diagnostics 已完成。** 配置入口为 `[diagnostics.laziness] enabled = true` 与可选 `path`；未显式启用时不启动 classifier diagnostics。隐藏 CLI 兼容入口继续可用且优先级最高。
- JSONL schema 固定 `schema_version = 1`。会话、模型、Todo、证据、分类器输出和错误仅记录进程加盐、域分离的 SHA-256 截断指纹与必要长度；分类、置信度、决策、计数和耗时保留用于聚合诊断。
- writer 在进程内串行写入，自动创建父目录，Unix 文件权限收紧为 `0600`；active log 超过 4 MiB 前轮转，保留 `.1`～`.3`。
- 验证：Laziness diagnostics 34 项（含刚结束 prompt 的前台/后台子代理计数）、配置解析/优先级 2 项、兼容 CLI 1 项通过；`cargo check -p xai-grok-shell -p xai-grok-pager` 通过。
- 发布前仍需按常规门禁运行 shell/pager/tools 全量测试和 workspace `cargo check`；这属于发布验证，不再是能力实现缺口。
- 发布门槛：无 unused warning、无 pending/stub 成功响应、无被默认 registry 暴露但不可执行的工具。

## 本轮交付边界

本轮计划内的工程化任务已全部完成：五项 P0、稳定 CLI 入口、三项 P1 本地安全工具、两项 P2 协调/定时能力、P3 ComputerUse、P3 外部依赖 capability matrix 与 Laziness diagnostics。当前没有剩余的本地能力实现缺口；三个缺少私有源码/服务契约的 adapter 继续保持明确不可执行，而不是用占位成功响应冒充完成，后续只有在获得对应外部契约后才能继续。
