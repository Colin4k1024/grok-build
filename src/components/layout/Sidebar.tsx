import { SessionList } from "../session/SessionList";
import { ProjectList } from "../session/ProjectList";

interface SidebarProps {
  collapsed: boolean;
  onNewSession: () => void;
  /** Start a session rooted at a specific project directory. */
  onNewSessionInDir: (cwd: string) => void;
  creating: boolean;
  onForkSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onOpenSettings: () => void;
  onOpenDashboard: () => void;
  onOpenAgentsPage: () => void;
  onOpenAutomations: () => void;
}

export function Sidebar({ collapsed, onNewSession, onNewSessionInDir, creating, onForkSession, onCloseSession, onOpenSettings, onOpenDashboard, onOpenAgentsPage, onOpenAutomations }: SidebarProps) {
  if (collapsed) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-gb-border/8 bg-gb-bg-secondary">
      <div className="p-2">
        <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-gb-text hover:bg-gb-surface-hover disabled:opacity-30" onClick={onNewSession} disabled={creating}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          {creating ? "Starting…" : "New Session"}
        </button>
      </div>
      <ProjectList onOpenProject={onNewSessionInDir} disabled={creating} />
      <SessionList onForkSession={onForkSession} onCloseSession={onCloseSession} />
      <div className="border-t border-gb-border/8 p-1">
        <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text" onClick={onOpenAutomations}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M8 4v4l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" /></svg>
          Automations
        </button>
        <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text" onClick={onOpenAgentsPage}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="5" r="2" /><circle cx="11" cy="5" r="2" /><circle cx="8" cy="11" r="2" /></svg>
          Agents
        </button>
        <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text" onClick={onOpenDashboard}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h5v5H2V4zm7 0h5v2H9V4zm0 4h5v6H9V8zM2 11h5v2H2v-2z" /></svg>
          Dashboard
        </button>
        <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text" onClick={onOpenSettings}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z M13.4 6.8l-1.2-.7-.2-1.2 1-.7-.5-1.3-1.3.3-1-.9.1-1.3L8.1 0 6.8 1l-1 .9-1.3-.1-.6 1.2.8 1-.4 1.3-1.2.4.1 1.4 1 .8-.1 1.3-1.3.6.5 1.3 1.3-.1.8 1 1.2-.3z" /></svg>
          Settings
        </button>
      </div>
    </aside>
  );
}
