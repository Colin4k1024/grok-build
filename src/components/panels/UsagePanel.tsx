import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { aggregateUsage, formatRetry } from "../../lib/usage";

interface UsagePanelProps {
  onClose: () => void;
}

/** Codex-style /usage panel: per-thread context usage + limits (ISS-081). */
export function UsagePanel({ onClose }: UsagePanelProps) {
  const tabs = useSessionStore((s) => s.tabs);
  const tokenUsage = useSessionStore((s) => s.tokenUsage);
  const rateLimits = useSessionStore((s) => s.rateLimits);
  const setRateLimit = useSessionStore((s) => s.setRateLimit);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [, forceTick] = useState(0);

  // Expired banners clear themselves.
  useEffect(() => {
    const t = window.setInterval(() => forceTick((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    for (const [sid, limit] of Object.entries(rateLimits)) {
      if (limit.until <= Date.now()) setRateLimit(sid, null);
    }
  }, [rateLimits, setRateLimit]);

  const agg = useMemo(
    () => aggregateUsage(tabs.map((t) => ({ id: t.id, title: t.title })), tokenUsage),
    [tabs, tokenUsage]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" onClick={onClose}>
      <div
        className="w-[460px] rounded-xl border border-gb-border bg-gb-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold text-gb-text">用量与限制</h2>
          <button className="text-xs text-gb-muted hover:text-gb-text" onClick={onClose}>✕</button>
        </div>

        <div className="mb-3 rounded-lg border border-gb-border/10 bg-gb-bg p-2.5 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-gb-text">
              {agg.totalUsed === null ? "未知" : `${(agg.totalUsed / 1000).toFixed(1)}k`}
            </span>
            <span className="text-gb-muted">tokens（{agg.knownCount}/{agg.threadCount} 线程有数据）</span>
          </div>
          <p className="mt-1 text-[10px] text-gb-muted">
            计数单调递增；compaction 后按新口径继续累计。缺失/乱序事件的线程显示"未知"。
          </p>
        </div>

        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {agg.rows.length === 0 && (
            <p className="py-3 text-center text-[11px] text-gb-muted">暂无线程。</p>
          )}
          {agg.rows.map((row) => {
            const limit = rateLimits[row.sessionId];
            return (
              <div
                key={row.sessionId}
                className={`rounded-md border px-2.5 py-1.5 ${
                  row.sessionId === activeSessionId ? "border-gb-accent/40" : "border-gb-border/10"
                }`}
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-gb-text">{row.title}</span>
                  <span className="tabular-nums text-gb-muted">
                    {row.known ? `${(row.used! / 1000).toFixed(1)}k / ${(row.size! / 1000).toFixed(0)}k` : "未知"}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-gb-border/20">
                  {row.percent !== null && (
                    <div
                      className={`h-1 rounded ${row.percent > 80 ? "bg-gb-red" : row.percent > 50 ? "bg-gb-yellow" : "bg-gb-accent"}`}
                      style={{ width: `${row.percent}%` }}
                    />
                  )}
                </div>
                {limit && limit.until > Date.now() && (
                  <p className="mt-1 text-[10px] text-gb-red">
                    ⏳ 限流中 — {formatRetry(limit.until)}（{limit.message.slice(0, 80)}）
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
