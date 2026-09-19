> Epic: #128 (ISS-069) · 批次: B1 · 标签: `parity-foundation` `command-palette` `priority/P1` `frontend`
> 规格来源: 差距文档 §L（127 条命令注册表已逆向）；`scripts/codex-ref/commands.mjs` 输出 `/tmp/codex-ref/commands.tsv`

## 目标

把命令、快捷键、文案三件事变成**可自动对照验收的数据**：命令注册表 schema 与 Codex 一致、快捷键逐条归位、i18n key 直接采用 Codex 文案 id。

## 范围

1. `src/state/commands.ts`：注册表 schema 对齐实物
   ```ts
   { id, titleIntlId, descriptionIntlId, availableIn:['electron'], shortcutScope:'app'|'os-global',
     commandMenuGroupKey:'thread'|'navigation'|'panels'|'app'|'configure'|'skills'|'workspace',
     commandMenuFeature, electron:{ defaultKeybindings:[{key}] } }
   ```
   - 7 个分组 + 组内固定优先级：`newTask > temporaryChat > quickChat > archiveThread > newProjectlessTask > openSideChat`
   - flag 门控（`isAutomationsEnabled`/`isDictationEnabled`/`isHotkeyWindowEnabled`/`isUnifiedTabStripEnabled`/`modeSwitchAvailable`/`fileLanguageFeaturesEnabled`/`isPriorityFilterEnabled`）
   - **IN 范围命令全量注册**（约 100 条）；OUT 范围命令（`openBrowserTab`/`reloadBrowserPage`/`hardReloadBrowserPage`/`realtimeVoice*`/`codexMicroSettings`/`openAvatarOverlay`/`toggleTraceRecording`）**不注册**
