> Epic: #128 (ISS-069) · 批次: B5 · 标签: `parity-slice` `onboarding` `security` `priority/P1` `frontend` `backend`
> 规格来源: 差距文档 §M(M1–M3) §A11；实物模块 `onboarding-page` `onboarding-login-content` `onboarding-interactive-tools` `pending-onboarding` `sidebar-onboarding-checklist.electron` `external-agent-config-import-flow` `external-agent-import-setup` `use-external-agent-import-setup-actions` `run-external-agent-import-command` `import-settings` `import-settings-gate` `auth-handoff-page`；文案 `electron.onboarding.*`(88) `externalAgentConfig.*`(10) `settings.agent.importSettings.*`(17) `codex.logout.*`(13) `threadPage.remoteConnectionStatusBadge.login`

## 目标

替换硬编码的假登录（`main.ts:55-60` 返回 `{authenticated:true,username:"dev"}`）为真实 `x.ai/auth/*` 流程，重做多步 onboarding，并实现**外部 agent 配置导入**（Claude Code / Cursor → AGENTS.md / config.toml / skills / plugins / projects / chats）。

## 范围

1. **真实 auth**：`x.ai/auth/{get_url,submit_code,cancel,info,logout,check_subscription,getBearerToken}`；`check_auth_status` / `login` / `logout` 三个 IPC 接真值；`auth-handoff-page`（`AuthHandoff.tsx` 当前无 invoke，是死页面）；设备码/浏览器回调流的等待态与取消态
2. **登录页重写**：`Login.tsx`（79 行）→ `onboarding-login-content` 语义；未登录时不得创建会话；登录状态变化广播到所有窗口
3. **多步 onboarding**：`onboarding-page` + `pending-onboarding` + `onboarding-interactive-tools`；替换现有 5 步纯文案弹窗（`Onboarding.tsx` 134 行）；步骤：欢迎 → 登录/API key → 项目选择 → 权限档位（含 Full Access 风险确认，与 ISS-093 共用组件）→ 外部导入（可跳过）→ 完成
4. **侧栏 onboarding checklist**：`sidebarOnboardingChecklist.*` 34 条 + `sidebar-onboarding-checklist.electron` + `sidebar-onboarding-checklist-task-config`（与 ISS-096 协同）
5. **外部 agent 配置导入**（`electron.onboarding.welcomeV2.externalAgentImport.*` 60+ 条）：
   - 提供方检测：`providers.{claudeCode,claudeCowork,cursor}` + `providers.appsFound`/`earlyAppsFound`/`chooseApps`/`dialogTitle`/`list`/`toggle`
   - 可选项：`customize.{projects,projectsDescription,chats,chatsDescription,pluginsWithCount,skillsWithCount,settingsTooltip,instructionsTooltip,cursorSettingsTooltip,cursorInstructionsTooltip}`（settings.json→config.toml、CLAUDE.md→AGENTS.md、Cursor rules→AGENTS.md）
   - 流程：`items.{title,subtitle,list}` → `importButton`/`importingButton`/`importingStatus`/`importedStatus` → `continueInBackground` → `error`
   - 同步：`providers.{keepInSync,keepInSyncDescription}`、`providers.setupPreserved`
   - 回顾：`review.{importSelected,selectedApps}`、`importedCounts`、`stepFinished`、`itemInfo`、`projects.{title,description,info}`、`recentChats.description`
   - 设置页入口：`settings.agent.importSettings.*` 17 条（`sharedImportLabel`/`sharedImportDescription`/`detectingDescription`/`loadingLabel`/`applySelected.appName`/`progress.*`/`sectionTitle`/`sectionSubtitle.appName`/`toast.*`）+ `import-settings` / `import-settings-gate`
   - 命令：`importExternalAgent`（configure 组）+ `codex.command.importExternalAgent.*`（`loading`/`retry`/`alreadyRunning`/`error`/`noCompatibleImports`/`noCompatibleAgentDataDescription`）
   - agent 侧对接：`xai-grok-shell/src/claude_import.rs`、`claude_import_state.rs`、`xai-grok-foreign-sessions` crate（**优先复用已有 Rust 能力，不新写解析器**）
6. **logout**：`codex.logout.*` 13 条 + `logOut` 命令；登出清理会话与密钥引用
7. **API key 路径保留**：`ApiKeyManager` 作为无订阅用户的替代登录方式（与 auth 并存，明确二者关系）

## 非目标

- 移动端配对（`codex-mobile-setup-flow/-dialog`、`codex-mobile-page`）—— OUT
- 企业账号 setup（`conversationalOnboarding.settingUpEnterpriseAccount`）—— OUT
- ChatGPT 订阅/计费/升级引导（`check_subscription` 仅用于能力判断，不做购买流）—— OUT
- 远程主机连接与 `installCodex`（OUT）
- 云端会话导入

