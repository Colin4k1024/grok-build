// VS Code-style Activity Bar: 48px icon rail on the far left.
// Top: view toggles (Explorer / Search / Dashboard / Automations).
// Bottom: account-level actions (Settings).
interface ActivityBarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onOpenDashboard: () => void;
  onOpenAutomations: () => void;
  onOpenSettings: () => void;
}

function ActivityIcon({ d, active, label, onClick }: { d: string; active?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative flex h-12 w-12 items-center justify-center transition-colors ${
        active ? "text-white" : "text-gb-activitybar-fg hover:text-white"
      }`}
    >
      {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-white" />}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </button>
  );
}

export function ActivityBar({
  sidebarVisible, onToggleSidebar, onOpenSearch, onOpenDashboard, onOpenAutomations, onOpenSettings,
}: ActivityBarProps) {
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center bg-gb-activitybar" aria-label="活动栏">
      <ActivityIcon
        label="资源管理器（会话）(⌘B)"
        active={sidebarVisible}
        onClick={onToggleSidebar}
        d="M14 3H5a2 2 0 00-2 2v14a2 2 0 002 2h9M14 3l5 5m-5-5v5h5M9 12h6M9 16h4"
      />
      <ActivityIcon
        label="搜索 (⌘G)"
        onClick={onOpenSearch}
        d="M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM21 21l-5.2-5.2"
      />
      <ActivityIcon
        label="仪表盘"
        onClick={onOpenDashboard}
        d="M3 20h18M6 20v-6m6 6V8m6 12v-9"
      />
      <ActivityIcon
        label="自动化"
        onClick={onOpenAutomations}
        d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3.5 2"
      />
      <div className="flex-1" />
      <ActivityIcon
        label="设置 (⌘,)"
        onClick={onOpenSettings}
        d="M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
      />
    </nav>
  );
}
