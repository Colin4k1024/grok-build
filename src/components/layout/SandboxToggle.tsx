import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";

const SANDBOX_KEY = "gb-sandbox-mode";

export type SandboxMode = "sandbox" | "full";

export function getSandboxMode(): SandboxMode {
  return (localStorage.getItem(SANDBOX_KEY) as SandboxMode) || "sandbox";
}

export function setSandboxMode(mode: SandboxMode) {
  localStorage.setItem(SANDBOX_KEY, mode);
}

/** Compact sandbox/full-access toggle for the TitleBar.
 *
 *  R3-01 fix: the toggle used to write gb-sandbox-mode to localStorage
 *  without any backend consumption. Now it syncs every open tab's
 *  approvalMode in the session store: "sandbox" → "ask" (must approve),
 *  "full" → "full-access" (auto-allow). New sessions pick up the current
 *  sandbox preference through the Home page composer which reads
 *  getSandboxMode(). */
export function SandboxToggle() {
  const [mode, setMode] = useState<SandboxMode>(getSandboxMode());
  const [showTooltip, setShowTooltip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const tabs = useSessionStore((s) => s.tabs);
  const setTabApprovalMode = useSessionStore((s) => s.setTabApprovalMode);

  useEffect(() => {
    setSandboxMode(mode);
    // Sync every open tab — the toggle is a global switch, not per-tab.
    const approval: "ask" | "full-access" = mode === "sandbox" ? "ask" : "full-access";
    for (const tab of tabs) {
      setTabApprovalMode(tab.id, approval);
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

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
                工具调用需逐个审批。写入、网络和命令访问受限。
              </p>
            </>
          ) : (
            <>
              <p className="mb-1 font-medium text-gb-yellow">完全访问</p>
              <p className="text-gb-text-secondary">
                工具调用自动批准。受信文件夹和权限规则仍然适用。
              </p>
            </>
          )}
          <p className="mt-1.5 text-gb-muted">点击切换。</p>
        </div>
      )}
    </div>
  );
}