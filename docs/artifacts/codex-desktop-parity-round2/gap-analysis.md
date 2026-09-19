# Codex 桌面端 1:1 复刻 — 第二轮差距分析

**调研日期**：2026-09-18
**仓库**：`Colin4k1024/grok-build` @ `b88435ac`
**性质**：只读调研，未修改任何业务代码
**目标来源**：OpenAI Codex 官方 release notes（v0.115.0 ~ v0.155.0，共 400 版，canonical changelog）+ 仓库内 `docs/design/desktop-codex-alignment.md`、`ISSUES.md`

---

## 1. 当前事实（均有文件/行号证据）

### 1.1 架构事实

| 事实 | 证据 |
|---|---|
| 活跃桌面壳 = **Electron** | `package.json` main → `dist-electron/main.cjs`；`src/lib/tauri.ts:1-7` 注释确认已迁移 Electron |
| Tauri 壳源码保留但前端不走它 | `src-tauri/`（main.rs 6028B、acp_bridge.rs 26387B、8 个 commands 模块）仍在；`vite.config.ts` 残留 `TAURI_DEV_HOST` |
| Agent 桥 = ACP over stdio | `electron/acp-session.ts:625行`，spawn `xai-grok-pager agent stdio` |
| 前端栈 | React 18 + Zustand + ProseMirror + xterm.js + react-diff-viewer-continued + Tailwind |
| 持久化布局 | `~/.grok/sessions/<cwd>/<id>/{summary.json,updates.jsonl}`、`~/.grok/config.toml`、`projects.json`、`api_keys.json`、`default_models.json` |
| 规模 | 59 个组件 / 7 页面 / 9 hooks / 2 stores；`electron/main.ts` 706 行 40+ IPC 通道 |

### 1.2 能力事实（上一轮 EPIC ISS-057 已交付的"交互外观"）

三栏 App Shell、Codex 风格 sidebar（Pinned/Projects/Triage、三态指示）、Home=New-chat、Composer 四选择器（Approval/Branch/ModelEffort/WorkMode）、ProseMirror + @mention + slash + 图片粘贴 + Tab 排队、Codex 气泡/代码块/Diff 调色、审批卡+提问卡、RightPanel（Files/Review/Terminal/Side chat + subagents/todo/context/mcp）、12-tab 设置、Command Palette、⌘G 全局搜索、快捷键注册表、通知+Dock badge、自启动、线程恢复（replay）、zh-CN 本地化、Codex 配色映射。

### 1.3 质量事实

| 事实 | 证据 |
|---|---|
| **前端 0 个测试文件** | 无 `*.test.*` / `*.spec.*` / `__tests__/`；仅 `scripts/test-mcp-config.mjs`、`test-session-resume.mjs` 两个手工脚本 |
| **CI 只构建 Tauri** | `.github/workflows/release.yml` 用 `npx tauri build`；Electron 无 CI、无打包发布管线 |
| 构建产物过期 | `dist/`（09-17）与 `dist-electron/`（09-18 20:13）均早于最新源码（09-18 21:30） |
| `scripts/test-tauri.sh` 硬编码他人机器路径 | `/Users/ailabuser1/Desktop/gitcode/grok-build` |
| **REVIEW_DEBT 未偿还** | `goal-state.json`：PR #117-127 全部未经独立 reviewer，合并依据仅为 build green |
| `ISSUES.md` ISS-044 描述与现状不符 | 称 `commands={[]}`，实际 Command Palette 已有注册命令 — 文档漂移 |

### 1.4 假实现 / 空壳事实（关键）

