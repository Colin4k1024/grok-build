# 自进化能力实施状态

更新时间：2026-07-29

基准方案：[experience-self-evolution-plan.md](./experience-self-evolution-plan.md)

实施版本：以包含本文件的 Git 提交为准

## 总体结论

自进化能力的 P0–P5 工程闭环已完成，并通过真实 worker、隔离预检、生命周期和产品入口验证。系统默认仍为 `Off`，不因代码完成而自动开放生产流量。

P6 的放量控制和 fail-closed 门禁已经实现，但 `ReuseEligible` 必须等待真实 Shadow 指标、固定 replay、安全演练和指标基线达标后人工批准。因此当前状态是“实现完成、生产放量待验收”，不是“已全量启用”。

## 阶段状态

| 阶段 | 状态 | 已完成内容 | 剩余放量条件 |
|---|---|---|---|
| P0 契约/威胁模型 | 完成 | 版本化领域契约、fixture、非法状态和安全边界测试 | 无 |
| P1 领域内核/事件库 | 完成 | Grok `EvolutionEngine`、事务式事件/投影、迁移、恢复、事件哈希、artifact manifest 和孤儿回收 | 无 |
| P2 Shadow 信号链 | 完成 | workspace service、turn-end 脱敏 delta、bounded queue、真实 Shadow run，且不修改 prompt/源工作树 | 开放 Shadow 前建立运行观测面板 |
| P3 隔离 Trial | 完成 | Git dirty-copy worktree、独立 worker v2、父进程模型调用、基线/候选验证、命令/路径/diff 守卫、内核文件和网络隔离 | 分阶段运行真实 trial 样本 |
| P4 Solidify/Reuse | 完成 | 验证后发布不可变 artifact、首轮 prompt 注入、reuse observation、三次成功晋升、两次失败 Quarantine | Reuse 放量前完成固定 replay |
| P5 ACP/CLI/TUI | 完成 | 七个 ACP 端点和统一 service；CLI/TUI 接通状态、列表、检查、谱系、模式、重试和证据导出 | 旧 agent/断线场景保持只读降级 |
| P6 分阶段放量 | 门禁就绪，尚未放量 | 默认 Off、内部 preflight、kill switch、circuit breaker、rollout readiness 门禁 | Shadow 指标、安全演练、固定 replay、证据完整率和指标基线全部达标 |

## 已验证安全属性

- macOS 真实 worker 隔离预检 7/7 通过：源目录不可写、网络阻断、符号链接逃逸阻断、worktree 外写阻断、sandbox 可用、磁盘充足、VCS 快照一致。
- worker 环境清除父进程凭据，只暴露隔离 HOME、Rust sysroot 和 Cargo `registry/git` 只读缓存；离线 `cargo check` 验证通过。
- worker 不持有模型客户端或凭据；候选生成与 critic 只在父进程执行，确定性安全门不可被 critic 覆盖。
- artifact 采用文件 fsync、目录 fsync、原子 rename、数据库事务的发布顺序；数据库失败不会产生悬空引用，孤儿可在启动时回收。
- 源树哈希仅覆盖 Git tracked 与非忽略 untracked 文件，不受 `target/` 等 ignored 构建缓存影响。
- 生命周期 E2E 已完成 Candidate → 三次成功 → Active → 注入 → 两次失败 → Quarantined，下一轮立即排除，源仓库保持不变。

## 验证记录

- `cargo check -p xai-grok-sandbox -p xai-grok-evolution -p xai-grok-shell -p xai-grok-pager --all-features`
- `cargo test -p xai-grok-sandbox --all-features`
- `cargo test -p xai-grok-evolution --all-features`：209 个单元测试、18 个契约 fixture、2 个真实 worker 进程测试通过
- `cargo test -p xai-grok-shell --lib evolution --no-fail-fast`：2 个定向测试通过
- `cargo test -p xai-grok-pager evolution_modal --lib`：6 个定向测试通过
- `cargo run -p xai-grok-evolution --example e2e_pipeline --all-features`
- `git diff --check`

## 放量决策

1. 保持默认 `Off`，先由明确配置开放 Shadow。
2. 收集 Shadow 的延迟、信号质量、源工作树污染和证据完整率基线。
3. 只有内部 worker preflight 全部通过时才允许进入 `IsolatedAutonomous`。
4. 只有 source pollution 为零、sandbox/evidence 完整率 100%、安全演练和固定 replay 通过、指标基线建立后，才批准 `ReuseEligible`。
5. 任一安全门失败立即降级或关闭，不允许使用模拟成功或内存回退绕过。
