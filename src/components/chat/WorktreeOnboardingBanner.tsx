import { useState, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";

const DISMISSED_KEY = "gb-worktree-onboarding-dismissed";

/**
 * First-run worktree onboarding banner. Shown once per install when the user
 * has at least one session rooted in a non-main worktree (i.e. cwd != "." and
 * cwd is not the repo root).
 *
 * Codex parity: `worktree-onboarding-banner-controller`.
 */
export function WorktreeOnboardingBanner() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [visible, setVisible] = useState(false);

  const tabs = useSessionStore((s) => s.tabs);

  useEffect(() => {
    if (dismissed) return;
    // Show the banner once the user actually creates a session in a non-trivial
    // cwd (so we don't flash it on the Home screen).
    const hasNonDefault = tabs.some((t) => t.cwd && t.cwd !== "." && t.cwd !== "/");
    setVisible(hasNonDefault);
  }, [tabs, dismissed]);

  if (!visible || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "true");
    } catch {
      /* quota */
    }
    setVisible(false);
  };

  return (
    <div className="mx-4 mt-2 flex items-start gap-3 rounded-md border border-gb-accent/30 bg-gb-accent/5 p-3">
      <span className="text-lg leading-none">🌿</span>
      <div className="flex-1 text-[12px] leading-relaxed text-gb-text-secondary">
        <p className="font-medium text-gb-text">Working in a git worktree</p>
        <p className="mt-0.5 text-gb-muted">
          This session is rooted in <code className="rounded bg-gb-bg px-1">{tabs.find((t) => t.cwd && t.cwd !== ".")?.cwd}</code>.
          Manage other worktrees under Settings → Worktrees.
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss worktree hint"
        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
      >
        Got it
      </button>
    </div>
  );
}
