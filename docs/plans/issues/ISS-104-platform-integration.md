> Epic: #128 (ISS-069) · 批次: B5 · 标签: `parity-slice` `app-shell` `priority/P2` `frontend` `backend`
> 规格来源: 差距文档 §B(B6–B9,B11) §N(N1–N3,N7)；实物证据 `chatgptTemplate.png`/`@2x`（tray 模板图标）、`native-menu-locales`(65)、`scripting.sdef`(AppleScript)、`codex-notification.wav`、`appUpdate.*`(15)、`appServerCrash.*`(6)、`appShell.detachedWindow.*`、`open-in-codex`、`plugin-mcp-app-deep-link-page`、`codex.triggers`(OUT)、`traceRecording.*`(14)

## 目标

补齐桌面平台层：tray、原生菜单、自动更新、deeplink、单实例、崩溃恢复、通知（分类 + 声音）、本地导出、trace recording。

## 范围

1. **Tray**（B6）：模板图标（macOS `chatgptTemplate` 语义 → grok 单色模板图）+ 菜单（新建会话 / 显示窗口 / 最近会话 / 设置 / 退出）；接线渲染层已有但主进程缺失的 `onTrayAction`（当前是死监听）；`set_badge` 保留
2. **原生菜单**（B7）：完整 app 菜单（About / Settings⌘, / Hide / Quit）+ Edit（Undo⌘Z / Redo⌘⇧Z / Cut / Copy / Paste / Select All）+ View（Reload / Toggle DevTools / 布局命令）+ Window（Minimize / Zoom / 前端 tab 列表 / detached windows）+ Help；菜单项与命令注册表（ISS-089）**单一真源**，不得双份维护；`native-menu-locales` 语义 → 菜单文案走 i18n
3. **自动更新**（B8）：`updater_check` 真实实现（当前 `ok(null)`）+ electron-updater 或自建 feed；`appUpdate.*` 15 条 + `appHeader.{downloadingUpdate,downloadingUpdatePercent,installUpdate,installUpdate.confirm{Title,Subtitle,Install,Cancel},installingUpdate}`；接线 `useUpdater.ts`（当前空转）
4. **Deeplink**（B9）：注册自定义 scheme（如 `grok://`）；`open-in-codex` 语义 → `grok://thread/<id>`、`grok://new?cwd=…`；`threadHeader.copyAppLink`（ISS-097）复制的链接可被本机 app 打开；`plugin-mcp-app-deep-link-page` 的本地部分
5. **单实例 + 崩溃恢复**（B11）：`requestSingleInstanceLock`（第二实例聚焦已有窗口并传 deeplink）；`appServerCrash.{recoveryTitle,recoveryDescription,configurationRecoveryDescription,restartChatGPT,reviewConfiguration,sendFeedback,feedbackGuidance}` → agent 崩溃恢复面板（Restart / Review configuration / Send feedback）；`appSunset.{title,body.inAppUpdate,manualDownload}` 语义用于强制更新
6. **通知**（N1）：分类（权限审批 `codex.notifications.permissionApproval.title`、turn complete、错误、定时任务触发）+ 声音（`codex-notification.wav` 语义 → 本地资源）+ 点击跳转对应 thread + `notifications-settings` 页联动（ISS-102）
7. **本地导出**（N7）：`copyConversationMarkdown`（ISS-097）+ 导出为文件（Markdown / JSON transcript）；`codex.sharedSnapshot`/`shareDialog` 的**本地文件**版本（云端分享 OUT）
8. **Trace recording**（N3）：`traceRecording.*` 14 条 + 命令 `toggleTraceRecording`；本地录制/导出（上传到服务 OUT）
9. **窗口生命周期**：`window-all-closed` 在 macOS 保留 dock、`activate` 重建（现有）；关闭时若有运行中 turn → 确认；`before-quit` 清理子进程（现有，需加断言）

## 非目标

- macOS 之外的平台视觉打磨（保持可构建，行为对齐即可）
- AppleScript `sdef` 完整脚本字典（可作为后续 issue；本轮只做菜单与 deeplink）
- 云端分享、Chronicle、Pets、Codex Micro、Realtime voice（OUT）
- 代码签名与公证流程变更（沿用现有 electron-builder 配置；若 updater 需要签名则记录为前置）

## 依赖

