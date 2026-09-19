import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "../../stores/sessionStore";
import type { ChatMessage } from "../../stores/sessionStore";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_IDS: string[] = [];
/** Minimum gap between corpus-driven search refreshes while a turn streams. */
const CORPUS_REFRESH_MS = 500;

/**
 * In-thread message search — searches the active session's messages and
 * renders a right-edge navigation rail with one marker per user message
 * (Codex's `thread-user-message-navigation-rail`). Clicking a marker
 * scrolls to that message.
 *
 * This component lives inside MessageList, so it re-renders on every stream
 * flush (~20 Hz). Its subscriptions are deliberately narrow: the marker rail
 * watches only user-message ids (shallow-compared, so an assistant delta
 * changes nothing), and the full transcript is subscribed ONLY while a search
 * is actually open. Previously it held the whole messages array, which made
 * every delta re-filter the transcript, re-render the rail, and — because the
 * debounce effect depended on `messages` — perpetually defer the search so it
 * never returned results while a reply was streaming.
 */
export function ThreadSearchRail() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ id: string; snippet: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  // Marker rail data: user-message ids only. `useStoreWithEqualityFn` is the
  // supported way to pass a custom equality fn in zustand v4 (passing one to
  // a `create()` hook is deprecated and warns).
  const userMsgIds = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((s) => {
      const id = s.activeSessionId;
      const msgs = id ? s.messages[id] : undefined;
      if (!msgs || msgs.length === 0) return EMPTY_IDS;
      const out: string[] = [];
      for (const m of msgs) if (m.role === "user") out.push(m.id);
      return out;
    }, []),
    shallow
  );

  const hasAnyMessage = useSessionStore(useCallback((s) => {
    const id = s.activeSessionId;
    return !!id && (s.messages[id]?.length ?? 0) > 0;
  }, []));

  // Full transcript, subscribed only while a search can actually run.
  const searchActive = open && query.trim().length > 0;
  const messages = useSessionStore(useCallback((s) => {
    if (!searchActive) return EMPTY_MESSAGES;
    const id = s.activeSessionId;
    return (id ? s.messages[id] : undefined) ?? EMPTY_MESSAGES;
  }, [searchActive]));

  // Runs the search against the CURRENT store contents (getState), never a
  // captured snapshot — so it always sees the latest transcript.
  const settledQueryRef = useRef("");
  const lastCorpusRunRef = useRef(0);

  const runSearch = useCallback((q: string) => {
    const sid = useSessionStore.getState().activeSessionId;
    const corpus = (sid ? useSessionStore.getState().messages[sid] : undefined) ?? [];
    const found: { id: string; snippet: string }[] = [];
    for (const m of corpus) {
      const idx = m.content.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 30);
      const end = Math.min(m.content.length, idx + q.length + 50);
      found.push({
        id: m.id,
        snippet:
          (start > 0 ? "…" : "") +
          m.content.slice(start, end).replace(/\n/g, " ") +
          (end < m.content.length ? "…" : ""),
      });
    }
    settledQueryRef.current = q;
    lastCorpusRunRef.current = Date.now();
    setMatches(found);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounce the query by 150ms so fast typists don't thrash the message list.
  //
  // Deliberately NOT keyed on the messages array: a streaming reply changes it
  // ~20×/s, and including it cleared and restarted this timer on every flush so
  // the search never completed while an answer was arriving.
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!open || !q) {
      settledQueryRef.current = "";
      setMatches((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const timer = setTimeout(() => runSearch(q), 150);
    return () => clearTimeout(timer);
  }, [query, open, runSearch]);

  // Once a query has settled, keep results fresh as new content streams in —
  // throttled so a live turn can't turn this into a per-flush full scan.
  useEffect(() => {
    if (!searchActive) return;
    const q = query.trim().toLowerCase();
    if (!q || q !== settledQueryRef.current) return;
    if (Date.now() - lastCorpusRunRef.current < CORPUS_REFRESH_MS) return;
    runSearch(q);
  }, [messages, searchActive, query, runSearch]);

  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Brief highlight flash
    el?.classList.add("gb-jump-highlight");
    setTimeout(() => el?.classList.remove("gb-jump-highlight"), 1200);
  }, []);

  const markerCount = userMsgIds.length;
  const markers = useMemo(
    () =>
      userMsgIds.map((id, i) => ({
        id,
        // Positioned proportionally down the right edge so the ticks hint at
        // where messages live in the thread.
        top: `${8 + (markerCount <= 1 ? 0 : i / (markerCount - 1)) * 84}%`,
        index: i,
      })),
    [userMsgIds, markerCount]
  );

  if (!activeSessionId || !hasAnyMessage) return null;

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

      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-1">
        {markers.map((m) => (
          <button
            key={m.id}
            onClick={() => jumpTo(m.id)}
            className="pointer-events-auto absolute left-0 h-2.5 w-full rounded-full bg-gb-border/30 transition-colors hover:bg-gb-accent"
            style={{ top: m.top }}
            aria-label={`Jump to user message ${m.index + 1} of ${markerCount}`}
          />
        ))}
      </div>
    </>
  );
}
