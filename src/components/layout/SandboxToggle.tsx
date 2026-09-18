import { useState, useRef, useEffect } from "react";

const SANDBOX_KEY = "gb-sandbox-mode";

export type SandboxMode = "sandbox" | "full";

export function getSandboxMode(): SandboxMode {
  return (localStorage.getItem(SANDBOX_KEY) as SandboxMode) || "sandbox";
}

export function setSandboxMode(mode: SandboxMode) {
  localStorage.setItem(SANDBOX_KEY, mode);
}

/** Compact sandbox/full-access toggle for the TitleBar. */
export function SandboxToggle() {
  const [mode, setMode] = useState<SandboxMode>(getSandboxMode());
  const [showTooltip, setShowTooltip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSandboxMode(mode);
  }, [mode]);

  useEffect(() => {
    if (!showTooltip) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowTooltip(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTooltip]);

  const isSandbox = mode === "sandbox";

  return (
    <div ref={ref} className="relative" data-no-drag>
      <button
        onClick={() => setMode(isSandbox ? "full" : "sandbox")}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
          isSandbox
            ? "bg-gb-green/10 text-gb-green hover:bg-gb-green/15"
            : "bg-gb-yellow/10 text-gb-yellow hover:bg-gb-yellow/15"
        }`}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        aria-label={`沙箱模式: ${mode}. Click to toggle.`}
      >
        <span>{isSandbox ? "🔒" : "⚡"}</span>
        <span>{isSandbox ? "Sandbox" : "完全访问"}</span>
      </button>

      {showTooltip && (
        <div className="absolute left-1/2 top-full z-50 mt-1 w-64 -translate-x-1/2 rounded-md border border-gb-border/10 bg-gb-surface-solid p-2.5 text-[11px] shadow-lg">
          {isSandbox ? (
            <>
              <p className="mb-1 font-medium text-gb-green">沙箱模式</p>
              <p className="text-gb-text-secondary">
                Commands run in an isolated environment. Writes outside the
                working directory require approval. Network access is limited
                to the model provider.
              </p>
            </>
          ) : (
            <>
              <p className="mb-1 font-medium text-gb-yellow">完全访问</p>
              <p className="text-gb-text-secondary">
                Commands run directly on your machine with no sandboxing.
                Trusted folders and permission rules still apply.
              </p>
            </>
          )}
          <p className="mt-1.5 text-gb-muted">点击切换。</p>
        </div>
      )}
    </div>
  );
}
