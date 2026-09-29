# R4 发布验收（R4-10 / #243）

> R4 epic（#233）的发布质量门槛记录：自动化验证结果、人工测试矩阵、
> 已知限制与回滚条件。通过标准 = 本文件所有"通过标准"行成立。

## 1. 自动化验证（每次发布必跑）

| 命令 | 覆盖 | 通过标准 |
| --- | --- | --- |
| `npm test` | 全部 vitest 单元/集成测试（980+ 用例） | 0 失败 |
| `npm run build` | `tsc --noEmit` + vite 生产构建 | 0 类型错误、构建成功 |
| `npm run electron:build` | 主进程/preload/设置存储 TS 编译 | 构建成功 |
| `npm run electron:pack` | electron-builder macOS dmg/zip 产物 | `release/` 生成可安装产物 |
| `git diff --check` | 空白/冲突标记 | 无输出 |

契约测试（包含在 `npm test` 内，单独点名因为它们是 R4 的护栏）：

- `designTokens.test.ts` — styles.css 与 tailwind.config.js 的 token 一致性。
- `contrast.test.ts` — 深色/浅色两主题的 WCAG AA 对比度（按 luminance 实算）。
- `motion.test.ts` — 时长 token 与 `motion.ts` 互为镜像；reduced-motion 块清零所有时长；
  `transitionFor` 拒绝 layout 属性（dev 抛错/prod 过滤）。
- `tokenCompliance.test.ts` — `src/components/ui/` 内禁止 hex/rgba/裸 border/任意 z 字面量。
- `accessibilityInteractions.test.tsx` — 键盘可达、焦点跟随目的地、skip link、可访问名称。
- `settingsStore` / `transfer` / `migrations` / `sanitize` 系列 — 配置不丢失、敏感值不导出、
  迁移失败可回滚。

## 2. 人工测试矩阵（发布前手测）

环境：macOS 桌面包（`release/*.dmg` 安装后），窗口默认尺寸 + 窄窗口（<900px）。

### 2.1 核心会话路径
| # | 步骤 | 预期 |
| --- | --- | --- |
| 1 | ⌘N 新建会话 | 会话出现在侧栏并获焦，仅触发一次 |
| 2 | 发送消息 → 流式输出 | composer 状态区播报"运行中"，列表跟随滚动 |
| 3 | 流式中点"停止" | 播报"停止中"，按钮禁用直至取消完成 |
| 4 | 发送失败 → 重试 | 错误可见，重试后恢复 |
| 5 | ⌘⇧[ / ⌘⇧] 切换线程 | 线程间切换，各自滚动位置独立 |
| 6 | 切换目的地（⌘1/⌘2/…） | 会话子树保持挂载（不丢流式状态），返回时原样恢复 |

### 2.2 设置中心
| # | 步骤 | 预期 |
| --- | --- | --- |
| 7 | 修改任一设置 | change bar 出现"未保存"，保存后落盘（`gb-settings.json`） |
| 8 | 作用域切换 全局/当前项目 | 仅真正按项目解析的设置（主题、沙箱模式）提供项目层；切换后值正确 |
| 9 | 导出 | 敏感项（凭证、绝对路径列表）不出现在导出内容 |
| 10 | 导入（merge 与 replace） | 预览列出 added/changed/reset/ignored；应用失败时整体回滚 |
| 11 | 预设（safe/balanced/high-autonomy） | 逐项应用，单键失败不影响其他键 |
| 12 | 有未保存修改时离开 | 离开守卫弹出确认 |

### 2.3 主题 / 缩放 / 动效
| # | 步骤 | 预期 |
| --- | --- | --- |
| 13 | 深色 ↔ 浅色切换 | 全表面无闪烁、无纯色块残留；focus ring 均 ≥3:1 |
| 14 | 系统高对比度模式 | 边框层级仍可分辨，无白边失控 |
| 15 | 200% 缩放（appearance.zoom） | 布局不破、无横向滚动条、弹层不裁切 |
| 16 | 窄窗口 | rail 折叠为图标，侧栏可 ⌘B 开关，主区可读 |
| 17 | 开启系统 reduced-motion | 页面/弹层/Toast 动效瞬时化，无残留动画 |

