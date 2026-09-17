import { useState, useEffect, useMemo } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { listHistorySessions, type HistorySession } from "../../lib/tauri";

interface GlobalSearchProps {
  onClose: () => void;
  onOpenTab: (tabId: string) => void;
  onResumeThread: (session: HistorySession) => void;
}

interface Result {
  key: string;
  title: string;
  cwd: string;
  snippet?: string;
  tabId?: string;
  session: HistorySession;
}

/** Codex ⌘G — search across open tabs, persisted threads, and in-memory
 *  message content; jump straight into the hit. */
export function GlobalSearch({ onClose, onOpenTab, onResumeThread }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistorySession[]>([]);
  const tabs = useSessionStore((s) => s.tabs);
  const messages = useSessionStore((s) => s.messages);

  useEffect(() => {
    listHistorySessions().then(setHistory).catch(() => {});
  }, []);

  const results: Result[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Result[] = [];
    const covered = new Set<string>();

    const matchTitle = (title: string, cwd: string) =>
      !q || title.toLowerCase().includes(q) || cwd.toLowerCase().includes(q);

    // Open tabs first (with in-memory content search).
    for (const t of tabs) {
      covered.add(t.acpSessionId || t.id);
      let snippet: string | undefined;
      if (q) {
        for (const m of messages[t.id] || []) {
          if (m.content.toLowerCase().includes(q)) {
            const idx = m.content.toLowerCase().indexOf(q);
            snippet = "…" + m.content.slice(Math.max(0, idx - 30), idx + q.length + 40).trim() + "…";
            break;
          }
        }
      }
      if (matchTitle(t.title, t.cwd) || snippet) {
        out.push({
          key: `tab-${t.id}`,
          title: t.title,
          cwd: t.cwd,
          snippet,
          tabId: t.id,
          session: {
            id: t.acpSessionId || t.id, session_id: t.acpSessionId || t.id,
            title: t.title, cwd: t.cwd, updated_at: t.lastActiveAt,
            last_active_at: "", model: t.model, num_messages: 0,
          },
        });
      }
    }

    // Persisted threads.
    for (const h of history) {
      if (covered.has(h.id)) continue;
      if (matchTitle(h.title, h.cwd)) {
        out.push({
          key: `hist-${h.id}`,
          title: h.title,
          cwd: h.cwd,
          session: h,
        });
      }
    }
    return out.slice(0, 30);
  }, [query, tabs, messages, history]);

  const open = (r: Result) => {
    if (r.tabId) onOpenTab(r.tabId);
    else onResumeThread(r.session);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-[560px] flex-col overflow-hidden rounded-xl border border-gb-border bg-gb-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && results[0]) open(results[0]);
          }}
          placeholder="Search threads and messages…"
          className="border-b border-gb-border/8 bg-transparent px-4 py-3 text-sm text-gb-text outline-none placeholder:text-gb-muted"
        />
        <div className="flex-1 overflow-y-auto p-2">
          {results.length === 0 && (
            <p className="py-8 text-center text-xs text-gb-muted">{query ? "No matches." : "Type to search."}</p>
          )}
          {results.map((r) => (
            <button
              key={r.key}
              onClick={() => open(r)}
              className="mb-0.5 block w-full rounded-md px-3 py-2 text-left hover:bg-gb-surface-hover"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-gb-text">{r.title}</span>
                <span className="shrink-0 text-[10px] text-gb-muted">{r.tabId ? "open" : "history"}</span>
              </div>
              <div className="truncate text-[11px] text-gb-muted">{r.cwd}</div>
              {r.snippet && <div className="mt-0.5 truncate text-[11px] text-gb-text-secondary">{r.snippet}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
