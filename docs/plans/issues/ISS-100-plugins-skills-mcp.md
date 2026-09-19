> Epic: #128 (ISS-069) · 批次: B5 · 标签: `parity-slice` `plugins` `mcp` `priority/P1` `frontend`
> 规格来源: 差距文档 §I(I1–I6) §A7/A8/A9；实物模块 `plugins-page` `plugins-store-page` `plugin-detail-page` `plugin-installation-content`(87KB) `plugin-picker-menu-content` `plugin-share-dialog` `plugin-skill-preview` `plugin-request-empty-state` `plugin-disabled-reason` `plugin-connected-account-links` `use-plugin-installation` `use-plugin-scheduled-tasks` `mcp-extension-plugin` `mcp-settings` `skills-settings` `settings-plugin-selection` `mcp-server-elicitation-request-panel`；文案 `plugins.*`(38) `skills.*`(100) `settings.mcp.*`(56) `codex.mcpTool.*`(75) `composer.skillMentionList.*`(9)

## 目标

把"硬编码 MCP catalog 冒充插件市场"纠正为真实的 **Plugins / Skills / MCP** 三套体系：插件市场与安装流、技能页与开关、MCP 连接管理面（状态/工具开关/OAuth/elicit/资源浏览）。

## 范围

1. **Plugins**（走 agent，不用前端硬编码）：
   - 列表/商店/详情/分区：`x.ai/plugins/{list,action,reload,notify-updates}` + `x.ai/marketplace/{list,action}` + `x.ai/pluginDirs`
   - 安装流：`use-plugin-installation` + `plugin-installation-content`（进度、权限确认、安装后配置、卸载清理）
   - `plugin-detail-page` / `plugin-details` / `plugin-skill-preview` / `plugin-disabled-reason` / `plugin-connected-account-links` / `plugin-settings-url` / `plugin-picker-menu-content` / `plugin-request-empty-state`
   - 分享：`plugin-share-dialog` → **本地导出**（云端分享 OUT）
   - 定时任务：`use-plugin-scheduled-tasks`（查看/管理插件的 scheduled tasks，与 ISS-101 协同）
   - 重写 `PluginManager.tsx`（当前 454 行硬编码 CATALOG）
2. **Skills**：
   - `skills-settings` 页 + `skills.*` 100 条：列表、来源分类（built-in / project / plugin / local file / admin）、开关、添加/移除/重置/刷新基线
   - `x.ai/skills/{list,add,remove,toggle,config,reset,refresh-baseline}`；命令 `openSkills` / `forceReloadSkills`
   - composer 的 `$` mention 数据源统一到这里（ISS-092）
   - 替换 `electron/main.ts:476` 的目录扫描实现（`~/.grok`+`~/.agents`+`~/.codex`+`~/.claude`）为 agent 真值
3. **MCP**：
   - `mcp-settings` 页（56 条）：服务器列表、连接状态（`server_status`/`init_progress`）、工具列表与逐个开关（`toggle_tool`/`tools_changed`）、增删改（`upsert`/`delete`）、启用开关（`toggle`）、OAuth（`auth_status`/`auth_trigger`）、elicit 请求面板（`mcp-server-elicitation-request-panel`）、资源浏览（`read_resource`）
   - side panel 的 MCP tab（`thread-mcp-app-side-panel-tab` / `mcp-extension-thread-side-panel-tab` / `mcp-extension-side-panel-tab-frame`）：当前会话可见的 MCP 服务器 + 工具调用历史
   - 消息流的 MCP 工具调用卡（`codex.mcpTool.*` 75 条，与 ISS-095 协同）
   - `x.ai/mcp/*` + 反向 `x.ai/mcp/sdk_call`（in-process SDK MCP server，ISS-087 提供通道）
   - **保留** `electron/mcp-config.ts` 的 config.toml 外科手术式编辑作为写入实现（有 round-trip 测试），但状态读取改走 agent
4. 设置页联动：`settings-plugin-selection` / `plugins-settings` / `plugins-settings-row` / `canonical-plugin-query` / `category-plugins-query` / `use-search-plugins`（搜索）

## 非目标

- MCP app 的 WebMCP/浏览器扩展形态（`webmcp-tool-calls` 依赖浏览器 tab，OUT）
- 云端插件商店账号体系、插件付费/评分
- `mcp-extension-plugin` 中依赖 ChatGPT 平台 connector 的部分
- 插件的沙箱隔离实现（沿用 agent 侧既有机制，不改）

## 依赖

