import { useState } from "react";

interface SidebarProps {
  collapsed: boolean;
  onNewSession: () => void;
  creating: boolean;
}

export function Sidebar({ collapsed, onNewSession, creating }: SidebarProps) {
  const [activeView, setActiveView] = useState<"sessions" | "settings">("sessions");

  if (collapsed) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-gb-border bg-gb-surface">
      {/* Nav tabs */}
      <div className="flex border-b border-gb-border">
        <button
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            activeView === "sessions"
              ? "border-b-2 border-gb-accent text-gb-text"
              : "text-gb-muted hover:text-gb-text"
          }`}
          onClick={() => setActiveView("sessions")}
        >
          Sessions
        </button>
        <button
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            activeView === "settings"
              ? "border-b-2 border-gb-accent text-gb-text"
              : "text-gb-muted hover:text-gb-text"
          }`}
          onClick={() => setActiveView("settings")}
        >
          Settings
        </button>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {activeView === "sessions" ? (
          <>
            <div className="p-2">
              <button
                className="w-full rounded-lg border border-gb-border bg-gb-bg px-3 py-2 text-xs font-medium text-gb-text hover:border-gb-accent/50 disabled:opacity-40"
                onClick={onNewSession}
                disabled={creating}
              >
                {creating ? "Starting..." : "+ New Session"}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2">
              <p className="py-8 text-center text-xs text-gb-muted">
                No sessions yet.
                <br />
                Create one to get started.
              </p>
              {/* Phase 2: session list here */}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-3">
            <p className="text-xs text-gb-muted">
              Settings will be available in Phase 2.
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-gb-border p-2">
        <div className="rounded-lg bg-gb-bg px-3 py-2 text-[10px] text-gb-muted">
          Grok Build v0.1.0
        </div>
      </div>
    </aside>
  );
}
