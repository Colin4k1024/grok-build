interface StatusBarProps {
  connected: boolean;
  workingDir: string;
  sandboxMode: boolean;
  sessionCount: number;
  streaming: boolean;
}

export function StatusBar({
  connected,
  workingDir,
  sandboxMode,
  sessionCount,
  streaming,
}: StatusBarProps) {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-gb-border bg-gb-surface px-3 text-[10px] text-gb-muted">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              connected ? "bg-gb-green" : "bg-gb-red"
            }`}
          />
          {connected ? "Connected" : "Disconnected"}
        </span>
        <span className="text-gb-border">|</span>
        <span className="truncate max-w-[200px]">{workingDir}</span>
        <span className="text-gb-border">|</span>
        <span className={sandboxMode ? "text-gb-yellow" : ""}>
          {sandboxMode ? "🔒 Sandbox" : "🔓 Full Access"}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {streaming && (
          <span className="text-gb-accent">● Generating...</span>
        )}
        <span>
          {sessionCount > 0 ? `${sessionCount} session${sessionCount > 1 ? "s" : ""}` : "no session"}
        </span>
      </div>
    </footer>
  );
}
