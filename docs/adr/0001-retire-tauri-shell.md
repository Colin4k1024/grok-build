# ADR 0001: 退役 Tauri 桌面壳，Electron 成为唯一活跃壳

- 状态：Accepted
- 日期：2026-09-18
- 决策人：ISS-072（#131 / Epic #128 第二轮）
- 取代：`docs/design/tauri-desktop-app-design.md`（历史设计，仅存档）

## 背景

仓库曾同时维护两个桌面壳：

- **Tauri 壳**（`src-tauri/`，crate `grok-build-desktop`）：第一轮桌面化的初始壳。
- **Electron 壳**（`electron/`）：迁移目标，现为活跃壳 —— 前端传输层 `src/lib/tauri.ts`
  仅为兼容命名，实际全部经 `window.electron`（preload contextBridge）路由；
  `src/lib/desktop.ts` 已用 Electron invoke 重写原 Tauri 插件能力
  （clipboard/window/notification/updater/process），**前端零运行时
  `@tauri-apps` 依赖**（package.json 中 9 个相关包为死重）。

双壳并存造成漂移源：

1. `release.yml` 仍在三平台矩阵跑 `npx tauri build`（且依赖 Tauri 签名密钥），
   与活跃壳不一致 —— 仓库任一时刻存在两个"可发布物"。
2. `vite.config.ts` 残留 `TAURI_DEV_HOST` 与 src-tauri watch ignore。
3. `scripts/test-tauri.sh` 硬编码他人机器路径 `/Users/ailabuser1/...`，不可执行。
4. Rust workspace（`Cargo.toml` members）包含 `src-tauri`，`cargo check --workspace`
   被壳代码拖累。

## 决策

**删除 Tauri 壳，Electron 成为唯一活跃壳。**

- 删除 `src-tauri/`（22 个跟踪文件；`gen/` 为 gitignore 的本机生成物）、
  Cargo workspace 成员引用、`scripts/test-tauri.sh`。
- package.json 移除 `tauri` script 与全部 `@tauri-apps/*` 依赖（api、7 个插件、cli）。
- `vite.config.ts` 移除 `TAURI_DEV_HOST` 与 src-tauri watch 项；`.gitignore` 移除
  `src-tauri/gen/`。
- `release.yml`（纯 Tauri 构建）随壳删除；Electron 发布管线由 ISS-071（#130）
  以 electron-builder 重建 —— 期间仓库无 tag 发布需求。
- `electron/*.ts` 中"Electron port of src-tauri/src/commands/..."注释为血缘记录，保留。

**不动**：Rust agent 运行时 `crates/`（桌面壳之外的生产代码）、`rust-toolchain.toml`、
`clippy.toml`、`.cargo/config.toml`（面向 agent workspace 的交叉编译配置）。

## 回退路径

- 删除动作独立成单个 commit（本 ADR 单独成 commit），`git revert <删除commit>`
  即可完整恢复 src-tauri/、workspace 成员、依赖与 workflow。
- 恢复后需 `npm install` 刷新 lockfile；`src-tauri/gen/` 需重新生成（本机产物）。

## 后果

- 单一活跃壳不变量成立：`package.json` 的 `main`（`dist-electron/main.cjs`）与
  CI 构建目标一致；`cargo check --workspace` 只覆盖 agent 运行时。
- Tauri 独有能力（极小体积、系统 webview）放弃；换取单一 IPC 面
  （contextBridge）、Node 生态（node-pty 等 ISS-075 依赖）与运维简单性。
- ISS-076（自动更新）将基于 electron-updater 而非 tauri-plugin-updater
  （原 `tauri.conf.json` 的 updater endpoint 随壳删除，届时在 Electron 侧重新配置）。
