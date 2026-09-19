> Epic: #128 (ISS-069) · 批次: B3 · 标签: `parity-slice` `composer` `permissions` `priority/P1` `frontend`
> 规格来源: 差距文档 §E(E5–E15,E17–E19) §7.2；实物模块 `composer-utility-bar` `composer-action-bar-run-location-dropdown` `composer-work-home-plugins-control` `worktree-environment-dropdown` `permission-dropdown` `permissions-mode-dropdown`；文案 `composer.permissionsDropdown.*`(20) `composer.newTask.*`(18) `composer.worktreeEnvironment.*`(9) `composer.mode.agentMode.fullAccessConfirm.*`(11)

## 目标

复刻 composer 底部工具条（utility bar）的全部控件与语义：权限档位、运行位置、worktree 环境、模型+effort、plan/fast mode、queue/steer/background、用量就地展示、建议与提示，以及 **Chat/Work 模式切换（按 AD-7 映射为无项目会话 / 项目会话）**。

## 范围

1. **权限下拉 4 档**（去掉范围外的 managed/enterprise）：`Ask for approval`(default) / `Full access` / `Approve for me`(guardian) / `Custom (config.toml)`；含 `disabledByConfig.tooltip`、`title.chatgptDesktop` 语义改为 grok 对应文案、`trigger.tooltip`
2. **Full Access 三段式风险确认弹窗**：Files and folders / Internet and connected apps / Terminal commands 三段 + `warningTitle`/`warningDescription.codeMode` + `goBack`(Cancel) / `turnOnButton`(Confirm)；Cyber model 额外警告（若模型标记为高危）
3. **运行位置下拉**：`This computer` / `Worktree`（Cloud/Remote 为 OUT）；`composer.newTask.{workIn,worktree,thisComputer,addProjectFolder,checkingFolders}`；选择 worktree 时联动 ISS-099 的 worktree 创建
4. **Worktree 环境下拉**（`composer.worktreeEnvironment.*` 9 条）：`Default environment` / `Work without environment` / `Set up project` / `Environment settings` / `titleForRepository` / loading / error
5. **模型 + effort**：合一选择器（沿用现有 `ModelEffortSelect`）+ 命令 `composer.cycleReasoningEffort` / `increase` / `decrease` / `openModelPicker`(Ctrl+⇧M)；可选 effort 集合来自 settings（`settings.agent.modelFeatures.reasoningEfforts`，ISS-102）
6. **Plan mode / Fast mode**：`composer.togglePlanMode` / `toggleFastMode` → `x.ai/toggle_plan_mode` / `x.ai/exit_plan_mode`
7. **Queue / Steer / Submit in background**：`composer.queue` / `steer` / `submitInBackground`(⌘↵) / `startOutcomeUnknown` → 接 `x.ai/queue/*` 与 `x.ai/interject`（替代现有前端数组队列）
8. **Chat / Work 模式切换（AD-7 / M1）**：Chat = 无项目会话（不绑 cwd、read-only sandbox、侧栏归 Chats、命令 `newProjectlessTask`⌘⌥O）；Work = 项目会话（绑 cwd/worktree、workspace-write、侧栏归 Projects）；切换真实驱动 `session/new` 的 cwd 与 sandbox/approval 预设
9. **用量就地展示**：token/context 进度（现有）+ `thread-usage-breakdown` 简版（OUT 的账单/额度部分不做）
10. **建议与提示**：`composer.suggestionList.*`、`composer-tip`、Home 的 starter prompts（数据源 = `x.ai/suggestPrompt` / `x.ai/announcements/update`，无则隐藏，不造假数据）
11. **附件**：`composer.addFiles`(⌘U) / `addPhotos`；分支起点选择（`composer.remote.branch*` 的本地分支部分）
12. 删除/重写死代码：`ApprovalModeSelect`（3 档 → 4 档）、`WorkModeSelect`、`SandboxToggle`（当前 1 处引用）、`AgentMenu`

## 非目标

- Cloud / Remote 运行位置、cloud follow-up（E16）、云环境（OUT）
- 企业 managed / requirements.toml 限制（OUT）—— 但保留 `disabledByConfig.tooltip` 用于本地 config.toml 限制
- Appshot 附件（OUT）
- Realtime voice / voice mode（`composer.startVoiceMode`）→ 保留现有本地听写（Ctrl+⇧D），不做 realtime
- 不做富文本编辑器本体（ISS-092）

## 依赖

- ISS-092（控件挂在同一个 utility bar 上）
- ISS-087（`x.ai/queue/*`、`x.ai/interject`、`x.ai/toggle_plan_mode`、`x.ai/skills/config`、`x.ai/models/list`、`x.ai/suggestPrompt`）
- ISS-099（worktree 环境/创建）—— 本 issue 先做 UI 与调用契约，worktree 生命周期在 083 完成；两者需协调接口

