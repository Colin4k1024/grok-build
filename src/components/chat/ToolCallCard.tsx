import { useState } from "react";
import { TerminalView } from "./TerminalView";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props { message: ChatMessage; }

export function ToolCallCard({ message }: Props) {
  const [expanded, setExpanded] = useState(true);
  const isTerminal = message.toolName?.toLowerCase().includes("bash") || message.toolName?.toLowerCase().includes("terminal") || message.toolName?.toLowerCase().includes("cmd");

  return (
    <div className="my-1 overflow-hidden rounded-md border border-gb-border/8">
      <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gb-surface-hover" onClick={() => setExpanded(!expanded)}>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" className={`text-gb-muted transition-transform ${expanded ? "" : "-rotate-90"}`}><path d="M1 2l3 3 3-3z" /></svg>
        <span className="text-[12px] text-gb-text-secondary">{message.toolName || "tool"}</span>
        {message.toolSuccess === true && <span className="text-[10px] text-gb-green">✓</span>}
        {message.toolSuccess === false && <span className="text-[10px] text-gb-red">failed</span>}
      </button>
      {expanded && message.content && (
        <div className="border-t border-gb-border/8 p-2">
          {isTerminal ? <TerminalView content={message.content} /> : <pre className="max-h-64 overflow-auto rounded bg-black/25 p-2.5 text-[12px] text-gb-text-secondary"><code>{message.content}</code></pre>}
        </div>
      )}
    </div>
  );
}
