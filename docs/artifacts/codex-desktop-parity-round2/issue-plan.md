# Codex 桌面端 1:1 复刻第二轮 — Epic & Issue 拆分方案
生成日期：2026-09-18
配套差距分析：./gap-analysis.md
状态：已授权提交 GitHub

## 16 张 Issue 全文

---

### ISS-069 [EPIC]: Codex 桌面端 1:1 复刻第二轮 — 真实化 + 质量基座 + 行为对齐
标签：enhancement

**背景**：第一轮（ISS-001~068，#49~#116）完成交互外观对齐，但存在"UI 先行、后端空壳"模式（认证硬编码、updater 返回 null、ACP `fs/read_text_file` 返回空串、`open_session_window` 空实现、终端无真实 PTY）。本轮消灭空壳，达到行为级 1:1。差距分析全文：`docs/artifacts/codex-desktop-parity-round2/gap-analysis.md`。

**目标**：能力对照表 18 域中 🟡/❌ 全部清零或显式降级。
**范围**：ISS-070~085。
**非目标**：Codex 云任务/hosted apps（OpenAI 专有服务）；TUI 与 Rust agent 内核重写；zh-CN 本地化（已超出 Codex，保留现状）。
**依赖**：无。
**回滚**：Epic 按 Wave 独立交付，任一 Wave 失败不阻断已交付 Wave。
**验收标准**：
- ① gap-analysis 对照表 18 域复评，每项 ✅/❌ 有据
- ② 每张子 Issue 验收证据齐备
- ③ REVIEW_DEBT（goal-state.json）清零
- ④ 全链路 smoke：新建线程→执行→审批→diff→commit→重启恢复

依赖顺序：
- Wave 0 质量基座：ISS-070（测试基座，阻塞全部后续）→ ISS-072（Tauri 退役）→ ISS-071（Electron CI，依赖 072）
- Wave 1 真实化：ISS-073 认证 / ISS-074 ACP 文件桥 / ISS-075 PTY 终端 / ISS-076 自动更新（依赖 071）/ ISS-077 多窗口 detach
- Wave 2 行为对齐：ISS-078 Slash 命令面 / ISS-079 线程管理 / ISS-080 Review 闭环 / ISS-081 Usage UI
- Wave 3 增强（P3）：ISS-082 /voice 实时语音 / ISS-083 /import
- Wave 4 收口：ISS-084 REVIEW_DEBT 偿还 / ISS-085 1:1 体验验收（依赖全部前置）

---

### ISS-070: 前端测试基座 — Vitest + 状态机/组件测试 + CI 接线
标签：enhancement, priority/P1

**目标**：建立前端回归保护网，`npm test` 可运行并接入 CI。当前前端 0 个测试文件，是全部后续改动的最大风险。
**范围**：Vitest + Testing Library 配置；`stores/sessionStore.ts`（584 行）与 `permissionsStore.ts` 状态机测试；Composer/ApprovalCard/ThreadTree 关键组件测试；`electron/` 纯函数（mcp-config.ts 段编辑、session-history.ts 解析）单测；`npm test` script 与 CI 接线。
**非目标**：不追求覆盖率数字指标；不改业务逻辑——测试暴露的 bug 单开 Issue。
**依赖**：无（Wave 0 第一张，阻塞 Wave 1/2 全部）。
**回滚**：纯新增，删除测试目录即回滚。
**验收标准**：
- 状态机不变量：会话状态机（idle→running→waiting→idle）合法转换全集通过，非法转换被拒绝
- 负向场景：ACP 断连/畸形事件/空 sessions 目录不崩溃
- 并发/崩溃/恢复：store 并发事件乱序到达不产生幻影 tab
- 外部副作用：测试零文件系统副作用（全部 tmpdir/mock）

---

### ISS-071: Electron CI + 打包发布管线
标签：enhancement, priority/P1

