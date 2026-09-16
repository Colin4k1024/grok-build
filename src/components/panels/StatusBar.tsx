interface StatusBarProps { connected: boolean; workingDir: string; sandboxMode: boolean; sessionCount: number; streaming: boolean; }

export function StatusBar({ connected, workingDir, sandboxMode: _sandboxMode, sessionCount, streaming }: StatusBarProps) {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-gb-border/8 px-3 text-[10px] text-gb-muted">
      <div className="flex items-center gap-2.5">
        <span className="flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-gb-green" : "bg-gb-red"}`} />
          {connected ? "Connected" : "Disconnected"}
        </span>
        <span className="text-gb-border/20">·</span>
        <span className="truncate max-w-[180px]">{workingDir}</span>
      </div>
      <div className="flex items-center gap-2.5">
        {streaming && <span className="text-gb-accent">Generating…</span>}
        <span>{sessionCount > 0 ? `${sessionCount} session${sessionCount > 1 ? "s" : ""}` : "—"}</span>
      </div>
    </footer>
  );
}
