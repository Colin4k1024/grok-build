import { useRef, useState, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { setSessionApprovalMode } from "../../lib/tauri";
import { getSetting } from "../../config/registry";
import { resolveSetting } from "../../config/resolve";

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
  const projectOverrides = useSettingsStore((s) => s.projectOverrides);
  const [showTooltip, setShowTooltip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const tabs = useSessionStore((s) => s.tabs);

  // Policy truth-sync. Every tab is pushed when it first appears (policies
  // boot at 'ask' after a restart — persisted approvalMode is not proof of
  // Policy state). After that: unpinned tabs follow global/project changes;
  // pinned tabs (user picked a per-session mode in the composer) are never
  // clobbered.
  const pushedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const def = getSetting("permissions.sandboxMode");
    for (const tab of tabs) {
      const resolved = tab.approvalPinned
        ? // User's per-session choice — re-push it, never recompute.
          (tab.approvalMode ?? "ask")
        : ((): "ask" | "full-access" => {
            const effective = def
              ? (resolveSetting(def as never, {
                  global: mode,
                  project: projectOverrides[tab.cwd]?.["permissions.sandboxMode"],
                }).value as SandboxMode)
              : mode;
            return effective === "sandbox" ? "ask" : "full-access";
          })();
      const already = pushedRef.current.has(tab.id);
      if (already && (tab.approvalMode ?? "ask") === resolved) continue;
      pushedRef.current.add(tab.id);
      if ((tab.approvalMode ?? "ask") !== resolved) {
        // System sync — does NOT pin (the tab still follows global changes).
        useSessionStore.getState().syncTabApprovalMode(tab.id, resolved);
      }
      // Push to the main-process Policy — the real enforcement boundary.
      // Failures are non-fatal (the Policy defaults to sandbox, the safe
      // mode), but are logged so the mismatch is visible rather than silent.
      setSessionApprovalMode(tab.id, resolved).catch((e) =>
        console.error("[sandbox] failed to sync approval mode to main process:", e)
      );
    }
  }, [mode, tabs, projectOverrides]);

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
        <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {isSandbox ? (
            <path d="M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 0110 0v4" />
          ) : (
            <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
          )}
        </svg>
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
