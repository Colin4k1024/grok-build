import { useRef, useState, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { setSessionApprovalMode } from "../../lib/tauri";

export type SandboxMode = "sandbox" | "full";

/** Non-React readers (e.g. Home's approval default). The store mirrors here. */
export function getSandboxMode(): SandboxMode {
  return useSettingsStore.getState().sandboxMode;
}

export function setSandboxMode(mode: SandboxMode) {
  useSettingsStore.getState().setSandboxMode(mode);
}

/** Compact sandbox/full-access toggle for the TitleBar.
 *
 *  R3-01 fix (#186) + R4-07 (#240): the settings store is the single source
 *  of truth — the Settings Center field and this toggle write the same
 *  value, and EVERY change (toggle click, settings apply, preset, import,
 *  multi-window sync) pushes to the main-process Policy, the real
 *  enforcement boundary that run_command / git_commit / fs-bridge consult.
 *  The Policy is the boundary; the renderer store is for display. */
export function SandboxToggle() {
  const mode = useSettingsStore((s) => s.sandboxMode);
  const [showTooltip, setShowTooltip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const tabs = useSessionStore((s) => s.tabs);
  const setTabApprovalMode = useSessionStore((s) => s.setTabApprovalMode);

  useEffect(() => {
    // Sync every open tab — the toggle is a global switch, not per-tab.
    const approval: "ask" | "full-access" = mode === "sandbox" ? "ask" : "full-access";
    for (const tab of tabs) {
      setTabApprovalMode(tab.id, approval);
      // Push to the main-process Policy — the real enforcement boundary.
      // Failures are non-fatal (the Policy defaults to sandbox, the safe
      // mode), but are logged so the mismatch is visible rather than silent.
      setSessionApprovalMode(tab.id, approval).catch((e) =>
        console.error("[sandbox] failed to sync approval mode to main process:", e)
      );
    }
  }, [mode]); // mode is the real trigger; tab list churn is irrelevant here

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
        onClick={() => setSandboxMode(isSandbox ? "full" : "sandbox")}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
          isSandbox
            ? "bg-gb-green/10 text-gb-success-text hover:bg-gb-green/15"
            : "bg-gb-yellow/10 text-gb-warning-text hover:bg-gb-yellow/15"
        }`}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        aria-label={`沙箱模式: ${mode}. Click to toggle.`}
      >
        <span aria-hidden="true">{isSandbox ? "🔒" : "⚡"}</span>
        <span>{isSandbox ? "Sandbox" : "完全访问"}</span>
      </button>

      {showTooltip && (
        <div className="absolute left-1/2 top-full z-gb-popover mt-1 w-64 -translate-x-1/2 rounded-gb-md border gb-border-hairline bg-gb-surface-1 p-2.5 text-gb-xs shadow-gb-medium">
          {isSandbox ? (
            <>
              <p className="mb-1 font-medium text-gb-success-text">沙箱模式</p>
              <p className="text-gb-text-secondary">
                工具调用需逐个审批。写入、网络和命令访问受限。
              </p>
            </>
          ) : (
            <>
              <p className="mb-1 font-medium text-gb-warning-text">完全访问</p>
              <p className="text-gb-text-secondary">
                工具调用自动批准。受信文件夹和权限规则仍然适用。
              </p>
            </>
          )}
          <p className="mt-1.5 text-gb-text-muted">点击切换。</p>
        </div>
      )}
    </div>
  );
}
