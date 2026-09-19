> Epic: #128 (ISS-069) · 批次: B2 · 标签: `parity-slice` `settings` `priority/P1` `frontend`
> 规格来源: 差距文档 §K(K1–K6) §L4；实物模块 `settings-page` `settings-layout` `settings-command-menu-section-items` `use-visible-settings-sections` `_virtual_settings-search-documents` `settings-unsaved-changes-dialog` `settings-row-disclosure` `settings-loading-row` `settings-host-dropdown` `agent-settings` `keyboard-shortcuts-dialog` `keyboard-shortcuts-settings` `general-settings` `git-settings` `code-review-settings` `hooks-settings` `import-settings` `notifications-settings` `storage-settings`；文案 `settings.*`(442: general 79 / agent 73 / nav 63 / mcp 56 / worktrees 40 / section 34 / automations 27 / localEnvironments 14 / dataControls 13) `keyboardShortcutsDialog.*`(12)

## 目标

Settings 从 12 个扁平 tab 升级为 Codex 的分组导航 + 完整页集 + **设置项级搜索** + Agent(Configuration) 页 + 未保存变更对话框；快捷键对话框按 7 分区重构并可搜索。

## 范围

1. **分组导航**（`settings.nav.heading.{personal,coding,integrations,archived}`）：
   - Personal：profile(→ 本地 auth/API key)、appearance、notifications、keyboard-shortcuts、storage、data-controls(归档会话)、security(→ sandbox/权限)
   - Coding：general-settings、**agent(Configuration)**、skills、plugins、mcp、worktrees、local-environments、git-settings、code-review、hooks-settings、import
   - Integrations：mcp / plugins 的连接器视角（本地范围）
   - 折叠导航（`collapseSidebar`/`expandSidebar`）、`settings-host-dropdown`（多主机过滤降级为多项目过滤）、`clearHostFilter`(+Description)、`back`、`title`、`ariaLabel`
2. **Agent(Configuration) 页**（`settings.agent.*` 73 条）：
   - approval policy（`configuration.approval.{definition,restricted}`）、sandbox mode（`configuration.sandbox.{definition,restricted}`）、network 开关（`configuration.network.{ariaLabel,definition}` + `inlineSandboxWriteError`）、web search（`configuration.webSearch.{definition,restricted}`）、model verbosity、reasoning summary
   - **配置作用域**：`configuration.scope.{project,open,readOnly,managedDescription,unavailable,loading}` + `configuration.notice.{fileContext,fileLocationSuffix,openFile}`（显示 `File: {path} (line {line}, column {column})` 并可打开）
   - 写入失败：`configuration.writeError`
   - **Model features**：`modelFeatures.{title,reasoningEfforts.{label,description,selectedCount},modelPickerSliderUltra.*}`（OUT 的 Ultra 部分跳过）
   - **Agent dependencies**：`dependencies.{enabled.*,bundleVersion.*,diagnose.*,reset.*,cancel.*,problemDescription}`（诊断/重装/取消下载）
   - permissions 默认档（`permissionsMode.{groupTitle,default.title,fullAccess.title}`）
   - ambient suggestions（`ambientSuggestions.groupTitle`）
   - 数据源：`x.ai/settings/update`、`x.ai/sessionConfig`、`x.ai/config_changed`、`x.ai/models/{list,update}`、`x.ai/internal/reload_*`
3. **页补齐**：`git-settings`(5)、`code-review`(code-review-settings + `settings.nav.codeReview`)、`hooks-settings`(+`-copy`/`-model`/`-route`)、`import-settings`(+`-gate`，与 ISS-103 的外部导入共用)、`notifications-settings`(14)、`storage-settings`、`data-controls`(13, 归档会话管理)、`local-environments`(14, 与 ISS-099 共用)、`automations`(27, 与 ISS-101 共用)
4. **设置项级搜索**（`_virtual_settings-search-documents` + `settings.search.*` 5 条）：把**每个设置项**做成可搜索文档（标题+描述+关键词），命中后跳到具体行并高亮（当前只按 tab 名过滤 → 粒度差一级）
5. **未保存变更**：`settings-unsaved-changes-dialog` + `settings.unsavedChanges`；行内编辑 `settings.editRow.*`(3)、`settings-loading-row`、`settings-row-disclosure`、`settings-panel`
6. **快捷键设置页 + 对话框**：`keyboard-shortcuts-settings` + `keyboard-shortcuts-dialog`（7 分区：App/General/Navigation/Panels/Chat(thread)/Project(workspace)/Skills + Configure）+ `keyboardShortcutsDialog.{title,loading,empty,noMatches,section.*}` + `keyboard-shortcuts-search-input`；数据源 = ISS-089 注册表
7. **命令菜单分区**：`settings-command-menu-section-items`（命令面板可搜设置项并跳转，对应旧 ISS-045）
8. 现有页迁移：models / apikeys / mcp / plugins / worktrees / appearance / permissions / agent / trusted / voice / general / about → 归入新分组（models+apikeys 合并入 agent/Configuration 或保留为 Coding 下独立页）

