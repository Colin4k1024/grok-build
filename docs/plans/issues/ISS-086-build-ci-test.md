> Epic: #128 (ISS-069) · 批次: B0 · 标签: `parity-foundation` `architecture` `priority/P1` `backend`
> 规格来源: 设计文档 §1.2 §1.4 §2(G2,G3) §6(AD-8,AD-9) §7

## 目标

在动任何重构之前，先建立**可执行的回归网**与**支持目录结构的打包链**：PR CI 四道门 + vitest + esbuild 打包，使后续 19 张 issue 的每一步都可验证、可回滚。

## 范围

1. **主进程打包改 esbuild**：`electron/main.ts` → 单文件 `dist-electron/main.cjs`（CJS，external: electron + 原生模块 node-pty/better-sqlite3 若有）；删除 `electron/build.sh` 的 `mv`+`sed` 改名法；`esbuild` 提升为显式 devDependency（当前 0.21.5 由 vite 传递引入）
2. **electron/tsconfig.json `include` 修正**：显式列出全部入口，避免"未引用模块静默不编译"
3. **vitest 就位**：`npm run test` / `test:watch` / `coverage`；首批单测覆盖现有纯逻辑（`electron/mcp-config.ts` 的 TOML 段编辑、`electron/session-history.ts` 解析、`src/stores/sessionStore.ts` reducer、`src/lib/automation.ts` cron 语法）
4. **CI workflow**：新增 `.github/workflows/ci.yml`，`on: pull_request` + `push: [main]`，四道门：
   - `typecheck`：`tsc --noEmit` + `tsc -p electron/tsconfig.json --noEmit`
   - `build`：`npm run build` + `npm run electron:build`
   - `unit`：`npm run test -- --run`
   - `smoke`：`electron .` 无头启动（`xvfb-run` on Linux / 直接 on macOS），断言 12s 内主进程无 uncaught exception、窗口 ready-to-show 触发
5. **Tauri release workflow 处置**：`release.yml` 当前构建 Tauri 但运行时是 Electron —— 本 issue 只**加注释标注 deprecated + 停止在 PR 上误导**，实际退役决策留 ISS-105
6. **smoke harness 规范化**：把 `scripts/test-mcp-config.mjs`、`scripts/test-session-resume.mjs` 纳入 `npm run test:smoke`（需 `GROK_AGENT_BIN`，CI 上标记为 optional/skip-if-missing）

## 非目标

- 不改任何业务行为（本 issue 只动构建/测试/CI 配置）
- 不引入 e2e 浏览器自动化（playwright/spectron）——留待 S 轨需要时另议
- 不退役 `src-tauri/`（ISS-105）
- 不做 Rust 侧 CI（`cargo check` 受 protobuf 工具链阻塞，见 `docs/memory/backlog.md`）

## 依赖

- 无（本 issue 是 F 轨起点）
- 需仓库写权限以添加 workflow；CI secrets 沿用现有（本 issue 不需要签名 secrets）

## 回滚

单 commit revert 即可：`ci.yml` 删除、`package.json` scripts 回退、`electron/build.sh` 从 git 恢复。esbuild 产物路径 `dist-electron/main.cjs` 与现状一致，故回滚不影响已打包用户。

## 验收标准

### 状态机不变量
- `npm run electron:build` 的产物集合恒等于 `{main.cjs, preload.cjs}` + 被 esbuild 内联的模块（不再出现"每文件一个 .cjs"），且 `package.json:main` 指向有效
- `import`/`require` 解析：任意深度子目录模块（新增 `electron/__probe__/nested/deep.ts` 临时探针验证后删除）均可被打包解析 —— 这是 G3 的回归断言
- CI 门的通过条件可复现：本地 `npm run ci` == 远端四道门逐条一致

### 负向场景
- 故意在 `electron/` 新增一个**未被引用**的模块含类型错误 → `typecheck` 门必须失败（验证 include 修正生效）
- 故意让主进程启动即抛异常 → `smoke` 门必须失败并输出堆栈
- 缺失 `GROK_AGENT_BIN` 时 `test:smoke` 必须 skip 而非 fail
- vitest 无任何测试文件时 `npm run test -- --run` 必须非零退出（`--passWithNoTests` 不启用）

### 并发 / 崩溃 / 恢复
- smoke 启动超时（>60s）必须被 CI 杀掉并判失败，不留僵尸进程
- 两个 PR 并发跑 CI 互不干扰（无共享临时目录；`GROK_HOME` 指向 `$RUNNER_TEMP`）

### 外部副作用检查
- CI 不得写 `~/.grok`（用 `GROK_HOME=$RUNNER_TEMP/grok` 隔离）；workflow 结束后目录随 runner 销毁
- 新增 workflow 的 `permissions:` 最小化（`contents: read`），不授予 write
- esbuild 打包不得把 `.env`、密钥、`~/.grok` 内容内联进产物（加断言：产物中 grep 不到 `XAI_API_KEY=` 形式的赋值）
- 不新增运行时依赖（devDependencies only）

### Parity 勾选项
- [ ] G2 关闭：`npm run test` 存在且非空，PR CI 四道门生效
- [ ] G3 关闭：子目录 require 可打包（探针验证记录在 PR 描述）
- [ ] 基线绿：当前 `tsc --noEmit` 双份均 exit 0（本次调研已实测），CI 上复现
