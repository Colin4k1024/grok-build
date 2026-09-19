# Issue 草稿与提交前重复检查报告

> 生成：2026-09-18 · 状态：**草稿，未提交 GitHub**（创建 Issue/Epic 属外部写操作，需明确授权）
> 配套设计：`../2026-09-18-codex-desktop-parity-design.md`
> 差距分析：`../../design/codex-desktop-parity-gap.md`

---

## 1. 提交前重复检查（必読 — 发现严重冲突）

### 1.1 结论

**仓库已有 33 个 OPEN issue，编号与本草稿完全冲突，且其中 16 个是重复创建的孤儿副本。**

| 事实 | 证据 |
|---|---|
| 已存在 OPEN Epic **#128 = ISS-069**「Codex 桌面端 1:1 复刻第二轮 — 真实化 + 质量基座 + 行为对齐」 | `gh issue view 128` |
| 已存在 OPEN 子 issue **ISS-070 … ISS-085**（16 张） | `gh issue list --state open` |
| 这 16 张**被创建了两遍**：#129–#144（本地时间 22:57–22:58）与 #145–#160（23:07–23:08）标题、正文近乎逐字相同（仅 Epic 引用行位置不同） | `diff <(gh issue view 129 -q .body) <(gh issue view 145 -q .body)` → 3 行差异 |
| Epic #128 的「子任务」清单指向 **#145–#160** ⇒ **#129–#144 是 16 个孤儿重复** | `gh issue view 128` 末尾 checkbox 列表 |
| 创建者 `Colin4k1024`，创建时间 2026-09-18 14:54–15:08 UTC（= 本地 22:54–23:08），即**本次会话进行期间** | `gh issue list --json createdAt,author` |
| 该并行会话的产物在本工作区：`docs/artifacts/codex-desktop-parity-round2/{gap-analysis.md,issue-plan.md,.write-test}`（**未提交**，`git status` 显示 `??`） | `git status --short` |
| 该并行会话**修改了 `package.json` / `package-lock.json`**（新增 vitest 2.1.9、jsdom 25、@testing-library/{react,jest-dom,user-event}）—— 与其自述"只读调研，未修改任何业务代码"不符 | `git diff package.json` |
| 其 `issue-plan.md` 自述「状态：已授权提交 GitHub」⇒ 该会话持有用户的提交授权 | `issue-plan.md:5` |

### 1.2 两套方案的规格来源不同（这是本质差异，不是重复劳动）

| | 并行会话（#128 / ISS-069~085） | 本草稿（ISS-086~105 + Epic 草案） |
|---|---|---|
| 目标来源 | **OpenAI Codex 官方 release notes** v0.115.0–v0.155.0（400 版 changelog）+ 仓库内既有文档 | **解包本机 ChatGPT.app 26.915.31029 渲染层**：5,295 个 JS 模块、4,622 条 i18n id、127 条命令注册表 |
| 对标物 | Codex 的**能力/命令面**（偏 CLI 与功能条目） | Codex **桌面端**的 UI 结构与交互体验（App Shell / Composer / Side Panel / 侧栏 IA / 快捷键） |
| 核心命题 | "消灭空壳、真实化"（认证/更新/fs 桥/PTY/detach） | 除空壳外，还包括 **架构地基**（会话拓扑、状态模型、IPC 契约、命令注册表）与 **交互复刻**（tab strip / 布局状态机 / 富文本 composer / Review 面板 99 条文案 / 侧栏 285 条文案） |
| 规模 | 16 张 issue | 20 张 issue + 1 Epic 草案 |
| 是否翻案 iss-058/063/064 | **否**（其 §1.2 把"无 tab、Home=New chat"列为已交付的对齐成果） | **是**（有实物证据，见差距文档 §1.3） |
| 本地化立场 | 非目标（"zh-CN 已超出 Codex，保留现状"） | i18n 层 + key 采用 Codex id（为可验收） |

### 1.3 并行会话 gap-analysis 中可验证的事实错误

