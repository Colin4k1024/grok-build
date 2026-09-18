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
  /** Persist a rename for a history thread (ISS-079). */
  onRenameHistory: (session: HistorySession, title: string) => void;
  onCloseSession: (id: string) => void;
  onOpenSearch: () => void;
  /** Open settings, optionally on a specific tab (e.g. "plugins"). */
  onOpenSettings: (tab?: string) => void;
  onOpenAutomations: () => void;
}

function NavItem({ icon, label, onClick, title, disabled }: {
  icon: React.ReactNode; label: string; onClick: () => void; title?: string; disabled?: boolean;
}) {
  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-gb-text-secondary transition-colors hover:bg-gb-surface-hover hover:text-gb-text disabled:opacity-30"
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {icon}
      {label}
    </button>
  );
}

// Codex desktop-style sidebar: app identity on top, primary nav rows, then the
// thread tree, with settings pinned to the bottom.
export function Sidebar({
  collapsed, creating, onNewSession, onNewSessionInDir, onResumeThread,
  onForkSession, onRenameHistory, onCloseSession, onOpenSearch, onOpenSettings, onOpenAutomations,
}: SidebarProps) {
  if (collapsed) return null;

  return (
    <aside className="flex w-[260px] shrink-0 flex-col bg-gb-bg-secondary">
      {/* Traffic-light clearance — draggable window region */}
      <div className="app-drag h-9 shrink-0" />

      {/* App identity + quick actions */}
      <div className="flex items-center justify-between px-3 pb-1">
        <button className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[14px] font-semibold text-gb-text hover:bg-gb-surface-hover" onClick={() => onOpenSettings()}>
          Grok Build
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-gb-muted"><path d="M2 3.5l3 3 3-3" /></svg>
        </button>
        <div className="flex items-center gap-0.5">
          <button className="rounded-md p-1.5 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text" onClick={onOpenSearch} title="搜索 (⌘G)" aria-label="搜索">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>

      {/* Primary nav */}
      <div className="space-y-0.5 px-2 pb-2">
        <NavItem
          label={creating ? "启动中…" : "新对话"}
          onClick={onNewSession}
          disabled={creating}
          title="新对话 (⌘N)"
          icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="2" width="12" height="12" rx="3" /><path d="M8 5.5v5M5.5 8h5" strokeLinecap="round" /></svg>}
        />
        <NavItem
          label="自动化"
          onClick={onOpenAutomations}
          icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" /></svg>}
        />
        <NavItem
          label="插件"
          onClick={() => onOpenSettings("plugins")}
          icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M6 2v2H4.5A1.5 1.5 0 003 5.5V7h2v2H3v1.5A1.5 1.5 0 004.5 12H6v2h4v-2h1.5a1.5 1.5 0 001.5-1.5V9h-2V7h2V5.5A1.5 1.5 0 0011.5 4H10V2H6z" /></svg>}
        />
      </div>

      {/* Thread tree */}
      <ThreadTree
        onNewSessionInDir={onNewSessionInDir}
        onResumeThread={onResumeThread}
        onForkSession={onForkSession}
        onRenameHistory={onRenameHistory}
        onCloseSession={onCloseSession}
      />

      {/* Bottom: settings */}
      <div className="p-2">
        <NavItem
          label="设置"
          onClick={() => onOpenSettings()}
          title="设置 (⌘,)"
          icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="8" cy="8" r="2.2" /><path d="M13.3 10a1.5 1.5 0 00.3 1.65l.06.06a1.8 1.8 0 11-2.55 2.55l-.06-.06a1.5 1.5 0 00-1.65-.3 1.5 1.5 0 00-.9 1.37v.17a1.8 1.8 0 11-3.6 0v-.09a1.5 1.5 0 00-.98-1.37 1.5 1.5 0 00-1.65.3l-.06.06a1.8 1.8 0 11-2.55-2.55l.06-.06a1.5 1.5 0 00.3-1.65 1.5 1.5 0 00-1.37-.9H2.9a1.8 1.8 0 110-3.6h.09a1.5 1.5 0 001.37-.98 1.5 1.5 0 00-.3-1.65l-.06-.06a1.8 1.8 0 112.55-2.55l.06.06a1.5 1.5 0 001.65.3h.09a1.5 1.5 0 00.9-1.37V2.9a1.8 1.8 0 113.6 0v.09a1.5 1.5 0 00.9 1.37 1.5 1.5 0 001.65-.3l.06-.06a1.8 1.8 0 112.55 2.55l-.06.06a1.5 1.5 0 00-.3 1.65v.09a1.5 1.5 0 001.37.9h.17a1.8 1.8 0 110 3.6h-.09a1.5 1.5 0 00-1.37.9z" /></svg>}
        />
      </div>
    </aside>
  );
}
