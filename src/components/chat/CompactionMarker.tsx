import { useSessionStore } from "../../stores/sessionStore";
import type { CompactionMarker as Marker } from "../../stores/sessionStore";

interface Props {
  marker: Marker;
}

export function CompactionMarkerItem({ marker }: Props) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const rollbackCompaction = useSessionStore((s) => s.rollbackCompaction);

  function formatTokens(n: number | null): string {
    if (n === null) return "?";
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
    return String(n);
  }

  const reduction = marker.tokensBefore !== null && marker.tokensAfter !== null
    ? marker.tokensBefore - marker.tokensAfter
    : null;

  return (
    <div className="my-2 flex items-center gap-2">
      <div className="h-px flex-1 bg-gb-border" />
      <div className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] ${marker.rolledBack ? "border-gb-yellow bg-gb-yellow/10 text-gb-yellow" : "border-gb-green bg-gb-green/10 text-gb-green"}`}>
        <span>{marker.rolledBack ? "↩ Compaction rolled back" : "✦ Context compacted"}</span>
        {reduction !== null && reduction > 0 && !marker.rolledBack && (
          <span className="tabular-nums">
            {formatTokens(marker.tokensBefore)} → {formatTokens(marker.tokensAfter)} ({formatTokens(reduction)} freed)
          </span>
        )}
        {marker.summary && !marker.rolledBack && (
          <span className="max-w-xs truncate text-gb-muted" title={marker.summary}>
            {marker.summary}
          </span>
        )}
        {!marker.rolledBack && activeSessionId && (
          <button
            onClick={() => rollbackCompaction(activeSessionId)}
            className="text-gb-muted underline hover:text-gb-text"
          >
            Undo
          </button>
        )}
      </div>
      <div className="h-px flex-1 bg-gb-border" />
    </div>
  );
}