**目标**：CI 构建 Electron 三平台产物（mac dmg/zip、win nsis、linux AppImage）；PR 级跑 `npm run build` + `npm test`，tag 级出包。当前 `.github/workflows/release.yml` 只构建 Tauri 产物，Electron 无 CI。
**范围**：新 workflow（electron.yml）；`electron:pack` 接入；产物上传 artifact；保留 workflow_dispatch。
**非目标**：签名/notarize（归入 ISS-076 一并决策）；不删 Tauri CI（由 ISS-072 处理）。
**依赖**：ISS-072。
**回滚**：workflow 独立文件，revert 即可。
**验收标准**：
- 状态机不变量：CI 状态机（push→build→test→pack）任一环节失败即红，不允许跳步绿
- 负向场景：Rust agent 二进制缺失时打包显式失败，而非产出空壳包
- 并发：矩阵三平台并发构建互不污染缓存
- 外部副作用：仅上传 artifact，不创建任何外部 Release（发布动作留在 ISS-076）

---

### ISS-072: Tauri 壳退役 ADR + 残留清理
标签：enhancement, priority/P2

**目标**：ADR 决策 src-tauri 去留；清理双壳漂移源。当前 Electron 为活跃壳（`src/lib/tauri.ts:1-7` 注释确认），但 src-tauri/ 完整保留、CI 仍在构建 Tauri、`vite.config.ts` 残留 `TAURI_DEV_HOST`、`scripts/test-tauri.sh` 硬编码他人机器路径 `/Users/ailabuser1/...`。
**范围**：ADR（含回退路径）；按决策删除或归档 `src-tauri/`、package.json tauri 依赖、vite 残留、test-tauri.sh、release.yml Tauri 构建步骤。
**非目标**：不动 Rust workspace `crates/`（agent 运行时不属桌面壳）。
**依赖**：无（阻塞 ISS-071）。
**回滚**：ADR 含 git 恢复路径；删除独立成 commit 可 revert。
**验收标准**：
- 状态机不变量：仓库任一时刻只有单一活跃壳（package.json main 与 CI 目标一致）
- 负向场景：清理后 `npm run build` / `electron:dev` / CI 全绿
- 外部副作用：确认无外部文档/脚本引用 src-tauri 路径

---

### ISS-073: 真实认证流 — 替换硬编码 check_auth_status
标签：enhancement, priority/P1

**目标**：登录/登出/过期/刷新全链路真实化；未认证进入 Login 页。当前 `electron/main.ts` 的 `check_auth_status` 返回硬编码 `{authenticated:true, username:"dev"}`。
**范围**：① 技术探针：xAI/Grok OAuth 或 device-code 端点可用性（失败则降级为 API key 首屏验证）② 真实登录流实现 ③ token 安全存储（macOS Keychain 写穿透补齐，acp-session.ts:50 的遗留项）④ 登出清态。
**非目标**：企业 OIDC、多账户切换（后续）。
**依赖**：外部端点探针；ISS-070。
**回滚**：feature flag `GROK_DESKTOP_AUTH=off` 回落 dev 模式。
**验收标准**：
- 状态机不变量：认证状态机（unknown→authed⇄expired→anon）无悬挂中间态
- 负向场景：错误凭据/网络断开/token 过期中途 → 明确错误态不卡死
- 崩溃恢复：登录中途强杀 app，重启后状态一致（无半登录）
- 外部副作用：登出必须撤销本地 token，不残留 api_keys.json 明文

---

### ISS-074: ACP 文件桥补全 — fs/read_text_file 真实化 + 写审计
标签：enhancement, bug, priority/P1

