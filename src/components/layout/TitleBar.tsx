import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { type AuthStatus } from "../../lib/tauri";
import { AgentMenu } from "./AgentMenu";
import { SandboxToggle } from "./SandboxToggle";
import { DESTINATION_LABELS, type AppDestination } from "./destinations";

interface TitleBarProps {
  auth: AuthStatus;
  /** True when the sidebar is hidden — traffic lights then overlay this bar. */
  sidebarCollapsed: boolean;
  /** Current top-level destination — shown as the window context. */
  destination: AppDestination;
  onLogout: () => void;
  onNewSession: () => void;
  creating: boolean;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
}

// Codex-style window chrome: hidden titlebar with traffic lights inset into
// a slim draggable toolbar. Shows the current destination, project/thread
// context, and window-level controls. Session controls (project / model /
// effort / approval) live in the composer (ISS-059); destinations live in
// the rail (R4-03) — no duplicated navigation here.
export function TitleBar({
  auth, onLogout, onNewSession, creating, sidebarCollapsed, destination,
  onToggleSidebar, onToggleRightPanel,
}: TitleBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeSessionId));
  const renameTab = useSessionStore((s) => s.renameTab);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const commitRename = () => {
    if (activeSessionId && renaming && renameValue.trim()) renameTab(activeSessionId, renameValue.trim());
    setRenaming(false);
  };

  const inConversation = destination === "conversations";

  return (
    <header className={`app-drag flex h-11 shrink-0 items-center justify-between bg-transparent pr-3 ${sidebarCollapsed ? "pl-24" : "pl-3"}`}>
      {/* Left — sidebar toggle + destination / thread title */}
      <div className="flex min-w-0 items-center gap-2">
        {inConversation && (
          <button className="rounded-gb-sm p-1 text-gb-text-muted transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary"
            onClick={onToggleSidebar} aria-label="切换侧边栏" title="切换侧边栏 (⌘B)">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 4h12v1H2V4zm0 3.5h12v1H2v-1zm0 3.5h12v1H2v-1z" /></svg>
          </button>
        )}
        {inConversation ? (
          renaming ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              className="w-56 rounded-gb-sm border border-gb-accent/40 bg-gb-canvas px-1.5 py-0.5 text-gb-xs text-gb-text-primary outline-none"
            />
          ) : (
            <span
              className="max-w-[340px] truncate text-gb-xs font-medium text-gb-text-secondary"
              onDoubleClick={() => {
                if (activeTab) {
                  setRenameValue(activeTab.title);
                  setRenaming(true);
                }
              }}
              title={activeTab ? `${activeTab.title}\nDouble-click to rename` : "Grok Build"}
            >
              {activeTab?.title || "Grok Build"}
            </span>
          )
        ) : (
          <span className="text-gb-xs font-medium text-gb-text-secondary">
            {DESTINATION_LABELS[destination]}
          </span>
        )}
      </div>

      {/* Right — sandbox + agent menu + new + inspector + user */}
      <div className="flex items-center gap-1.5">
        <SandboxToggle />
        <AgentMenu />
        <button className="flex items-center gap-1 rounded-gb-sm px-2 py-1 text-gb-xs font-medium text-gb-text-primary transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover disabled:opacity-30"
          onClick={onNewSession} disabled={creating} title="新建会话 (⌘N)">
          {creating ? "…" : "New"}
        </button>
        {inConversation && (
          <button className="rounded-gb-sm p-1 text-gb-text-muted transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary"
            onClick={onToggleRightPanel} aria-label="切换检查器">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9 2h5v12H9V2zM7 2H2v12h5V2z" /></svg>
          </button>
        )}
        <div ref={menuRef} className="relative">
          <button className="flex items-center rounded-gb-sm p-1 transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover" onClick={() => setMenuOpen(v => !v)} aria-label="账户菜单">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gb-surface-hover text-[10px] font-medium text-gb-text-primary">
              {(auth.username || "?")[0]?.toUpperCase()}
            </span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-gb-dropdown mt-1 w-48 rounded-gb-md border gb-border-hairline bg-gb-surface-1 py-0.5 shadow-gb-medium">
              <div className="border-b gb-border-hairline px-2.5 py-2">
                <p className="text-gb-xs font-medium text-gb-text-primary">{auth.username || "User"}</p>
              </div>
              <button className="w-full px-2.5 py-1.5 text-left text-gb-xs text-gb-danger-text transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover"
                onClick={() => { setMenuOpen(false); onLogout(); }}>退出登录</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
