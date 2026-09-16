import { useState } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { compactSession } from "../../lib/tauri";

export function ContextBar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tokenUsage = useSessionStore((s) => s.tokenUsage);
  const compacting = useSessionStore((s) => (activeSessionId ? s.compacting[activeSessionId] : false));
  const snapshotForCompaction = useSessionStore((s) => s.snapshotForCompaction);
  const setCompacting = useSessionStore((s) => s.setCompacting);
  const [error, setError] = useState<string | null>(null);

  const usage = activeSessionId ? tokenUsage[activeSessionId] : undefined;

  if (!usage || usage.size === 0) {
    return null;
  }

  const percent = Math.min(100, (usage.used / usage.size) * 100);
  const remaining = usage.size - usage.used;

  const color = percent < 50 ? "bg-gb-green" : percent < 80 ? "bg-gb-yellow" : "bg-gb-red";
  const textColor = percent < 50 ? "text-gb-green" : percent < 80 ? "text-gb-yellow" : "text-gb-red";
  const showWarning = percent >= 80;

  async function handleCompact() {
    if (!activeSessionId || compacting) return;
    setError(null);
    snapshotForCompaction(activeSessionId);
    setCompacting(activeSessionId, true);
    try {
      await compactSession(activeSessionId);
    } catch (e) {
      setError(String(e));
      setCompacting(activeSessionId, false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-t border-gb-border bg-gb-bg px-3 py-1">
      <span className="text-[10px] text-gb-muted">Context</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-gb-surface">
        <div
          className={`h-full rounded-full transition-all ${compacting ? "bg-gb-blue animate-pulse" : color}`}
          style={{ width: `${compacting ? 100 : percent}%` }}
        />
      </div>
      {compacting ? (
        <span className="text-[10px] text-gb-blue animate-pulse">Compacting…</span>
      ) : (
        <>
          <span className={`text-[10px] tabular-nums ${textColor}`}>
            {formatTokens(usage.used)} / {formatTokens(usage.size)}
          </span>
          {showWarning && (
            <span className="rounded bg-gb-red/10 px-1.5 py-0.5 text-[9px] text-gb-red">
              ⚠ Consider /compact
            </span>
          )}
          {!showWarning && remaining > 0 && (
            <span className="text-[9px] text-gb-muted">
              {formatTokens(remaining)} left
            </span>
          )}
          <button
            onClick={handleCompact}
            disabled={compacting}
            className="rounded border border-gb-border px-1.5 py-0.5 text-[9px] text-gb-muted transition-colors hover:bg-gb-surface hover:text-gb-text disabled:opacity-50"
            title="Compact conversation context"
          >
            Compact
          </button>
        </>
      )}
      {error && (
        <span className="text-[9px] text-gb-red">{error}</span>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}