**目标**：修复功能性缺陷——当前 `electron/acp-session.ts` 的 `fs/read_text_file` 返回空字符串，agent 读宿主文件拿到空串，直接毒害 agent 行为。写操作补边界与审计。
**范围**：read 真实实现（会话 cwd 根目录白名单 + 大小上限 + 二进制拒绝）；`fs/write_text_file` 补审计日志；路径逃逸（`..`/symlink）防御；IPC 参数校验。
**非目标**：任意路径读写；文件 watch/实时同步。
**依赖**：ISS-070；与 ISS-075 同改 acp-session.ts 需协调。
**回滚**：配置开关回落"拒绝读写"（安全默认）。
**验收标准**：
- 状态机不变量：文件桥权限与会话 cwd 绑定，切换项目即重估
- 负向场景：越界路径/超大文件/symlink 逃逸/非法 UTF-8 → 结构化拒绝
- 并发：读写并发 + 文件被外部修改 → 不崩溃、结果可解释
- 外部副作用：写操作产生审计记录（时间/路径/会话 id）；不越界写会话根外

---

### ISS-075: 真实 PTY 终端 — TerminalView 接持续会话
标签：enhancement, priority/P2

**目标**：Terminal tab 成为真实交互式 PTY（ssh/vim/top 可用）。当前后端 `run_command` 是一次性非交互 `/bin/bash -lc`（60s/2MB 上限），xterm.js 前端无持续会话后端。
**范围**：① 方案选型 ADR：`node-pty`（Electron 主流）vs Rust 侧 PTY 经 ACP 流式扩展 ② xterm.js 接线（addon-fit/web-links 依赖已有）③ resize/滚动缓冲/会话生命周期 ④ 与 agent 后台终端的关系定义。
**非目标**：Windows ConPTY 尽力而为；多终端 tab 可降级。
**依赖**：ISS-070、ISS-074。
**回滚**：Terminal tab 隐藏开关，回落 run_command 只读输出。
**验收标准**：
- 状态机不变量：PTY 生命周期（spawn→running→exit→disposed）无僵尸进程
- 负向场景：shell 崩溃/非法 resize/二进制输出 → 终端存活或明确退出态
- 并发/崩溃恢复：多 PTY 并发 + app 退出 → 子进程全部回收（`ps` 验证无泄漏）
- 外部副作用：PTY 不继承超出会话 cwd 的隐式权限；kill 信号只作用于自身进程组

---

### ISS-076: 自动更新真实化 — updater_check 去空实现
标签：enhancement, priority/P2

**目标**：检查/下载/安装/回滚全链路。当前 `updater_check` 返回 null（注释 "no update server configured"）。ISS-054 已交付更新 UI，本卡补后端。
**范围**：feed 选型（GitHub Releases 零基础设施方案 vs 自建 update server）；electron-updater 接入；版本比较与降级保护；已有 UI 接真实数据。
**非目标**：增量更新；企业内网分发。
**依赖**：ISS-071（发布通道）。
**回滚**：updater_check 回落 null + UI 显示"手动下载"（现状行为）。
**验收标准**：
- 状态机不变量：更新状态机（idle→checking→available→downloading→ready→relaunch）断电可恢复
- 负向场景：无网络/坏包/降级版本 → 拒绝并保留现版本
- 崩溃恢复：下载中途强杀 → 重启后不装载半下载包
- 外部副作用：仅签名校验通过的包可安装；更新不触碰 ~/.grok 用户数据

---

### ISS-077: 多窗口 detach 补全 — open_session_window 实现
标签：enhancement, priority/P3

**目标**：会话可 detach 到独立窗口，主窗与 detached 窗状态一致。当前前端 `?session=<id>` 分支存在（App.tsx:79-88），但 `open_session_window` 是空实现。补全已关闭的 #52（ISS-004）的空壳部分。
**范围**：`open_session_window` 真实实现（新 BrowserWindow + `?session=` 路由）；双窗 ACP 会话归属规则（独占 or 只读镜像）；关窗资源回收。
**非目标**：多屏布局记忆；>2 窗口编排。
**依赖**：ISS-070、ISS-074。
**回滚**：入口按钮隐藏，回落单窗口。
**验收标准**：
- 状态机不变量：同一会话任意时刻仅一个可写窗口（写锁不变量）
- 负向场景：detach 已删除的会话 → 明确错误页不白屏
- 并发：双窗并发发消息 → 仅持有写锁的窗口生效，另一窗只读跟随
- 外部副作用：关 detached 窗不杀 agent 会话；关主窗明确处理 detached 子窗