## 非目标

- OUT 的设置页：billing、personalization、pets、parental-controls、trusted-contact、time-management、ads-controls、analytics/consumer-view、browser-use、computer-use、chronicle、appshots、cloud-environments、remote-connections、codex-micro、debug/employee-only、profile/account（改为本地 auth + API key）
- 企业 managed policy 的强制展示（保留 `managedDescription` 文案位但本地无 policy 源）
- 设置同步到云

## 依赖

- ISS-089（命令注册表 → 快捷键页；i18n key）
- ISS-087（`x.ai/settings/update`、`x.ai/sessionConfig`、`x.ai/config_changed`、`x.ai/hooks/list`、`x.ai/models/*`）
- 被依赖：ISS-099（worktrees/local-environments 页容器）、ISS-100（plugins/skills/mcp 页容器）、ISS-101（automations 页容器）、ISS-103（import 页容器）—— **因此本 issue 排在 B2**

## 回滚

新 Settings 以独立组件树实现（`src/features/settings/`），flag `settings.v2`；回滚 = `App.tsx` 指回 `src/pages/Settings.tsx`（132 行，保留）。设置值本身存 `~/.grok/config.toml` 与 `GROK_HOME`，格式不变，回滚无数据迁移。

## 验收标准

### 状态机不变量
- **UI 值 ⟺ config 真值**：任一设置项显示值 == `x.ai/sessionConfig`/config.toml 解析值；写入后重读一致（禁止只更新本地 state）
- 作用域不变量：项目级设置只影响该项目；用户级影响全局；`readOnly` 源的项必须禁用编辑并说明（`scope.readOnly`）
- 未保存变更：有脏值时离开页面必弹 `unsaved-changes-dialog`；保存成功后脏标记清空；丢弃后值回到上次保存态
- 搜索结果 == 可见设置项文档集合的子集；隐藏（OUT/flag 关闭）项不得出现在搜索结果
- 快捷键页显示 == 命令注册表真值（ISS-089），无手工维护的第二份数据

### 负向场景
- config.toml 语法错误 → 显示解析错误 + 文件路径与行列（`notice.fileContext`/`fileLocationSuffix`）+ `openFile`，且**不允许保存**直到修复
- 写入失败（只读文件 / 权限 / inline sandbox table）→ `writeError` / `inlineSandboxWriteError`，UI 回滚到原值
- 被 restricted 的项（approval/sandbox/webSearch）→ 显示 `*.restricted` 且禁用
- 依赖诊断失败 / 重装失败 / 取消下载 → 各自 `diagnose.failed` / `reset.failed` / `cancel.failed|canceled`，不卡进度条
- 搜索无结果 → `settings.search` 空态；搜索输入含正则特殊字符不得崩
- reasoning efforts 全不选 → 校验阻止（至少一个）
- hooks 配置指向不存在的文件 → 明确错误

### 并发 / 崩溃 / 恢复
- 外部（TUI / 手改 config.toml）修改配置时设置页打开 → `x.ai/config_changed` 触发刷新；有本地脏值时不得静默覆盖用户输入（提示冲突）
- 保存进行中关闭窗口 → 写入原子完成或明确失败，不留半写文件
- 两个窗口同时改同一项 → 最后写入胜出 + 另一侧刷新
- app 重启 → 所有设置从 config 恢复（无本地影子状态导致的漂移）
- 依赖重装（长时间下载）中 app 重启 → 状态可恢复或明确重置，不永久卡在"下载中"

### 外部副作用检查
- 写 `~/.grok/config.toml` 必须外科手术式：无关段逐字保留（沿用 `scripts/test-mcp-config.mjs` 的 round-trip 断言，并扩展为通用 config 写入断言）
- `dependencies.reset`（重装）会下载并安装捆绑工具 → 必须显示进度、可取消、说明将写入的目录
- `hooks-settings` 涉及执行外部脚本 → 必须显示脚本路径与触发时机；新增 hook 需信任确认（沿用 `x.ai/hooks` 的信任语义）
- 设置页不得执行 git 写操作、不得删除会话（data-controls 的归档删除需走 ISS-096 的确认流）
- API key 写入 key store 后 UI 不回显明文；日志不打印

### Parity 勾选项
- [ ] K1 分组导航 + 折叠 + 过滤
- [ ] K2 IN 范围页全量（general/agent/skills/plugins/mcp/worktrees/local-environments/git/code-review/hooks/import/notifications/keyboard/appearance/storage/data-controls/security）
- [ ] K3 设置项级搜索（`_virtual_settings-search-documents` 语义）
- [ ] K4 Agent(Configuration) 页 73 条（含作用域/notice/writeError/Model features/dependencies）
- [ ] K5 未保存对话框 + 行内编辑 + disclosure + loading row
- [ ] K6/L4 快捷键对话框 7 分区 + 搜索 + 空/加载态
- [ ] 命令面板可搜设置项并跳转（`settings-command-menu-section-items`）
