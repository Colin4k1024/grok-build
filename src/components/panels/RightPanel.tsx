import { useState, type ReactNode } from "react";

interface RightPanelProps {
  collapsed: boolean;
}

export function RightPanel({ collapsed }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<"tools" | "diff" | "context">("tools");

  if (collapsed) return null;

  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: "tools", label: "Tools" },
    { id: "diff", label: "Diff" },
    { id: "context", label: "Context" },
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
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-gb-border bg-gb-surface">
      <div className="flex border-b border-gb-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 px-2 py-2 text-[11px] font-medium transition-colors ${
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