---

### ISS-078: Slash 命令面对齐 Codex
标签：enhancement, priority/P2

**目标**：命令面从现状（`src/data/slashCommands.ts` 仅 36 行）扩充到 Codex 官方已核实命令集。
**范围**：`/diff /review /fork /rename /usage /clear /new /worktree /copy /cd /pwd /goal /recap` 等逐项映射（依据 Codex releases v0.149~v0.155 核实清单）；无后端能力的命令明确降级或隐藏；补全排序/分组/hint 对齐。
**非目标**：`/voice`（ISS-082）、`/import`（ISS-083）、`/ide`（无对应宿主）。
**依赖**：ISS-074（/diff 依赖文件桥）、ISS-079（/fork /rename）。
**回滚**：命令注册表按条目开关。
**验收标准**：
- 状态机不变量：命令执行不改变会话状态机合法性（/clear 后不可残留 running 幻觉）
- 负向场景：未知命令/参数缺失/运行中执行冲突命令 → 明确提示
- 并发：流式输出与命令输出交错不串台
- 外部副作用：/diff /commit 类命令的 git 副作用限于当前 worktree

---

### ISS-079: 线程管理操作补全 — rename / archive / fork / 写冲突
标签：enhancement, priority/P2

**目标**：对齐 Codex agents overview（v0.149/v0.155）的线程操作面。当前已有 delete 与三态指示，缺 rename/archive/fork。
**范围**：rename（持久化到 summary.json）；archive/unarchive（列表过滤语义）；fork（复制转录为新会话）；active-writer 冲突处理（他端写入中 → 只读转录 + retry，对齐 Codex #43253 行为）。
**非目标**：跨设备同步；线程搜索算法重构。
**依赖**：ISS-070、ISS-074。
**回滚**：操作入口隐藏，只读列表不受影响。
**验收标准**：
- 状态机不变量：archive 不改变磁盘转录；fork 产生新 id 且与源会话互写隔离
- 负向场景：rename 重名/特殊字符/并发改名 → 最后写胜出且 UI 一致
- 并发：fork 进行中源会话仍在流式 → fork 点确定性（快照语义）
- 外部副作用：delete（已有）与 archive 严格区分；fork 不复制审批授权态

---

### ISS-080: Review 工作流深化 — /diff + 评论循环 + PR helpers
标签：enhancement, priority/P2

**目标**：从"看 diff"升级为 Codex 式 review 闭环。在 #116（ISS-067 review 队列）基础上深化。
**范围**：workspace-aware `/diff`（turn 级/累计级，对齐 Codex #21001/#39625）；diff 评论 → request changes → agent 修订循环；PR helpers（commit/push/open PR 入口，复用已有 git IPC + `gh` CLI）。
**非目标**：内建 GitHub 评论同步（交给 gh）；Guardian 自动审批（OpenAI 专有）。
**依赖**：ISS-074、ISS-078。
**回滚**：Review tab 回落只读 diff（现状）。
**验收标准**：
- 状态机不变量：review 循环（clean→modified→reviewing→changes-requested→modified）无死锁
- 负向场景：空 diff/二进制 diff/合并冲突态 → 明确展示
- 并发：review 中 agent 继续改文件 → diff 视图版本化不撕裂
- 外部副作用：commit/push 必须显式用户确认（二次确认 + 展示将执行的命令），不静默推远端

---

### ISS-081: Usage & limits UI — /usage + 用量计量 + 限流 banner
标签：enhancement, priority/P3

