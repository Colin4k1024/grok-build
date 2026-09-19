> Epic: #128 (ISS-069) · 批次: B2 · 标签: `parity-slice` `composer` `priority/P1` `frontend`
> 规格来源: 差距文档 §E(E1–E4)；实物模块 `composer-host` `composer-state` `primary-composer-at-mention-list`；文案 `composer.formatToolbar.*`(11) `composer.richLinkPopover.*`(12) `composer.codeBlock.*`(12) `composer.slashCommands.*`(5) `composer.skillMentionList.*`(9) `composer.pluginMention.*`(2)

## 目标

把 composer 从 `<textarea>` 升级为 **ProseMirror 富文本编辑器**（接线现有 328 行死代码 `ComposerEditor.tsx`），并实现格式工具条、rich link、mention pill、slash 命令对话框、代码块插入 + 语言选择。

## 范围

1. **接线 ProseMirror**：`ComposerEditor.tsx` 接入 `PromptInput`（替换 textarea）；保留现有行为：Enter 发送 / Shift+Enter 换行 / ⌘↵ 后台发送 / Tab 排队（streaming 中）/ Esc 取消 / ⌘↑↓ 历史 / 自动高度（≤160px）/ 图片粘贴拖拽
2. **格式工具条**（`composer.formatToolbar.*`）：Text styles（paragraph / H1 / H2 / H3）、Bold、Italic、Bulleted list、Numbered list、Link（含 `Apply`、`invalidLink` 校验：仅 http/https）
3. **Rich link popover**（`composer.richLinkPopover.*`）：Open link / Edit link / Edit text / Remove link / Save link text / Save link URL，含 Text 与 URL 双输入
4. **Mention 系统**：`@` 触发 pill（文件/文件夹，来源 = agent 的 `x.ai/search/fuzzy/*` 或 `x.ai/fs/list`，替代当前一次性拉全量 `git_ls_files`）；`$` 触发技能 pill，带**来源分类**（`builtInSource` / `projectSource` / `fromPlugin` / `pluginSource` / `localFileSource` / `adminSource`）+ `noResults` + `loading`；插件 mention（`pluginMention.browserUse` 范围外，仅保留本地插件）；pill 可整体删除、可编辑、粘贴纯文本时降级为文本
5. **Slash 命令对话框**（`composer.slashCommands.*`）：从行内下拉改为**独立可搜索弹层**（dialogTitle/dialogLabel/dialogDescription/inputPlaceholder/noResults）；命令来源改为 `x.ai/commands/list`（ISS-087），移除硬编码 `src/data/slashCommands.ts`
6. **代码块插入 + 语言选择器**（`composer.codeBlock.*`）：插入代码块、语言选择（`Auto detect` / `Plain text` / 搜索语言 / `noLanguagesFound`）、`autoDetectedLanguage` 显示
7. **草稿 per-thread**：草稿存 thread scope（ISS-088），切换 tab 不串草稿
8. 删除死代码 `MentionComplete.tsx`（功能已内联/被本 issue 取代）
9. 单测：ProseMirror schema 序列化（富文本 → 发送给 agent 的纯文本/markdown 契约）、mention pill 边界、语言检测

## 非目标

- 不做控件行（权限/模型/运行位置/模式 → ISS-093）
- 不做听写与语音（ISS-093 的 E10 或单独 issue）
- 不做 Appshot（OUT）、附件文件上传到云（OUT）
- 不做 `composer.threadGoal`（ISS-095 的聚合区块一起）
- 不实现富文本发给 agent 的**新协议**：仍按现有 text block 发送（markdown 序列化），除非验证 agent 支持富文本 block

## 依赖

- ISS-088（per-thread 草稿 scope）
- ISS-089（`composer.*` 命令与快捷键、i18n key）
- ISS-087（`x.ai/commands/list`、`x.ai/search/fuzzy/*`、`x.ai/skills/list`）

## 回滚

`ComposerEditor` 与 `PromptInput` 并存，flag `composer.richText` 控制；回滚 = flag 关闭退回 textarea 路径（保留一个批次）。ProseMirror 依赖已在 `package.json`（无需新增/移除）。

## 验收标准

### 状态机不变量
- **序列化契约恒定**：任意富文本状态 → 发送给 agent 的字符串必须可逆推（标题/列表/链接/代码块的 markdown 形式确定且稳定）；空文档 ⟺ 空字符串 ⟺ 发送按钮禁用
- mention pill 是原子节点：光标不可进入内部；删除一次移除整个 pill；pill 内容恒等于其来源 id（文件路径 / 技能名）
- slash 弹层开启 ⟺ 文档首个 block 以 `/` 开头且无空格；选择命令后弹层关闭且文本被替换为 `/<cmd> `
- 格式状态与选区一致（选区跨标题与正文时工具条状态有确定规则，不得抖动）
- 草稿与 threadId 一一对应；切换 tab 后草稿不串、不丢

### 负向场景
- 粘贴超大文本（>100KB）/ 含 NUL 或控制字符 / RTF 或 HTML 富格式 → 有上限与清洗，不卡死不崩
- 粘贴含 `<script>` 的 HTML → 必须以纯文本插入，不得执行（XSS）
- mention 无匹配、技能加载失败、`x.ai/commands/list` 失败 → 各自空态/错误态，且**不阻断手动输入**（可直接敲完整命令）
- 链接校验：`javascript:`、`file:`、非 http(s) → `composer.formatToolbar.invalidLink`，拒绝应用
- 语言检测无结果 → `composer.codeBlock.noLanguagesFound`
- IME 中文输入过程中按 Enter → 不得误发送（composition 事件必须处理）
- 图片粘贴在不支持图片的模型下 → `composer.imageInputsUnsupported`（文案已存在，需接线）

### 并发 / 崩溃 / 恢复
- streaming 中输入草稿 + Tab 排队：排队内容与草稿互不污染；turn 结束后队列按序 flush
- 输入过程中切换 tab / agent 断线重连 → 草稿保留，编辑器不丢焦点内容
- 渲染进程崩溃重载 → 草稿从 thread scope 持久化恢复（明确策略：恢复或丢弃，二者之一并测试）
- 快速连续格式切换（bold×20、list 嵌套）无 schema 损坏（用随机操作序列 + 不变式校验）

### 外部副作用检查
- mention 文件搜索不得读取会话 cwd 之外的路径（路径穿越断言）
- 编辑器不得直接写文件（Apply/写盘走 agent）
- 粘贴的图片只进入内存/临时区，发送前不落盘到项目目录
- 富文本 HTML 不得作为 `dangerouslySetInnerHTML` 渲染（markdown 渲染路径需经 sanitize）

### Parity 勾选项
- [ ] E1 ProseMirror + 格式工具条（11 条文案）+ rich link popover（12 条）
- [ ] E2 mention pill + 技能来源分类（9 条）
- [ ] E3 slash 对话框（5 条）+ 命令来源改 `x.ai/commands/list`（A6）
- [ ] E4 代码块 + 语言选择器（12 条）
- [ ] 死代码清零：`ComposerEditor.tsx` 接线、`MentionComplete.tsx` 删除、`src/data/slashCommands.ts` 移除