| 其表述（§1.2 能力事实） | 实测 |
|---|---|
| "ProseMirror + @mention + slash … 已交付" | ❌ `src/components/chat/ComposerEditor.tsx`（328 行 ProseMirror）**零引用**；`MentionComplete.tsx`（144 行）**零引用**；实际 composer 是 `<textarea>`（`PromptInput.tsx:65`），mention 是内联简版 |
| "Command Palette、快捷键注册表"已对齐 | 🟡 注册表仅 11 条 vs Codex 127 条；⌘G/⌘K/⌘T 三处与实物冲突 |
| "RightPanel（Files/Review/Terminal/Side chat + subagents/todo/context/mcp）"已交付 | 🟡 容器在，但 Review 缺 99 条 `codex.review.*` 行为；subagent 数据是工具名猜测 |
| 其未发现 | ❌ **会话拓扑问题**（每 tab 一个 agent 进程 vs agent 侧 `session_registry` 支持多驻留）—— 这是最贵的一颗雷，其 Wave 1 的 PTY/detach 会在错误地基上返工 |
| 其未发现 | ❌ **事件只广播给 `mainWindow`**（`main.ts:165,180,213`）⇒ 其 ISS-077「多窗口 detach 补全」缺前置，做完也收不到事件 |
| 其未发现 | ❌ **`electron/build.sh` 的 sed 不支持子目录**（实测 `require("./agent/ext/git")` 不被改写）⇒ 任何新增目录结构会静默断链 |

### 1.4 重叠与去重判定（本草稿 20 张 vs 现有 16 张）

| 本草稿 | 与现有 OPEN issue 的关系 | 建议处置 |
|---|---|---|
| ISS-086 构建·CI·测试地基 | **重叠** #145(ISS-070 测试基座) + #146(ISS-071 Electron CI) | 合并：其 vitest+Testing Library 方案保留（依赖已装），本草稿**只补** esbuild 打包（G3）+ smoke 门 + `include` 修正 |
| ISS-087 ACP 单连接多会话 + `x.ai/*` client | **无对应**；#149(ISS-074 fs 桥) 是其子集 | 新建；#149 收窄为"fs 桥 + 写审计"并改为**依赖** ISS-087 |
| ISS-088 状态·IPC 契约·多窗口广播 | **无对应** | 新建；#152(ISS-077 detach) 改为**依赖** ISS-088 |
| ISS-089 命令注册表·快捷键·i18n | **部分重叠** #153(ISS-078 Slash 命令面) | 新建；#153 收窄为"slash 数据源接 `x.ai/commands/list`"，注册表与键位归 ISS-089 |
| ISS-090 parity 验收工具链 | **部分重叠** #160(ISS-085 UXR 验收) | 新建（工具化）；#160 保留为人工走查，消费 ISS-090 的 checklist |
| ISS-091 App Shell（tab strip/布局状态机/bottom/side panel 多 tab/detach） | **部分重叠** #152(ISS-077 detach) | 新建；#152 并入 ISS-091（detach 离不开 tab 体系与广播） |
| ISS-092 Composer 编辑器内核 | **无对应**（且被误判为已交付） | 新建 |
| ISS-093 Composer 控件行 | **部分重叠** #156(ISS-081 Usage UI) | 新建；#156 并入 ISS-093 的用量就地展示，或保留为独立 P2 |
| ISS-094 Review 面板 | **重叠** #155(ISS-080 Review 工作流深化) | 合并：以 ISS-094 为准（范围更全：99 条 `codex.review.*` + hunk-tracker + 虚拟化），#155 关闭为 duplicate 或改为子任务 |
| ISS-095 Thread 视图 | **部分重叠** #154(ISS-079 线程管理) | 新建；#154 的操作类内容移入 ISS-097 |
| ISS-096 侧栏 IA | **无对应** | 新建 |
| ISS-097 Thread Header | **重叠** #154(ISS-079 rename/archive/fork/写冲突) | 合并：以 ISS-097 为准，#154 关闭为 duplicate 或改子任务 |
| ISS-098 Terminal(pty) + Subagents | **重叠** #150(ISS-075 真实 PTY 终端) | 合并：以 ISS-098 为准（含 subagent 真值 + 后台终端），#150 改子任务 |
| ISS-099 Worktree + 本地环境 | **无对应 issue**（其 gap 表域 1 标 🟡 但未拆 issue） | 新建 |
| ISS-100 Plugins + Skills + MCP | **无对应** | 新建 |
| ISS-101 Automations | **无对应** | 新建 |
| ISS-102 Settings 重构 | **无对应** | 新建 |
| ISS-103 Onboarding + Auth + 外部导入 | **重叠** #148(ISS-073 真实认证) + #158(ISS-083 /import) | 合并：以 ISS-103 为准，#148/#158 改子任务 |
| ISS-104 平台集成 | **重叠** #151(ISS-076 自动更新) | 合并：以 ISS-104 为准，#151 改子任务 |
| ISS-105 收尾与总验收 | **重叠** #147(ISS-072 Tauri 退役) + #159(ISS-084 REVIEW_DEBT) + #160(ISS-085 UXR) | 合并；#159(REVIEW_DEBT) 与 #147(Tauri) 可**保留为独立 issue**（性质不同：流程债 / 退役决策），ISS-105 只做桩清零 + ADR + 总验收 |
| — | #157(ISS-082 /voice 实时语音) | **本草稿判为 OUT**（realtime voice 依赖平台服务）。若要保留，应明确降级为"本地听写增强"，否则建议关闭为 wontfix |
| — | #159(ISS-084 REVIEW_DEBT 偿还 PR #117~127) | 保留（流程债，与复刻正交，且 `goal-state.json` 已记录） |

