/**
 * UAT run state (R5-04 / #260).
 *
 * One run = one directory under .uat/runs/<id>/ containing:
 *   manifest.json  — id, startedAt, appVersion, commit, isolated env paths
 *   results.jsonl  — append-only records; the LATEST record per item wins,
 *                    so interrupting and resuming a run is just continuing
 *                    to record.
 *
 * The registry maps the 34 R4 acceptance-matrix rows (docs/design/
 * r4-release-acceptance.md §2) to stable machine IDs. A result status is
 * pass | fail | partial; the strict report rejects partials and fails
 * without a linked issue — a release gate never judges Markdown by hand.
 */

import fs from "node:fs";
import path from "node:path";

/** @typedef {{ id: string, group: string, title: string, requiresRealAccount: boolean }} UatItem */
/** @typedef {"pass" | "fail" | "partial"} UatStatus */
/** @typedef {{ item: string, status: UatStatus, at: string, executor: string, note?: string, issueUrl?: string }} UatResultRecord */
/** @typedef {{ id: string, startedAt: string, appVersion: string, commit: string, paths: { grokHome: string, journalDir: string, userData: string, workspace: string }, withCredentials: boolean }} UatManifest */

/** The R4 §2 matrix, 1:1 by row number. */
export const UAT_ITEMS = [
  // 核心会话路径
  { id: "UAT-01", group: "核心会话路径", title: "⌘N 新建会话出现在侧栏并获焦，仅触发一次", requiresRealAccount: false },
  { id: "UAT-02", group: "核心会话路径", title: "发送消息→流式输出，状态区播报运行中，列表跟随滚动", requiresRealAccount: true },
  { id: "UAT-03", group: "核心会话路径", title: "流式中点停止：播报停止中，按钮禁用直至取消完成", requiresRealAccount: true },
  { id: "UAT-04", group: "核心会话路径", title: "发送失败→错误可见，重试后恢复", requiresRealAccount: true },
  { id: "UAT-05", group: "核心会话路径", title: "⌘⇧[/⌘⇧] 或 ⌘1-9 切换线程：子树保持挂载、流式不中断、回到跟随最新", requiresRealAccount: false },
  { id: "UAT-06", group: "核心会话路径", title: "rail 切换目的地：会话子树保持挂载，返回原样恢复", requiresRealAccount: false },
  // 设置中心
  { id: "UAT-07", group: "设置中心", title: "修改任一设置：change bar 未保存→保存落盘", requiresRealAccount: false },
  { id: "UAT-08", group: "设置中心", title: "作用域切换 全局/当前项目：值正确，仅项目级设置提供项目层", requiresRealAccount: false },
  { id: "UAT-09", group: "设置中心", title: "导出：敏感项（凭证、绝对路径列表）不出现", requiresRealAccount: false },
  { id: "UAT-10", group: "设置中心", title: "导入（merge/replace）：预览列出 added/changed/reset/ignored，失败整体回滚", requiresRealAccount: false },
  { id: "UAT-11", group: "设置中心", title: "预设 safe/balanced/high-autonomy 逐项应用，单键失败不影响其他键", requiresRealAccount: false },
  { id: "UAT-12", group: "设置中心", title: "有未保存修改时离开：守卫弹出确认", requiresRealAccount: false },
  // 主题/缩放/动效
  { id: "UAT-13", group: "主题/缩放/动效", title: "深色↔浅色切换：无闪烁、无纯色块残留、focus ring ≥3:1", requiresRealAccount: false },
  { id: "UAT-14", group: "主题/缩放/动效", title: "系统高对比度模式：边框层级可分辨，无白边失控", requiresRealAccount: false },
  { id: "UAT-15", group: "主题/缩放/动效", title: "200% 缩放：布局不破、无横向滚动条、弹层不裁切", requiresRealAccount: false },
  { id: "UAT-16", group: "主题/缩放/动效", title: "窄窗口 <1000px：rail 图标态；侧栏断点隐藏可 ⌘B；<1200px Inspector 隐藏", requiresRealAccount: false },
  { id: "UAT-17", group: "主题/缩放/动效", title: "reduced-motion：页面/弹层/Toast 动效瞬时化", requiresRealAccount: false },
  // 键盘与读屏
  { id: "UAT-18", group: "键盘与读屏", title: "全程键盘：新建会话→发消息→停止→改设置→保存，无死胡同，焦点可见", requiresRealAccount: false },
  { id: "UAT-19", group: "键盘与读屏", title: "Tab 顺序：skip link→rail→侧栏→标题栏→主区→检查器", requiresRealAccount: false },
  { id: "UAT-20", group: "键盘与读屏", title: "Dialog：焦点圈定，Escape 关闭，焦点回触发器", requiresRealAccount: false },
  { id: "UAT-21", group: "键盘与读屏", title: "DropdownMenu：方向键/Home/End 跳过禁用项；Escape 只关菜单", requiresRealAccount: false },
  { id: "UAT-22", group: "键盘与读屏", title: "VoiceOver：rail/图标按钮/Toast 有可访问名称；状态变化进 live region", requiresRealAccount: false },
  // 性能观察
  { id: "UAT-23", group: "性能观察", title: "页面快速来回切换 ×20：无可见掉帧，主进程无长任务卡顿", requiresRealAccount: false },
  { id: "UAT-24", group: "性能观察", title: "长列表（200+ 消息）滚动：不跳动，IO 重测正常", requiresRealAccount: false },
  { id: "UAT-25", group: "性能观察", title: "流式输出期间：渲染节流，无明显风扇/卡顿", requiresRealAccount: false },
  { id: "UAT-26", group: "性能观察", title: "Inspector 展开/收起：瞬时切换，主区回流无抖动", requiresRealAccount: false },
  // 自动化与插件管理
  { id: "UAT-27", group: "自动化与插件", title: "Automations 创建定时任务：出现在列表，状态徽章正确", requiresRealAccount: false },
  { id: "UAT-28", group: "自动化与插件", title: "Automations 暂停/恢复/删除：状态即时切换，删除有确认，列表同步", requiresRealAccount: false },
  { id: "UAT-29", group: "自动化与插件", title: "插件：浏览市场/已安装、安装、启用/停用、卸载，失败有错误提示", requiresRealAccount: false },
  { id: "UAT-30", group: "自动化与插件", title: "Agents/Dashboard 空态 EmptyState；Automations 错误态带重试", requiresRealAccount: false },
  // 安装与持久化
  { id: "UAT-31", group: "安装与持久化", title: "挂载 dmg→拷贝安装→首次启动：正常到首页，无白屏", requiresRealAccount: false },
  { id: "UAT-32", group: "安装与持久化", title: "新建会话发一条消息：端到端可用", requiresRealAccount: true },
  { id: "UAT-33", group: "安装与持久化", title: "修改设置→完全退出→重启：设置保持", requiresRealAccount: false },
  { id: "UAT-34", group: "安装与持久化", title: "删除 gb-settings.json→重启：从 localStorage 回种，不丢设置", requiresRealAccount: false },
];

