# ADR 0003: 语音走"明确降级"——保留听写，不引入实时对话

- 状态：Accepted
- 日期：2026-09-19
- 决策人：ISS-082（#141 / Epic #128 第二轮）

## 探针结果（2026-09-19）

Issue 要求"先做能力探针（Grok 侧 realtime 端点 / agent realtime 能力），再定实施或明确降级"：

1. **Agent 侧**：workspace 无任何 realtime/WebRTC/voice-session 能力
   （`crates/` 全量 grep：无 webrtc、无 voice session、无 realtime 音频通路；
   pager 中的 "realtime" 命中均为 UI/计时器语境）。
2. **端点侧**：应用未配置任何 realtime 端点；探针环境无法建立到
   `api.x.ai` 的出站连接（curl 全部超时，无法证实端点存在性）；
   应用亦未集成 WebRTC 客户端栈。
3. **凭据侧**：ISS-073 落地的认证面为 API-key（无 realtime 会话凭据形态）。

**判定：两条腿均失败 → 按 Issue 授权执行"明确降级保留现状"。**

## 决策

保留 Ctrl+M hold-to-talk **听写**（Web Speech API，进程内转录，不落盘），
并将听写层升级到验收要求的形态：

- 形式化语音状态机 `idle→connecting→live⇄muted→ended→idle`
  （`src/lib/voiceMachine.ts`，纯函数可测）
- **mute**：录音中 Ctrl+Shift+M 或按钮切换 —— 暂停捕捉但会话保持
  （静音指示 + 恢复路径）
- **负向降级显式化**：引擎缺失 / 麦克风未授权 / 网络失败 →
  黄色降级横幅（"已降级为键盘输入"），绝不静默无效
- **并发**：语音层从不调用 textarea focus —— 与文本输入并发不抢焦点；
  转录仅追加文本
- **录音不落盘**：Web Speech 转录仅在内存/消息流，无任何音频文件写出

## 未来升级路径

设置 `VITE_GROK_REALTIME_URL`（https）后 `realtimeVoiceAvailable()` 翻真，
实时对话模式（WebRTC）届时在 `voiceMachine` 上扩展 `connecting→live` 的
媒体面，状态机无需重构。

## 回滚

入口即现状（Ctrl+M 听写）；降级横幅与 mute 为纯增强，隐藏即回滚。
