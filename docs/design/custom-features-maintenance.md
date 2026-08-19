# 自定义功能维护与上游同步流程

## 背景：结构性问题

本仓库定期以 "Synced from monorepo" 提交从 SpaceXAI monorepo **全量覆盖工作树**。
每次同步会抹掉所有不属于上游的自定义功能 —— 2026-08 已发生过一次：
Phase A/B/C 全部 11 项能力吸收实现（issue #14）在同步后从 main 消失，
仅 `backup-pre-upstream-sync` 分支保留了旧实现。

**结论：任何未列入本文档清单的自定义代码，都应视为随时会丢。**

## 当前 main 上的自定义功能清单（同步后必须逐项确认存活）

### DashScope BYOK 适配（commit 5213cbd，2026-08-19）

| 文件 | 内容 |
|------|------|
| `crates/codegen/xai-grok-shell/src/agent/config.rs` | `DefaultModelJson` 支持 `base_url`/`env_key`/`auth_scheme`/`extra_headers` |
| `crates/codegen/xai-grok-tools/src/implementations/web_search/{types,client,mod}.rs` | `WebSearchBackend`：Chat Completions + `enable_search` 搜索路径 |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/spawn.rs` | 从 `SamplerConfig.api_backend` 自动选择搜索后端 |
| `crates/codegen/xai-grok-models/default_models.json` | DashScope 模型目录（deepseek-v4-pro 默认，env_key=DASHSCOPE_API_KEY） |

机器侧配套（不在仓库内，丢失后果同样严重）：
`~/.grok/config.toml` 的 `auto_update=false`（防官方二进制覆盖）、
`telemetry=false` / `remote_fetch=false`（切断 grok.com/x.ai 辅助流量）。

### 能力吸收实现（全部丢失，待重落地）

旧实现位置：`backup-pre-upstream-sync` 分支（设计文档已恢复到本目录）。
上游已原生吸收、无需重做的：strictAllowlist、Focus View（FocusMode）、
Thread Forking（/fork）。

重落地优先级队列：

1. **A1 Permission Classifier**（`xai-grok-hooks/src/native/permission_classifier.rs`
   + workspace/permission 集成）— 价值高，涉及 6+ 文件，需按当前权限管线重构
2. **A2 Credential Masking**（`xai-grok-sandbox/src/credential_mask.rs`，611 行）—
   自包含模块，移植面中等
3. C2 DirectoryAdded Hook — **暂缓**：当前上游无 add-dir 类基础功能，
   事件无触发点，移植只会产生死代码；待基础功能出现后再做
4. B2 Multi-Marketplace（`plugin-marketplace/provider.rs`）— 按需

注意：旧分支代码基于同步前结构（web_search 等文件已重写），
**只能对照参考重新实现，不能 cherry-pick**。

## 上游同步 SOP（每次 Synced from monorepo 之后）

1. `git merge upstream/main`（同步本体）
2. 对照上面清单逐项 `git grep` 确认自定义功能存活；丢失的立即从
   本文档记录的来源重新落地
3. 离线构建（build script 需本地 rg，绕过 GitHub 下载超时）：
   ```sh
   GROK_SHELL_BUNDLE_RG_PATH=$HOME/.grok/bin/rg \
   GROK_TOOLS_BUNDLE_RG_PATH=$HOME/.grok/bin/rg \
   cargo build -p xai-grok-pager-bin --release
   ```
4. 部署（**必须先 rm 再 cp**，原地覆写会因 macOS provenance cdhash
   不匹配被 "Taskgated Invalid Signature" SIGKILL）：
   ```sh
   rm ~/.grok/downloads/grok-1.0.5-dashscope-macos-aarch64
   cp target/release/xai-grok-pager ~/.grok/downloads/grok-1.0.5-dashscope-macos-aarch64
   ```
5. 端到端冒烟：`grok -p "回复两个字：成功"`（验证 DashScope 路由 + 认证）
6. 更新 issue #14 的状态表
