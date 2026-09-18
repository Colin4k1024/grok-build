/**
 * Usage aggregation (ISS-081): pure helpers so the panel and the /usage
 * command share one data口径.
 */

export interface UsageRow {
  sessionId: string;
  title: string;
  used: number | null;
  size: number | null;
  /** null for threads with no usage event yet — the UI shows 未知. */
  known: boolean;
  percent: number | null;
}

export interface UsageAggregate {
  rows: UsageRow[];
  totalUsed: number | null;
  threadCount: number;
  knownCount: number;
}

export function aggregateUsage(
  tabs: { id: string; title: string }[],
  tokenUsage: Record<string, { used: number; size: number }>
): UsageAggregate {
  const rows: UsageRow[] = tabs.map((t) => {
    const u = tokenUsage[t.id];
    if (!u || typeof u.used !== "number" || typeof u.size !== "number") {
      return { sessionId: t.id, title: t.title, used: null, size: null, known: false, percent: null };
    }
    return {
      sessionId: t.id,
      title: t.title,
      used: u.used,
      size: u.size,
      known: true,
      percent: u.size > 0 ? Math.min(100, Math.round((u.used / u.size) * 100)) : null,
    };
  });
  const known = rows.filter((r) => r.known);
  return {
    rows,
    totalUsed: known.length ? known.reduce((acc, r) => acc + (r.used ?? 0), 0) : null,
    threadCount: rows.length,
    knownCount: known.length,
  };
}

/** Format a retry deadline for the rate-limit banner. */
export function formatRetry(until: number, now = Date.now()): string {
  const remain = Math.max(0, Math.ceil((until - now) / 1000));
  if (remain <= 0) return "现在可重试";
  if (remain < 60) return `${remain} 秒后重试`;
  const m = Math.floor(remain / 60);
  return `${m} 分 ${remain % 60} 秒后重试`;
}
