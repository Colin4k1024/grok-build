import { useState, useMemo, useCallback } from "react";
import { useSessionStore, type Subagent } from "../../stores/sessionStore";

interface AgentActivity {
  id: string;
  ts: number;
  kind: "spawn" | "tool" | "thought" | "result" | "error";
  text: string;
}

export function SubagentPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const subagents = useSessionStore((s) => s.subagents);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sessionSubagents: Subagent[] = useMemo(
    () => (activeSessionId ? subagents[activeSessionId] || [] : []),
    [activeSessionId, subagents]
  );

  // Synthesize a timeline from subagent lifecycle events. This is the
  // "agent activity units" view from ISS-026 — one row per event per agent.
  const activities = useMemo(() => {
    const list: AgentActivity[] = [];
    for (const a of sessionSubagents) {
      list.push({
        id: `${a.id}-spawn`,
        ts: a.createdAt,
        kind: "spawn",
        text: `Spawned ${a.name}`,
      });
      if (a.status === "done" && a.summary) {
        list.push({
          id: `${a.id}-result`,
          ts: a.createdAt + 1,
          kind: "result",
          text: a.summary.slice(0, 200),
        });
      } else if (a.status === "failed") {
        list.push({
          id: `${a.id}-err`,
          ts: a.createdAt + 1,
          kind: "error",
          text: a.summary || "Subagent failed",
        });
      }
    }
    return list.sort((a, b) => a.ts - b.ts);
  }, [sessionSubagents]);

  const handleCancel = useCallback(
    (id: string) => {
      // Mark as failed locally; backend cancellation is a separate Tauri
      // command that can be wired in once it exists.
      updateSubagent(activeSessionId!, id, { status: "failed" });
    },
    [activeSessionId, updateSubagent]
  );

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

  const activityIcon = (kind: AgentActivity["kind"]) => {
    switch (kind) {
      case "spawn": return "▶";
      case "tool": return "🔧";
      case "thought": return "💭";
      case "result": return "✓";
      case "error": return "✗";
    }
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

      {/* Activity timeline */}
      {activities.length > 0 && (
        <div className="mb-3 space-y-0.5 rounded-md border border-gb-border/10 bg-gb-bg-secondary p-2">
          <p className="mb-1 text-[9px] font-medium uppercase text-gb-muted">
            Activity
          </p>
          {activities.slice(-10).map((a) => (
            <div key={a.id} className="flex gap-1.5 text-[10px]">
              <span className="shrink-0 text-gb-muted">{activityIcon(a.kind)}</span>
              <span className="flex-1 truncate text-gb-text-secondary">{a.text}</span>
              <span className="shrink-0 text-gb-muted/60">
                {new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Agent list */}
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
              <span className="block truncate text-xs font-medium text-gb-text">
                {agent.name}
              </span>
              <span className="text-[10px] text-gb-muted">
                {statusLabels[agent.status]}
              </span>
            </div>
            {(agent.status === "running" || agent.status === "spawning") && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCancel(agent.id);
                }}
                className="shrink-0 rounded px-1.5 py-0.5 text-[9px] text-gb-red hover:bg-gb-red/10"
                aria-label="Cancel subagent"
              >
                Cancel
              </button>
            )}
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
              <p className="mb-1 text-[9px] font-medium uppercase text-gb-muted">
                Result summary
              </p>
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
