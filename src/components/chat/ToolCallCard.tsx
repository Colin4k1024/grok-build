import { useState } from "react";
import { TerminalView } from "./TerminalView";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props {
  message: ChatMessage;
}

export function ToolCallCard({ message }: Props) {
  const [expanded, setExpanded] = useState(true);

  const isTerminal = message.toolName?.toLowerCase().includes("bash") ||
    message.toolName?.toLowerCase().includes("terminal") ||
    message.toolName?.toLowerCase().includes("cmd");

  return (
    <div className="my-2 rounded border border-gb-border bg-gb-surface/50">
      {/* Header */}
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gb-surface"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gb-muted">
            {expanded ? "▼" : "▶"}
          </span>
          <span className="font-mono text-gb-text">
            🔧 {message.toolName || "tool"}
          </span>
          {message.toolSuccess === true && (
            <span className="text-gb-green">✓</span>
          )}
          {message.toolSuccess === false && (
            <span className="text-gb-red">✗ failed</span>
          )}
        </div>
      </button>

      {/* Content */}
      {expanded && message.content && (
        <div className="border-t border-gb-border p-2">
          {isTerminal ? (
            <TerminalView content={message.content} />
          ) : (
            <pre className="max-h-64 overflow-auto rounded bg-gb-bg p-3 text-xs text-gb-muted">
              <code>{message.content}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
