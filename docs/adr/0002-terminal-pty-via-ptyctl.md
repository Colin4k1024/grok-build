# ADR 0002: Terminal PTY 走 Rust 侧 ptyctl，而非 node-pty

- 状态：Accepted
- 日期：2026-09-19
- 决策人：ISS-075（#134 / Epic #128 第二轮）

## 背景

Terminal tab 需要真实交互式 PTY（ssh/vim/top 可用）。Issue 给出两个候选：

- **A. node-pty（Electron 主流）**：主进程原生模块。
- **B. Rust 侧 PTY 经流式桥**：复用 workspace 内已有的 `ptyctl`
  （`crates/codegen/ptyctl` + `ptyctl-cli`）——headless PTY 控制器，
  自带 localhost HTTP + `/ws` WebSocket 协议：
  服务端 binary 帧 = 原始终端输出 + text 帧 `{"type":"closed","exit_code":N}`；
  客户端 binary 帧 = 原始 stdin 或 JSON `{"type":"input"|"keys"|"resize",...}`。

## 决策

**选 B：Electron 主进程只负责 `ptyctl run` 子进程生命周期管理；
xterm.js 在渲染进程直连 `ws://127.0.0.1:<port>/ws`。**

理由：

1. **零新增原生面**：ptyctl 已在生产 workspace 内（含 pty 转义/滚动正确性
   测试 `xai-grok-pager-pty-harness`）；node-pty 需要为 Electron ABI
   rebuild + 三平台预编译产物 + 签名链维护。
2. **关注点分离**：终端字节流不经 IPC 序列化（renderer↔ws 直连），
   主进程不成为高频字节泵。
3. **ConPTY/Unix PTY 差异收敛在 Rust 侧**，Electron 无平台分支。
4. 工程事实：本仓库安全扫描链（Mimosa）将 node-pty 导入判定为高危
   命令执行面并阻止落地；而受控的 `child_process.spawn(bin, [固定参数])`
   模式（与 agent 启动一致）是放行的既定模式。

## 后果

- 打包管线新增 `ptyctl` 二进制（extraResources，与 agent 并列；ISS-071 的
  electron.yml 矩阵增加 `-p ptyctl-cli` 构建与暂存）。
- PTY 输入输出绕过主进程 IPC —— 审计/权限边界以"会话 cwd + 本机回环端口"
  划定；端口由 ptyctl 随机分配（`-p 0`），仅本机可达。
- 回滚：`GROK_DESKTOP_PTY=off` → 主进程拒绝 spawn，Terminal tab 回落
  `run_command` 只读输出（隐藏交互入口）。
- 弃用 node-pty 依赖（曾短暂引入 1.0.0 验证后移除；1.1.0 在 darwin 25
  存在 posix_spawnp 回归，佐证原生模块维护成本）。
