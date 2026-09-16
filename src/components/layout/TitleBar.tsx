import { useState, useRef, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionStore } from "../../stores/sessionStore";
import { setSessionModel, type AuthStatus, type ConfigSnapshot } from "../../lib/tauri";

interface TitleBarProps {
  auth: AuthStatus;
  config: ConfigSnapshot | null;
  onLogout: () => void;
  onNewSession: () => void;
  creating: boolean;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
}

const isMacOS =
  typeof navigator !== "undefined" &&
  /macintosh|mac os x/i.test(navigator.userAgent);
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tabs = useSessionStore((s) => s.tabs);
  const setTabModel = useSessionStore((s) => s.setTabModel);
  const setTabEffort = useSessionStore((s) => s.setTabEffort);
  const activeTab = tabs.find((t) => t.id === activeSessionId);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node))
        setModelOpen(false);
      if (effortRef.current && !effortRef.current.contains(e.target as Node))
        setEffortOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (!activeSessionId) return;
      setTabModel(activeSessionId, modelId);
      setModelOpen(false);
      try {
        await setSessionModel(activeSessionId, modelId);
      } catch (e) {
        console.error("Failed to set model:", e);
      }
    },
    [activeSessionId, setTabModel]
  );

  const handleEffortChange = useCallback(
    (effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh") => {
      if (!activeSessionId) return;
      setTabEffort(activeSessionId, effort);
      setEffortOpen(false);
    },
    [activeSessionId, setTabEffort]
  );

  const handleDragMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      // Only start window drag when the press lands on the drag region itself,
      // not on any button / interactive element inside the title bar.
      if (!isTauri) return;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, [data-no-drag]")) return;
      e.preventDefault();
      getCurrentWindow()
        .startDragging()
        .catch((err) => console.error("startDragging failed:", err));
    },
    []
  );

  const handleMinimize = useCallback(() => {
    getCurrentWindow().minimize().catch(console.error);
  }, []);
  const handleToggleMaximize = useCallback(() => {
    getCurrentWindow()
      .toggleMaximize()
      .catch(console.error);
  }, []);
  const handleClose = useCallback(() => {
    getCurrentWindow().close().catch(console.error);
  }, []);

  const currentModel = activeTab?.model || config?.default_model || "—";
  const currentEffort = activeTab?.reasoningEffort || "medium";
  const modelName =
    config?.models.find((m) => m.id === currentModel)?.name || currentModel;

  const efforts = [
    { id: "none", label: "None" },
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
  ] as const;

  return (
    <header
      data-tauri-drag-region
      onMouseDown={handleDragMouseDown}
      className="relative flex h-11 shrink-0 select-none items-center justify-between border-b border-gb-border/8 px-3"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Left cluster — leave room for the macOS traffic lights. */}
      <div
        className="flex items-center gap-2"
        style={isMacOS ? { marginLeft: 68 } : undefined}
        data-no-drag
      >
        <button
          className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 4h12v1H2V4zm0 3.5h12v1H2v-1zm0 3.5h12v1H2v-1z" />
          </svg>
        </button>
        <span className="text-[13px] font-medium text-gb-text">Grok Build</span>

        <div ref={modelRef} className="relative">
          <button
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-gb-text-secondary hover:bg-gb-surface-hover hover:text-gb-text disabled:opacity-30"
            onClick={() => setModelOpen((v) => !v)}
            disabled={!activeSessionId}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <span className="max-w-[130px] truncate">{modelName}</span>
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="currentColor"
              className="opacity-40"
            >
              <path d="M1 3l3 3 3-3z" />
            </svg>
          </button>
          {modelOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 max-h-60 w-56 overflow-y-auto rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg">
              {config?.models
                .filter((m) => !m.hidden)
                .map((m) => (
                  <button
                    key={m.id}
                    className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-gb-surface-hover ${
                      m.id === currentModel ? "text-gb-accent" : "text-gb-text"
                    }`}
                    onClick={() => handleModelChange(m.id)}
                  >
                    <span className="truncate">{m.name}</span>
                    {m.id === currentModel && (
                      <span className="text-gb-accent">✓</span>
                    )}
                  </button>
                ))}
            </div>
          )}
        </div>

        <div ref={effortRef} className="relative">
          <button
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-gb-text-secondary hover:bg-gb-surface-hover hover:text-gb-text disabled:opacity-30"
            onClick={() => setEffortOpen((v) => !v)}
            disabled={!activeSessionId}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <span>
              {efforts.find((e) => e.id === currentEffort)?.label || "Medium"}
            </span>
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="currentColor"
              className="opacity-40"
            >
              <path d="M1 3l3 3 3-3z" />
            </svg>
          </button>
          {effortOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-32 rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg">
              {efforts.map((e) => (
                <button
                  key={e.id}
                  className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-gb-surface-hover ${
                    e.id === currentEffort ? "text-gb-accent" : "text-gb-text"
                  }`}
                  onClick={() => handleEffortChange(e.id)}
                >
                  <span>{e.label}</span>
                  {e.id === currentEffort && (
                    <span className="text-gb-accent">✓</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right cluster — window actions + user menu. On non-macOS we also render
          custom min/max/close buttons because decorations are disabled. */}
      <div className="flex items-center gap-1.5" data-no-drag>
        <button
          className="flex items-center gap-1 rounded px-2.5 py-1 text-[12px] font-medium text-gb-text hover:bg-gb-surface-hover disabled:opacity-30"
          onClick={onNewSession}
          disabled={creating}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {creating ? "…" : "New"}
        </button>
        <button
          className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onToggleRightPanel}
          aria-label="Toggle right panel"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9 2h5v12H9V2zM7 2H2v12h5V2z" />
          </svg>
        </button>
        <div ref={menuRef} className="relative">
          <button
            className="flex items-center rounded p-1 hover:bg-gb-surface-hover"
            onClick={() => setMenuOpen((v) => !v)}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gb-surface-hover text-[10px] font-medium text-gb-text">
              {(auth.username || "?")[0]?.toUpperCase()}
            </span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg">
              <div className="border-b border-gb-border/8 px-2.5 py-2">
                <p className="text-[12px] font-medium text-gb-text">
                  {auth.username || "User"}
                </p>
              </div>
              <button
                className="w-full px-2.5 py-1.5 text-left text-[12px] text-gb-red hover:bg-gb-surface-hover"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>

        {!isMacOS && isTauri && (
          <div
            className="ml-2 flex items-center gap-1 border-l border-gb-border/10 pl-2"
            data-no-drag
          >
            <button
              className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
              onClick={handleMinimize}
              aria-label="Minimize window"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect x="1" y="5.5" width="10" height="1" />
              </svg>
            </button>
            <button
              className="rounded p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
              onClick={handleToggleMaximize}
              aria-label="Maximize or restore window"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                <rect x="1.5" y="1.5" width="9" height="9" />
              </svg>
            </button>
            <button
              className="rounded p-1 text-gb-muted hover:bg-gb-red/20 hover:text-gb-red"
              onClick={handleClose}
              aria-label="Close window"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