| 缺口 | 证据 |
|---|---|
| **认证是假实现** | `electron/main.ts` `check_auth_status` 返回硬编码 `{authenticated:true, username:"dev"}` |
| **更新机制为空** | `updater_check` 返回 null（注释 "no update server configured"） |
| **ACP 文件读桥返回空内容** | `electron/acp-session.ts` `fs/read_text_file` 返回空字符串 — agent 读文件拿到空串，**功能性缺陷** |
| **多窗口 detach 后端缺失** | `open_session_window` 空实现 `ok(null)`；前端 `?session=` 分支存在但无后端支撑 |
| **终端无真实 PTY** | `run_command` = 一次性非交互 `/bin/bash -lc`（60s/2MB 上限）；xterm.js 前端无持续会话后端 |
| Keychain 仅读穿透 | `acp-session.ts:50` 注释 "keychain parity can come later" |
| ISS-004/054/030-032 等"已关闭"Issue 存在同类模式 | UI 完成 + 后端空壳（见 §4 系统性模式） |

---

## 2. 目标对齐表（Codex 目标 vs 本仓库现状）

图例：✅ 已对齐　🟡 部分（UI 有/后端空 或 深度不足）　❌ 缺失　⚪ 非目标

| # | 能力域 | Codex 目标（官方 release 核实） | 本仓库现状 | 判定 |
|---|---|---|---|---|
| 1 | Worktree 隔离 | managed worktree 创建/浏览/恢复/ownership/确认删除（v0.154/155） | worktree add/remove IPC + onboarding banner + 环境下拉 | 🟡 生命周期深度不足 |
| 2 | 线程管理 | agents overview（搜索/重命名/停止/archive/hide/delete）、resume/fork、active-writer 只读冲突 | ThreadTree 三态 + resume + delete；**rename/fork/archive 未确认** | 🟡 |
| 3 | Composer | model+effort（max/ultra 档）、approval mode、@任务 mention、slash 全命令面、图片、queue 编辑 | 四选择器 + @文件 + slash（`slashCommands.ts` 仅 36 行，命令面小）+ 图片 + Tab 排队 | 🟡 命令面/档位不足 |
| 4 | 语音 | `/voice` 实验性实时语音对话（WebRTC、live transcript、mute） | Ctrl+M hold-to-talk 听写 | 🟡 代差（听写≠对话） |
| 5 | Diff/Review | workspace-aware `/diff`、`/review`、PR helpers（commit/push/open PR） | DiffViewer + Review tab + git_commit IPC；**PR 创建/评论循环缺失** | 🟡 |
| 6 | 终端 | background terminal PTY API、输入预览 | xterm.js UI + 一次性 run_command，**无 PTY** | ❌ 后端缺失 |
| 7 | 自动化 | 本地自动化闸门、定时提醒 | AutomationsPage + lib/automation.ts；调度后端未确认 | 🟡 |
| 8 | 认证 | ChatGPT/OIDC 登录、token 刷新、切换失效 | **硬编码假实现** | ❌ |
| 9 | 自动更新 | daemon update schedules、doctor 诊断 | **updater_check 返回 null** | ❌ |
| 10 | 多窗口 | detached window | 前端 URL 分支有；**open_session_window 空实现** | 🟡 |
| 11 | ACP 文件桥 | agent 读写宿主文件 | read 返回空串、write 无审计 | ❌ 功能缺陷 |
| 12 | Usage 显示 | `/usage`、rate-limit banner、提前告警 | tokenUsage 存于 store；UI 深度未确认 | 🟡 |
| 13 | Usage 导入 | `/import` from Claude Code | 无 | ❌ |
| 14 | Vim 模式 | undo/redo、motions、搜索 | 无 | ❌（建议 P3） |
| 15 | i18n | Codex 无 i18n | zh-CN 全量本地化 | ⚪ 超出目标（保留） |
| 16 | 云任务 | Noise 加密 remote executor、hosted apps | 无 | ⚪ **非目标**（OpenAI 专有服务；交互体验复刻不绑定其云） |
| 17 | 通知/Dock | 应用内通知确认；OS 通知/Dock 官方未证实 | OS 通知 + Dock badge 已实现 | ✅（超前） |
| 18 | 快捷键 | 可配置快捷键、footer hints | 注册表驱动快捷键 + 速查表 | ✅ |

**判定汇总**：✅ 2　🟡 8　❌ 6（终端PTY、认证、更新、文件桥、/import、Vim）　⚪ 2