2. 快捷键归位（实测冲突修复）：
   | 现状 | 目标 |
   |---|---|
   | ⌘G 全局搜索 | `searchChats` = **⌘K** |
   | ⌘K / ⌘⇧P 命令面板 | 命令面板 = **⌘⇧P**（⌘K 让位 searchChats） |
   | `CommandPalette.tsx:39` 标注 ⌘T | 修正为 ⌘N / ⌘⇧O（⌘T 在 Codex 是范围外的 `openBrowserTab`） |
   | 缺 | 补 `archiveThread`⌘⇧A、`temporaryChat`⌘⇧N、`quickChat`⌘⌥N、`newProjectlessTask`⌘⌥O、`openSideChat`⌘⌥S、`markThreadUnread`⌘⇧U、`nextThreadNeedingAttention`⌘⌥A、`togglePriorityFilter`⌘⌥U、`findInThread`⌘F、`showKeyboardShortcuts`⌘/、`reopenClosedTab`⌘⇧T、`closeOtherTabs`⌘⌥W、`stepWorkspaceLayout`⌘⇧B、`showWorkspaceTabView`⌘⇧F、`toggleSidePanel`⌘⌥B、`toggleSidebar`⌘⇧S(+⌘B)、`undo/redo`⌘Z/⌘⇧Z、`clearAllUnreads`⇧Esc、`composer.addFiles`⌘U、`composer.openModelPicker`Ctrl+⇧M、`composer.openProjectPicker`⌘⌥⇧O、`composer.startDictation`Ctrl+⇧D、`composer.submitInBackground`⌘↵、`openFolder`⌘O、`personalitySettings`⌘⇧I、`environmentAction1`⌘⇧D、`recentThread1-5`⌘⌥1-5、`nextThread/previousThread`⌘⇧]/⌘⇧[（+Ctrl+PageDown/Up、鼠标侧键）、`thread1-9`⌘1-9 |
   - 保留已对齐项：⌘N/⌘⇧O、⌘B、⌘O、⌘J、⌘,、⌘1-9、⌘⇧[ ]
3. 命令面板增强：分组标题、组内优先级排序、Color themes 可搜索区、Recently viewed threads（含 `{title}, {position} of {count}` 播报）
4. `src/i18n/`：`zh-CN.ts` + `en.ts` 兜底；**key 直接沿用 Codex i18n id**（如 `threadHeader.copyWorkingDirectory`）；`useI18n()` / `<T id=… />`；本 issue 覆盖 shell + composer + 命令面板全部文案（消除现存中英混排，如 `App.tsx` 关闭确认弹窗的英文）
5. `src/components/layout/CommandPalette.tsx`、`ShortcutCheatSheet.tsx` 重构为注册表驱动（cheat sheet 按 7 分区 + 搜索 + 空态/加载态）
6. **一致性测试**：从 `/tmp/codex-ref/commands.tsv` 生成快照，CI 比对注册表的 id/keys/group 三元组，OUT 范围命令必须缺席

## 非目标

- 不实现命令背后的功能（命令先注册 + 未实现者标 `available:false` 并在面板中隐藏，由各切片 issue 逐个点亮）
- 不做 `os-global` scope 的系统级快捷键（hotkeyWindow / 全局听写 → ISS-104）
- 不做多语言（仅 zh-CN + en 兜底）
- 不改键位到 Codex 的 Windows/Linux 差异细节（本轮以 macOS 为准，其余平台用 `CmdOrCtrl` 自动映射）

## 依赖

- ISS-088（命令需要 layout store 与 thread scope；快捷键动作作用于布局状态机）
- `scripts/codex-ref/commands.mjs`（规格来源，已入库）

## 回滚

注册表与 i18n 均为新增文件；回滚 = 恢复 `CommandPalette.tsx` / `ShortcutCheatSheet.tsx` / `useKeyboardShortcuts.ts` 三个旧文件并删除 `src/state/commands.ts`、`src/i18n/`。键位回滚会影响肌肉记忆但不影响数据。

## 验收标准

### 状态机不变量
- **唯一命中**：任一按键组合至多命中一个命令（注册表构建期做冲突检测，冲突即 CI 失败）
- 命令可见性 = `availableIn` ∧ flags ∧ 当前 scope ∧ 已实现；不可见命令不得被快捷键触发
- 每个命令的 `titleIntlId`/`descriptionIntlId` 必须在 i18n 表中有对应 key（CI 断言，缺 key 即失败）
- 分组与优先级恒定：面板中同组命令顺序 == 注册表优先级顺序，稳定可复现

### 负向场景
- i18n 缺 key → 渲染 en 兜底而非 `undefined` 或空白；同时 CI 报缺
- 快捷键在输入框/编辑器内触发 → 文本编辑类组合（⌘C/V/X/A/Z 在 ProseMirror 内）不被劫持；`approval.approve`=Enter 只在审批卡焦点内生效，不得在 composer 里误触发
- 命令执行抛错 → 面板显示错误、不关闭 palette 之外无副作用、错误可复制
- 无匹配搜索结果 → 空态文案（对齐 `composer.slashCommands.noResults` / `keyboardShortcutsDialog.noMatches`）
- 未实现命令被快捷键触发 → 无操作 + 明确提示，不静默成功

### 并发 / 崩溃 / 恢复
- 快捷键重复触发（连按/长按自动重复）不得产生重复动作（新建会话需去抖或幂等）
- 命令执行中途切换 thread / 关闭窗口 → 动作作用于**触发时**的 thread，不错投到当前 active thread
- app 重启后用户对键位的自定义（若本轮支持）需持久化；不支持自定义则必须显式声明为不支持

### 外部副作用检查
- 命令不得绕过 IPC 白名单直接访问 Node 能力
- i18n 文案不得内嵌用户数据（路径/密钥）；动态部分走参数插值
- 快照比对只读 `/tmp/codex-ref/`，CI 上若缺失则重新用 `scripts/codex-ref` 生成或 skip（不得把 ChatGPT.app 产物写入仓库）

### Parity 勾选项
- [ ] L1 注册表 schema + 分组 + 优先级 + flag 门控
- [ ] L2 IN 范围命令全量注册（≈100 条），OUT 范围 7 条确认缺席
- [ ] L3 Color themes + Recently viewed threads 附加区
- [ ] L4 快捷键对话框 7 分区 + 搜索 + 空/加载态
- [ ] G7 关闭（⌘K/⌘⇧P/⌘T 三处修正）
- [ ] G8 关闭（i18n 层就位，shell/composer/palette 文案 key == Codex id）
