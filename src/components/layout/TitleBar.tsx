import { useState, useRef, useEffect, useCallback } from "react";
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

export function TitleBar({
  auth, config, onLogout, onNewSession, creating, onToggleSidebar, onToggleRightPanel,
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
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (effortRef.current && !effortRef.current.contains(e.target as Node)) setEffortOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleModelChange = useCallback(async (modelId: string) => {
    if (!activeSessionId) return;
    setTabModel(activeSessionId, modelId);
    setModelOpen(false);
    try {
      await setSessionModel(activeSessionId, modelId);
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [activeSessionId, setTabModel]);

  const handleEffortChange = useCallback((effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh") => {
    if (!activeSessionId) return;
    setTabEffort(activeSessionId, effort);
    setEffortOpen(false);
  }, [activeSessionId, setTabEffort]);

  const currentModel = activeTab?.model || config?.default_model || "—";
  const currentEffort = activeTab?.reasoningEffort || "medium";
  const modelName = config?.models.find((m) => m.id === currentModel)?.name || currentModel;

  const efforts: { id: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"; label: string }[] = [
    { id: "none", label: "None" },
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
  ];

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-gb-border bg-gb-surface px-3">
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

        {/* Model dropdown */}
        <div ref={modelRef} className="relative">
          <button
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gb-muted hover:bg-gb-border/50 hover:text-gb-text disabled:opacity-40"
            onClick={() => setModelOpen((v) => !v)}
            disabled={!activeSessionId}
          >
            <span className="max-w-[140px] truncate">{modelName}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d="M2 3.5L5 7l3-3.5z" />
            </svg>
          </button>
          {modelOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 max-h-60 w-56 overflow-y-auto rounded-lg border border-gb-border bg-gb-surface py-1 shadow-xl">
              {config?.models.filter((m) => !m.hidden).map((m) => (
                <button
                  key={m.id}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-gb-bg ${
                    m.id === currentModel ? "text-gb-accent font-medium" : "text-gb-text"
                  }`}
                  onClick={() => handleModelChange(m.id)}
                >
                  <span className="truncate">{m.name}</span>
                  {m.id === currentModel && <span>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="text-gb-border">·</span>

        {/* Effort dropdown */}
        <div ref={effortRef} className="relative">
          <button
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gb-muted hover:bg-gb-border/50 hover:text-gb-text disabled:opacity-40"
            onClick={() => setEffortOpen((v) => !v)}
            disabled={!activeSessionId}
          >
            <span>{efforts.find((e) => e.id === currentEffort)?.label || "Medium"}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d="M2 3.5L5 7l3-3.5z" />
            </svg>
          </button>
          {effortOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-32 rounded-lg border border-gb-border bg-gb-surface py-1 shadow-xl">
              {efforts.map((e) => (
                <button
                  key={e.id}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-gb-bg ${
                    e.id === currentEffort ? "text-gb-accent font-medium" : "text-gb-text"
                  }`}
                  onClick={() => handleEffortChange(e.id)}
                >
                  <span>{e.label}</span>
                  {e.id === currentEffort && <span>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

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
