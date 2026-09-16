import { useState } from "react";
import { SessionList } from "../session/SessionList";

interface SidebarProps {
  collapsed: boolean;
  onNewSession: () => void;
  creating: boolean;
  onForkSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onOpenSettings: () => void;
  onOpenDashboard: () => void;
}

export function Sidebar({ collapsed, onNewSession, creating, onForkSession, onCloseSession, onOpenSettings, onOpenDashboard }: SidebarProps) {
  const [activeView, setActiveView] = useState<"sessions" | "settings">("sessions");

  if (collapsed) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-gb-border bg-gb-surface">
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
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors text-gb-muted hover:text-gb-text`}
          onClick={onOpenDashboard}
        >
          ◧ Dashboard
        </button>
        <button
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors text-gb-muted hover:text-gb-text`}
          onClick={onOpenSettings}
        >
          ⚙ Settings
        </button>
      </div>

      <div className="p-2">
        <button
          className="w-full rounded-lg border border-gb-border bg-gb-bg px-3 py-2 text-xs font-medium text-gb-text hover:border-gb-accent/50 disabled:opacity-40"
          onClick={onNewSession}
          disabled={creating}
        >
          {creating ? "Starting..." : "+ New Session"}
        </button>
      </div>
      <SessionList onForkSession={onForkSession} onCloseSession={onCloseSession} />

      <div className="border-t border-gb-border p-2">
        <div className="rounded-lg bg-gb-bg px-3 py-2 text-[10px] text-gb-muted">
          Grok Build v0.1.0
        </div>
      </div>
    </aside>
  );
}
