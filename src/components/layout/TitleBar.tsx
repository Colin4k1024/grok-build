import { useState, useRef, useEffect } from "react";
import type { AuthStatus, ConfigSnapshot } from "../../lib/tauri";

interface TitleBarProps {
  auth: AuthStatus;
  config: ConfigSnapshot | null;
  onLogout: () => void;
  onNewSession: () => void;
  creating: boolean;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
}

export function TitleBar({
  auth,
  config,
  onLogout,
  onNewSession,
  creating,
  onToggleSidebar,
  onToggleRightPanel,
}: TitleBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const modelName = config?.default_model || "—";

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-gb-border bg-gb-surface px-3">
      {/* Left: toggle + app name + model */}
      <div className="flex items-center gap-2">
        <button
          className="rounded p-1.5 text-gb-muted hover:bg-gb-border/50 hover:text-gb-text"
          onClick={onToggleSidebar}
          title="Toggle sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 3h12v1.5H2V3zm0 4h12v1.5H2V7zm0 4h12v1.5H2V11z" />
          </svg>
        </button>
        <h1 className="text-sm font-semibold text-gb-text">Grok Build</h1>
        <span className="text-gb-border">|</span>
        <span className="text-xs text-gb-muted">{modelName}</span>
      </div>

      {/* Right: session + user menu */}
      <div className="flex items-center gap-2">
        <button
          className="rounded bg-gb-accent px-3 py-1 text-xs font-medium text-white hover:opacity-80 disabled:opacity-40"
          onClick={onNewSession}
          disabled={creating}
        >
          {creating ? "Starting..." : "+ New"}
        </button>

        <button
          className="rounded p-1.5 text-gb-muted hover:bg-gb-border/50 hover:text-gb-text"
          onClick={onToggleRightPanel}
          title="Toggle panel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9 2h5v12H9V2zM7 2H2v12h5V2z" />
          </svg>
        </button>

        {/* User dropdown */}
        <div ref={menuRef} className="relative">
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-gb-muted hover:bg-gb-border/50 hover:text-gb-text"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gb-accent/20 text-gb-accent text-[10px] font-bold">
              {(auth.username || "?")[0]?.toUpperCase()}
            </span>
            <span className="max-w-[120px] truncate">{auth.username || "User"}</span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-gb-border bg-gb-surface py-1 shadow-xl">
              <div className="border-b border-gb-border px-3 py-2">
                <p className="text-xs font-medium text-gb-text">{auth.username || "User"}</p>
                <p className="text-[10px] text-gb-muted">Signed in</p>
              </div>
              <button
                className="w-full px-3 py-2 text-left text-xs text-gb-red hover:bg-gb-red/10"
                onClick={() => { setMenuOpen(false); onLogout(); }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
