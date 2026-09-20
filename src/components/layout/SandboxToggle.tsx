import { useState, useRef, useEffect } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSessionStore } from "../../stores/sessionStore";

export type SandboxMode = "sandbox" | "full";

/** Compact sandbox/full-access toggle for the TitleBar.
 *
 *  R3-01 / R3-11: reads/writes through the centralized settingsStore
 *  ("gb-settings" key). Syncs every open tab's approvalMode:
 *  "sandbox" → "ask", "full" → "full-access". */
export function SandboxToggle() {
  const sandboxMode = useSettingsStore((s) => s.sandboxMode);
  const setSandboxModeStore = useSettingsStore((s) => s.setSandboxMode);
  const [showTooltip, setShowTooltip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const tabs = useSessionStore((s) => s.tabs);
  const setTabApprovalMode = useSessionStore((s) => s.setTabApprovalMode);

  useEffect(() => {
    const approval: "ask" | "full-access" = sandboxMode === "sandbox" ? "ask" : "full-access";
    for (const tab of tabs) {
      setTabApprovalMode(tab.id, approval);
    }
  }, [sandboxMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showTooltip) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowTooltip(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTooltip]);

  const isSandbox = sandboxMode === "sandbox";

  return (
    <div ref={ref} className="relative" data-no-drag>
      <button
        onClick={() => setSandboxModeStore(isSandbox ? "full" : "sandbox")}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
          isSandbox
            ? "bg-gb-green/10 text-gb-green hover:bg-gb-green/15"
            : "bg-gb-yellow/10 text-gb-yellow hover:bg-gb-yellow/15"
        }`}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        aria-label={`沙箱模式: ${sandboxMode}. Click to toggle.`}
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

/** Standalone getter for non-React call-sites (e.g. session creation). */
export function getSandboxMode(): SandboxMode {
  try {
    const raw = localStorage.getItem("gb-settings");
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed?.state?.sandboxMode === "full" ? "full" : "sandbox";
    }
  } catch {}
  return "sandbox";
}