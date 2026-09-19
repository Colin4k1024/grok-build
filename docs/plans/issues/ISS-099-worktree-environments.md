> Epic: #128 (ISS-069) · 批次: B4 · 标签: `parity-slice` `project` `priority/P1` `frontend` `backend`
> 规格来源: 差距文档 §H(H1–H5,H7) §E7；实物模块 `worktree-environment-dropdown` `use-codex-worktrees` `worktrees-settings-page` `worktree-onboarding-banner-controller` `worktree-onboarding-state` `worktree-setup-auto-fix` `stable-worktree-status-dialog` `local-environments-settings-page` `worktreeRestoreBanner`；文案 `settings.worktrees.*`(40) `projectSetup.*`(35) `worktreeRestoreBanner.*`(10) `localConversation.moveTo*`(26)

## 目标

Worktree 全生命周期改由 agent 管理（替换主进程 `execFile('git worktree')`），并补齐本地环境（project setup / Run·Test 动作）、设置页、onboarding + auto-fix、恢复横幅、会话在 local↔worktree↔host worktree 间迁移。

## 范围

1. **生命周期走 agent**：`x.ai/git/worktree/{create,create_from_worktree,create_from_worktree_sync,list,show,status,remove,detach,gc,salvage,apply,clean-artifacts,resume_session,db/{path,rebuild,stats}}`；替换 `electron/main.ts:367-410` 的 `git_worktree_{list,add,remove}`
2. **Worktree 设置页**（`settings.worktrees.*` 40 条）：列表（repository 元数据 / loading / unknown）、每 worktree 关联会话列表（`row.conversations{,.empty,.loading}`）、`row.newChat`(+description)、`row.delete`、`refresh`、空态（`empty.{title,body}`）、错误态（`error.{title,body}`）、删除成功/失败、**自动清理**（`autoCleanup.{label,description,ariaLabel,save.*}` + 关闭时二次确认 `autoCleanup.confirm.{title,body,cancel,confirm}`）、**保留数量上限**（`keepCount.{label,description,description.disabled,ariaLabel,save.*}`）、**创建前 fetch upstream**（`upstreamRefresh.{label,description,ariaLabel,save.*}`）
3. **本地环境 / project setup**（`projectSetup.*` 35 条 + `local-environments-settings-page`）：一次性项目 setup、Run/Test 动作复用、`workspace.environmentAction1-9` 命令（`environmentAction1`=⌘⇧D）
4. **Worktree 环境下拉**（与 ISS-093 协同）：`composer.worktreeEnvironment.*` 数据源接本地环境
5. **Onboarding + auto-fix**：`worktree-onboarding-banner-controller` / `worktree-onboarding-state` / `worktree-setup-auto-fix`（检测并修复 worktree setup 问题）；升级现有 `WorktreeOnboardingBanner`
6. **恢复横幅**：`worktreeRestoreBanner.*` 10 条（worktree 被外部删除/移动后的恢复引导）+ `stable-worktree-status-dialog`
7. **会话迁移**：`localConversation.moveToLocal`(14) / `moveToWorktree`(8) / `moveToHostWorktree`(4) / `threadHandoff`(8) —— 把运行中/已完成的会话在本地与 worktree 间迁移（走 `x.ai/session/*` + worktree `resume_session`）
8. **稳定 worktree**（与 ISS-096 协同）：`sidebarElectron.createStableWorktree`(8) + `worktreeGroupTooltip`
9. Triage/审阅队列语义保留（iss-067）：worktree 产出集中审阅仍可用，但数据源改 agent

## 非目标

- 云环境（`cloud-environments-settings-page`）、远程主机 worktree（OUT）
- jj（Jujutsu）支持（agent 有 `extensions/jj.rs`，本轮不做 UI）
- worktree 快照存储的用户可见管理（agent 内部行为）
- 不做 worktree 内文件编辑器

## 依赖

