> Epic: #128 (ISS-069) · 批次: B5 · 标签: `parity-slice` `automation` `priority/P2` `frontend` `backend`
> 规格来源: 差距文档 §J(J1,J3) §A10；实物模块 `automations-page` `automation-dialog` `automation-frequency-section` `automation-delete-confirmation-dialog` `automation-side-panel-tab` `appgen-automations-page`；文案 `inbox.automations.*` `settings.automations.*`(27) `codex.localConversation.heartbeatAutomation.*`(3) `threadHeader.archiveConfirmHeartbeat*`(5) `codex.triggers.*`(11, OUT)

## 目标

把 Automations 从"localStorage + 前端 cron（关 app 即失效）"改为 **agent 侧 scheduler 驱动**的定时任务：创建/编辑/频率/删除/详情/侧面板 tab/与会话绑定，并支持"让 agent 帮你建"。

## 范围

1. **接 agent scheduler**：`x.ai/scheduler/*`、`x.ai/scheduler/delete`、`x.ai/schedulerGeneration`、`x.ai/schedulerRevision`、通知 `x.ai/scheduled_task_{created,deleted,fired}`
2. **Automations 页**（重写 `AutomationsPage.tsx` 200 行 + `src/lib/automation.ts` 159 行）：列表、创建（`create` / `createMenu.options` / `setUpManually`）、`createWithCodex`（"Create with Codex" + 引导 prompt，对齐 `inbox.automations.createWithChatGPT.prompt` 语义）、编辑、删除（`deleteTooltip`/`deleteError`/`deleteFailedTryAgain`/`createError`）
3. **频率区**：`automation-frequency-section` + `inbox.automations.day.label`、`cloud.monthlySchedule` 语义的本地版（每天/每周/每月 + 时间）
4. **删除确认**：`automation-delete-confirmation-dialog`；**草稿丢弃确认**：`discardDraft.{title,description,cancel,confirm}`
5. **详情面板**：`inbox.automations.detail.{close}`、`detailLoading`、side panel tab（`automation-side-panel-tab` / `open-automation-side-panel-tab`）
6. **空态建议**：`emptySuggestion.{add,dailyBrief,dailyBrief.description,dailyBrief.taskPrompt,followUpMonitor,…}`（建议内容本地化，不依赖云端）
7. **会话绑定**：`codex.localConversation.heartbeatAutomation.{title,nextRun,open}`（Scheduled · Next run: X · Open scheduled task）；归档会话时联动移除任务（ISS-097 的 `archiveConfirmHeartbeat*`）；侧栏 `localTaskRow.attachedHeartbeatAutomation` / `automation`（ISS-096）
8. **运行历史**：任务触发产生的会话在侧栏 `Scheduled task folders` 分组（ISS-096）；`manageTasks` 命令
9. **插件定时任务**：与 ISS-100 的 `use-plugin-scheduled-tasks` 协同
10. 删除 localStorage cron 实现（`src/lib/automation.ts` 的 STORAGE_KEY 路径）

## 非目标

- 云端定时任务（`inbox.automations.cloud.*`：loadError/updateError/deleteError/monthlySchedule/row.task）—— OUT
- Connector 触发器订阅（`codex.triggers.*`：chat/PR/issue/page/data source/email 更新）—— OUT
- `appgen-automations-*`（AppGen 平台）—— OUT
- 任务的云端调度与跨设备同步

## 依赖

- ISS-087（scheduler 扩展域 + 三个通知）
- ISS-091（side panel tab 容器）
- ISS-096（侧栏 Scheduled task folders 分组 + 行内状态）
- ISS-097（归档联动移除任务）
- ISS-100（插件定时任务）

## 回滚

保留 `src/lib/automation.ts` 至本 issue 稳定；回滚 = 恢复 localStorage cron（明确标注为降级：关 app 不执行）。agent 侧已创建的任务在回滚后仍会触发 → 回滚步骤必须包含"列出并提示用户 agent 侧遗留任务"，避免无人管理的后台行为。

## 验收标准

### 状态机不变量
- UI 任务列表 == `x.ai/scheduler` 真值；`schedulerRevision`/`schedulerGeneration` 变化 ⟹ 列表刷新（不得用本地副本覆盖）
- 任务状态：`draft → active → (running) → active|paused|deleted`；`fired` 通知必产生一次运行记录（或明确失败记录）
- 一个任务绑定至多一个会话来源；绑定会话被归档 ⟹ 任务同时被移除（实物语义），undo 可恢复两者
- 频率表达式与下次运行时间一致（`nextRun` 显示值 == agent 计算值）
- **关 app 后任务仍会触发**（这是与现状最核心的差异，必须有验证）

### 负向场景
- 频率无效（非法 cron / 过去时间 / 过密如每秒）→ 校验失败 + 明确提示，不创建
- 创建失败（agent 报错 / 无权限 / 目录不存在）→ `createError`，草稿保留
- 删除失败 → `deleteError` + `deleteFailedTryAgain`，任务仍在列表中
- 任务触发时会话不可用（cwd 被删 / agent 未运行）→ 有失败记录且下次仍尝试，不静默丢弃
- 详情加载失败 → `detailLoading` 转错误态 + 重试
- 编辑后丢弃 → `discardDraft` 确认；确认丢弃后原任务保持未改
- 时区变化 / DST → 下次运行时间计算正确（跨 DST 边界的用例必须有测试）

### 并发 / 崩溃 / 恢复
- app 关闭期间任务触发 → 重启后运行记录可见（不丢历史）
- 任务正在运行时编辑/删除该任务 → 明确语义（当前运行不受影响 or 被取消），并测试
- 两个窗口同时编辑同一任务 → 最后写入胜出 + 另一侧刷新，无重复任务
- kill agent → 重启后任务列表从 agent 恢复；`scheduled_task_fired` 通知不重复消费（幂等）
- 快速连续创建/删除（10 次）→ 无重复任务、无孤儿记录
- 大量任务（100+）时列表与调度不退化

### 外部副作用检查
- **定时任务 = 无人值守执行 = 高风险**：创建时必须显示将执行的 prompt、工作目录、权限档位；默认不得以 full-access 创建无人值守任务（或需额外确认）
- 任务运行产生的文件改动/commit 必须可在 Review 面板追溯（关联到运行记录）
- 删除任务是破坏性操作 → 二次确认；批量删除需列出受影响任务
- 不写 localStorage 作为真值源（仅缓存 UI 偏好）
- 通知/日志不含密钥与完整 prompt 正文

### Parity 勾选项
- [ ] J1 定时任务全生命周期（agent scheduler 驱动，关 app 仍触发）
- [ ] J3 会话绑定 + 归档联动 + 侧栏分组 + `heartbeatAutomation.*` 3 条
- [ ] `inbox.automations.*` IN 部分 + `settings.automations.*` 27 条
- [ ] A10 接线；localStorage cron 实现删除（假数据清零）