export const UAT_ITEM_IDS = UAT_ITEMS.map((i) => i.id);

export const UAT_STATUSES = ["pass", "fail", "partial"];

export function runsRoot(repoRoot) {
  return path.join(repoRoot, ".uat", "runs");
}

export function runDir(repoRoot, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
  return path.join(runsRoot(repoRoot), runId);
}

/** @returns {UatManifest} */
export function readManifest(repoRoot, runId) {
  const file = path.join(runDir(repoRoot, runId), "manifest.json");
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

/** @param {UatManifest} manifest */
export function writeManifest(repoRoot, manifest) {
  const dir = runDir(repoRoot, manifest.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** @param {UatResultRecord} record */
export function appendResult(repoRoot, runId, record) {
  if (!UAT_ITEM_IDS.includes(record.item)) {
    throw new Error(`unknown UAT item: ${record.item}`);
  }
  if (!UAT_STATUSES.includes(record.status)) {
    throw new Error(`invalid status: ${record.status}`);
  }
  const dir = runDir(repoRoot, runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, "results.jsonl"), JSON.stringify(record) + "\n");
}

/** Latest record per item wins; absent items are unexecuted. */
export function collectResults(repoRoot, runId) {
  const file = path.join(runDir(repoRoot, runId), "results.jsonl");
  /** @type {Map<string, UatResultRecord>} */
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    out.set(rec.item, rec);
  }
  return out;
}

/**
 * @returns {{ runId: string, rows: { item: UatItem, record: UatResultRecord | null }[],
 *   counts: { pass: number, fail: number, partial: number, missing: number },
 *   strictFailures: string[] }}
 */
export function buildReport(repoRoot, runId) {
  const results = collectResults(repoRoot, runId);
  const rows = UAT_ITEMS.map((item) => ({
    item,
    record: results.get(item.id) ?? null,
  }));
  const counts = { pass: 0, fail: 0, partial: 0, missing: 0 };
  const strictFailures = [];
  for (const { item, record } of rows) {
    if (!record) {
      counts.missing += 1;
      strictFailures.push(`${item.id} 未执行`);
      continue;
    }
    if (record.status === "partial") {
      counts.partial += 1;
      strictFailures.push(`${item.id} 部分通过（必须收敛为 pass/fail）`);
      continue;
    }
    if (record.status === "fail") {
      counts.fail += 1;
      if (!record.issueUrl) {
        strictFailures.push(`${item.id} 失败但未关联 issue URL`);
      }
      continue;
    }
    counts.pass += 1;
  }
  return { runId, rows, counts, strictFailures };
}
