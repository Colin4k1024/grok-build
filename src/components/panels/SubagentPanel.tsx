import { useState } from "react";
import { useSessionStore, type Subagent } from "../../stores/sessionStore";

export function SubagentPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const subagents = useSessionStore((s) => s.subagents);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sessionSubagents: Subagent[] = activeSessionId
    ? subagents[activeSessionId] || []
    : [];

  if (sessionSubagents.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-gb-muted">
        No active subagents.
      </div>
    );
  }

  const statusColors: Record<Subagent["status"], string> = {
    spawning: "bg-gb-yellow",
    running: "bg-gb-accent",
    done: "bg-gb-green",
    failed: "bg-gb-red",
  };

  const statusLabels: Record<Subagent["status"], string> = {
    spawning: "Spawning",
    running: "Running",
    done: "Done",
    failed: "Failed",
  };

  return (
    <div className="space-y-1 p-2">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase text-gb-muted">
          Subagents ({sessionSubagents.length})
        </span>
        <div className="flex gap-1">
          {sessionSubagents.filter((s) => s.status === "running").length > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-gb-accent">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gb-accent" />
              {sessionSubagents.filter((s) => s.status === "running").length} running
            </span>
          )}
        </div>
      </div>

      {sessionSubagents.map((agent) => (
        <div
          key={agent.id}
          className="rounded-md border border-gb-border bg-gb-surface"
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
            onClick={() => setExpandedId(expandedId === agent.id ? null : agent.id)}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusColors[agent.status]}`} />
            <div className="min-w-0 flex-1">
              <span className="text-xs font-medium text-gb-text truncate block">
                {agent.name}
              </span>
              <span className="text-[10px] text-gb-muted">
                {statusLabels[agent.status]}
              </span>
            </div>
            {agent.summary && (
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                className={`text-gb-muted transition-transform ${
                  expandedId === agent.id ? "rotate-180" : ""
                }`}
              >
                <path d="M2 3.5L5 7l3-3.5z" />
              </svg>
            )}
          </button>
          {expandedId === agent.id && agent.summary && (
            <div className="border-t border-gb-border px-3 py-2">
              <pre className="whitespace-pre-wrap text-[11px] text-gb-muted">
                {agent.summary}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