---

## 3. 缺口归纳与风险

### 3.1 缺口按性质分三类

**A 类 — 真实化缺口（最高优先）**：认证、更新、ACP 文件桥、PTY、detach 窗口。特征：UI 声称能力存在，后端为空/假。用户可感知的功能性缺陷（尤其 fs/read_text_file 返回空串会直接毒害 agent 行为）。

**B 类 — 质量基座缺口**：前端 0 测试、Electron 无 CI、双壳并存、构建产物过期、评审债。特征：不直接可见，但使任何后续改动无回归保护、无发布通道。

**C 类 — 行为深度缺口**：slash 命令面、线程 rename/fork/archive、Review 循环、usage 显示、语音代差、/import。特征：与 Codex 行为级 1:1 的距离。

### 3.2 系统性模式（必须写入 Epic 背景）

> **"UI 先行、后端空壳"模式**：ISSUES.md 56 项 + ISS-057 EPIC 12 项全部 CLOSED，但其中若干项（ISS-004 detach、ISS-054 更新、ISS-030~032 终端、ISS-046/047 认证）交付物停留在 UI 层。这与仓库自身 `docs/artifacts/2026-08-03-capability-productionization-plan.md` 的教训一致："源码存在 ≠ 可用能力"。本轮所有 Issue 的验收标准必须要求**端到端可验证证据**，禁止仅以 UI 存在作为完成依据。

### 3.3 风险登记

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| R1 无测试网下重构 | 高 | 0 前端测试，Wave 1 真实化改动必然破坏现有行为且不可知 | Wave 0 测试基座先行，是全部后续 Issue 的硬依赖 |
| R2 双壳配置漂移 | 中 | Tauri/Electron 并存，CI 还在构建错误目标 | ISS-072 退役决策先行 |
| R3 ACP 协议能力边界 | 高 | PTY、usage、voice、fork 可能需要 `xai-grok-pager` agent 侧新增 ACP 方法，跨层依赖 | 每张 Wave1/2 Issue 的依赖字段显式标注；先探针后实施 |
| R4 认证方案涉外部服务 | 中 | 真实登录需 xAI/Grok 服务端 OAuth 端点可用性确认 | ISS-073 先做技术探针，失败则降级为 API-key 首屏 |
| R5 更新机制涉签名资产 | 中 | macOS 签名/notarize + 更新服务器或 GitHub Releases feed | ISS-076 允许 GitHub Releases 作为零基础设施方案 |
| R6 评审债复利 | 中 | 上轮 12 PR 未评审，本轮在其上叠加 | ISS-084 独立评审，且本轮每张 PR 强制 review gate |
| R7 Electron 安全面 | 中 | `sandbox:false` + 40 IPC 通道 + fs 桥 = 攻击面 | ISS-074 含权限边界审计；全部 IPC 参数校验 |

---

## 4. 关键依赖

1. **测试基座（ISS-070）是所有后续 Issue 的硬依赖** — 无回归网不做真实化。
2. **Tauri 退役（ISS-072）阻塞 Electron CI（ISS-071）** — CI 目标必须先收敛。
3. **ACP agent 侧能力探针** — `xai-grok-pager agent stdio` 当前支持的方法集决定 PTY/usage/voice/fork 的实现路径（纯 Electron 侧 vs 需 Rust 侧配合）。
4. **xAI 认证端点可用性**（ISS-073 前置探针）。
5. **更新基础设施**（ISS-076：更新服务器 vs GitHub Releases 决策）。
6. **已关闭 Issue 的"空壳复核"**（ISS-004/054/030~032/046/047）— 新 Issue 与它们的关系是"补全"而非"重复"。

---

## 5. 结论

上一轮完成了**交互外观对齐**（形）；本轮的核心命题是**能力真实化 + 质量基座 + 行为级对齐**（神）。建议按 Wave 0 → 1 → 2 → 3 的依赖顺序执行，详见 `issue-plan.md`。
