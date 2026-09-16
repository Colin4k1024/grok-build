import { useState, useMemo } from "react";
import { TerminalView } from "./TerminalView";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props { message: ChatMessage; }

/** Pick a small emoji glyph per tool so users can scan the timeline quickly. */
function toolIcon(toolName?: string): string {
  const n = (toolName || "").toLowerCase();
  if (n.includes("bash") || n.includes("terminal") || n.includes("cmd") || n.includes("shell")) return "💻";
  if (n.includes("read") || n.includes("open")) return "📖";
  if (n.includes("write") || n.includes("edit")) return "✏️";
  if (n.includes("search") || n.includes("grep") || n.includes("find")) return "🔍";
  if (n.includes("web") || n.includes("http") || n.includes("fetch")) return "🌐";
  if (n.includes("git")) return "🌿";
  if (n.includes("todo") || n.includes("plan")) return "📝";
  if (n.includes("image") || n.includes("screenshot")) return "🖼️";
  if (n.includes("mcp")) return "🔌";
  return "🔧";
}

/** Format milliseconds as a compact human-readable duration. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Remember collapse state per tool so a user who always expands "bash" doesn't
 *  have to click it for every call in the thread. Persisted to localStorage. */
const COLLAPSE_KEY = "gb-tool-card-collapsed";
function loadCollapsedMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveCollapsed(toolName: string, collapsed: boolean) {
  const map = loadCollapsedMap();
  map[toolName] = collapsed;
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map));
  } catch {
    /* quota */
  }
}

export function ToolCallCard({ message }: Props) {
  const toolName = message.toolName || "tool";
  const [expanded, setExpanded] = useState(() => {
    const map = loadCollapsedMap();
    // Default expanded; honor a previously-saved collapse preference.
    return !(map[toolName] === true);
  });

  const isTerminal =
    toolName.toLowerCase().includes("bash") ||
    toolName.toLowerCase().includes("terminal") ||
    toolName.toLowerCase().includes("cmd");

  const durationMs = useMemo(() => {
    // Use message duration if the backend provides it (future-proof); else
    // derive from timestamp delta against the previous tool call is not
    // available here — so omit duration when unknown.
    const anyMsg = message as ChatMessage & { durationMs?: number };
    return typeof anyMsg.durationMs === "number" ? anyMsg.durationMs : null;
  }, [message]);

  const statusColor =
    message.toolSuccess === true
      ? "text-gb-green"
      : message.toolSuccess === false
        ? "text-gb-red"
        : "text-gb-muted";

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    saveCollapsed(toolName, !next);
  };

  return (
    <div
      className={`my-1 overflow-hidden rounded-md border transition-colors ${
        message.toolSuccess === true
          ? "border-gb-green/20"
          : message.toolSuccess === false
            ? "border-gb-red/30"
            : "border-gb-border/8"
      }`}
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gb-surface-hover"
        onClick={toggleExpanded}
        aria-expanded={expanded}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="currentColor"
          className={`shrink-0 text-gb-muted transition-transform ${expanded ? "" : "-rotate-90"}`}
        >
          <path d="M1 2l3 3 3-3z" />
        </svg>
        <span className="shrink-0 text-sm" aria-hidden>
          {toolIcon(toolName)}
        </span>
        <span className="truncate text-[12px] text-gb-text-secondary">{toolName}</span>
        {durationMs !== null && (
          <span className="shrink-0 rounded bg-gb-bg px-1.5 py-0.5 text-[9px] tabular-nums text-gb-muted">
            {formatDuration(durationMs)}
          </span>
        )}
        {message.toolSuccess === true && (
          <span className={`shrink-0 text-[10px] ${statusColor}`}>✓</span>
        )}
        {message.toolSuccess === false && (
          <span className={`shrink-0 text-[10px] ${statusColor}`}>failed</span>
        )}
      </button>
      {expanded && (message.content || (message as ChatMessage & { toolInput?: string }).toolInput) && (
        <div className="border-t border-gb-border/8">
          {/* Input section if the message carries a separate input payload. */}
          {(message as ChatMessage & { toolInput?: string }).toolInput && (
            <div className="border-b border-gb-border/8 px-3 py-1.5">
              <p className="mb-1 text-[9px] font-medium uppercase text-gb-muted">Input</p>
              <pre className="max-h-32 overflow-auto rounded bg-black/25 p-2 text-[11px] text-gb-text-secondary">
                <code>{(message as ChatMessage & { toolInput?: string }).toolInput}</code>
              </pre>
            </div>
          )}
          {message.content && (
            <div className="p-2">
              <p className="mb-1 px-1 text-[9px] font-medium uppercase text-gb-muted">Output</p>
              {isTerminal ? (
                <TerminalView content={message.content} />
              ) : (
                <pre className="max-h-64 overflow-auto rounded bg-black/25 p-2.5 text-[12px] text-gb-text-secondary">
                  <code>{message.content}</code>
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
