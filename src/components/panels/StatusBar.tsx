import { useSessionStore } from "../../stores/sessionStore";

interface StatusBarProps { connected: boolean; workingDir: string; sandboxMode: boolean; sessionCount: number; streaming: boolean; }

export function StatusBar({ connected, workingDir, sandboxMode: _sandboxMode, sessionCount, streaming }: StatusBarProps) {
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions);
  // Count all unresolved permission requests across sessions — this is the
  // in-app "notification badge" surface for ISS-053.
  const pendingCount = Object.values(pendingPermissions).reduce(
    (sum, arr) => sum + arr.length,
    0
  );

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-gb-border/8 px-3 text-[10px] text-gb-muted">
      <div className="flex items-center gap-2.5">
        <span className="flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-gb-green" : "bg-gb-red"}`} />
          {connected ? "Connected" : "Disconnected"}
        </span>
        <span className="text-gb-border/20">·</span>
        <span className="max-w-[180px] truncate">{workingDir}</span>
      </div>
      <div className="flex items-center gap-2.5">
        {pendingCount > 0 && (
          <span
            className="flex items-center gap-1 rounded-full bg-gb-yellow/15 px-1.5 py-0.5 text-[9px] font-medium text-gb-yellow"
            title={`${pendingCount} approval${pendingCount > 1 ? "s" : ""} waiting`}
          >
            <span className="h-1 w-1 rounded-full bg-gb-yellow" />
            {pendingCount} pending
          </span>
        )}
        {streaming && <span className="text-gb-accent">Generating…</span>}
        <span>{sessionCount > 0 ? `${sessionCount} session${sessionCount > 1 ? "s" : ""}` : "—"}</span>
      </div>
    </footer>
  );
}
