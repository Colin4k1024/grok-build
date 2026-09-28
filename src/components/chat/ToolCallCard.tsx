import { useState, useMemo, memo, useCallback } from "react";
import { LazyTerminalView as TerminalView } from "./LazyTerminalView";
import type { ChatMessage } from "../../stores/sessionStore";

interface Props { message: ChatMessage; }

/** Shared SVG glyphs per tool family (R4 design rule: no emoji as icons). */
const TOOL_ICONS: Array<{ match: (n: string) => boolean; d: string }> = [
  { match: (n) => n.includes("bash") || n.includes("terminal") || n.includes("cmd") || n.includes("shell"),
    d: "M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM7 9l3 3-3 3M12 15h5" },
  { match: (n) => n.includes("read") || n.includes("open"),
    d: "M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-6-5zM13 3v5h5" },
  { match: (n) => n.includes("write") || n.includes("edit"),
    d: "M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4L16.5 3.5z" },
  { match: (n) => n.includes("search") || n.includes("grep") || n.includes("find"),
    d: "M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM21 21l-5.2-5.2" },
  { match: (n) => n.includes("web") || n.includes("http") || n.includes("fetch"),
    d: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a13 13 0 010 18 13 13 0 010-18z" },
  { match: (n) => n.includes("git"),
    d: "M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9" },
  { match: (n) => n.includes("todo") || n.includes("plan"),
    d: "M9 11l3 3 8-8M20 12v6a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9" },
  { match: (n) => n.includes("image") || n.includes("screenshot"),
    d: "M3 5h18v14H3zM8.5 11a2 2 0 100-4 2 2 0 000 4zM21 15l-5-5-7 7" },
  { match: (n) => n.includes("mcp"),
    d: "M9 3v5M15 3v5M6 8h12v4a6 6 0 01-12 0V8zM12 18v3" },
];
const TOOL_ICON_FALLBACK =
  "M14.5 6.5a4.5 4.5 0 00-6 6L4 17l3 3 4.5-4.5a4.5 4.5 0 006-6l-2.8 2.8-2.2-2.2 2.8-2.8z";

export function ToolIcon({ toolName, className }: { toolName?: string; className?: string }) {
  const n = (toolName || "").toLowerCase();
  const d = TOOL_ICONS.find((t) => t.match(n))?.d ?? TOOL_ICON_FALLBACK;
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={d} />
    </svg>
  );
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
 *  have to click it for every call in the thread. Persisted to localStorage.
 *
 *  The map is cached at module scope: reading + JSON.parsing localStorage in
 *  every card's useState initializer meant one synchronous storage read per
 *  tool call in the transcript (a thread with 200 bash calls did 200 reads
 *  while mounting). */
const COLLAPSE_KEY = "gb-tool-card-collapsed";
let collapsedCache: Record<string, boolean> | null = null;

function loadCollapsedMap(): Record<string, boolean> {
  if (collapsedCache) return collapsedCache;
  let parsed: Record<string, boolean>;
  try {
    parsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    parsed = {};
  }
  collapsedCache = parsed;
  return parsed;
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

/** Test-only: drop the module-level collapse cache. */
export function __resetCollapsedCache(): void {
  collapsedCache = null;
}

/** Memoized: tool cards sit inside the streaming message list, so every flush
 *  used to re-render all of them (and re-read localStorage) for no change. */
export const ToolCallCard = memo(function ToolCallCard({ message }: Props) {
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
      ? "text-gb-success-text"
      : message.toolSuccess === false
        ? "text-gb-danger-text"
        : "text-gb-muted";

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      saveCollapsed(toolName, !next);
      return next;
    });
  }, [toolName]);

  const lowerName = toolName.toLowerCase();
  const isScreenshot = lowerName.includes("screenshot") || lowerName.includes("capture");

  return (
    <div
      className={`my-1 overflow-hidden rounded-md border transition-colors ${
        isScreenshot ? "gb-screenshot-capture" : ""
      } ${
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
        <span className={`shrink-0 ${statusColor}`}>
          <ToolIcon toolName={toolName} />
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
          <span className={`shrink-0 text-[10px] ${statusColor}`}>失败</span>
        )}
      </button>
      {expanded && (message.content || (message as ChatMessage & { toolInput?: string }).toolInput) && (
        <div className="border-t border-gb-border/8">
          {/* Input section if the message carries a separate input payload. */}
          {(message as ChatMessage & { toolInput?: string }).toolInput && (
            <div className="border-b border-gb-border/8 px-3 py-1.5">
              <p className="mb-1 text-[9px] font-medium uppercase text-gb-muted">输入</p>
              <pre className="max-h-32 overflow-auto rounded bg-black/25 p-2 text-[11px] text-gb-text-secondary">
                <code>{(message as ChatMessage & { toolInput?: string }).toolInput}</code>
              </pre>
            </div>
          )}
          {message.content && (
            <div className="p-2">
              <p className="mb-1 px-1 text-[9px] font-medium uppercase text-gb-muted">输出</p>
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
});
