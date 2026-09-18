import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import type { ChatMessage } from "../../stores/sessionStore";

const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * In-thread message search — searches the active session's messages and
 * renders a right-edge navigation rail with one marker per user message
 * (Codex's `thread-user-message-navigation-rail`). Clicking a marker
 * scrolls to that message.
 */
export function ThreadSearchRail() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ id: string; snippet: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    activeSessionId ? (s.messages[activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounce search by 150ms so fast typists don't thrash the message list.
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      return;
    }
    const q = query.toLowerCase();
    const timer = setTimeout(() => {
      const found = messages
        .filter((m) => m.content.toLowerCase().includes(q))
        .map((m) => {
          const idx = m.content.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 30);
          const end = Math.min(m.content.length, idx + q.length + 50);
          const snippet =
            (start > 0 ? "…" : "") +
            m.content.slice(start, end).replace(/\n/g, " ") +
            (end < m.content.length ? "…" : "");
          return { id: m.id, snippet };
        });
      setMatches(found);
    }, 150);
    return () => clearTimeout(timer);
  }, [query, messages]);

  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Brief highlight flash
    el?.classList.add("gb-jump-highlight");
    setTimeout(() => el?.classList.remove("gb-jump-highlight"), 1200);
  }, []);

  const userMessages = useMemo(
    () => messages.filter((m) => m.role === "user"),
    [messages]
  );

  if (!activeSessionId || messages.length === 0) return null;

  return (
    <>
      {/* Toggle button — fixed to the right edge of the thread viewport. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="搜索当前会话"
        className="absolute right-2 top-14 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-gb-border/20 bg-gb-surface-solid text-gb-muted shadow hover:text-gb-text"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="5" />
          <path d="M11 11l4 4" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-2 top-[88px] z-20 w-64 rounded-md border border-gb-border/10 bg-gb-surface-solid shadow-xl">
          <div className="border-b border-gb-border/8 p-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索会话内容…"
              className="w-full rounded border border-gb-border/20 bg-gb-bg px-2 py-1 text-[12px] text-gb-text outline-none focus:border-gb-accent/50"
            />
            {query && (
              <p className="mt-1 text-[10px] text-gb-muted">
                {matches.length} match{matches.length === 1 ? "" : "es"}
              </p>
            )}
          </div>
          <div className="max-h-72 overflow-y-auto">
            {matches.length === 0 && query ? (
              <p className="px-3 py-4 text-center text-[11px] text-gb-muted">无匹配结果</p>
            ) : (
              matches.map((m) => (
                <button
                  key={m.id}
                  onClick={() => jumpTo(m.id)}
                  className="block w-full px-3 py-1.5 text-left text-[11px] text-gb-text-secondary hover:bg-gb-surface-hover"
                  title={m.snippet}
                >
                  <span className="block truncate">{m.snippet}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Marker rail — one tick per user message, positioned proportionally
          down the right edge so the ticks hint at where messages live in the
          thread. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-1">
        {userMessages.map((m, i) => {
          const ratio = userMessages.length <= 1 ? 0 : i / (userMessages.length - 1);
          return (
            <button
              key={m.id}
              onClick={() => jumpTo(m.id)}
              className="pointer-events-auto absolute left-0 h-2.5 w-full rounded-full bg-gb-border/30 transition-colors hover:bg-gb-accent"
              style={{ top: `${8 + ratio * 84}%` }}
              aria-label={`Jump to user message ${i + 1} of ${userMessages.length}`}
            />
          );
        })}
      </div>
    </>
  );
}
