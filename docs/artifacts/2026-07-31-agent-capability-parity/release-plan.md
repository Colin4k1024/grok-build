# Release Plan: Agent Capability Parity

## 发布信息

| 字段 | 内容 |
|------|------|
| 版本 | main@44d6b10 |
| 发布时间 | 2026-07-31 15:44 |
| 发布方式 | 本地 release build + 二进制安装 |
| 负责人 | fanjia |
| 观察窗口 | 24h |

## 变更范围

| Commit | 描述 |
|--------|------|
| ba7192a | Computer Use crate + auto-format hook templates |
| 5cbc73b | PRD (6 gaps) |
| 7626801 | Delivery plan |
| 7879092 | **6 capability-parity tools 实现** |
| 44d6b10 | Test plan + launch acceptance |

**核心变更**: 6 个新 tool 模块 (422 行 Rust) + 1 个新 crate (770 行) + hook 模板

## 执行步骤

1. [x] `cargo build --release` — 编译成功
2. [x] `cargo check -p xai-grok-tools` — 零 error
3. [x] `cargo test -p xai-grok-tools` — 新 tool 零 failure
4. [x] 安装到 `~/.grok/bin/` — 完成
5. [x] `git push origin main` — 已推送

## 验证与监控

| 检查项 | 结果 |
|--------|------|
| release build 编译 | ✅ PASS |
| 二进制大小合理 | ✅ pager: 162MB, worker: 2MB |
| 回归测试 | ✅ 2823 pass, 新 tool 0 fail |
| 本地安装可用 | ✅ 二进制替换成功 |

## 回滚方案

- **触发条件**: 新 tool 模块导致 grok session crash 或 tool dispatch panic
- **回滚路径**: `git revert 7879092` → rebuild → reinstall
- **验证**: `cargo test -p xai-grok-tools`

## 放行结论

| 项目 | 结论 |
|------|------|
| 放行决定 | **GO** |
| 已接受风险 | CodeGraph/ComputerUse 为 stub（优雅降级） |
| 后续观察 | ToolKind 注册后首次模型调用是否正常 |
| 下一步 | 完成 ToolKind enum 扩展 + system prompt 描述注入 |