- ISS-087（`x.ai/git/worktree/*`、`x.ai/session/*`、本地环境相关扩展）
- ISS-093（composer 的 worktree 环境与运行位置）
- ISS-102（Settings 容器 —— worktrees / local-environments 两个页）
- ISS-096（侧栏稳定 worktree 入口）

## 回滚

`git_worktree_*` IPC 保留为薄封装（内部改为转发 agent），回滚 = 恢复 `execFile('git worktree')` 实现，channel 与 payload 不变，前端无需回滚。设置项持久化到 `~/.grok/config.toml` 的独立键，回滚后旧版本忽略这些键而不报错。

## 验收标准

### 状态机不变量
- worktree 列表 == `git worktree list` 真值（经 agent）；创建/删除后列表与磁盘状态一致，无"UI 有磁盘无"
- 每个 worktree 恰有一个路径与一个分支；`is_main` 唯一
- 会话迁移：迁移前后 threadId 不变、transcript 不丢、cwd 与 worktree 绑定关系一致；迁移中 `streaming` 的会话必须先停止或用户确认（不得静默 re-anchor）
- 自动清理开启 ⟹ 超过 `keepCount` 的托管 worktree 被清理且**先快照**（可恢复，`salvage`）；关闭 ⟹ 不清理
- onboarding 状态机：`未开始 → 进行中 → 完成/失败(可 auto-fix → 重试)`，状态持久化且不重复弹

### 负向场景
- 非 git 仓库 / bare 仓库 / detached HEAD / 有未提交改动时创建 worktree → 各自明确错误，不留半成品目录
- 分支已存在 / 目标路径已存在且非空 / 磁盘空间不足 / 无写权限 → 明确错误 + 可操作建议
- `create_from_worktree_sync` 上游 fetch 失败（无网络）→ 降级为本地分支创建并告知
- worktree 被外部删除 → `worktreeRestoreBanner` 引导，会话不崩
- 删除有关联会话的 worktree → 列出关联会话并要求确认；删除失败给出原因
- `db/rebuild` 失败 → 保留旧 db，明确错误
- auto-fix 无法修复 → 给出手动步骤而非静默失败

### 并发 / 崩溃 / 恢复
- 创建 worktree 进行中 kill agent/app → 无半成品目录残留（或有明确清理入口 `clean-artifacts`/`gc`）
- 同时对同一仓库创建两个 worktree → 串行化或明确冲突，无竞态损坏 `.git`
- 会话迁移中 agent 断线 → 迁移要么完成要么回滚到源位置，不出现"两侧都没有会话"
- app 重启 → worktree 列表、关联会话、onboarding 状态、设置项恢复
- 与 TUI 同时操作 worktree（TUI 也在同一 leader 下）→ 列表一致，无互相覆盖

### 外部副作用检查
- **破坏性操作**：`worktree/remove`（含 force）、`gc`、`clean-artifacts`、`detach`、`salvage` 必须二次确认；force 删除需额外提示未提交改动会丢失
- 所有 git 写操作走 agent，不在渲染层/主进程拼 shell（`execFile` 参数数组或 agent 调用）
- 创建 worktree 的磁盘占用需在 UI 可见（避免静默占满磁盘）；自动清理默认开启（对齐实物推荐）
- 写入 `~/.grok/config.toml` 的自动清理/keepCount/upstreamRefresh 键必须外科手术式（round-trip 断言）
- 不得在 worktree 创建过程中修改用户的主检出（main working tree）内容

### Parity 勾选项
- [ ] H1 生命周期全量走 agent（14 个方法）
- [ ] H2 设置页 40 条文案对应行为
- [ ] H3 onboarding + auto-fix；H4 恢复横幅(10) + stable-worktree-status-dialog
- [ ] H5 本地环境 + projectSetup(35) + `environmentAction1-9`
- [ ] H7 会话迁移（moveToLocal/moveToWorktree/moveToHostWorktree/threadHandoff，26 条）
- [ ] A3 收尾：主进程 `execFile('git worktree')` 全部下线
