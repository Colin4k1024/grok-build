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
}

function NavItem({ icon, label, onClick, title, disabled }: {
  icon: React.ReactNode; label: string; onClick: () => void; title?: string; disabled?: boolean;
}) {
  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-gb-md px-2 py-1.5 text-gb-sm text-gb-text-secondary transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary disabled:opacity-30"
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {icon}
      {label}
    </button>
  );
}

// Contextual sidebar (R4-03 #236): conversation context ONLY — new thread
// and the thread tree. Top-level destinations live exclusively in the
// primary rail (ActivityBar), and the rail owns the search command too.
export function Sidebar({
  collapsed, creating, onNewSession, onNewSessionInDir, onResumeThread,
  onForkSession, onRenameHistory, onCloseSession,
}: SidebarProps) {
  if (collapsed) return null;

  return (
    <aside aria-label="会话侧栏" className="flex w-[260px] shrink-0 flex-col bg-gb-sidebar">
      {/* Header — app identity */}
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="px-1 text-gb-sm font-semibold text-gb-text-primary">Grok Build</span>
      </div>

      {/* Conversation actions */}
      <div className="space-y-0.5 px-2 pb-2">
        <NavItem
          label={creating ? "启动中…" : "新对话"}
          onClick={onNewSession}
          disabled={creating}
          title="新对话 (⌘N)"
          icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" /><path d="M8 5.5v5M5.5 8h5" strokeLinecap="round" /></svg>}
        />
      </div>

      {/* Thread tree (projects + threads) */}
      <ThreadTree
        onNewSessionInDir={onNewSessionInDir}
        onResumeThread={onResumeThread}
        onForkSession={onForkSession}
        onRenameHistory={onRenameHistory}
        onCloseSession={onCloseSession}
      />
    </aside>
  );
}
