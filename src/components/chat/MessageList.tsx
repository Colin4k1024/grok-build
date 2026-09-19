import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { MessageItem } from "./MessageItem";
import { CompactionMarkerItem } from "./CompactionMarker";
import { ThreadSearchRail } from "./ThreadSearchRail";
import { useSessionStore } from "../../stores/sessionStore";
import { requestHighlight } from "./useHighlight";
import type { ChatMessage, CompactionMarker } from "../../stores/sessionStore";

const RENDER_WINDOW = 150;
const OVERSCAN = 20;
/** Distance from the bottom (px) still counted as "following the stream". */
const FOLLOW_THRESHOLD = 120;

const EMPTY_MESSAGES: ChatMessage[] = [];
// Module-level constants: an inline `|| []` in a zustand selector returns a
// fresh array identity on every store change, which re-renders this list on
// every delta of every session even when there are no markers at all.
const EMPTY_MARKERS: CompactionMarker[] = [];

interface Props { sessionId?: string; resuming?: boolean; }

type FlatItem = { type: "message"; data: ChatMessage } | { type: "marker"; data: CompactionMarker };

export function MessageList({ sessionId, resuming }: Props = {}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(RENDER_WINDOW);
  // Two booleans, not an object — a scroll handler that setStates a fresh
  // object every frame re-rendered the whole list on every scroll event.
  const [hasOverflowTop, setHasOverflowTop] = useState(false);
  const [hasOverflowBottom, setHasOverflowBottom] = useState(false);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const listSessionId = sessionId ?? activeSessionId;
  const markers = useSessionStore((s) => {
    const id = sessionId ?? s.activeSessionId;
    return (id && s.compactionMarkers[id]) || EMPTY_MARKERS;
  });
  // Self-subscribed messages slice: stream flushes re-render this list (and
  // via memo only the one changed MessageItem), never the App shell above.
  const messages =
    useSessionStore((s) => {
      const id = sessionId ?? s.activeSessionId;
      return id ? s.messages[id] : undefined;
    }) ?? EMPTY_MESSAGES;

  // Interleave compaction markers by timestamp. Memoized: this is O(n) over
  // the entire transcript and used to re-run on every one of the ~20 stream
  // flushes per second.
  const items = useMemo<FlatItem[]>(() => {
    if (markers.length === 0) {
      // Fast path — by far the common case: no markers, no interleave work.
      return messages.map((data) => ({ type: "message", data }));
    }
    const out: FlatItem[] = [];
    let markerIdx = 0;
    for (const msg of messages) {
      while (markerIdx < markers.length && markers[markerIdx].timestamp <= msg.timestamp) {
        out.push({ type: "marker", data: markers[markerIdx] });
        markerIdx++;
      }
      out.push({ type: "message", data: msg });
    }
    while (markerIdx < markers.length) {
      out.push({ type: "marker", data: markers[markerIdx] });
      markerIdx++;
    }
    return out;
  }, [messages, markers]);

  const totalItems = items.length;
  const renderStart = Math.max(0, totalItems - visibleCount);
  const visibleItems = useMemo(() => items.slice(renderStart), [items, renderStart]);

  // True while the user is parked at the bottom. A ref, so the scroll handler
  // can read it without re-subscribing, and so streaming never yanks the
  // viewport away from someone who scrolled up to read.
  const followRef = useRef(true);
  const lastMessage = totalItems > 0 ? items[totalItems - 1] : undefined;
  const isLastStreaming =
    lastMessage?.type === "message" && lastMessage.data.streaming === true;

  // Keep the tail pinned while following. Direct scrollTop write instead of
  // scrollIntoView: the latter walks every scrollable ancestor (it scrolled
  // the whole app shell) and its smooth animation fought the next flush.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [totalItems, isLastStreaming, messages]);

  const measureOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop > 4;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
    // setState with an identical primitive is a no-op in React, so these are
    // cheap — but only because they are primitives, not a fresh object.
    setHasOverflowTop(top);
    setHasOverflowBottom(bottom);
    followRef.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_THRESHOLD;
  }, []);

  // Scroll runs at display rate; coalesce to one measurement per frame.
  const frameRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Reading scrollTop here is what makes the follow flag accurate; do the
    // cheap follow update inline so a fast fling can't overshoot it.
    followRef.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_THRESHOLD;
    if (el.scrollTop < 200) {
      setVisibleCount((c) => (c < totalItems ? Math.min(c + OVERSCAN, totalItems) : c));
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measureOverflow();
    });
  }, [measureOverflow, totalItems]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  // Re-measure the edge fades when the content size changes.
  useEffect(() => {
    measureOverflow();
  }, [totalItems, measureOverflow]);

  useEffect(() => {
    setVisibleCount(RENDER_WINDOW);
    // A freshly opened thread starts pinned to the bottom.
    followRef.current = true;
  }, [listSessionId]);

  // Pull the syntax-highlight grammars in once the thread view is up. Runs off
  // the critical path (idle callback) so first paint is not waiting on ~377 KB
  // of highlight.js.
  useEffect(() => {
    requestHighlight();
  }, []);

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* In-thread search + marker rail (ISS-009) */}
      <ThreadSearchRail />
      {/* Top fade — visible when there's scrollable content above. */}
      {hasOverflowTop && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-gradient-to-b from-gb-bg to-transparent"
        />
      )}
      {/* Bottom fade — visible when there's scrollable content below. */}
      {hasOverflowBottom && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-gradient-to-t from-gb-bg to-transparent"
        />
      )}
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-4 py-4">
        {totalItems === 0 ? (
          resuming ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gb-border border-t-gb-accent" />
              <p className="text-sm text-gb-muted">正在恢复会话…</p>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center"><p className="text-[13px] text-gb-muted">开始对话</p></div>
          )
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {renderStart > 0 && <div className="py-2 text-center text-[10px] text-gb-muted">↑ {renderStart} earlier messages</div>}
            {visibleItems.map((item) =>
              item.type === "message" ? (
                <MessageItem key={item.data.id} message={item.data} />
              ) : (
                <CompactionMarkerItem key={item.data.id} marker={item.data} />
              )
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}