## 回滚

控件按 flag 逐个点亮（`composer.permissionsV2` / `composer.runLocation` / `composer.modeToggle`）；回滚 = flag 关闭恢复现有三控件（`ApprovalModeSelect`/`WorkModeSelect`/`ModelEffortSelect`）。权限档位变更必须与 agent 侧 approval/sandbox 设置解耦存储，回滚不得遗留"UI 显示 ask 但 agent 处于 full-access"的状态（见不变量）。

## 验收标准

### 状态机不变量
- **UI 档位 ⟺ agent 实际策略**：任一时刻 composer 显示的权限档位必须等于 agent 侧生效的 approval/sandbox 配置（读取 `x.ai/sessionConfig` 校验，不得只信本地状态）
- `full-access` ⟹ 不产生 pending 审批卡且自动选 `allow*`；`read-only`/Chat 模式 ⟹ 自动选 `reject*`；`ask` ⟹ 卡片必须出现
- Full Access 确认弹窗未 Confirm ⟹ 档位不得变更（Cancel/关闭/Esc 均视为拒绝）
- Chat 模式 ⟹ 会话无 cwd 绑定、不创建 worktree、侧栏归 Chats；Work 模式 ⟹ 必须有 cwd（无项目时提示 `addProjectFolder`）
- queue/steer 状态：`queuedPrompts` 与 agent 侧队列（`x.ai/queue/changed`）一致；`startOutcomeUnknown` 期间禁止重复发送同一 prompt
- plan mode 开启 ⟹ 工具执行被限制（agent 侧语义），UI 有持续可见指示

### 负向场景
- 切换权限档位失败（config.toml 只读 / 写入失败）→ 回滚到原档位 + `settings.agent.configuration.writeError` 类提示
- `Custom (config.toml)` 档位在 config 无效时 → 明确错误并指向文件（`notice.fileContext` 语义：文件 + 行列）
- worktree 环境加载失败 / 无环境可选 → `composer.worktreeEnvironment.error` / `noEnvironmentOption`
- 运行位置切换到 worktree 但当前目录不是 git 仓库 → 明确拒绝（对齐 `threadHeader.forkThreadRequiresGitRepo` 语义）
- `x.ai/suggestPrompt` 无返回 → 建议区隐藏，不显示假建议
- 模型不支持图片 → `composer.imageInputsUnsupported`；模型不支持所选 effort → 该 effort 项禁用并说明
- 发送时 agent 未 ready / 会话已关闭 → 明确错误，不静默丢弃 prompt

### 并发 / 崩溃 / 恢复
- turn 进行中切换权限档位：立即生效于**后续**工具调用，已在途的审批请求保持原语义（不得出现"卡片消失但未响应"导致 agent 永久等待）
- turn 进行中切 Chat/Work 或切项目：必须走确认（沿用现有"停止并切换 / 保留并新开线程"语义），不得静默 re-anchor
- 多窗口（detached）同时改同一 thread 的档位 → 最终一致，两处 UI 同步
- app 重启 → 每 thread 的档位/运行位置/plan mode/队列恢复；队列中未发送项要么恢复要么明确清空（策略固定并测试）
- kill agent 后重连 → 档位从 agent 重新读取并校正 UI（防止漂移）

### 外部副作用检查
- 档位变更写入 `~/.grok/config.toml` 必须外科手术式（无关内容逐字保留，沿用 `scripts/test-mcp-config.mjs` 断言）
- Full Access 是高风险副作用：必须经确认弹窗；变更需记审计日志（不含密钥）
- 附件（addFiles/addPhotos）只读会话 cwd 与用户显式选择的路径；不得递归读取整个磁盘
- queue/interject 不得绕过 agent 直接操作会话状态

### Parity 勾选项
- [ ] E5 权限 4 档 + Full Access 三段式确认（20 + 11 条文案）
- [ ] E6 运行位置（This computer / Worktree）
- [ ] E7 worktree 环境下拉（9 条）
- [ ] E8 模型 + effort 循环/增减/⌘⇧M
- [ ] E9 plan mode / fast mode
- [ ] E12 queue / steer / submit in background（接 agent 队列，替换前端数组）
- [ ] E14 用量就地展示（token 维度）
- [ ] E15 建议与提示（无数据则隐藏）
- [ ] E17 分支起点（本地分支）
- [ ] E18 Chat/Work 切换（AD-7 M1 映射，真实驱动 cwd + sandbox）
- [ ] E19 浮动 / 覆盖式 composer（与 ISS-091 side panel 协同）
