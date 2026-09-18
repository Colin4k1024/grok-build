// VS Code-style editor tab strip: one tab per open session, plus a
// pinned Home tab on the left (like VS Code's Welcome tab).
import { useSessionStore } from "../../stores/sessionStore";

interface EditorTabsProps {
  showHome: boolean;
  onOpenHome: () => void;
  onCloseSession: (id: string) => void;
  streaming: boolean;
}

export function EditorTabs({ showHome, onOpenHome, onCloseSession, streaming }: EditorTabsProps) {
  const tabs = useSessionStore((s) => s.tabs);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  if (tabs.length === 0 && !showHome) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-gb-border/40 bg-gb-bg-secondary">
      {/* Home / Welcome tab */}
      <button
        onClick={onOpenHome}
        className={`group flex shrink-0 items-center gap-1.5 border-r border-gb-border/40 px-3 text-[12px] ${
          showHome
            ? "bg-gb-bg text-gb-text shadow-[inset_0_1px_0_0_rgb(var(--gb-brand))]"
            : "bg-gb-tab-inactive text-gb-muted hover:text-gb-text"
        }`}
      >
        <span className="text-gb-brand">✻</span>
        首页
      </button>

      {tabs.map((tab) => {
        const active = !showHome && tab.id === activeSessionId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => setActiveSession(tab.id)}
            className={`group flex min-w-0 max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-gb-border/40 px-3 text-[12px] ${
              active
                ? "bg-gb-bg text-gb-text shadow-[inset_0_1px_0_0_rgb(var(--gb-brand))]"
                : "bg-gb-tab-inactive text-gb-muted hover:text-gb-text"
            }`}
          >
            {active && streaming && (
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-gb-accent" title="运行中" />
            )}
            <span className="truncate">{tab.title}</span>
            <button
              aria-label="关闭标签页"
              className="ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-gb-surface-hover group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); onCloseSession(tab.id); }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M1 1l8 8M9 1L1 9" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
