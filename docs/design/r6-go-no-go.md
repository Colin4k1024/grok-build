# R6 Go/No-Go 决策包（R6-07 / #285）

单一命令生成 SHA 绑定的发布决策包，让缺失证据可见，并把生产发布保持阻塞，
直到用户显式授权。

## 命令

```bash
node scripts/go-no-go.mjs [--sha <sha>] [--json]
```

默认取最新候选（`.candidates/` 中带 `candidate-manifest.json` 的目录）；
`--sha` 强制校验"证据必须恰好绑定该 SHA"（溯源取自候选的 BUILD 戳，
而非工作区 HEAD）。

## 状态机（不变量）

```
collecting → ready_for_decision → approved | rejected
```

- **collecting** — 存在证据缺口（平台缺失、场景未演练、e2e 过期、ruleset
  未验证激活、回滚文档缺失）。出口码 1。
- **ready_for_decision** — 证据齐备但无人工决策记录。**ready ≠ go**。出口码 0。
- **approved** — 仅当 `decisions/<sha>.json` 存在且
  `grantedBy:"human"` + 具名 `approver`。工具自身永远不能自批准
  （`grantedBy:"automation"` 视为阻断项）。出口码 2。
- **rejected** — 任一硬阻断（候选彩排 rejected、溯源 SHA 不匹配、安全
  例外过期）。出口码 3。

**发布是另一个独立动作**：本工具与 approved 状态都不执行任何发布、打标、
feed 提升或产物删除——这些需要用户在批准之后的显式操作。

## 汇总的证据

| 证据 | 来源 | 缺口/阻断判定 |
| --- | --- | --- |
| 候选彩排 | `candidate-report.json`（rehearse:candidate） | partial→缺口按 missing 逐项；rejected→阻断 |
| 溯源 | 候选 BUILD 戳 SHA | 彩报 SHA ≠ 戳 SHA → 阻断 |
| 安全例外 | `security/audit-exceptions.json` | 过期→阻断；未过期→残余风险列出 |
| 分支保护 | `scripts/check-branch-protection.mjs` | 未激活→缺口 |
| 回滚文档 | `docs/release-validation.md` | 缺失→缺口 |
| e2e 新鲜度 | `e2e-results/results.json` mtime ≥ 候选 builtAt | 过旧/缺失→缺口 |
| 人工决策 | `decisions/<sha>.json` | 非 human/无 approver→阻断 |

每次运行向候选目录的 `go-no-go-runs.jsonl` **追加**一行（只增不改），
中断重跑不破坏既有证据。

## 人工授权（未来发布时）

```bash
mkdir -p .candidates/decisions
cat > .candidates/decisions/<full-sha>.json << 'EOF'
{ "approver": "<你的名字>", "grantedBy": "human", "at": "<时间>", "note": "<可选说明>" }
EOF
node scripts/go-no-go.mjs --sha <full-sha>   # → approved (exit 2) 仅当无新阻断
```

## 当前状态（2026-10-08）

候选 `0.1.0-3137685f-muzho1h9`（macOS arm64）：

- 彩排 state=**partial**（缺 darwin-x64/win32-x64/linux-x64 平台与
  install-uninstall/update-interruption/corrupt-package-reject/
  restart-recovery/rollback 场景）
- ruleset 24706904 处于 emergency-disabled（目标完成后或 CI 恢复后重新激活）
- 决策：**collecting（NO-GO）** — 与事实一致；发布保持阻塞。
