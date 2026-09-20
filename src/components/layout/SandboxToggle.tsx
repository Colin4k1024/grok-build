import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { setSessionApprovalMode } from "../../lib/tauri";

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
 *  R3-01 fix (#186): the toggle used to write gb-sandbox-mode to localStorage
 *  without any backend consumption — the UI claimed "写入、网络和命令访问受限"
 *  while the main process enforced nothing. Now it syncs every open tab's
 *  approvalMode in the session store AND calls the main-process
 *  `session_set_approval_mode` IPC, which updates the per-session typed
 *  Policy that run_command / git_commit / fs-bridge actually consult. The
 *  Policy is the real boundary; the renderer store is just for UI display. */
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
      // R3-01 (#186): push the mode to the main-process Policy — the real
      // enforcement boundary. Failures are non-fatal (the Policy defaults
      // to sandbox, the safe mode), but are logged so the mismatch is
      // visible rather than silent.
      setSessionApprovalMode(tab.id, approval).catch((e) =>
        console.error("[sandbox] failed to sync approval mode to main process:", e)
      );
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