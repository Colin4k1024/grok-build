import { useState, useEffect, useCallback, useMemo } from "react";
import {
  listHistorySessions, getSessionHistory, createSession, resumeSession, deleteHistorySession,
  type HistorySession,
} from "../../lib/tauri";
import { useSessionStore, type ChatMessage } from "../../stores/sessionStore";

interface SessionPickerProps {
  onClose: () => void;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

export function SessionPicker({ onClose }: SessionPickerProps) {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const addTab = useSessionStore((s) => s.addTab);

  useEffect(() => {
    listHistorySessions()
      .then((s) => { setSessions(s); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.model.toLowerCase().includes(q)
    );
  }, [sessions, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, HistorySession[]>();
    for (const s of filtered) {
      if (!map.has(s.cwd)) map.set(s.cwd, []);
      map.get(s.cwd)!.push(s);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const handleRestore = useCallback(async (session: HistorySession) => {
    setRestoring(session.id);
    setError(null);
    try {
      // Primary path — resume the persisted thread with session/load so the
      // agent regains full context and replays the transcript into the tab.
      const info = await resumeSession(session.id, session.cwd);
      useSessionStore.getState().finalizeMessages(info.id);
      addTab({
        id: info.id,
        acpSessionId: info.acp_session_id,
        title: session.title.slice(0, 40) + (session.title.length > 40 ? "…" : ""),
        cwd: session.cwd,
        model: session.model || info.models[0]?.id || "",
        reasoningEffort: "medium",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      onClose();
    } catch (resumeErr) {
      // Fallback — start a fresh session and display the stored transcript
      // read-only (same behavior as before resume support).
      console.warn("[SessionPicker] resume failed, falling back to fresh session:", resumeErr);
      try {
        const history = await getSessionHistory(session.id, session.cwd);
        const info = await createSession(session.cwd);
        const messages: ChatMessage[] = history.map((entry, i) => ({
          id: `hist-${session.id}-${i}`,
          role: entry.role === "assistant" ? "assistant" : "user",
          content: entry.content,
          timestamp: Date.now() - (history.length - i) * 1000,
        }));
        useSessionStore.setState((state) => ({
          messages: { ...state.messages, [info.id]: messages },
        }));
        addTab({
          id: info.id,
          acpSessionId: info.acp_session_id,
          title: session.title.slice(0, 40) + (session.title.length > 40 ? "…" : ""),
          cwd: session.cwd,
          model: session.model,
          reasoningEffort: "medium",
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        });
        onClose();
      } catch (e) {
        setError(String(e));
      }
    } finally {
      setRestoring(null);
    }
  }, [addTab, onClose]);

  const handleDelete = useCallback(async (session: HistorySession) => {
    if (!window.confirm(`Delete "${session.title}"? This permanently removes the thread history.`)) return;
    try {
      await deleteHistorySession(session.id, session.cwd);
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[600px] flex-col rounded-xl border border-gb-border bg-gb-surface"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gb-border px-4 py-3">
          <h2 className="text-sm font-semibold text-gb-text">恢复会话</h2>
          <button className="text-gb-muted hover:text-gb-text" onClick={onClose}>✕</button>
        </div>

        {/* Search */}
        <div className="p-3">
          <input
            type="text"
            placeholder="搜索历史…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-gb-border bg-gb-bg px-3 py-2 text-xs text-gb-text outline-none focus:border-gb-accent/50"
            autoFocus
          />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {loading && (
            <p className="py-8 text-center text-xs text-gb-muted">加载会话中…</p>
          )}
          {error && (
            <p className="py-4 text-center text-xs text-gb-red">{error}</p>
          )}
          {!loading && filtered.length === 0 && (
            <p className="py-8 text-center text-xs text-gb-muted">
              {search ? `No sessions match "${search}"` : "No history sessions found"}
            </p>
          )}

          {grouped.map(([cwd, items]) => (
            <div key={cwd} className="mb-4">
              <div className="mb-1 flex items-center gap-1 px-2 text-[10px] font-medium uppercase text-gb-muted">
                <span className="truncate">{cwd}</span>
                <span className="ml-auto rounded bg-gb-bg px-1">{items.length}</span>
              </div>
              {items.map((session) => (
                <div
                  key={session.id}
                  className="group mb-1 cursor-pointer rounded-lg border border-gb-border bg-gb-bg p-3 hover:border-gb-accent/40"
                  onClick={() => handleRestore(session)}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate text-xs font-medium text-gb-text">{session.title}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[10px] text-gb-muted">{formatTime(session.last_active_at)}</span>
                      <button
                        className="rounded p-0.5 text-gb-muted opacity-0 transition-opacity hover:text-gb-red focus:opacity-100 group-hover:opacity-100"
                        onClick={(e) => { e.stopPropagation(); handleDelete(session); }}
                        aria-label={`Delete ${session.title}`}
                        title="删除会话"
                      >
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                          <path d="M2 3h8l-.7 8.1a1 1 0 0 1-1 .9H3.7a1 1 0 0 1-1-.9L2 3zm2.5-2h3l.5 1H10v1H2V2h2l.5-1z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-gb-muted">
                    {session.model && (
                      <>
                        <span className="rounded bg-gb-surface px-1.5 py-0.5">{session.model}</span>
                      </>
                    )}
                    <span>{session.num_messages} messages</span>
                    {restoring === session.id && (
                      <span className="text-gb-accent">恢复中…</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
