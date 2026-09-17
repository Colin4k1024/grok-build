import { useState, useRef, useEffect } from "react";
import { type AuthStatus } from "../../lib/tauri";
import { AgentMenu } from "./AgentMenu";
import { SandboxToggle } from "./SandboxToggle";

interface TitleBarProps {
  auth: AuthStatus;
  onLogout: () => void;
  onNewSession: () => void;
  creating: boolean;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
}

// Window chrome only — all session controls (project / model / effort /
// approval) live in the composer, codex-style. See ISS-059.
export function TitleBar({
  auth, onLogout, onNewSession, creating,
  onToggleSidebar, onToggleRightPanel,
}: TitleBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-gb-border/8 bg-gb-surface-solid px-3">
      {/* Left — toggle sidebar */}
      <div className="flex items-center gap-2">
        <button className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onToggleSidebar} aria-label="Toggle sidebar">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v1H2V4zm0 3.5h12v1H2v-1zm0 3.5h12v1H2v-1z" /></svg>
        </button>
        <span className="text-[13px] font-medium text-gb-text">
          <span className="mr-1 text-gb-brand" aria-hidden>✻</span>Grok Build
        </span>
      </div>

      {/* Right — sandbox + agent menu + new session + right panel toggle + user */}
      <div className="flex items-center gap-1.5">
        <SandboxToggle />
        <AgentMenu />
        <button className="flex items-center gap-1 rounded px-2.5 py-1 text-[12px] font-medium text-gb-text hover:bg-gb-surface-hover disabled:opacity-30"
          onClick={onNewSession} disabled={creating}>
          {creating ? "…" : "New"}
        </button>
        <button className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onToggleRightPanel} aria-label="Toggle right panel">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M9 2h5v12H9V2zM7 2H2v12h5V2z" /></svg>
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
                onClick={() => { setMenuOpen(false); onLogout(); }}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}