> Epic: #128 (ISS-069) · 批次: B1 · 标签: `parity-foundation` `documentation` `priority/P2`
> 规格来源: `scripts/codex-ref/{index,get,i18n,commands}.mjs`；差距文档 §6.1 IN 清单

## 目标

让"1:1 复刻"变成**可度量、可勾选、可回归**的验收，而不是主观判断：从规格抽取产物自动生成 parity checklist，并纳入 CI。

## 范围

1. `scripts/parity.mjs`：
   - 输入：`/tmp/codex-ref/i18n.tsv`（4,622 条）、`commands.tsv`（127 条）、模块清单（458 个功能命名模块）、差距文档 §6.1/§6.2 的 IN/OUT 判定
   - 输出：`docs/parity/<domain>.md`，每条 = `[ ] <能力> · 证据 id · 所属 issue · 状态`
   - 支持 `--domain composer`、`--issue ISS-094`、`--only-missing`
2. **IN/OUT 判定表**入库：`docs/parity/scope.tsv`（能力 → IN/OUT → 理由 → 对应差距项编号），是 §6.1/§6.2 的机器可读版
3. **实现侧探测**：对可静态判定的项自动打勾 —— i18n key 是否存在于 `src/i18n/zh-CN.ts`、命令 id 是否注册于 `src/state/commands.ts`、ext 域方法是否在 `electron/agent/ext/*` 出现；不可静态判定的标 `manual`
4. CI job：`parity` 门 —— 报告"IN 项已覆盖比例"，**不允许回退**（与上次 main 的报告比较，覆盖率下降即失败）
5. `docs/parity/README.md`：说明如何重跑规格抽取（ChatGPT.app 自更新后 diff 流程）
6. 规格漂移检测：`scripts/codex-ref/diff.mjs` —— 对比新旧 `i18n.tsv`/`commands.tsv`，输出新增/删除/改名的 id（每切片开工前跑一次）

## 非目标

- 不做视觉回归（截图 diff）—— 需要另议工具与基线管理
- 不把 ChatGPT.app 的任何产物写入仓库（版权；只存 id 清单与我们自己的判定）
- 不自动判定"交互体验是否一致"（只覆盖可静态/半自动验证的项）

## 依赖

- ISS-089（命令 id 与 i18n key 的探测目标必须已存在）
- `scripts/codex-ref/*`（已入库）

## 回滚

纯工具与文档：删除 `scripts/parity.mjs`、`docs/parity/`、CI 的 `parity` job 即可，不影响运行时。

## 验收标准

### 状态机不变量
- checklist 是**幂等生成**的：同样输入两次生成，diff 为空（顺序、编号、分组稳定）
- 每条 IN 项恰好归属一个 issue（无孤儿项、无重复归属）；OUT 项不出现在 checklist 主体（单列 OUT 附录 + 理由）
- 覆盖率单调不减：CI 门以 `main` 上一次报告为基线，下降即失败

### 负向场景
- `/tmp/codex-ref/` 缺失或为空 → 工具给出明确指引（先跑 `index.mjs` + `get.mjs`）而非生成空报告
- `scope.tsv` 中出现未知差距项编号 → 校验失败
- i18n key 存在但值为空字符串 → 计为未覆盖，不误判为已实现
- ChatGPT.app 升级导致 id 改名 → `diff.mjs` 必须报告 rename 疑似对（旧 id 消失 + 新 id 出现），checklist 不得静默丢项

### 并发 / 崩溃 / 恢复
- CI 上多 job 并发写 `docs/parity/` → 只在专用 job 内生成并提交到 artifact，避免竞争
- 生成中途失败 → 不留下半成品覆盖既有报告（原子写：临时文件 + rename）

### 外部副作用检查
- 只读 `/Applications/ChatGPT.app`（不写、不解包到仓库）
- 生成的报告不含 ChatGPT.app 的代码片段或完整文案正文（只含 id 与我们自己的中文描述）—— 版权与合规
- 不上传任何抽取产物到 CI artifact 之外的位置

### Parity 勾选项
- [ ] AD-11 落地：每切片交付附 checklist 勾选
- [ ] Epic 全局验收项「IN 范围 100% 勾选」有可执行工具支撑
- [ ] 规格漂移可检测（R5 缓解）
