import { useState, useEffect, type ReactNode } from "react";
import { SubagentPanel } from "./SubagentPanel";
import { TodoPanel } from "./TodoPanel";
import { getMcpServers, type McpServerInfo } from "../../lib/tauri";

interface RightPanelProps {
  collapsed: boolean;
}

function McpPanel() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMcpServers()
      .then((list) => {
        if (!cancelled) setServers(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="py-8 text-center text-xs text-gb-muted">Loading MCP servers…</p>;
  }
  if (error) {
    return <p className="py-8 px-3 text-center text-xs text-gb-red">{error}</p>;
  }
  if (servers.length === 0) {
    return (
      <p className="py-8 px-3 text-center text-xs text-gb-muted">
        No MCP servers configured.
        <br />
        Add one under Settings → MCP Servers.
      </p>
    );
  }
  return (
    <div className="space-y-1 p-2">
      {servers.map((s) => (
        <div
          key={s.name}
          className="rounded-md border border-gb-border/10 bg-gb-surface px-2.5 py-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gb-text">{s.name}</span>
            <span
              className={`rounded px-1 text-[9px] ${
                s.enabled
                  ? "bg-gb-green/15 text-gb-green"
                  : "bg-gb-border text-gb-muted"
              }`}
            >
              {s.enabled ? "on" : "off"}
            </span>
            <span className="ml-auto rounded bg-gb-bg px-1 text-[9px] text-gb-muted">
              {s.transport_type}
            </span>
          </div>
          {s.command && (
            <p className="mt-1 truncate font-mono text-[10px] text-gb-muted">
              {s.command} {s.args.join(" ")}
            </p>
          )}
          {s.url && (
            <p className="mt-1 truncate font-mono text-[10px] text-gb-muted">{s.url}</p>
          )}
        </div>
      ))}
    </div>
  );
}

export function RightPanel({ collapsed }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<
    "tools" | "subagents" | "todo" | "diff" | "context" | "mcp"
  >("tools");

  if (collapsed) return null;

  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: "tools", label: "Tools" },
    { id: "subagents", label: "Agents" },
    { id: "todo", label: "TODO" },
    { id: "diff", label: "Diff" },
    { id: "context", label: "Context" },
    { id: "mcp", label: "MCP" },
  ];

  let content: ReactNode;
  switch (activeTab) {
    case "tools":
      content = (
        <p className="py-8 text-center text-xs text-gb-muted">
          No active tool calls.
        </p>
      );
      break;
    case "subagents":
      content = <SubagentPanel />;
      break;
    case "todo":
      content = <TodoPanel />;
      break;
    case "diff":
      content = (
        <p className="py-8 text-center text-xs text-gb-muted">
          No file changes yet.
        </p>
      );
      break;
    case "context":
      content = (
        <div className="space-y-3 p-3">
          <div>
            <p className="mb-1 text-[10px] uppercase text-gb-muted">Context Window</p>
            <div className="h-2 overflow-hidden rounded-full bg-gb-bg">
              <div className="h-full w-0 rounded-full bg-gb-accent" />
            </div>
            <p className="mt-1 text-[10px] text-gb-muted">0 / 0 tokens</p>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase text-gb-muted">Files in context</p>
            <p className="text-xs text-gb-muted">None</p>
          </div>
        </div>
      );
      break;
    case "mcp":
      content = <McpPanel />;
      break;
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-gb-border bg-gb-surface">
      <div className="flex overflow-x-auto border-b border-gb-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 shrink-0 px-2 py-2 text-[11px] font-medium transition-colors ${
              activeTab === tab.id
                ? "border-b-2 border-gb-accent text-gb-text"
                : "text-gb-muted hover:text-gb-text"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">{content}</div>
    </aside>
  );
}
