import { useSessionStore } from "../../stores/sessionStore";

export function ContextBar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tokenUsage = useSessionStore((s) => s.tokenUsage);

  const usage = activeSessionId ? tokenUsage[activeSessionId] : undefined;

  if (!usage || usage.size === 0) {
    return null;
  }

  const percent = Math.min(100, (usage.used / usage.size) * 100);
  const remaining = usage.size - usage.used;

  const color = percent < 50 ? "bg-gb-green" : percent < 80 ? "bg-gb-yellow" : "bg-gb-red";
  const textColor = percent < 50 ? "text-gb-green" : percent < 80 ? "text-gb-yellow" : "text-gb-red";
  const showWarning = percent >= 80;

  return (
    <div className="flex items-center gap-2 border-t border-gb-border bg-gb-bg px-3 py-1">
      <span className="text-[10px] text-gb-muted">Context</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-gb-surface">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${percent}%` }}
        />
      </div>
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
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}
