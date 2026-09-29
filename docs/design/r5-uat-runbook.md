# R5 桌面 UAT Runbook（R5-04 / #260）

> 用与真实用户数据完全隔离的环境执行发布验收矩阵。34 项矩阵的机读定义在
> `scripts/lib/uat-state.mjs`（`UAT-01`..`UAT-34`，与
> `docs/design/r4-release-acceptance.md` §2 行号一一对应）。
> 本文档是执行规程；验收结论由 `uat:report --strict` 机器判定，不靠人工读 Markdown。

## 1. 准备（prepare）

```bash
npm run electron:pack            # 先产出本轮待验包（release/mac-arm64/…）
npm run uat:prepare -- --with-credentials
```

`prepare` 在 `.uat/runs/<run-id>/` 下创建隔离环境并输出 manifest：

- `grok-home/` — 隔离的 `GROK_HOME`（含空 sessions；`--with-credentials` 时从真实
  `~/.grok` **只读复制** `api_keys.json`/`auth.json` 进来，mode 0600；非敏感的
  模型目录缓存 `default_models.json`/`version.json` 总是注入——否则 agent 首次启动
  会联网拉目录，在慢网络下 serve 永不就绪）
- `journal/` — 隔离的 `GB_JOURNAL_DIR`
- `user-data/` — 隔离的 Electron `userData`（应用经 `GB_UAT_USER_DATA_DIR` 在
  `app.ready` 前重定向；非绝对路径直接拒绝启动）
- `workspace/` — fixture 工作区

凭证只进运行目录；`.uat/` 已 gitignore，永不发布。`npm run uat:clean -- --run <id>`
连同凭证一起删除运行目录。

## 2. 执行（run + record）

```bash
npm run uat:run -- --run <id>    # 以隔离环境启动本轮打包的 App
```

逐项执行矩阵并即时记录（每项一条；重复记录同项时最新覆盖——中断后重开同一 run
即恢复进度）：

```bash
npm run uat:record -- --run <id> --item UAT-07 --status pass --note "落盘验证通过"
npm run uat:record -- --run <id> --item UAT-22 --status fail --note "缺少名称" \
  --issue https://github.com/Colin4k1024/grok-build/issues/NNN
```

规则：

- 状态只有 `pass` / `fail` / `partial`；`partial` 在 strict 报告中等同未完成，
  必须收敛为 pass 或 fail。
- `fail` 必须附独立 GitHub issue URL（先立案再记录）。
- 标 `requiresRealAccount` 的项（UAT-02/03/04/32）必须真发消息，不得 mock。

## 3. 报告（report）

```bash
npm run uat:report -- --run <id>            # 打印矩阵状态
npm run uat:report -- --run <id> --strict   # 门禁：未执行/部分通过/失败无 issue → 非零
npm run uat:report -- --run <id> --write    # 把结果回填到 r4-release-acceptance.md §2
```

## 4. 隔离验证（每次 UAT 必须附带）

运行前后对真实 `~/.grok` 做递归快照并 diff——必须零差异：

```bash
find ~/.grok -type f | sort > /tmp/grok-before.txt
# … uat:run 执行全部矩阵 …
find ~/.grok -type f | sort > /tmp/grok-after.txt
diff /tmp/grok-before.txt /tmp/grok-after.txt   # 必须无输出
```
