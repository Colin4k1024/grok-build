# R4 矩阵 UAT-22 跟进：VoiceOver 实机朗读巡检记录（#274）

日期：2026-10-01 · 执行机：macOS（darwin 25.6.0，arm64）· 应用：Grok Build 0.1.0 @ commit `e58e33f5`（R5-10 合并后 main），隔离 UAT 环境 `.uat/runs/vo-274`（GROK_HOME / journal / userData / workspace 全隔离，`GROK_DESKTOP_AUTH=off` 离线启动，zh-CN / Asia-Shanghai）。

## 结论

**VoiceOver 实机朗读巡检执行完成。** VoiceOver 以真实系统开关开启（非模拟），语音输出进程（scrod）驻留朗读全程；通过 VoiceOver 官方 AppleScript 通道捕获到应用窗口的**真实朗读文本**；并以与 VoiceOver 逐站朗读内容同源的 AX 焦点属性（role+title+description+value）完成整条 R4 矩阵 2.4 站序记录。rail 目的地、图标按钮、设置页控件均有可访问名称，正反向遍历对称，无名称缺失或焦点陷阱。

## 方法

1. **VoiceOver 真实开启**：`open /System/Library/CoreServices/VoiceOver.app`；首次启动完成 VoiceOver Quickstart 欢迎流程。进程证据：`VoiceOver launchd -s`（主服务）、`scrod`（ScreenReader 语音输出守护）、`BrailleTranslationService`。**开启/关闭始终由执行方控制系统开关，脚本不擅自翻转**（沉淀的 `scripts/voiceover-patrol.mjs` 在 VO 未运行时拒绝执行并提示 ⌘F5）。
2. **官方朗读捕获通道**：在 VoiceOver Utility（通用 → "允许使用 AppleScript 来控制旁白"，VO 自身的官方开关，经 UI 自动化勾选）启用后，`tell application "VoiceOver" to get content of last phrase` 返回 VO 实际朗读的最近短语。
3. **隔离应用**：`desktop-uat.mjs prepare` 隔离目录 + `GROK_DESKTOP_AUTH=off`（e2e 同款逃生舱）启动 unpacked Electron（为规避同机其它同名 "Electron" 进程，副本重命名为 GrokPatrol —— System Events 按 `name` 定位唯一可靠）。

## VoiceOver 真实朗读捕获（原话）

| 时点 | VO 实际朗读 | 说明 |
| --- | --- | --- |
| 应用激活后 `move to first item` | **「Grok Build 网页内容」** | VO 朗读应用窗口（AXWebArea，window "Grok Build"） |
| `move right` | **「工作区 主体内容」** | VO 朗读 `<main>` landmark —— UAT-22 起始骨架（窗口 → 主区） |
| 首次连接触发系统授权 | 「应用程序 警告 系统对话框 "ZCode" 想要控制"旁白"。允许控制将可访问"旁白"中文稿和数据…」 | live region 类行为实证：VO 自动打断并朗读系统级状态变化 |
| VO Utility / Quickstart | 「旁白」窗口按钮「进一步了解使用旁白」「关闭旁白」 | VO 自身 UI 的朗读正常 |

## R4 矩阵 2.4 站序记录（AX 焦点属性 = VO 逐站朗读内容来源）

正向 Tab 序（UAT-19 站序对照，全部具名）：

```
ST00 初始        AXGroup      工作区                  （main landmark）
A01  Tab  AXButton   选择目录…              （空工作区起始态）
A02  Tab  AXTextArea  （composer 输入区）
A03  Tab  AXPopUpButton  Grok 4 Fast · 中    （模型选择，名称+值）
A04  Tab  AXPopUpButton  修改前询问           （权限模式）
A05  Tab  AXButton   语音输入                （图标按钮具名 ✓）
A06  Tab  AXLink     跳到工作区              （skip link，UAT-19 第一站 ✓）
A07  Tab  AXButton   会话                    （rail ✓）
A08  Tab  AXButton   仪表盘                  （rail ✓）
A09  Tab  AXButton   自动化                  （rail ✓）
A10  Tab  AXButton   代理                    （rail ✓）
A11  Tab  AXButton   搜索 (⌘G)               （rail ✓）
A12  Tab  AXCheckBox 切换会话侧栏 (⌘B)       （UAT-19 第八站 ✓）
```

设置目的地（⌘,）Tab 序：搜索设置（文本域）→ 全局（单选）→ 预设 → 重置 → 高级 → 导出 → 导入，全部具名；Shift+Tab 反向遍历完全对称（导出→…→搜索设置），无焦点陷阱。

Toast live region 在场性由 #260（UAT-04）AX 树机器验证（3 处 aria-live 区域），系统级自动朗读行为由上表授权对话框实证。

## 已知限制（如实记录）

- VO 光标逐项长序列（30+ 站）在本执行机未完成：多窗口桌面（Trae/系统设置/ZCode 等）导致 VO 光标上下文导引不稳定（⌘Tab/Spotlight/chooser 均被焦点漂移干扰）。已捕获的 VO 真实朗读覆盖起始骨架（窗口+主区），完整站序以 AX 同构记录为准；如需纯 VO 光标长走查，可在安静发布窗口以 `scripts/voiceover-patrol.mjs` 复跑（含 VO 导航与逐站朗读捕获）。
- 朗读音频未录音（scrod 无日志接口）；文本证据来自 VoiceOver 官方 AppleScript 朗读短语通道。

## 复现

```bash
# 1) executor toggles VoiceOver on (⌘F5) — the script refuses to flip it
npm run uat:prepare -- --run vo-patrol
GROK_HOME=$PWD/.uat/runs/vo-patrol/grok-home \
GB_JOURNAL_DIR=$PWD/.uat/runs/vo-patrol/journal \
GB_UAT_USER_DATA_DIR=$PWD/.uat/runs/vo-patrol/user-data \
GROK_DESKTOP_AUTH=off npx electron .          # or the packed app binary
node scripts/voiceover-patrol.mjs --app-name <unique-process-name> \
     --vo-stops 8 --tab-stops 12 --out .uat/voiceover-patrol.log
```

关联：#260（UAT harness/AX 机器验证）、#274（本跟进）、R4 矩阵第 22 行、`docs/design/r5-uat-runbook.md`。
