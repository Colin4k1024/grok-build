> Epic: #128 (ISS-069) · 批次: B6 · 标签: `parity-slice` `architecture` `documentation` `priority/P2`
> 规格来源: 差距文档 附录 A（21 处桩/死代码）、§6.3、设计文档 §2(G10) §6(AD-10)

## 目标

收尾：清零全部桩与死代码、决定 Tauri 退役、更名误导性模块、跑通 Epic 级总验收（IN 范围 parity 100%），并把经验写入项目记忆（替代缺失的 ADR 机制）。

## 范围

1. **桩/死代码清零审计**（差距文档附录 A 的 21 项，逐项验证"已接线或已删除"）：
   - 死代码：`ComposerEditor`(076)、`MentionComplete`(076)、`EditorTabs`(075)、`ActivityBar`、`StatusBar`、`EmojiPicker`(079)、`ProjectList`(080)
   - 桩：`check_auth_status`/`login`/`logout`(087)、`open_session_window`(075)、`updater_check`(088)、`fs/read_text_file`+`fs/write_text_file`(071)、capabilities(071)、`grok:apply-code`(079)、`automation.ts` localStorage cron(085)、`SUBAGENT_TOOLS` 猜测(082)、`slashCommands.ts` 硬编码(076)、`PluginManager` CATALOG(084)、`ThreadSummaryPanel` 无后端(079)、`useUpdater`(088)、`onTrayAction`(088)、`CommandPalette` ⌘T 错标(073)
   - 产出：`grep` 可验证的清单（每项附验证命令）
2. **Tauri 退役决策**（AD-10）：评估 `src-tauri/`（含 `acp_bridge.rs`、`commands/`、`tauri.conf.json`、`capabilities/`）与 `.github/workflows/release.yml` 的 Tauri 构建；决定删除 / 冻结 / 保留；若删除则同步移除 `@tauri-apps/*` 依赖（7 个）与 `npm run tauri`、`scripts/test-tauri.sh`
3. **误导性命名修正**：`src/lib/tauri.ts`(511 行，实为 Electron IPC 桥) → `src/lib/ipc.ts`；`src/lib/desktop.ts` 职责合并审视
4. **文档与记忆**：
   - 补 `docs/design/` 的 ADR 空缺：把 AD-1..AD-11 写成 `docs/adr/ADR-001..011-*.md`（AUDIT.md 缺点 7 的整改）
   - 更新 `docs/design/desktop-codex-alignment.md`（第一批）→ 追加第二批结论与翻案说明
   - `docs/memory/lessons-learned.md` 追加："规格来源必须是实物而非二手 issue/文档"（#105 的教训）
   - `ISSUES.md`（v1，56 条）标注为 superseded，指向 `docs/design/codex-desktop-parity-gap.md`
5. **Epic 总验收**：
   - `docs/parity/*` IN 项 100% 勾选（OUT 项在附录标注理由）
   - 127 条命令中 IN 部分全部注册且键位与 `commands.tsv` 一致
   - `ps` 验证单 agent 进程承载 N tab
   - CI 四道门 + parity 门全绿
   - 手工验收脚本：`docs/parity/manual-acceptance.md`（对照 ChatGPT.app 逐屏走查的 checklist）
6. **性能与体积基线**：冷启动时间、1000 轮长会话的内存与帧率、打包体积（记录到 `docs/parity/perf-baseline.md`，作为后续回归基线）

## 非目标

- 不新增功能（本 issue 只做清理、决策、文档、验收）
- 不做视觉像素级对齐的打磨（若走查发现缺口，另开 issue）
- 不做 Windows/Linux 的专项适配

## 依赖

- 全部前序 issue（ISS-086 .. ISS-104）
- 若 Tauri 退役选择"删除"，需确认无用户依赖 Tauri 产物（发布历史检查）

## 回滚

清理类改动逐项独立 commit，可单独 revert。Tauri 删除是**不可逆性最高**的一项 → 必须在独立 commit 且保留 tag 便于恢复；删除前确认 CI 与打包均不依赖 `src-tauri/`。文档改动无运行时影响。

## 验收标准

### 状态机不变量
- 全仓库无"零引用组件"（脚本化检查：对 `src/components/**` 每个导出符号做引用计数，0 引用即失败）
- 无返回常量 `ok(null)` 的 IPC handler（除显式标注为 no-op 且有 issue 追踪的）
- 无前端自造的假数据源（`localStorage` 仅用于 UI 偏好与缓存，不得作为能力真值源）—— 脚本化检查关键 key
- `src/lib/ipc.ts` 更名后无残留 `tauri` 引用（除 `src-tauri/` 目录本身，若保留）
- parity 报告覆盖率 == 100%（IN 项）且不回退（CI 门）

### 负向场景
- 走查发现的缺口 → 每项开新 issue 并链到 Epic，不得在验收报告里"备注后忽略"
- Tauri 删除后若发现打包/CI 仍引用 → 构建必须失败（而非静默跳过），本 issue 需先验证
- ADR 与实际实现不符 → 以实现为准并修正 ADR（不允许文档与代码分叉）

### 并发 / 崩溃 / 恢复
- 清理后重跑全部 smoke（`npm run test:smoke`）：多会话并发、agent 崩溃重连、app 重启恢复三条主路径必须绿
- 打包后的 app（`npm run electron:pack`）在干净环境首启 → onboarding 可用、能创建会话、能收发消息（端到端验收）

### 外部副作用检查
- 清理不得删除用户数据（`~/.grok/**`、localStorage 中的会话/tab 数据）
- 删除 `src-tauri/` 前确认其中不含唯一的密钥/配置逻辑（`acp_bridge.rs` 的行为必须已在 Electron 侧等价实现）
- 文档中不得写入 ChatGPT.app 的代码片段或完整文案正文（只引用 id）
- 发布体积/性能基线测量不得上传数据到外部服务

### Parity 勾选项
- [ ] 附录 A 的 21 项全部关闭（每项附验证命令与结果）
- [ ] AD-1..AD-11 落成 ADR 文档
- [ ] Tauri 退役决策已执行且 CI/打包一致
- [ ] Epic 全局验收 7 项全部通过
- [ ] `docs/parity/manual-acceptance.md` 走查完成并记录结果
