// VS Code-style Status Bar: 22px bar pinned to the bottom.
// Left: project context. Right: model, session count, layout toggles,
// and ACP connection status dot (ISS-187).
import { useSessionStore } from "../../stores/sessionStore";
import type { ConnectionStatus } from "../../stores/sessionStore";
import type { ConfigSnapshot } from "../../lib/tauri";

interface StatusBarProps {
  config: ConfigSnapshot | null;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  onOpenSettings: () => void;
}

const STATUS_DOT: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: "#4ade80", label: "Connected" },
  reconnecting: { color: "#facc15", label: "Reconnecting" },
  disconnected: { color: "#f87171", label: "Disconnected" },
  error: { color: "#ef4444", label: "Error" },
};

export function StatusBar({ config, onToggleSidebar, onToggleRightPanel, onOpenSettings }: StatusBarProps) {
  const tabs = useSessionStore((s) => s.tabs);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const connectionStatus = useSessionStore((s) => s.connectionStatus);
  const connectionError = useSessionStore((s) => s.connectionError);
  const activeTab = tabs.find((t) => t.id === activeSessionId);

  const projectName = activeTab?.cwd
    ? activeTab.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop()
    : null;
  const modelName = activeTab?.model
    ? config?.models.find((m) => m.id === activeTab.model)?.name || activeTab.model
    : null;

  const currentStatus: ConnectionStatus | undefined =
    activeSessionId ? connectionStatus[activeSessionId] : undefined;
  const currentError: string | null =
    activeSessionId ? (connectionError[activeSessionId] ?? null) : null;
  const dot = currentStatus ? STATUS_DOT[currentStatus] : null;
  const tooltip = dot ? (currentError ? `${dot.label}: ${currentError}` : dot.label) : undefined;

  return (
    <footer className="flex h-[22px] shrink-0 items-center justify-between bg-gb-statusbar px-2 text-[11px] text-white/90 select-none">
      <div className="flex min-w-0 items-center gap-3">
        {projectName && (
          <span className="flex items-center gap-1 truncate">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.5C0 .7.7 0 1.5 0h5l1.5 1.5h6.5c.8 0 1.5.7 1.5 1.5v9.5c0 .8-.7 1.5-1.5 1.5h-13C.7 14 0 13.3 0 12.5v-11z"/></svg>
            {projectName}
          </span>
        )}
        {activeTab && <span className="truncate opacity-80">{activeTab.title}</span>}
      </div>
      <div className="flex items-center gap-1">
        {/* ACP connection status dot (ISS-187) */}
        {dot && (
          <span className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10" title={tooltip}>
            <svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3.5" fill={dot.color} /></svg>
            <span className="hidden sm:inline opacity-80">{dot.label}</span>
          </span>
        )}
        {modelName && (
          <button className="rounded px-1.5 py-0.5 hover:bg-white/15" onClick={onOpenSettings} title="模型（点击打开设置）">{modelName}</button>
        )}
        <span className="px-1.5 opacity-80">{tabs.length} 个会话</span>
        <button className="rounded px-1.5 py-0.5 hover:bg-white/15" onClick={onToggleSidebar} title="切换侧边栏 (⌘B)" aria-label="切换侧边栏">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="2" width="14" height="12" rx="1.5"/><path d="M6 2v12"/></svg>
        </button>
        <button className="rounded px-1.5 py-0.5 hover:bg-white/15" onClick={onToggleRightPanel} title="切换右侧面板" aria-label="切换右侧面板">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="2" width="14" height="12" rx="1.5"/><path d="M10 2v12"/></svg>
        </button>
      </div>
    </footer>
  );
}
