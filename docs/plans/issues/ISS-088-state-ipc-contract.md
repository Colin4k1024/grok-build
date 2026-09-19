> Epic: #128 (ISS-069) · 批次: B1 · 标签: `parity-foundation` `architecture` `priority/P1` `frontend` `app-shell`
> 规格来源: 差距文档 §7.3（布局状态机实物逆向）；设计文档 §2(G4,G5) §6(AD-2,AD-3,AD-4) §7.1

## 目标

建立承载 Codex 交互的三块地基：**工作区布局状态机**、**per-thread scoped 状态**、**类型化 IPC 契约 + 多窗口广播**。没有它们，tab strip / bottom panel / detached window / 每线程面板状态都无法实现。

## 范围

1. `shared/contract.ts`（前后端共用单一真源）：
   - `type Channels = { 'session/create': {req:…; res:…}; … }`，`invoke<K extends keyof Channels>(ch, req): Promise<Res<K>>`
   - `type Events = { 'acp/event': …; 'layout/changed': …; 'sessions/changed': … }`
   - **channel 白名单**：主进程只注册白名单内 channel；preload 的通用 `invoke` 增加白名单校验（当前任意 channel 可调，见 `electron/preload.ts`）
2. `electron/ipc/register.ts`：统一注册，替换 59 个散落的 `ipcMain.handle`（`main.ts` 收敛为窗口/生命周期编排）
3. `electron/ipc/broadcast.ts`：事件广播到**所有** BrowserWindow（修复 G4：当前只 `mainWindow.webContents.send`），带窗口订阅过滤（detached window 只订自己 thread 的事件）
4. `src/state/workspaceLayout.ts`：实物逆向的布局状态机
   ```ts
   { mode:'full'|'split', contentSide:'left'|'right', focus:'main'|'right-panel',
     bottomPanelOpen:boolean, tabs:[{tabId,kind:'chat'|'content',dndId,…}], activeTabId }
   ```
   动作：`openTab / closeTab / closeOthers / closeToRight / moveTab(to:'left'|'right'|'bottom'|'chat'|'new-window') / stepLayout / toggleSidebar / toggleSidePanel / toggleBottomPanel / maximizeSidePanel / reopenClosedTab / pinTab`；持久化 = `thread-tab-route-checkpoint`
5. `src/state/threads/`：per-thread scoped store —— `Map<threadId, StoreApi<ThreadScope>>` + `useThread(threadId)`；`ThreadScope` 含 messages / draft / streaming / pendingPermissions / pendingQuestions / todos / subagents / usage / compaction / queue / panelState / reviewState / terminalBuffers / navBookmarks / findQuery
6. 迁移策略：**新旧并存 + 逐字段搬迁**（禁止大爆炸替换）。先搬 messages/draft/streaming，再 panel/review/terminal；每步保持 `tsc` 绿 + 冒烟可启动
7. `src/state/flags.ts`：feature flags（驱动命令可见性与切片灰度）
8. 单测：布局状态机 reducer 全动作覆盖；scoped store 隔离性；contract 类型往返

## 非目标

- 不实现 tab strip / bottom panel 的**视觉**（ISS-091）
- 不实现命令注册表（ISS-089）
- 不改 agent 侧（ISS-087）
- 不引入 jotai/redux 等新状态库（AD-2：沿用 zustand）
- 不动 `src-tauri/`

## 依赖

- ISS-086（vitest + CI）
- 与 ISS-087 **可并行**：两者在 `shared/contract.ts` 上先对齐类型再各自实现

## 回滚

按字段迁移 ⇒ 可逐字段回退。完整回滚 = 恢复 `src/stores/sessionStore.ts` 为唯一状态源、`main.ts` 的 59 个 handle、preload 无白名单版本。持久化 key 保持向后兼容：新 store 读旧 `localStorage["gb-session-tabs"]` 并可写回旧格式一个版本周期（保证降级不丢 tab）。

## 验收标准

### 状态机不变量
- `mode==='full'` ⟺ content tabs 不可见；`mode==='split'` ⟹ 至少一个 content tab 存在
- `bottomPanelOpen===false` ⟹ `moveTab(…,'bottom')` 必须被拒（实物规则：`if(n==='bottom'&&!bottomPanelOpen)return false`）
- `tabs.length===0` ⟹ `activeTabId===null` 且视图落 Home
- 关闭最后一个"可丢弃"tab ⟹ `split → full`；`reopenClosedTab` 恢复后布局回到关闭前
- `activeTabId` 恒 ∈ `tabs`；任何动作后不变式必须重新成立（用 property-based 断言：随机 500 步动作序列后校验全部不变式）
- **scope 隔离不变量**：对 threadA 的任何写入不得改变 threadB 的 store 引用内容（`Object.is` 级别断言）
- IPC 白名单：`invoke` 未声明 channel ⟹ reject 且主进程记日志，不产生副作用

### 负向场景
- localStorage 损坏/被清空/版本不符 → 降级为空 tabs + Home，不白屏，且**不覆盖**磁盘上的会话历史
- 持久化的 tab 指向已不存在的会话 → 走 `unrestored-thread-tab-route` 语义：标记为不可恢复并提示，而非静默丢弃
- 广播目标窗口已销毁（detached window 关闭竞态）→ 发送必须被吞掉且不抛
- 渲染层调用白名单外 channel → 明确错误
- 迁移中途（部分字段在新 store、部分在旧 store）读取 → 有确定的优先级规则，不出现"消息重复"或"消息丢失"

### 并发 / 崩溃 / 恢复
- 主窗 + detached window 同时打开同一 thread：两侧状态一致；一侧改布局另一侧按订阅规则更新；无重复事件导致的重复消息
- 渲染进程崩溃重启（`webContents` reload）：布局与 tabs 从持久化恢复；per-thread scope 重建且不重复计入历史消息
- 主进程重启（app 重启）：布局（mode/contentSide/bottomPanelOpen/side panel tabs/activeTab）+ tabs 完整恢复
- 快速连续动作（100 次 open/close/move 混合，含拖拽中途取消）无竞态、无幽灵 tab、无 activeTabId 悬空
- 两个 thread 同时 streaming 时切换 activeTab：流不中断、事件不错投

### 外部副作用检查
- 持久化只写 `localStorage`（渲染层）与既有会话目录（主进程），不新增写盘位置
- 广播不携带敏感内容（API key、文件正文）；detached window 只收到其订阅 thread 的事件（断言：另一 thread 的 prompt 文本不出现在该窗口的 IPC 流量中）
- 白名单外的能力（如任意路径读写）不得因引入通用 contract 而意外暴露
- 不改变 `~/.grok/config.toml` 的写入方式（仍走 ISS-087 的 ext / 现有 mcp-config 外科手术式编辑）

### Parity 勾选项
- [ ] G4 关闭（多窗口广播）
- [ ] G5 关闭（per-thread scoped store）
- [ ] §7.3 布局状态机字段与动作全覆盖
- [ ] `thread-tab-route-checkpoint` / `unrestored-thread-tab-route` 语义落地
- [ ] IPC channel 白名单生效（安全项 R9 缓解）