**目标**：对齐 Codex `/usage` 与 rate-limit banner 行为（#41742/#42142）。
**范围**：token 用量聚合（sessionStore 已有 tokenUsage）；/usage 面板；限流/配额 banner（含重试时间）；ACP `usage_update` 事件探针与数据口径确认。
**非目标**：计费/套餐管理（xAI 侧能力待探针）。
**依赖**：ISS-078（/usage 命令）。
**回滚**：面板隐藏，保留 composer 内 token 显示。
**验收标准**：
- 状态机不变量：用量计数单调递增，compaction 后口径一致
- 负向场景：usage 事件缺失/乱序 → UI 降级为"未知"而非显示错数
- 并发：多线程并发用量 → 按会话隔离展示
- 外部副作用：无（纯展示）

---

### ISS-082: /voice 实时语音（实验性）— 听写升级为对话
标签：enhancement, priority/P3

**目标**：从 Ctrl+M hold-to-talk 听写升级为 Codex v0.155 式实时语音对话（WebRTC、live transcript、mute 快捷键、录音指示）。
**范围**：先做能力探针（Grok 侧 realtime 端点/agent realtime 能力），再定实施或明确降级保留现状。
**非目标**：视频；电话级降噪。
**依赖**：外部能力探针；ISS-073。
**回滚**：保留现有 hold-to-talk。
**验收标准**：
- 状态机不变量：语音会话状态机（idle→connecting→live⇄muted→ended）
- 负向场景：无麦克风权限/断网 → 明确降级回听写
- 并发：语音与文本输入并发不抢 composer 焦点
- 外部副作用：录音不落盘（除显式 transcript）

---

### ISS-083: /import from Claude Code — 选择性导入
标签：enhancement, priority/P3

**目标**：对齐 Codex `/import`（#27070/#27071）：选择性导入 setup、项目配置、最近会话。
**范围**：探测 `~/.claude` 数据；导入预览；冲突处理。
**非目标**：持续同步；其他工具（cursor 等）导入。
**依赖**：ISS-078、ISS-074。
**回滚**：命令隐藏。
**验收标准**：
- 状态机不变量：导入幂等（重复导入不产生重复项）
- 负向场景：源数据损坏/版本不符 → 部分导入 + 明确报告
- 并发：导入中目标会话被使用 → 冲突检测
- 外部副作用：只读源目录；写入前预览清单并需用户确认

---

### ISS-084: REVIEW_DEBT 偿还 — PR #117~127 独立评审
标签：enhancement, priority/P2

**目标**：goal-state.json 记录上轮 12 个 PR（#117~127）未经独立 reviewer 即合并（ccb 通道不可用）。本卡对这 12 个合并点做独立评审。
**范围**：逐 PR diff 评审（聚焦安全/状态机/资源泄漏）；发现项转新 Issue。
**非目标**：重写已合并功能（除非 Critical）。
**依赖**：ISS-070（用测试网验证发现）。
**回滚**：N/A（纯评审）。
**验收标准**：每 PR 一份评审结论（pass/修复项/严重级）；Critical 项当轮修复或显式风险接受记录。

---

### ISS-085: 1:1 体验验收 — UXR walkthrough + 证据包（收口）
标签：enhancement, priority/P1

**目标**：对照 Codex 行为清单做端到端走查，产出证据包，Epic 收口。
**范围**：gap-analysis.md 的 18 域对照表逐项走查（截图/录屏）；关键路径性能预算（冷启动、线程切换、大转录滚动）；zh-CN 回归；负向路径演示（断网/崩溃恢复）。
**非目标**：像素级复刻（行为与信息架构 1:1，视觉以已对齐调色板为准）。
**依赖**：ISS-070~081。
**回滚**：N/A（验收关卡）。
**验收标准**：① 对照表每项 ✅/❌ 有据 ② 崩溃恢复演示（杀进程→重启→线程无损恢复）③ 全链路 smoke 通过 ④ 证据包落 docs/artifacts/
