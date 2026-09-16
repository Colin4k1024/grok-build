import { useState, useMemo, useCallback } from "react";
import { useSessionStore, type SessionTab } from "../../stores/sessionStore";

interface SessionListProps {
  onForkSession: (id: string) => void;
  onCloseSession: (id: string) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  tab: SessionTab;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function SessionList({ onForkSession, onCloseSession }: SessionListProps) {
  const tabs = useSessionStore((s) => s.tabs);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const messages = useSessionStore((s) => s.messages);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return tabs;
    const q = search.toLowerCase();
    return tabs.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.cwd.toLowerCase().includes(q) ||
        t.model.toLowerCase().includes(q)
    );
  }, [tabs, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, SessionTab[]>();
    for (const tab of filtered) {
      const key = tab.cwd;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(tab);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tab: SessionTab) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, tab });
  }, []);

  const handleExport = useCallback((tabId: string) => {
    const msgs = messages[tabId] || [];
    const lines = msgs.map((m) => {
      if (m.role === "user") return `## User\n${m.content}`;
      if (m.role === "assistant") return `## Assistant\n${m.content}`;
      return `## Tool: ${m.toolName}\n${m.content}`;
    });
    const blob = new Blob([lines.join("\n\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${tabId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages]);

  if (tabs.length === 0) {
    return (
      <div className="px-2 py-8 text-center text-xs text-gb-muted">
        No sessions yet.
        <br />
        Create one to get started.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Search */}
      <div className="p-2">
        <input
          type="text"
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-gb-border bg-gb-bg px-2 py-1.5 text-xs text-gb-text outline-none focus:border-gb-accent/50"
        />
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {grouped.map(([cwd, sessions]) => (
          <div key={cwd} className="mb-3">
            <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium uppercase text-gb-muted">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <path d="M0 1.5C0 .7.7 0 1.5 0h3l1.5 1.5h2.5C9.3 1.5 10 2.2 10 3v5.5c0 .8-.7 1.5-1.5 1.5h-7C.7 10 0 9.3 0 8.5v-7z" />
              </svg>
              <span className="truncate">{cwd}</span>
              <span className="ml-auto rounded bg-gb-bg px-1 text-[9px]">{sessions.length}</span>
            </div>
            {sessions.map((tab) => (
              <div
                key={tab.id}
                onClick={() => setActiveSession(tab.id)}
                onContextMenu={(e) => handleContextMenu(e, tab)}
                className={`group mb-0.5 cursor-pointer rounded-md px-2 py-1.5 text-xs transition-colors ${
                  activeSessionId === tab.id
                    ? "bg-gb-accent/15 border-l-2 border-gb-accent"
                    : "hover:bg-gb-bg border-l-2 border-transparent"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`truncate font-medium ${activeSessionId === tab.id ? "text-gb-text" : "text-gb-muted"}`}>
                    {tab.title}
                  </span>
                  {tab.id === activeSessionId && useSessionStore.getState().isStreaming && (
                    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-gb-accent" />
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gb-muted">
                  <span>{formatRelativeTime(tab.lastActiveAt)}</span>
                  {tab.model && (
                    <>
                      <span className="text-gb-border">·</span>
                      <span className="truncate">{tab.model}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="py-4 text-center text-xs text-gb-muted">
            No sessions match "{search}"
          </div>
        )}
      </div>

      {/* Context menu */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div
            className="fixed z-50 w-40 rounded-lg border border-gb-border bg-gb-surface py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => { setActiveSession(menu.tab.id); setMenu(null); }}
            >
              Switch to
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => { onForkSession(menu.tab.id); setMenu(null); }}
            >
              Fork
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => { handleExport(menu.tab.id); setMenu(null); }}
            >
              Export
            </button>
            <div className="my-1 border-t border-gb-border" />
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-red hover:bg-gb-red/10"
              onClick={() => { onCloseSession(menu.tab.id); setMenu(null); }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
