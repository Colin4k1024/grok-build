# Deployment Context: Evolution Auto-Trigger

## 环境清单

| 环境 | 用途 | 部署方式 |
|------|------|----------|
| 开发 | 本地 cargo build + test | `cargo test -p xai-grok-evolution` |
| CI | PR 验证 | GitHub Actions `cargo check` + `cargo test` |
| 生产 | 集成到 xai-grok-shell binary | 随 shell 主 binary 编译发布 |

## 部署入口

| 入口 | 说明 |
|------|------|
| 主入口 | 合并到 main 分支后随 CI 编译进 xai-grok-shell |
| 回退入口 | `git revert` 相关 commits 并重新编译 |
| 前置条件 | protobuf 工具链修复后 `cargo check -p xai-grok-shell` 通过 |

## 配置与变量

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `positive_sample_rate` | 0.3 | 正信号采样率（0.0-1.0） |
| `skill_decay_window` | 10 | Decay 检测滑动窗口大小 |
| `skill_decay_threshold` | 0.4 | Decay 触发阈值（ineffective 比率） |

所有新配置字段使用 `#[serde(default)]`，无需额外配置即可运行。

## 密钥与敏感信息

无新增密钥或敏感配置。

## 运行保障

| 维度 | 状态 |
|------|------|
| Feature flag | 无（受 `EvolutionMode::Off/Shadow/Active` 控制） |
| 灰度控制 | `Shadow` 模式下只采样不执行 |
| 监控 | `warn!` 日志：signal queue 满丢弃 |
| 观察窗口 | 发布后 7 天内观察 decay signal 频率和 queue 丢弃率 |

## 恢复能力

| 项目 | 说明 |
|------|------|
| 回滚触发条件 | decay 信号频率异常高、queue 满丢弃比例 > 5%、crash |
| 回滚路径 | `git revert` + 重新编译发布 |
| 验证方法 | 回滚后 `cargo test -p xai-grok-evolution` 全过 |
| 数据兼容性 | 新 signal types 向后兼容，旧 binary 忽略未知类型 |
