import { ThreadTree } from "../session/ThreadTree";
import type { HistorySession } from "../../lib/tauri";

interface SidebarProps {
  collapsed: boolean;
  creating: boolean;
  onNewSession: () => void;
  /** Start a new thread rooted at a specific project directory. */
  onNewSessionInDir: (cwd: string) => void;
  onResumeThread: (session: HistorySession) => void;
  onForkSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onOpenSearch: () => void;
  /** Open settings, optionally on a specific tab (e.g. "plugins"). */
  onOpenSettings: (tab?: string) => void;
  onOpenAutomations: () => void;
}

// Codex app sidebar IA: New chat / Search / Plugins / Automations, then the
// thread tree (Pinned / Projects / Chats), with Settings pinned to the bottom.
export function Sidebar({
  collapsed, creating, onNewSession, onNewSessionInDir, onResumeThread,
  onForkSession, onCloseSession, onOpenSearch, onOpenSettings, onOpenAutomations,
}: SidebarProps) {
  if (collapsed) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-gb-border/8 bg-gb-bg-secondary">
      <div className="space-y-0.5 p-2">
        <button
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-gb-text hover:bg-gb-surface-hover disabled:opacity-30"
          onClick={onNewSession}
          disabled={creating}
          title="New chat (⌘N)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {creating ? "Starting…" : "New chat"}
        </button>
        <button
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onOpenSearch}
          title="Search (⌘G)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Search
        </button>
        <button
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={() => onOpenSettings("plugins")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6 2v2H4.5A1.5 1.5 0 003 5.5V7h2v2H3v1.5A1.5 1.5 0 004.5 12H6v2h4v-2h1.5a1.5 1.5 0 001.5-1.5V9h-2V7h2V5.5A1.5 1.5 0 0011.5 4H10V2H6z" stroke="currentColor" strokeWidth="1.1" />
          </svg>
          Plugins
        </button>
        <button
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onOpenAutomations}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 4v4l3 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Automations
        </button>
      </div>

      <div className="mx-2 border-t border-gb-border/8" />

      <ThreadTree
        onNewSessionInDir={onNewSessionInDir}
        onResumeThread={onResumeThread}
        onForkSession={onForkSession}
        onCloseSession={onCloseSession}
      />

      <div className="border-t border-gb-border/8 p-1">
        <button
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={() => onOpenSettings()}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z M13.4 6.8l-1.2-.7-.2-1.2 1-.7-.5-1.3-1.3.3-1-.9.1-1.3L8.1 0 6.8 1l-1 .9-1.3-.1-.6 1.2.8 1-.4 1.3-1.2.4.1 1.4 1 .8-.1 1.3-1.3.6.5 1.3 1.3-.1.8 1 1.2-.3z" />
          </svg>
          Settings
        </button>
      </div>
    </aside>
  );
}
