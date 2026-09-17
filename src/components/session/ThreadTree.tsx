import { useState, useEffect, useCallback, useMemo } from "react";
import { useSessionStore, type SessionTab } from "../../stores/sessionStore";
import {
  listProjects, removeProject, listHistorySessions, deleteHistorySession,
  type HistorySession, type ProjectEntry,
} from "../../lib/tauri";
import { writeText } from "../../lib/desktop";

interface ThreadTreeProps {
  onNewSessionInDir: (cwd: string) => void;
  onResumeThread: (session: HistorySession) => void;
  onForkSession: (id: string) => void;
  onCloseSession: (id: string) => void;
}

interface ThreadEntry {
  key: string;
  /** Persisted ACP/history session id (resume + delete key). */
  sessionId: string;
  /** Present when the thread is open as a live tab. */
  tabId?: string;
  title: string;
  cwd: string;
  model?: string;
  lastActiveAt: number;
  numMessages?: number;
}

const PIN_KEY = "gb-pinned-sessions";
const ARCHIVE_KEY = "gb-archived-threads";

function readIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeIdSet(key: string, ids: Iterable<string>) {
  localStorage.setItem(key, JSON.stringify([...ids]));
}

function projectName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d`;
  return new Date(ts).toLocaleDateString();
}

/** Codex-style sidebar tree: Pinned / Projects (bookmarked folders and the
 *  threads that live in them, open or persisted) / Chats (everything else). */
export function ThreadTree({ onNewSessionInDir, onResumeThread, onForkSession, onCloseSession }: ThreadTreeProps) {
  const tabs = useSessionStore((s) => s.tabs);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const renameTab = useSessionStore((s) => s.renameTab);
  const streaming = useSessionStore((s) => s.streaming);
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions);

  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [history, setHistory] = useState<HistorySession[]>([]);
  const [pinned, setPinned] = useState<Set<string>>(() => readIdSet(PIN_KEY));
  const [archived, setArchived] = useState<Set<string>>(() => readIdSet(ARCHIVE_KEY));
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; entry: ThreadEntry } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);

  const refreshHistory = useCallback(() => {
    listHistorySessions().then(setHistory).catch(() => {});
  }, []);

  const refreshProjects = useCallback(() => {
    listProjects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    refreshHistory();
    refreshProjects();
    const onThreadsChanged = () => refreshHistory();
    const onProjectsChanged = () => refreshProjects();
    window.addEventListener("gb-threads-changed", onThreadsChanged);
    window.addEventListener("gb-projects-changed", onProjectsChanged);
    return () => {
      window.removeEventListener("gb-threads-changed", onThreadsChanged);
      window.removeEventListener("gb-projects-changed", onProjectsChanged);
    };
  }, [refreshHistory, refreshProjects]);

  // tabs join the tree reactively.
  const entries: ThreadEntry[] = useMemo(() => {
    const list: ThreadEntry[] = [];
    const coveredHistory = new Set<string>();
    for (const t of tabs as SessionTab[]) {
      list.push({
        key: `tab-${t.id}`,
        sessionId: t.acpSessionId || t.id,
        tabId: t.id,
        title: t.title,
        cwd: t.cwd,
        model: t.model,
        lastActiveAt: t.lastActiveAt,
      });
      if (t.acpSessionId) coveredHistory.add(t.acpSessionId);
    }
    for (const h of history) {
      if (coveredHistory.has(h.id) || h.num_messages === 0) continue;
      list.push({
        key: `hist-${h.id}`,
        sessionId: h.id,
        title: h.title,
        cwd: h.cwd,
        model: h.model,
        lastActiveAt: h.updated_at || Date.parse(h.last_active_at) || 0,
        numMessages: h.num_messages,
      });
    }
    list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return list.filter((e) => !archived.has(e.key) && !archived.has(e.sessionId));
  }, [tabs, history, archived]);

  const { pinnedEntries, projectGroups, chatEntries } = useMemo(() => {
    const pinnedList: ThreadEntry[] = [];
    const groups = new Map<string, ThreadEntry[]>();
    const chats: ThreadEntry[] = [];
    const claimed = new Set<string>();
    for (const e of entries) {
      if (pinned.has(e.key) || pinned.has(e.sessionId)) {
        pinnedList.push(e);
        claimed.add(e.key);
      }
    }
    for (const p of projects) {
      const inProject = entries.filter(
        (e) => !claimed.has(e.key) && (e.cwd === p.path || e.cwd.startsWith(p.path.replace(/[/\\]+$/, "") + "/"))
      );
      for (const e of inProject) claimed.add(e.key);
      if (inProject.length > 0) groups.set(p.path, inProject);
    }
    for (const e of entries) {
      if (!claimed.has(e.key)) chats.push(e);
    }
    return { pinnedEntries: pinnedList, projectGroups: [...groups.entries()], chatEntries: chats };
  }, [entries, projects, pinned]);

  const togglePin = useCallback((e: ThreadEntry) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(e.key) || next.has(e.sessionId)) {
        next.delete(e.key);
        next.delete(e.sessionId);
      } else {
        next.add(e.key);
      }
      writeIdSet(PIN_KEY, [...next]);
      return next;
    });
    setMenu(null);
  }, []);

  const archiveEntry = useCallback((e: ThreadEntry) => {
    setArchived((prev) => {
      const next = new Set(prev);
      next.add(e.key);
      next.add(e.sessionId);
      writeIdSet(ARCHIVE_KEY, [...next]);
      return next;
    });
    setMenu(null);
  }, []);

  const deleteEntry = useCallback(
    async (e: ThreadEntry) => {
      if (!window.confirm(`Delete "${e.title}"? This permanently removes the thread history.`)) {
        setMenu(null);
        return;
      }
      try {
        await deleteHistorySession(e.sessionId, e.cwd);
      } catch {
        /* no persisted copy — just drop the entry locally */
      }
      if (e.tabId) onCloseSession(e.tabId);
      refreshHistory();
      setMenu(null);
    },
    [onCloseSession, refreshHistory]
  );

  const openEntry = useCallback(
    (e: ThreadEntry) => {
      if (e.tabId) {
        setActiveSession(e.tabId);
        window.dispatchEvent(new CustomEvent("gb-open-session"));
      } else {
        const hist = history.find((h) => h.id === e.sessionId);
        if (hist) onResumeThread(hist);
      }
    },
    [history, onResumeThread, setActiveSession]
  );

  const exportEntry = useCallback((e: ThreadEntry) => {
    if (!e.tabId) return;
    const msgs = useSessionStore.getState().messages[e.tabId] || [];
    const lines = msgs.map((m) =>
      m.role === "user" ? `## User\n${m.content}` : m.role === "assistant" ? `## Assistant\n${m.content}` : `## Tool: ${m.toolName}\n${m.content}`
    );
    const blob = new Blob([lines.join("\n\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `thread-${e.sessionId}.md`;
    a.click();
    URL.revokeObjectURL(url);
    setMenu(null);
  }, []);

  const renderEntry = (e: ThreadEntry) => {
    const isActive = e.tabId && e.tabId === activeSessionId;
    // Three-state indicator (codex sidebar): running / waiting for approval /
    // idle. Background threads keep their running flag via per-session state.
    const running = !!e.tabId && streaming[e.tabId];
    const waiting = !!e.tabId && (pendingPermissions[e.tabId]?.length ?? 0) > 0;
    return renaming?.key === e.key ? (
      <input
        key={e.key}
        autoFocus
        value={renaming.value}
        onChange={(ev) => setRenaming({ key: e.key, value: ev.target.value })}
        onBlur={() => {
          if (e.tabId && renaming.value.trim()) renameTab(e.tabId, renaming.value.trim());
          setRenaming(null);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            if (e.tabId && renaming.value.trim()) renameTab(e.tabId, renaming.value.trim());
            setRenaming(null);
          } else if (ev.key === "Escape") setRenaming(null);
        }}
        className="mb-0.5 w-full rounded border border-gb-accent/40 bg-gb-bg px-2 py-1 text-xs text-gb-text outline-none"
      />
    ) : (
      <div
        key={e.key}
        onClick={() => openEntry(e)}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
        }}
        className={`group mb-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
          waiting
            ? "bg-gb-yellow/10 text-gb-text hover:bg-gb-yellow/15"
            : isActive
              ? "bg-gb-accent/15 text-gb-text"
              : "text-gb-text-secondary hover:bg-gb-surface-hover"
        }`}
        title={`${e.title}\n${e.cwd}${e.numMessages !== undefined ? `\n${e.numMessages} messages` : ""}${waiting ? "\nWaiting for approval" : ""}`}
      >
        {running ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-gb-accent" title="Running" />
        ) : waiting ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gb-yellow" title="Waiting for approval" />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{e.title}</span>
        {pinned.has(e.key) && <span className="shrink-0 text-[9px] text-gb-accent">•</span>}
        <span className="hidden shrink-0 group-hover:block">
          <button
            className="rounded p-0.5 text-[9px] text-gb-muted hover:bg-gb-bg hover:text-gb-text"
            onClick={(ev) => {
              ev.stopPropagation();
              setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
            }}
            title="Thread actions"
          >
            …
          </button>
        </span>
        <span className="w-6 shrink-0 text-right text-[10px] text-gb-muted">{relTime(e.lastActiveAt)}</span>
      </div>
    );
  };

  const sectionLabel = "flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-gb-muted";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-2">
      {pinnedEntries.length > 0 && (
        <div className="mb-2">
          <div className={sectionLabel}>Pinned</div>
          {pinnedEntries.map(renderEntry)}
        </div>
      )}

      <div className="mb-2">
        <div className={sectionLabel}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="shrink-0">
            <path d="M0 1.5C0 .7.7 0 1.5 0h3l1.5 1.5h2.5C9.3 1.5 10 2.2 10 3v5.5c0 .8-.7 1.5-1.5 1.5h-7C.7 10 0 9.3 0 8.5v-7z" />
          </svg>
          Projects
        </div>
        {projectGroups.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-gb-muted/70">
            Add a project (⌘O) to group threads by folder.
          </p>
        )}
        {projectGroups.map(([path, threads]) => {
          const isCollapsed = collapsedProjects.has(path);
          return (
            <div key={path}>
              <div
                className="group flex w-full items-center gap-1 rounded-md px-2 py-1 hover:bg-gb-surface-hover"
                onClick={() =>
                  setCollapsedProjects((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-gb-muted">
                  <path d="M2 4.5A1.5 1.5 0 013.5 3h2.6a1.5 1.5 0 011.06.44l.88.88a1.5 1.5 0 001.06.44H12.5A1.5 1.5 0 0114 6.26v5.24a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.2" />
                </svg>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-gb-text" title={path}>
                  {projectName(path)}
                </span>
                <button
                  className="hidden rounded p-0.5 text-[10px] text-gb-muted hover:text-gb-text group-hover:block"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setProjectMenu({ x: ev.clientX, y: ev.clientY, path });
                  }}
                  title="Project actions"
                >
                  …
                </button>
                <button
                  className="hidden rounded p-0.5 text-gb-muted hover:text-gb-text group-hover:block"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onNewSessionInDir(path);
                  }}
                  title="New thread in this project"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                <span className="rounded bg-gb-bg px-1 text-[9px] text-gb-muted">{threads.length}</span>
              </div>
              {!isCollapsed && threads.map(renderEntry)}
            </div>
          );
        })}
      </div>

      <div className="mb-2">
        <div className={sectionLabel}>Chats</div>
        {chatEntries.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-gb-muted/70">No unfiled threads.</p>
        ) : (
          chatEntries.map(renderEntry)
        )}
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-50 w-48 rounded-lg border border-gb-border bg-gb-surface py-1 shadow-xl" style={{ left: menu.x, top: menu.y }}>
            <button className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg" onClick={() => { openEntry(menu.entry); setMenu(null); }}>Open</button>
            <button className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg" onClick={() => togglePin(menu.entry)}>
              {pinned.has(menu.entry.key) ? "Unpin" : "Pin"}
            </button>
            {menu.entry.tabId && (
              <button className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg" onClick={() => { setRenaming({ key: menu.entry.key, value: menu.entry.title }); setMenu(null); }}>
                Rename
              </button>
            )}
            {menu.entry.tabId && (
              <button className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg" onClick={() => { onForkSession(menu.entry.tabId!); setMenu(null); }}>Fork</button>
            )}
            {menu.entry.tabId && (
              <button className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg" onClick={() => exportEntry(menu.entry)}>Export as Markdown</button>
            )}
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={async () => {
                try { await writeText(`grokbuild://thread/${menu.entry.sessionId}`); } catch { /* clipboard denied */ }
                setMenu(null);
              }}
            >
              Copy link
            </button>
            <button className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg" onClick={() => archiveEntry(menu.entry)}>Archive</button>
            <div className="my-1 border-t border-gb-border" />
            <button className="w-full px-3 py-1.5 text-left text-xs text-gb-red hover:bg-gb-red/10" onClick={() => deleteEntry(menu.entry)}>Delete…</button>
          </div>
        </>
      )}

      {projectMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setProjectMenu(null)} onContextMenu={(e) => { e.preventDefault(); setProjectMenu(null); }} />
          <div className="fixed z-50 w-48 rounded-lg border border-gb-border bg-gb-surface py-1 shadow-xl" style={{ left: projectMenu.x, top: projectMenu.y }}>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-text hover:bg-gb-bg"
              onClick={() => { onNewSessionInDir(projectMenu.path); setProjectMenu(null); }}
            >
              New thread here
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-gb-red hover:bg-gb-red/10"
              onClick={async () => {
                try { await removeProject(projectMenu.path); refreshProjects(); } catch (e) { console.error(e); }
                setProjectMenu(null);
              }}
            >
              Remove from sidebar
            </button>
          </div>
        </>
      )}
    </div>
  );
}
