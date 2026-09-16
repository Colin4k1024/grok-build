import { useMemo, useState } from "react";
import { useSessionStore, type Subagent } from "../stores/sessionStore";

interface WorkspaceAgentsPageProps {
  onClose: () => void;
  onOpenSession: (id: string) => void;
}

/**
 * Workspace-wide agent overview — lists every subagent across every open
 * session, with detail drill-down. Codex parity: `workspace-agents-page`.
 */
export function WorkspaceAgentsPage({ onClose, onOpenSession }: WorkspaceAgentsPageProps) {
  const tabs = useSessionStore((s) => s.tabs);
  const subagents = useSessionStore((s) => s.subagents);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Flatten subagents with their session context.
  const all = useMemo(() => {
    const list: { agent: Subagent; sessionId: string; sessionTitle: string }[] = [];
    for (const tab of tabs) {
      const items = subagents[tab.id] || [];
      for (const a of items) {
        list.push({ agent: a, sessionId: tab.id, sessionTitle: tab.title });
      }
    }
    return list.sort((a, b) => b.agent.createdAt - a.agent.createdAt);
  }, [tabs, subagents]);

  const selected = all.find(
    (x) => `${x.sessionId}:${x.agent.id}` === selectedAgentId
  );

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-gb-border/8 px-4">
        <h2 className="text-[13px] font-medium">Workspace agents</h2>
        <button
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onClose}
        >
          ← Back
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* List */}
        <div className="w-80 shrink-0 overflow-y-auto border-r border-gb-border/8 bg-gb-bg-secondary p-2">
          {all.length === 0 ? (
            <p className="py-8 text-center text-xs text-gb-muted">
              No subagents yet. They'll appear here as sessions spawn them.
            </p>
          ) : (
            all.map(({ agent, sessionId, sessionTitle }) => {
              const key = `${sessionId}:${agent.id}`;
              const active = key === selectedAgentId;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedAgentId(key)}
                  className={`mb-1 flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                    active ? "bg-gb-accent/15" : "hover:bg-gb-surface-hover"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        agent.status === "running"
                          ? "bg-gb-accent"
                          : agent.status === "done"
                            ? "bg-gb-green"
                            : agent.status === "failed"
                              ? "bg-gb-red"
                              : "bg-gb-yellow"
                      }`}
                    />
                    <span className="truncate text-[12px] font-medium text-gb-text">
                      {agent.name}
                    </span>
                  </div>
                  <span className="truncate text-[10px] text-gb-muted">
                    {sessionTitle} · {agent.status}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Detail */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selected ? (
            <p className="py-12 text-center text-xs text-gb-muted">
              Pick an agent on the left to see its details.
            </p>
          ) : (
            <div className="mx-auto max-w-2xl space-y-4">
              <div>
                <h3 className="text-base font-semibold text-gb-text">
                  {selected.agent.name}
                </h3>
                <p className="mt-0.5 text-[12px] text-gb-muted">
                  Session:{" "}
                  <button
                    onClick={() => onOpenSession(selected.sessionId)}
                    className="text-gb-accent hover:underline"
                  >
                    {selected.sessionTitle}
                  </button>
                </p>
              </div>

              <div className="rounded-lg border border-gb-border bg-gb-surface p-4">
                <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">
                  Status
                </p>
                <p className="text-[13px] text-gb-text">{selected.agent.status}</p>
              </div>

              <div className="rounded-lg border border-gb-border bg-gb-surface p-4">
                <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">
                  Summary
                </p>
                <pre className="whitespace-pre-wrap text-[12px] text-gb-text-secondary">
                  {selected.agent.summary || "No summary yet."}
                </pre>
              </div>

              <div className="rounded-lg border border-gb-border bg-gb-surface p-4">
                <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">
                  Metadata
                </p>
                <dl className="grid grid-cols-2 gap-2 text-[12px]">
                  <dt className="text-gb-muted">ID</dt>
                  <dd className="truncate font-mono text-gb-text">{selected.agent.id}</dd>
                  <dt className="text-gb-muted">Tool call</dt>
                  <dd className="truncate font-mono text-gb-text">
                    {selected.agent.toolCallId}
                  </dd>
                  <dt className="text-gb-muted">Created</dt>
                  <dd className="text-gb-text">
                    {new Date(selected.agent.createdAt).toLocaleString()}
                  </dd>
                </dl>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