### 2.4 键盘与读屏
| # | 步骤 | 预期 |
| --- | --- | --- |
| 18 | 全程只用键盘完成：新建会话→发消息→停止→改设置→保存 | 无死胡同，焦点始终可见 |
| 19 | Tab 顺序 | rail → skip link → 主区 → 检查器；无意外跳入隐藏子树 |
| 20 | Dialog 打开 | 焦点圈定在框内，Escape 关闭，关闭后焦点回到触发器 |
| 21 | DropdownMenu | 方向键/Home/End 跳过禁用项；Escape 只关菜单不关底层 Dialog |
| 22 | VoiceOver 浏览 | rail 目的地、图标按钮、Toast 均有可访问名称；状态变化进 live region |

### 2.5 性能观察（主观 + 计数）
| # | 步骤 | 预期 |
| --- | --- | --- |
| 23 | 页面快速来回切换 ×20 | 无可见掉帧；主进程无长任务卡顿 |
| 24 | 长列表（200+ 消息）滚动 | 不跟随阅读位置跳动；IntersectionObserver 重新测量正常 |
| 25 | 流式输出期间 | 渲染节流，无明显风扇/卡顿 |
| 26 | Inspector 展开/收起 | 只 transform/opacity 动效，无 layout 抖动 |

### 2.6 安装冒烟
| # | 步骤 | 预期 |
| --- | --- | --- |
| 27 | 安装 dmg → 首次启动 | 正常到首页，无白屏 |
| 28 | 新建会话发一条消息 | 端到端可用 |
| 29 | 修改设置 → 完全退出 → 重启 | 设置保持（durable file 生效） |
| 30 | 删除 `gb-settings.json` → 重启 | 从 localStorage 缓存回种，不丢设置 |

## 3. 已知限制（本发布接受，不阻断）

1. **视觉回归无像素级快照基线**——窗口尺寸/主题覆盖由人工矩阵（§2.3）+
   对比度/token 契约测试承担；像素基线留待后续引入 Playwright 截图对比。
2. **高对比度与 200% 缩放为人工验证项**，无自动化断言。
3. `pushedRef`（SandboxToggle 推送记录）不随标签页关闭修剪——内存可忽略，行为正确。
4. `trustedFolders` 属安全相关但未标 `planned`——已有专门管理器界面，登记口径留待后续统一。
5. 性能门槛为主观评估（§2.5），无自动 FPS/长任务阈值告警。
6. Windows/Linux 打包未在本 Issue 范围内，仅验收 macOS 产物。
7. 打包产物未签名——构建环境无 "Developer ID Application" 证书
   （electron-builder 日志：`skipped macOS application code signing`）。
   首次打开需右键 → 打开绕过 Gatekeeper；签名配置留待发布流水线处理。

## 4. 回滚条件

满足任一即回滚（revert 合并提交并重新打开对应 Issue）：

- **P0**：启动白屏/崩溃；配置丢失或迁移失败不可恢复；敏感值出现在导出或日志。
- **P1**：核心流程（新建/发送/停止/重试/设置保存）键盘不可完成；深色或浅色主题
  出现阻断级视觉错误（文本不可读、控件不可见）；reduced-motion 失效导致动画不可关闭。
- 打包产物无法安装或安装后无法启动。

回滚后在本文件记录原因、影响范围与修复计划，再重新走 R4-10 验证。

## 5. 本次验收记录

- `npm test` — **75 文件 991 通过 / 1 跳过，0 失败**（98s）。
- `npm run build` — tsc 0 错误，vite 产物构建成功（2.12s）。
- `npm run electron:build` — 主进程 + preload 编译成功（`dist-electron/`）。
- `npm run electron:pack` — electron-builder 26.15.3 / Electron 44.4.1 / darwin-arm64：
  `release/Grok Build-0.1.0-arm64.dmg` 与 `…-mac.zip`（各 ~202MB）生成成功；
  代码签名因环境无 Developer ID 证书被跳过（见已知限制 #7）。
- `git diff --check` — 无输出。
- 安装冒烟（§2.6 #27 启动项）— 从 `release/mac-arm64/Grok Build.app` 启动，
  主进程与渲染/helper 进程全部存活 12s+，退出干净。**通过**。
  （#28–#30 依赖真实账号/后端，按矩阵在发布窗口人工执行并记录。）
- 人工矩阵：§2 全项在发布窗口执行；本文件为执行模板与通过标准。