- ISS-087（plugins / marketplace / skills / mcp 扩展域 + 反向 `sdk_call`）
- ISS-102（Settings 容器：plugins / skills / mcp 三页）
- ISS-091（side panel MCP tab 容器）
- ISS-095（消息流 MCP 工具卡）
- ISS-101（插件定时任务）

## 回滚

三块各自 flag（`plugins.v2` / `skills.v2` / `mcp.v2`）。回滚 = 恢复现有 `PluginManager.tsx`（MCP catalog）+ `McpManager.tsx`（config.toml 编辑）+ `main.ts:476` 的技能扫描。`~/.grok/config.toml` 的 `[mcp_servers.*]` 格式不变，故回滚无数据迁移。已安装的 agent 侧插件不受前端回滚影响。

## 验收标准

### 状态机不变量
- 插件状态机：`notInstalled → installing(progress) → installed(enabled|disabled(reason)) → uninstalling → notInstalled`；任一失败态可重试且不残留半成品
- UI 显示的安装集合 == `x.ai/plugins/list` 真值；`reload` 后一致
- 技能开关状态 == `x.ai/skills/list` 返回值；toggle 后立即反映，不需重启
- MCP 服务器状态机：`configured → connecting(init_progress) → connected | failed(reason) | needsAuth`；工具开关集合 == `toggle_tool` 后的真值
- MCP 工具被禁用 ⟹ 该工具不出现在 agent 可用工具中（可通过一次实际调用验证）
- `sdk_call` 反向调用的 serverId 必须在 `session/new` 声明的 `x.ai/mcp/servers` 集合内

### 负向场景
- 插件安装失败（网络/权限/依赖缺失/校验失败）→ 明确原因 + 可重试 + 不留半成品目录
- 插件被禁用 → `plugin-disabled-reason` 显示具体原因（而非只显示灰态）
- MCP server 启动超时/命令不存在/env 缺失 → `failed` + 原因 + `init_progress` 的最后状态
- MCP OAuth 未完成/过期 → `needsAuth` + `auth_trigger` 入口；取消授权后回到未连接
- elicit 请求被用户拒绝/超时 → agent 侧收到明确拒绝，不永久挂起
- 技能来源目录缺失/无 SKILL.md/格式错误 → 该行降级显示或跳过，不整页失败
- 搜索无结果 → `plugin-request-empty-state` / `composer.skillMentionList.noResults`
- config.toml 手写坏（语法错误）→ MCP 页显示解析错误与文件位置，不崩

### 并发 / 崩溃 / 恢复
- 同时安装两个插件 → 进度独立、互不干扰；一个失败不影响另一个
- 安装中 kill app → 重启后状态收敛（installed 或 notInstalled），无"installing 永久卡住"
- MCP server 崩溃/被外部 kill → 状态转 failed 并可重连；`x.ai/mcp/tools_changed` / `servers_updated` 通知实时刷新 UI
- agent 重启 → 插件/技能/MCP 状态全部重新拉取并校正
- 多窗口同时改 MCP 配置 → 最终一致，config.toml 不出现并发写损坏（需串行化写入）
- `forceReloadSkills` 与技能扫描并发 → 结果确定，无重复项

### 外部副作用检查
- **插件安装是最高风险面之一**：安装前必须展示将执行的命令/将写入的目录/所需 env，并二次确认；卸载必须清理其创建的配置
- 写 `~/.grok/config.toml` 必须外科手术式（沿用 `scripts/test-mcp-config.mjs` round-trip 断言：无关段逐字保留）
- MCP env 中的密钥写入后 UI 不得回显明文（只显示是否已设置）；日志不得打印
- 插件目录只允许在 `GROK_HOME` 与用户显式选择的路径内；路径穿越被拒
- `x.ai/marketplace/action` 涉及下载 → 需可见的进度与取消；不得静默后台下载
- 技能/插件不得在无用户操作时被自动启用（`notify-updates` 只提示，不自动装）

### Parity 勾选项
- [ ] I1 插件页/商店页/详情页/分区；I2 安装流（进度+权限确认）
- [ ] I3 插件定时任务；I4 分享（本地导出）/技能预览/已连接账号/禁用原因/picker
- [ ] I5 skills-settings + `skills.*` 100 条；I6 mcp-settings + `settings.mcp.*` 56 条
- [ ] A7/A8/A9 接线；`codex.mcpTool.*` 75 条（与 ISS-095 分摊）
- [ ] 死代码/假数据清零：`PluginManager.tsx` 硬编码 CATALOG、`main.ts:476` 目录扫描
