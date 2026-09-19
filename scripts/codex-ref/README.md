# codex-ref — Codex 桌面端规格抽取工具

对标物是本机安装的 **ChatGPT.app**（Codex 桌面端随其分发，渲染层代码在
`Contents/Resources/app.asar` 的 `/webview/assets/`）。复刻期间以抽取出的
**模块清单 + i18n 文案 id** 作为可验证的规格来源，替代凭截图/CSS 类名猜测。

差距分析结论见 [`docs/design/codex-desktop-parity-gap.md`](../../docs/design/codex-desktop-parity-gap.md)。

## 用法

```bash
# 1) 建索引（解析 asar 头，落 /tmp/codex-ref/index.json）
node scripts/codex-ref/index.mjs
node scripts/codex-ref/index.mjs /Applications/ChatGPT.app/Contents/Resources/app.asar

# 2) 浏览模块
node scripts/codex-ref/get.mjs --list 'codex|thread|composer'   # 按模式列模块名
node scripts/codex-ref/get.mjs --top 30                         # 最大的 30 个资源

# 3) 抽取模块源码（base 名 = 去掉 -<hash> 后缀）
node scripts/codex-ref/get.mjs app-initial app-shared \
  local-conversation-thread thread-side-panel-tab-content \
  composer-host composer-utility-bar thread-overflow-menu \
  keyboard-shortcut-command-order use-visible-settings-sections

# 4) 抽 i18n 规格（id + defaultMessage）
node scripts/codex-ref/i18n.mjs --summary      # 命名空间直方图
node scripts/codex-ref/i18n.mjs --ns composer  # 只看 composer.*
node scripts/codex-ref/i18n.mjs > /tmp/all.tsv
```

产物目录：`$CODEX_REF_DIR`（默认 `/tmp/codex-ref`）
- `index.json` — asar 全量文件索引（路径 / 大小 / 偏移）
- `out/` — 抽取出的 bundle
- `i18n.tsv` — `id <TAB> defaultMessage`

## 核心 bundle

| bundle | 内容 |
|---|---|
| `app-initial` (~12MB) | 命令注册表、快捷键、app shell、侧栏、通知、更新 |
| `app-shared` (~2.5MB) | 共享组件与命令（`composer.togglePlanMode`、`toggleSidebar` 等） |
| `local-conversation-thread` (~380KB) | 会话主视图（turn entries、工具渲染、聚合区块） |
| `thread-side-panel-tab-content` (~105KB) | Review / diff 面板全部行为 |
| `composer-utility-bar` (~45KB) | composer 底部工具条 |
| `keyboard-shortcut-command-order` (~2KB) | 命令分组与优先级排序规则 |
| `use-visible-settings-sections` (~35KB) | 设置页可见性与路由清单 |

## 注意

- ChatGPT.app 会自动更新，规格会漂移：对齐前重跑一遍，diff `i18n.tsv`。
- 抽取物是第三方受版权保护的编译产物，**仅用于本机行为对齐分析，不得入库、
  不得复制其代码/文案**；本目录只保留抽取脚本。
- `--list`/`--top` 只读索引，不解包，速度很快。