**去重后净新增：13 张**（ISS-087/088/089/090/091/092/093/095/096/099/100/101/102）
**建议合并/改子任务：7 张**（086→#145+#146、094→#155、097→#154、098→#150、103→#148+#158、104→#151、105→#147+#159+#160）

### 1.5 排序冲突（技术风险，需裁决）

现有 Epic #128 的 Wave 顺序为：`Wave 0 测试基座 → Tauri 退役 → Electron CI` → `Wave 1 真实化（认证/fs 桥/PTY/更新/detach）` → `Wave 2 行为对齐`。

**问题**：Wave 1 的 PTY(#150) 与 detach(#152) 都建立在两个未修复的地基缺陷上：
- **G1 会话拓扑**：每 tab 一个 agent 进程（`acp-session.ts:222`）。PTY 会话归属、后台终端列表、subagent 跨线程可见性都要求"单连接多会话"，否则做完要重做。
- **G4 事件广播**：只发 `mainWindow`（`main.ts:165,180,213`）。detach 窗口做完也收不到 ACP 事件。

**建议**：在 #128 的 Wave 0 与 Wave 1 之间插入 **Wave A（架构地基）= ISS-087 + ISS-088**（可并行，接口先在 `shared/contract.ts` 定死），Wave 1 的 #149/#150/#152 改为依赖 Wave A。

---

## 2. 需要用户裁决的事项（全部涉及 GitHub 写操作）

| # | 事项 | 我的建议 | 风险 |
|---|---|---|---|
| Q1 | **Epic 处置**：方案 X（并入 #128，追加 Wave A/B + 20 张子 issue）还是方案 Y（新建 ISS-106 sibling Epic） | **X** —— 单一 Epic 便于统一验收与覆盖率门；#128 已有 16 张且被授权 | Y 会造成两套并行 Epic，覆盖率与依赖难统一 |
| Q2 | **16 个孤儿重复 #129–#144**：关闭为 `duplicate`？ | **关闭**，并在每个上留一行指向对应 #145–#160 | 关闭是写操作；不关会持续污染看板与搜索 |
| Q3 | **7 张重叠 issue**：关闭为 duplicate，还是保留为"子任务"并在正文加 `Superseded-by:` 行 | **保留为子任务**（历史可追溯，且并行会话可能已在做） | 直接关闭可能与并行会话的工作冲突 |
| Q4 | **#157(ISS-082 /voice 实时语音)**：本草稿判为 OUT | 关闭为 `wontfix` 或改写为"本地听写增强" | 需你确认 realtime voice 是否真的不做 |
| Q5 | **编号**：本草稿已重编号为 **ISS-086 … ISS-105**（避开已占用的 069–085） | 采用 | 若并行会话继续开新 issue，仍可能再撞号 ⇒ 建议约定"开 issue 前先 `gh issue list --state open` 取最大号" |
| Q6 | **并行会话协调**：是否先停掉另一个会话，避免继续重复创建/改 `package.json` | **先停**，或明确分工（它做 Wave 0/1 真实化，我做 Wave A + 交互复刻） | 两会话同时写同一工作区已造成 `package.json` 未提交改动与 `.write-test` 残留 |
| Q7 | **`package.json` 的未提交改动**（vitest/jsdom/@testing-library）：保留（并入 ISS-086）还是回退 | **保留**并在 ISS-086 中记账（依赖已装，正好用） | 不是我改的，我不会擅自回退 |

---

## 3. 提交脚本（**未执行**，需授权后运行）

```bash
# 前置：确认编号未被再次占用
gh issue list --state open --limit 100 --json number,title | jq -r '.[].title' | grep -oE 'ISS-[0-9]+' | sort -u | tail -5

# Q2：关闭 16 个孤儿重复（逐个留痕）
for n in $(seq 129 144); do
  gh issue close "$n" --reason "not planned" --comment "重复创建：同一内容见 #$((n+16))（Epic #128 的子任务清单指向 #145–#160）。"
done

# Q1 方案 X：把 20 张草稿挂到既有 Epic #128
LABELS="parity-slice,enhancement,priority/P1"
for f in ISS-086-build-ci-test ISS-087-acp-single-connection ISS-088-state-ipc-contract \
         ISS-089-commands-shortcuts-i18n ISS-090-parity-tooling ISS-091-app-shell \
         ISS-092-composer-editor ISS-093-composer-controls ISS-094-review-panel \
         ISS-095-thread-view ISS-096-sidebar ISS-097-thread-header \
         ISS-098-terminal-subagents ISS-099-worktree-environments \
         ISS-100-plugins-skills-mcp ISS-101-automations ISS-102-settings \
         ISS-103-onboarding-auth-import ISS-104-platform-integration ISS-105-cleanup-acceptance; do
  title=$(head -1 "docs/plans/issues/$f.md" | sed 's/^> *//')   # 或用下方 title 映射表
  gh issue create --title "$title" --body-file "docs/plans/issues/$f.md" --label "$LABELS"
done

# 追加到 Epic #128 的子任务清单（编辑正文，需先备份原文）
gh issue view 128 --json body -q .body > /tmp/epic128.bak.md
# …人工/脚本追加 Wave A / Wave B 与新 issue 链接后：
gh issue edit 128 --body-file /tmp/epic128.new.md

# 新增标签（也是写操作）
gh label create parity-foundation --color 5319E7 --description "复刻地基（架构/构建/契约）" || true
gh label create parity-slice      --color 0E8A16 --description "复刻垂直切片" || true
gh label create supersedes-105    --color B60205 --description "翻案 #105(ISS-057) 的错误基准" || true
```

**标题映射表**（草稿文件首行是引用块，不是标题，创建时需显式指定）：

| 文件 | 建议标题 |
|---|---|
| ISS-086-build-ci-test | `ISS-086: 构建与 CI 地基 — esbuild 打包替换 sed + PR 四道门 + smoke` |
| ISS-087-acp-single-connection | `ISS-087: ACP 单连接多会话 + x.ai/* typed client（会话拓扑重构）` |
| ISS-088-state-ipc-contract | `ISS-088: 状态与 IPC 契约地基 — 布局状态机 + per-thread scope + 多窗口广播` |
| ISS-089-commands-shortcuts-i18n | `ISS-089: 命令注册表（127 条）+ 快捷键归位 + i18n（key 用 Codex id）` |
| ISS-090-parity-tooling | `ISS-090: parity 验收工具链 — checklist 自动生成 + 覆盖率门 + 规格漂移检测` |
| ISS-091-app-shell | `ISS-091: App Shell 工作台 — tab strip / 布局状态机 / bottom panel / side panel 多 tab / detached window` |
| ISS-092-composer-editor | `ISS-092: Composer 编辑器内核 — ProseMirror 接线 / 格式工具条 / mention pill / slash 对话框 / 代码块` |
| ISS-093-composer-controls | `ISS-093: Composer 控件行 — 权限档位 / 运行位置 / worktree 环境 / plan·fast / queue·steer / Chat·Work` |
| ISS-094-review-panel | `ISS-094: Review 面板 — 多源 diff / 文件树 / 虚拟化 / hunk revert / 行级评论 / PR` |
| ISS-095-thread-view | `ISS-095: Thread 视图 — turn entries 按轮聚合 / 虚拟化 / 导航栏 / find bar / 轮内聚合区块` |
| ISS-096-sidebar | `ISS-096: 侧栏信息架构 — priority / 自定义分区 / hover card / 批量 / undo / 行内状态 / 归档区` |
| ISS-097-thread-header | `ISS-097: Thread Header — continue / fork 三态 / copy 三态 / archive 差异化确认 / side chat / context bar` |
| ISS-098-terminal-subagents | `ISS-098: 真实 PTY 终端 + Subagent 真值 + 后台进程` |
| ISS-099-worktree-environments | `ISS-099: Worktree 生命周期（走 agent）+ 本地环境 / project setup / 会话迁移` |
| ISS-100-plugins-skills-mcp | `ISS-100: Plugins / Skills / MCP 三体系真实化（替换硬编码 catalog）` |
| ISS-101-automations | `ISS-101: Automations 接 agent scheduler（关 app 仍触发）+ 会话绑定` |
| ISS-102-settings | `ISS-102: Settings 重构 — 分组导航 / 页补齐 / 项级搜索 / Agent(Configuration) / 快捷键对话框` |
| ISS-103-onboarding-auth-import | `ISS-103: 真实认证 + 多步 onboarding + 外部 agent 配置导入` |
| ISS-104-platform-integration | `ISS-104: 平台集成 — tray / 原生菜单 / 自动更新 / deeplink / 单实例 / 崩溃恢复 / 通知` |
| ISS-105-cleanup-acceptance | `ISS-105: 收尾 — 21 处桩与死代码清零 / ADR 补齐 / Tauri 决策 / Epic 总验收` |

---

## 4. 依赖 DAG（去重合并后的建议顺序）

```
Wave 0（质量基座，并行会话已在做）
  #145 ISS-070 测试基座 ──┐
  #146 ISS-071 Electron CI ┤
  #147 ISS-072 Tauri 退役  ┘
  ISS-086 构建地基（esbuild + smoke 门）  ← 必须早于任何新增子目录

Wave A（架构地基，本稿新增，**必须先于 Wave 1**）
  ISS-087 单连接多会话 + x.ai/* client   ┐ 可并行（接口先在 shared/contract.ts 定死）
  ISS-088 布局状态机 + per-thread scope + 多窗口广播 ┘
        └─> ISS-089 命令注册表 + 快捷键 + i18n
               └─> ISS-090 parity 工具链

Wave 1（真实化，改为依赖 Wave A）
  #148/ISS-103 认证 · #149 fs 桥(依赖 087) · #150/ISS-098 PTY(依赖 087,091)
  #151/ISS-104 更新 · #152/ISS-091 detach(依赖 088)

Wave 2（交互复刻，Wave A 后大量可并行）
  ISS-091 App Shell ─┬─> ISS-094 Review · ISS-095 Thread 视图 · ISS-096 侧栏 · ISS-098 终端
  ISS-092 Composer 编辑器 ─> ISS-093 Composer 控件行
  ISS-102 Settings ─┬─> ISS-099 Worktree · ISS-100 Plugins/Skills/MCP · ISS-101 Automations · ISS-103 Onboarding

Wave 3（收口）
  ISS-097 Thread Header · ISS-104 平台集成 · #159 REVIEW_DEBT · ISS-105 总验收 · #160 UXR 走查
```

---

## 5. 文件清单

| 文件 | 内容 |
|---|---|
| `ISS-106-epic.md` | Epic 草案（含与 #128 的冲突说明与方案 X/Y） |
| `ISS-086 … ISS-105`（20 个） | 每张含：目标 / 范围 / 非目标 / 依赖 / 回滚 / 验收标准（状态机不变量 · 负向场景 · 并发·崩溃·恢复 · 外部副作用检查）/ Parity 勾选项 |

每张 issue 的验收标准都强制包含四类核心验收逻辑（设计文档 §7）：**状态机不变量**、**负向场景**、**并发/崩溃/恢复**、**外部副作用检查**。
