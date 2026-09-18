import { useEffect, useMemo, useState } from "react";
import {
  claudeProbe,
  claudeListSessions,
  claudeImportInstructions,
  claudeClaimSession,
  claudeUnmarkSession,
  persistTranscript,
  createSession,
  type ClaudeSessionItem,
} from "../../lib/tauri";
import { useSessionStore } from "../../stores/sessionStore";

interface ImportPanelProps {
  onClose: () => void;
  /** Project root for the optional CLAUDE.md → AGENTS.md merge. */
  projectRoot: string | undefined;
}

/**
 * Selective /import from Claude Code (ISS-083): read-only probe →
 * preview checklist → explicit confirm → import. Sessions are seeded as
 * new threads (fresh backend id, local transcript copy); instructions
 * merge into the project's AGENTS.md under an idempotent marker.
 */
export function ImportPanel({ onClose, projectRoot }: ImportPanelProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<ClaudeSessionItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mergeInstructions, setMergeInstructions] = useState(false);
  const [report, setReport] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    claudeProbe().then((p) => {
      setAvailable(p.available);
      if (p.available) {
        claudeListSessions().then((list) => {
          setSessions(list);
          setSelected(new Set(list.slice(0, 3).map((s) => s.sourceId)));
        });
      }
    });
  }, []);

  const anySelected = selected.size > 0 || mergeInstructions;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runImport = async () => {
    setBusy(true);
    setReport([]);
    const lines: string[] = [];
    for (const id of selected) {
      // Atomic claim (review r3): registry check + parse + registration in
      // one main-process step — a stale preview or a second window can never
      // produce a duplicate destination. The claim is released if creation
      // fails, keeping the source retryable.
      const info = sessions.find((s) => s.sourceId === id);
      const claim = await claudeClaimSession(id);
      if (claim.status === "already-imported") {
        lines.push(`• 会话 ${id.slice(0, 8)} 此前已导入（跳过）`);
        continue;
      }
      if (claim.status === "error") {
        lines.push(`✗ 会话 ${id.slice(0, 8)}：${claim.message}`);
        continue;
      }
      const entries = claim.entries.filter(
        (e) => e.role === "user" || e.role === "assistant"
      );
      try {
        const created = await createSession(info?.cwd ?? projectRoot ?? ".");
        const title = `导入 · ${info?.title ?? id.slice(0, 8)}`;
        await persistTranscript({
          acpSessionId: created.acp_session_id,
          cwd: created.cwd,
          title,
          entries,
        });
        useSessionStore.getState().addTab({
          id: created.id,
          acpSessionId: created.acp_session_id,
          title,
          cwd: created.cwd,
          model: created.models[0]?.id ?? "",
          reasoningEffort: "medium",
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        });
        useSessionStore.getState().loadHistoryMessages(created.id, entries);
        lines.push(`✓ 会话 ${id.slice(0, 8)} 已导入（${entries.length} 条${claim.skippedLines ? `，跳过 ${claim.skippedLines} 行损坏` : ""}，已持久化）`);
      } catch (e) {
        await claudeUnmarkSession(id).catch(() => {});
        lines.push(`✗ 会话 ${id.slice(0, 8)} 建线程失败（已释放申领，可重试）：${String(e)}`);
      }
    }
    if (mergeInstructions && projectRoot) {
      const r = await claudeImportInstructions(projectRoot);
      lines.push(
        r.status === "merged"
          ? "✓ CLAUDE.md 已合并进项目 AGENTS.md（幂等标记）"
          : r.status === "already"
            ? "• AGENTS.md 此前已合并（幂等跳过）"
            : `✗ 指令合并失败：${r.message ?? r.status}`
      );
    }
    setReport(lines);
    setBusy(false);
  };

  const summary = useMemo(
    () => (available === null ? "探测中…" : available ? null : "未检测到 ~/.claude 数据 — 无可导入内容"),
    [available]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={busy ? undefined : onClose}>
      <div
        className="w-[520px] rounded-xl border border-gb-border bg-gb-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold text-gb-text">从 Claude Code 导入</h2>
          <button className="text-xs text-gb-muted hover:text-gb-text" onClick={onClose} disabled={busy}>✕</button>
        </div>

        {summary && <p className="py-3 text-center text-[11px] text-gb-muted">{summary}</p>}

        {available && (
          <>
            <p className="mb-2 text-[10px] text-gb-muted">
              预览清单 — 源目录只读；确认后才会写入（会话以新线程导入，指令合并进 AGENTS.md）。
            </p>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {sessions.length === 0 && (
                <p className="py-2 text-center text-[11px] text-gb-muted">没有可导入的会话。</p>
              )}
              {sessions.map((s) => (
                <label
                  key={s.sourceId}
                  className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] ${s.imported ? "opacity-50" : "cursor-pointer hover:bg-gb-surface-hover"}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.sourceId)}
                    onChange={() => toggle(s.sourceId)}
                    disabled={s.imported}
                  />
                  <span className="min-w-0 flex-1 truncate text-gb-text">{s.title}</span>
                  <span className={`shrink-0 text-[9px] ${s.imported ? "text-gb-accent" : "text-gb-muted"}`}>
                    {s.imported ? "已导入" : `${(s.size / 1024).toFixed(0)}k`}
                  </span>
                </label>
              ))}
            </div>
            {projectRoot && (
              <label className="mt-2 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-gb-surface-hover">
                <input
                  type="checkbox"
                  checked={mergeInstructions}
                  onChange={() => setMergeInstructions((v) => !v)}
                />
                <span className="flex-1 text-gb-text">合并 CLAUDE.md → 项目 AGENTS.md（幂等标记）</span>
              </label>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={runImport}
                disabled={busy || !anySelected}
                className="flex-1 rounded bg-gb-accent px-3 py-1.5 text-xs font-medium text-gb-bg disabled:opacity-40"
              >
                {busy ? "导入中…" : `导入所选（${selected.size} 会话${mergeInstructions ? " + 指令" : ""}）`}
              </button>
              <button onClick={onClose} disabled={busy} className="rounded border border-gb-border/20 px-3 py-1.5 text-xs text-gb-muted hover:bg-gb-surface-hover">
                取消
              </button>
            </div>
          </>
        )}

        {report.length > 0 && (
          <div className="mt-3 max-h-40 space-y-0.5 overflow-y-auto rounded border border-gb-border/10 bg-gb-bg p-2 text-[10px] text-gb-muted">
            {report.map((l, i) => (
              <div key={i} className={l.startsWith("✗") ? "text-gb-red" : undefined}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
