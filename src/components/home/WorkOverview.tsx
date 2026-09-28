import { useEffect, useMemo, useState } from "react";
import { useSessionStore, type SessionTab } from "../../stores/sessionStore";
import { listHistorySessions, type HistorySession } from "../../lib/tauri";
import { Skeleton } from "../ui";

/**
 * WorkOverview (R4-04 #237): the home workbench's operational summary —
 * running work, queued follow-ups, and ONE merged recent list where live
 * sessions and resumable history never duplicate (keyed by acpSessionId).
 */

export interface OverviewEntry {
  key: string;
  title: string;
  cwd: string;
  updatedAt: number;
  /** Currently open as a tab. */
  live: boolean;
  /** Actively streaming right now. */
  running: boolean;
  /** Queued follow-ups waiting. */
  queued: number;
  /** Live tab id (open) or history session (resumable). */
  tab?: SessionTab;
  history?: HistorySession;
}

interface Props {
  onOpenSession: (id: string) => void;
  onResumeThread: (session: HistorySession) => void;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

export function WorkOverview({ onOpenSession, onResumeThread }: Props) {
  const tabs = useSessionStore((s) => s.tabs);
  const streaming = useSessionStore((s) => s.streaming);
  const queuedPrompts = useSessionStore((s) => s.queuedPrompts);

  const [history, setHistory] = useState<HistorySession[] | null>(null); // null = loading
  useEffect(() => {
    let alive = true;
    listHistorySessions()
      .then((list) => {
        if (alive) setHistory(list.slice(0, 8));
      })
      .catch(() => {
        if (alive) setHistory([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const entries = useMemo<OverviewEntry[]>(() => {
    const byKey = new Map<string, OverviewEntry>();
    for (const tab of tabs) {
      const key = tab.acpSessionId ?? tab.id;
      byKey.set(key, {
        key,
        title: tab.title,
        cwd: tab.cwd,
        updatedAt: tab.lastActiveAt,
        live: true,
        running: !!streaming[tab.id],
        queued: queuedPrompts[tab.id]?.length ?? 0,
        tab,
      });
    }
    // History entries fill in only when no live tab covers the same thread.
    // HistorySession.id IS the agent (acp) session id — that's how
    // threadResume matches live tabs to history.
    for (const h of history ?? []) {
      const key = h.id;
      if (byKey.has(key)) continue; // live twin wins
      byKey.set(key, {
        key,
        title: h.title,
        cwd: h.cwd,
        updatedAt: h.updated_at,
        live: false,
        running: false,
        queued: 0,
        history: h,
      });
    }
    return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  }, [tabs, streaming, queuedPrompts, history]);

  const runningCount = entries.filter((e) => e.running).length;

  return (
    <section data-testid="work-overview" aria-label="工作概览" className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-gb-xs font-medium uppercase tracking-wider text-gb-text-muted">
          继续最近工作
        </h2>
        {runningCount > 0 && (
          <span className="rounded-full bg-gb-accent/15 px-2 py-0.5 text-gb-xs text-gb-accent-text">
            {runningCount} 进行中
          </span>
        )}
      </div>

      {history === null ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-gb-md border gb-border-hairline bg-gb-surface-1 p-4 text-center">
          <p className="text-gb-sm text-gb-text-muted">
            暂无进行中的工作 — 用上方输入框开始新任务。
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              data-thread-entry
              data-live={entry.live}
              onClick={() =>
                entry.tab ? onOpenSession(entry.tab.id) : entry.history && onResumeThread(entry.history)
              }
              className="group flex flex-col rounded-gb-md border gb-border-hairline bg-gb-surface-1 p-3 text-left transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-gb-sm font-medium text-gb-text-primary group-hover:text-gb-accent-text">
                  {entry.title}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-gb-xs text-gb-text-muted">
                  {entry.running && (
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gb-accent" aria-hidden="true" />
                  )}
                  {entry.queued > 0 && <span>{entry.queued} 排队</span>}
                  {formatRelativeTime(entry.updatedAt)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-gb-xs text-gb-text-muted">
                <span className="truncate">{entry.cwd || "."}</span>
                <span className="shrink-0 opacity-60">·</span>
                <span className="shrink-0">{entry.live ? "已打开" : "可恢复"}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
