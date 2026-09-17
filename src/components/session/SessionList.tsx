import { useState, useMemo, useCallback, type ReactNode } from "react";
import { useSessionStore, type SessionTab } from "../../stores/sessionStore";
import { writeText } from "../../lib/desktop";

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

/** Wrap every case-insensitive occurrence of `query` in `text` with a
 *  highlighted <mark>. Returns the original string when there's no query
 *  so React doesn't allocate extra nodes for the common no-search case. */
function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark
        key={key++}
        className="rounded-sm bg-gb-yellow/30 px-0.5 text-gb-text"
      >
        {text.slice(idx, idx + needle.length)}
      </mark>
    );
    i = idx + needle.length;
  }
  return parts;
}

function projectNameFromCwd(cwd: string): string {
  if (!cwd) return "(no project)";
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

export function SessionList({ onForkSession, onCloseSession }: SessionListProps) {
  const tabs = useSessionStore((s) => s.tabs);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const renameTab = useSessionStore((s) => s.renameTab);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("gb-pinned-sessions");
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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

  // Split pinned vs. unpinned, then group each by cwd.
  const { pinned, grouped } = useMemo(() => {
    const pinnedList: SessionTab[] = [];
    const unpinnedByCwd = new Map<string, SessionTab[]>();
    for (const tab of filtered) {
      if (pinnedIds.has(tab.id)) {
        pinnedList.push(tab);
      } else {
        const key = tab.cwd;
        if (!unpinnedByCwd.has(key)) unpinnedByCwd.set(key, []);
        unpinnedByCwd.get(key)!.push(tab);
      }
    }
    // Sort groups by project name (not raw cwd) so the UI feels Codex-like.
    const sorted = Array.from(unpinnedByCwd.entries()).sort((a, b) =>
      projectNameFromCwd(a[0]).localeCompare(projectNameFromCwd(b[0]))
    );
    return { pinned: pinnedList, grouped: sorted };
  }, [filtered, pinnedIds]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem("gb-pinned-sessions", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const toggleGroup = useCallback((cwd: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, tab: SessionTab) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, tab });
  }, []);

  const handleExport = useCallback(
    (tabId: string) => {
      // Read the messages map imperatively — subscribing to it would re-render
      // the sidebar on every streamed token.
      const msgs = useSessionStore.getState().messages[tabId] || [];
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
    },
    []
  );

  const handleCopyLink = useCallback(async (tabId: string) => {
    const link = `grokbuild://session/${tabId}`;
    try {
      await writeText(link);
    } catch {
      try {
        await navigator.clipboard.writeText(link);
      } catch (e) {
        console.error("copy link failed:", e);
      }
    }
  }, []);

  const handleOpenInNewWindow = useCallback((tabId: string) => {
    // detached-window.html handles the `?session=` query and renders the
    // chat-only view (App.tsx routes it).
    const url = `/detached-window.html?session=${encodeURIComponent(tabId)}`;
    window.open(url, "_blank", "width=800,height=600");
  }, []);

  const startRename = useCallback((tab: SessionTab) => {
    setRenamingId(tab.id);
    setRenameValue(tab.title);
    setMenu(null);
  }, []);

  const submitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameTab(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue("");
  }, [renamingId, renameValue, renameTab]);

  const renderTab = (tab: SessionTab) => (
    <div
      key={tab.id}
      onClick={() => setActiveSession(tab.id)}
      onContextMenu={(e) => handleContextMenu(e, tab)}
      className={`group mb-0.5 cursor-pointer rounded-md px-2 py-1.5 text-xs transition-colors ${
        activeSessionId === tab.id
          ? "border-l-2 border-gb-accent bg-gb-accent/15"
          : "border-l-2 border-transparent hover:bg-gb-bg"
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        {renamingId === tab.id ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              else if (e.key === "Escape") {
                setRenamingId(null);
                setRenameValue("");
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 rounded border border-gb-accent/40 bg-gb-bg px-1 text-xs text-gb-text outline-none"
          />
        ) : (
          <>
            {pinnedIds.has(tab.id) && (
              <span className="shrink-0 text-[9px] text-gb-accent" title="Pinned">
                📌
              </span>
            )}
            <span
              className={`truncate font-medium ${
                activeSessionId === tab.id ? "text-gb-text" : "text-gb-muted"
              }`}
            >
              {highlightMatch(tab.title, search)}
            </span>
          </>
        )}
        {tab.id === activeSessionId && isStreaming && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-gb-accent" />
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gb-muted">
        <span>{formatRelativeTime(tab.lastActiveAt)}</span>
        {tab.model && (
          <>
            <span className="text-gb-border">·</span>
            <span className="truncate">{highlightMatch(tab.model, search)}</span>
          </>
        )}
      </div>
    </div>
  );

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
        {pinned.length > 0 && (
          <div className="mb-3">
            <div className="px-2 py-1 text-[10px] font-medium uppercase text-gb-muted">
              Pinned
            </div>
            {pinned.map(renderTab)}
          </div>
        )}

        {grouped.map(([cwd, sessions]) => {
          const isCollapsed = collapsedGroups.has(cwd);
          const projectName = projectNameFromCwd(cwd);
          return (
            <div key={cwd} className="mb-3">
              <button
                onClick={() => toggleGroup(cwd)}
                className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] font-medium uppercase text-gb-muted hover:text-gb-text"
                aria-expanded={!isCollapsed}
              >
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="currentColor"
                  className={`shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                >
                  <path d="M2 1l4 3-4 3V1z" />
                </svg>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="shrink-0">
                  <path d="M0 1.5C0 .7.7 0 1.5 0h3l1.5 1.5h2.5C9.3 1.5 10 2.2 10 3v5.5c0 .8-.7 1.5-1.5 1.5h-7C.7 10 0 9.3 0 8.5v-7z" />
                </svg>
                <span className="truncate" title={cwd}>
                  {highlightMatch(projectName, search)}
                </span>
                <span className="ml-auto rounded bg-gb-bg px-1 text-[9px]">{sessions.length}</span>
              </button>
              {!isCollapsed && sessions.map(renderTab)}
            </div>
          );
        })}

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
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-50 w-48 rounded-lg border border-gb-border bg-gb-surface py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => {
                setActiveSession(menu.tab.id);
                setMenu(null);
              }}
            >
              Switch to
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => {
                togglePin(menu.tab.id);
                setMenu(null);
              }}
            >
              {pinnedIds.has(menu.tab.id) ? "Unpin" : "Pin"}
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => startRename(menu.tab)}
            >
              Rename
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => {
                onForkSession(menu.tab.id);
                setMenu(null);
              }}
            >
              Fork
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => {
                handleExport(menu.tab.id);
                setMenu(null);
              }}
            >
              Export as Markdown
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => {
                handleOpenInNewWindow(menu.tab.id);
                setMenu(null);
              }}
            >
              Open in new window
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => {
                handleCopyLink(menu.tab.id);
                setMenu(null);
              }}
            >
              Copy link
            </button>
            <div className="my-1 border-t border-gb-border" />
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-red hover:bg-gb-red/10"
              onClick={() => {
                onCloseSession(menu.tab.id);
                setMenu(null);
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
