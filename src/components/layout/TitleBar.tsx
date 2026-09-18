import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { type AuthStatus } from "../../lib/tauri";
import { AgentMenu } from "./AgentMenu";
import { SandboxToggle } from "./SandboxToggle";

interface TitleBarProps {
  auth: AuthStatus;
  /** True when the sidebar is hidden — traffic lights then overlay this bar. */
  sidebarCollapsed: boolean;
  onLogout: () => void;
  onNewSession: () => void;
  creating: boolean;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  onOpenSettings: () => void;
}

// Codex-style window chrome: hidden titlebar with traffic lights inset into
// a slim draggable toolbar. Window-level controls only — session controls
// (project / model / effort / approval) live in the composer (ISS-059).
export function TitleBar({
  auth, onLogout, onNewSession, creating, sidebarCollapsed,
  onToggleSidebar, onToggleRightPanel, onOpenSettings,
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

  return (
    <header className={`app-drag flex h-11 shrink-0 items-center justify-between bg-transparent pr-3 ${sidebarCollapsed ? "pl-24" : "pl-3"}`}>
      {/* Left — sidebar toggle + thread title (double-click to rename) */}
      <div className="flex min-w-0 items-center gap-2">
        <button className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onToggleSidebar} aria-label="切换侧边栏" title="切换侧边栏 (⌘B)">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v1H2V4zm0 3.5h12v1H2v-1zm0 3.5h12v1H2v-1z" /></svg>
        </button>
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="w-56 rounded border border-gb-accent/40 bg-gb-bg px-1.5 py-0.5 text-[12px] text-gb-text outline-none"
          />
        ) : (
          <span
            className="max-w-[340px] truncate text-[12px] font-medium text-gb-text-secondary"
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
        )}
      </div>

      {/* Right — sandbox + agent menu + new + right panel + settings + user */}
      <div className="flex items-center gap-1.5">
        <SandboxToggle />
        <AgentMenu />
        <button className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-gb-text hover:bg-gb-surface-hover disabled:opacity-30"
          onClick={onNewSession} disabled={creating} title="新建会话 (⌘N)">
          {creating ? "…" : "New"}
        </button>
        <button className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onToggleRightPanel} aria-label="切换右侧面板">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M9 2h5v12H9V2zM7 2H2v12h5V2z" /></svg>
        </button>
        <button className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onOpenSettings} aria-label="设置" title="设置 (⌘,)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z M13.4 6.8l-1.2-.7-.2-1.2 1-.7-.5-1.3-1.3.3-1-.9.1-1.3L8.1 0 6.8 1l-1 .9-1.3-.1-.6 1.2.8 1-.4 1.3-1.2.4.1 1.4 1 .8-.1 1.3-1.3.6.5 1.3 1.3-.1.8 1 1.2-.3z" />
          </svg>
        </button>
        <div ref={menuRef} className="relative">
          <button className="flex items-center rounded p-1 hover:bg-gb-surface-hover" onClick={() => setMenuOpen(v => !v)}>
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gb-surface-hover text-[10px] font-medium text-gb-text">
              {(auth.username || "?")[0]?.toUpperCase()}
            </span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg">
              <div className="border-b border-gb-border/8 px-2.5 py-2">
                <p className="text-[12px] font-medium text-gb-text">{auth.username || "User"}</p>
              </div>
              <button className="w-full px-2.5 py-1.5 text-left text-[12px] text-gb-red hover:bg-gb-surface-hover"
                onClick={() => { setMenuOpen(false); onLogout(); }}>退出登录</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
