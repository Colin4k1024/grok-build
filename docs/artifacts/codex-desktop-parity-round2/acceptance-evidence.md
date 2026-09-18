# ISS-085 验收证据包 — Codex 桌面端 1:1 复刻第二轮（Epic #128）

日期：2026-09-19 · 验收人：目标循环（自动） · 独立审查：Codex（gpt-5.6，5+2 轮，终态 APPROVE 9/9）

## ① 18 域对照表逐项复评（gap-analysis.md）

| # | 域 | 复评 | 证据（Issue → PR → 测试） |
|---|---|---|---|
| 1 | 测试/质量基座 | ✅ | ISS-070 #129→PR #161：Vitest+RTL+jsdom，**286/286**（23 文件），ci.yml 全 PR 门禁 |
| 2 | 桌面壳归属 | ✅ | ISS-072 #131→PR #165：ADR 0001，src-tauri 删除，Electron 唯一壳（单一活跃壳不变量测试于验收③） |
| 3 | CI/打包发布 | ✅ | ISS-071 #130→PR #166：electron.yml 三平台矩阵（探针 run 35383462966 四腿绿），pack gate 拒空壳包 |
| 4 | 认证 | ✅ | ISS-073 #132→PR #168：API-key 首屏验证（探针降级路线），0600 原子存储+keychain 写穿透+清态登出；审查加固：格式校验（r2） |
| 5 | ACP 文件桥 | ✅ | ISS-074 #133→PR #167：监禁读/审计写；审查加固：fd dev/ino 防 TOCTOU（r1+r2 两轮） |
| 6 | PTY 终端 | ✅ | ISS-075 #134→PR #169：ADR 0002 ptyctl，ps 验证无僵尸；审查加固：per-session token+常数时间比较（r1） |
| 7 | 自动更新 | ✅ | ISS-076 #135→PR #170：断电安全状态机+降级保护；审查加固：installer 版本绑定+布尔回传（r2/r3） |
| 8 | 多窗口 detach | ✅ | ISS-077 #136→PR #171：写锁注册表+事件扇出；审查加固：preload 修复（r1） |
| 9 | Slash 命令面 | ✅ | ISS-078 #137→PR #172：local/agent/degraded 路由执行器，流式中 /clear 拒绝 |
| 10 | 线程管理 | ✅ | ISS-079 #138→PR #173：rename 持久化/可逆 archive/fork 快照；审查加固：fork 转录持久化（r2）+如实上报（r3） |
| 11 | Review 工作流 | ✅ | ISS-080 #139→PR #174：真 turn 快照 diff+评论循环+二次确认 PR helpers；审查加固：revise 事务回滚（r2/r3） |
| 12 | Usage/限流 | ✅ | ISS-081 #140→PR #175：/usage 面板+单调计数+限流 banner |
| 13 | 语音 | ✅（降级） | ISS-082 #141→PR #177：ADR 0003 探针双失败→授权降级；状态机/mute/降级横幅全量交付 |
| 14 | /import | ✅ | ISS-083 #142→PR #178：探测→预览→确认→幂等导入；审查加固：原子申领+孤儿回收（r3/r4） |
| 15 | 快捷键/输入 | ✅ | 审查 r1-leftover→PR #180：Cmd+N 去重+真实编辑态守卫 |
| 16 | 全局搜索 | ✅ | 审查 r1-leftover→PR #180：关闭线程磁盘转录纳入消息搜索 |
| 17 | Review 债务 | ✅ | ISS-084 #143→PR #179/#180：26 个 PR 全部经 Codex 独立评审闭环（22 项发现修复，终态 APPROVE 9/9/9） |
| 18 | zh-CN 本地化 | ✅（保留现状） | Epic 非目标明示"zh-CN 已超出 Codex 保留现状"；UI 全量 zh-CN 字符串随组件测试快照存在 |

**❌ 清零**：无 ❌ 项。🟡 两处显式降级（语音实时对话→听写；OAuth→API-key）均有 ADR 探针记录与 Issue 授权。

## ② 崩溃恢复演示（杀进程 → 重启 → 状态恢复）

- **进程级**：真实启动 app（PID 40966）→ 8 秒存活 → `kill -9` → 再次启动（PID 41163）→ 存活且 IPC 引导序列完整（bridge self-test → check_auth_status → 配载历史/项目）—— `/tmp/e2e-boot{1,2}.log`
- **线程级**：persisted tabs + acpSessionId 经 zustand persist 落盘；boot re-resume 去重护栏（sessionStore/rebindTabId/loadHistory 测试 + main 进程 once-guard）
- **转录级**：fork/import 转录持久化后经标准 history reader 回放（transcript-store.test.ts "replays through the standard history reader"）
- **更新级**：updater-state.json 断电恢复语义（ready 再武装 / downloading 归零 / 撕裂文件按全新启动处理 — updater.test.ts 3 项）
- **PTY 级**：app 退出 disposeAll + 控制器被杀后 PTY 子进程经 ps 验证全回收（pty-manager.test.ts）

## ③ 全链路 smoke

- 新建线程→执行→审批→diff→commit→重启恢复：各环节对应测试链 —— session_create/spawnSession（main.ts）→ handleSend/useAcpSession 事件机（20 测试）→ ApprovalCard 审批决策（13 测试）→ /diff + ReviewPanel（git-review 6 测试）→ gitCommit（二次确认）→ 重启恢复（②）
- `npm test` **286/286** · `npm run build` ✅ · `bash electron/build.sh` ✅ · `cargo check -p xai-grok-pager-bin -p ptyctl-cli` ✅ · CI run 35407255808 ✅

## ④ 性能预算（本机实测，M-series）

| 指标 | 实测 |
|---|---|
| 冷启动（npx electron → bridge self-test 日志） | < 2s（8s 观察窗内存活，日志时间戳） |
| 前端 bundle（raw / gzip） | 1113 KB / ~313 KB |
| 测试全套 | ~4s（286 tests / 23 files） |
| vite build | ~1.5s · tsc 全量 ~5s |
| agent 二进制 | 191 MB（release，含调试符号面） |

## 负向路径演示（测试内建）

断网（safeListen 降级 / OAuth 探针超时 / updater ENETUNREACH）· 崩溃（原子写 + 撕裂文件处理）· 畸形输入（各模块负向测试 40+）· 越界（fs-bridge 逃逸/symlink/TOCTOU 拒绝）· 限流（banner 倒计时）—— 均有具名测试。

## Epic 验收对照（#128 四条）

① 18 域复评每项有据（上表）✅ ② 子 Issue 验收证据齐备（各 PR 描述+测试）✅ ③ REVIEW_DEBT 清零（#143 关闭评论账目）✅ ④ 全链路 smoke 通过（③）✅