- ISS-088（多窗口广播、IPC 契约 —— tray/deeplink 需要唤起特定 thread）
- ISS-091（detached window、tab 列表进 Window 菜单）
- ISS-089（命令注册表 = 菜单单一真源）
- ISS-102（notifications 设置页）
- 更新 feed 需要发布基础设施（若无，则本 issue 只做"检查 + 提示手动下载"，`appSunset.manualDownload` 语义）

## 回滚

每项独立 flag：`platform.tray` / `platform.menu` / `platform.updater` / `platform.deeplink` / `platform.singleInstance`。回滚不影响会话数据。deeplink scheme 注册回滚需清理系统注册（记录步骤）。updater 回滚必须保证不会自动安装旧版本。

## 验收标准

### 状态机不变量
- 单实例：任意时刻至多一个 app 实例持有锁；第二实例启动 ⟹ 已有窗口聚焦 + 参数（deeplink）传递 + 第二实例退出，不产生第二个 tray 图标
- 菜单项可见性/启用态 == 命令注册表的 `availableIn ∧ flags ∧ scope`（单一真源，无第二份条件判断）
- 更新状态机：`idle → checking → available → downloading(percent) → downloaded → installing → restarted`；任一失败态可回到 idle 并重试；`installUpdate.confirmCancel` 后不得安装
- 通知点击 ⟹ 聚焦窗口 + 激活对应 thread（thread 已关闭则明确提示）
- badge 数 == 全窗口未决审批总数（现有 `pendingTotal` 语义保留并扩展到多窗口）
- 崩溃恢复面板出现 ⟹ agent 连接处于 disconnected，且面板消失前不得允许发送 prompt

### 负向场景
- tray 图标资源缺失 / 平台不支持 tray → 静默降级，不影响主功能
- 更新 feed 不可达 / 返回非法版本 / 下载校验失败（签名或 hash 不符）→ 明确错误，**绝不安装未校验产物**
- deeplink 携带非法/越权参数（`grok://thread/../../etc`、外部 URL、未知 host）→ 拒绝并记录，不打开任意路径或 URL
- 通知权限被系统拒绝 → `notification_is_permitted` 走降级（仅 in-app badge），不反复弹权限请求
- 声音资源缺失 → 静音降级
- 导出时 transcript 为空 / 含二进制附件 → 有确定行为（跳过附件并注明）
- agent 崩溃且配置损坏 → `configurationRecoveryDescription` + `reviewConfiguration` 路径可用

### 并发 / 崩溃 / 恢复
- agent 进程崩溃（kill -9）→ 崩溃面板出现；Restart 后 tabs/transcript 保留（依赖 ISS-087/072 的恢复）
- 更新下载中 app 退出 → 重启后不自动安装未完成产物；可重新检查
- deeplink 在 app 未运行时触发（冷启动）→ 参数被保留并在窗口就绪后处理（不丢）
- 两个 deeplink 快速连续到达 → 按序处理，不产生重复 tab
- 多窗口下 tray「显示窗口」→ 聚焦最后活跃窗口（确定规则）
- 通知在 app 退出瞬间到达 → 不崩溃、不残留

### 外部副作用检查
- **自动更新 = 远程代码执行面**：必须校验签名/hash；feed URL 白名单；不得从非官方源安装；安装前用户确认（`installUpdate.confirm*`）
- deeplink scheme 注册写系统（macOS LaunchServices）→ 卸载/回滚需清理；scheme 名不得与既有 app 冲突
- tray/菜单不得暴露破坏性操作而无确认（退出时若有运行中 turn 需确认）
- 通知内容不得包含密钥、完整 prompt 正文或文件内容（只含标题/项目名/动作类型）
- trace recording 写本地文件需明确目录与大小上限，可一键删除；不得上传
- 导出文件默认写到用户选择的位置，不写项目目录

### Parity 勾选项
- [ ] B6 tray（含 `onTrayAction` 死监听接线）；B7 原生菜单（与命令注册表单一真源）
- [ ] B8 自动更新（`appUpdate.*` 15 + `appHeader.*` 8）；B9 deeplink + `open-in-codex`
- [ ] B11 单实例 + 崩溃恢复（`appServerCrash.*` 6）
- [ ] N1 通知分类 + 声音 + 点击跳转；N2 badge 多窗口一致
- [ ] N3 trace recording(14)；N7 本地导出（Markdown / JSON）
- [ ] 桩清零：`updater_check`、`useUpdater.ts`、`onTrayAction`
