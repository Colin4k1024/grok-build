import { useState, useCallback, useRef, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";

/**
 * In-thread message search — searches the active session's messages and
 * renders a right-edge navigation rail with one marker per match. Clicking
 * a marker scrolls to that message.
 *
 * Codex parity: `thread-user-message-navigation-rail`.
 */
export function ThreadSearchRail() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ id: string; snippet: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    activeSessionId ? s.messages[activeSessionId] || [] : []
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      return;
    }
    const q = query.toLowerCase();
    const found = messages
      .filter((m) => m.content.toLowerCase().includes(q))
      .map((m) => ({
        id: m.id,
        snippet: m.content.slice(0, 80).replace(/\n/g, " "),
      }));
    setMatches(found);
  }, [query, messages]);

  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Brief highlight flash
    el?.classList.add("gb-jump-highlight");
    setTimeout(() => el?.classList.remove("gb-jump-highlight"), 1200);
  }, []);

  if (!activeSessionId || messages.length === 0) return null;

  return (
    <>
      {/* Toggle button — fixed to the right edge of the thread viewport. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Search in this conversation"
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
              placeholder="Search in conversation…"
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
              <p className="px-3 py-4 text-center text-[11px] text-gb-muted">No matches</p>
            ) : (
              matches.map((m) => (
                <button
                  key={m.id}
                  onClick={() => jumpTo(m.id)}
                  className="block w-full truncate px-3 py-1.5 text-left text-[11px] text-gb-text-secondary hover:bg-gb-surface-hover"
                >
                  {m.snippet}…
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Marker rail — one tick per user message on the right edge. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-1 flex-col justify-start gap-0.5 py-4">
        {messages
          .filter((m) => m.role === "user")
          .map((m, i, arr) => (
            <button
              key={m.id}
              onClick={() => jumpTo(m.id)}
              className="pointer-events-auto h-3 w-full rounded-full bg-gb-border/30 transition-colors hover:bg-gb-accent"
              style={{ marginTop: i === 0 ? 0 : undefined }}
              aria-label={`Jump to message ${i + 1} of ${arr.length}`}
            />
          ))}
      </div>
    </>
  );
}