## 依赖

- ISS-087（`x.ai/auth/*`、导入相关扩展；`xai-grok-foreign-sessions` 能力确认）
- ISS-102（`import-settings` 页容器）
- ISS-096（侧栏 checklist）
- ISS-093（Full Access 风险确认组件复用）
- ISS-088（auth 状态需广播到所有窗口）

## 回滚

auth 是安全敏感项：回滚不得退回"硬编码已登录"（那会让所有权限门失效）。回滚策略 = 保留真实 auth，仅回退 onboarding UI 与导入流程（各自 flag：`onboarding.v2`、`import.external`）。若 `x.ai/auth/*` 在本地不可用，降级为 **API key only** 模式并明确提示，而不是假装已登录。

## 验收标准

### 状态机不变量
- auth 状态机：`unknown → unauthenticated → (authenticating → authenticated | failed) → loggedOut`；`unknown` 期间不得渲染主界面（现有"加载中…"保留），`unauthenticated` 期间不得创建会话或调用 agent
- 登录态在所有窗口一致；登出后所有 thread 的密钥引用失效，pending 审批被清空
- onboarding 步骤状态机线性且可恢复：`step_i` 完成后重启不回到 step_0；跳过导入不得标记为已完成
- 导入状态机：`detecting → selectable → importing(progress) → done|partial|failed`；`alreadyRunning` 时第二次触发必须被拒（幂等）
- 导入是**加法式**：不得覆盖或删除目标 app 的既有配置（`providers.setupPreserved` 必须有验证）
- checklist 完成态 == 对应功能真实可用（不得手工打勾）

### 负向场景
- `get_url` 失败 / 浏览器打不开 / 用户取消（`auth/cancel`）/ 超时 / code 无效 / 订阅不满足 → 各自明确态且可重试
- 无网络时的 auth → 明确离线提示 + 引导 API key 路径
- 未检测到任何可导入 app → `noCompatibleImports` + `noCompatibleAgentDataDescription`
- 导入部分失败 → `progress.errorTitle`/`errorSubtitle` + 逐项状态（`progress.currentProjectSection`/`userConfigSection`/`ok`），成功项保留、失败项可重试
- 源配置格式异常（CLAUDE.md 不存在 / settings.json 坏 / Cursor rules 为空）→ 该项跳过并报告，不整体失败
- 导入目标已存在同名 AGENTS.md / skill → 冲突策略明确（合并/跳过/重命名）且不静默覆盖
- onboarding 中途退出 app → 重启回到中断步骤，不重复已完成步骤

### 并发 / 崩溃 / 恢复
- auth 进行中 kill app → 重启后状态收敛为 unauthenticated 或 authenticated（不得卡在 authenticating）
- 导入进行中 kill app → 重启后无半成品配置（原子写或可重入），`alreadyRunning` 不误报
- 导入与 agent 正在运行并发 → 导入的配置变更通过 `x.ai/config_changed` / `x.ai/internal/reload_*` 生效，不需重启且不影响在途 turn
- 多窗口同时触发登录 → 只走一次流程，其余窗口跟随状态
- 导入 100+ 会话/技能时的进度与取消可用

### 外部副作用检查
- **凭据安全**：token/API key 只存 OS key store（沿用现有 key store），不落 localStorage、不进日志、不进 crash 报告；UI 不回显明文
- 导入会写入 `~/.grok/`（config.toml / AGENTS.md / skills / plugins）与项目目录（AGENTS.md）→ 每项写入前列出目标路径并要求确认；config.toml 写入必须外科手术式（round-trip 断言）
- 读取其他 app 的配置目录（`~/.claude`、`~/.cursor`）必须**只读**
- 导入不得执行任何被导入的脚本/hook（只复制配置；hook 需另经信任确认，见 ISS-102）
- `auth/get_url` 打开浏览器必须走 `shell.openExternal` 且 URL 白名单（仅 x.ai / grok 官方域）
- 登出必须撤销/清理本地凭据，不得只清 UI 状态

### Parity 勾选项
- [ ] M1 多步 onboarding + 侧栏 checklist(34)
- [ ] M2 外部 agent 导入（`electron.onboarding.*` 88 条 IN 部分 + `importSettings.*` 17 条 + 命令 6 条）
- [ ] M3 真实登录（A11）+ auth handoff 页接线 + logout(13)
- [ ] 桩清零：`main.ts:55-60` 假 auth、`AuthHandoff.tsx` 死页面、`Onboarding.tsx` 纯文案弹窗
