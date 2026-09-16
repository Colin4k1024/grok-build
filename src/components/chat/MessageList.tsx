import { useEffect, useRef, useState, useCallback } from "react";
import { MessageItem } from "./MessageItem";
import { CompactionMarkerItem } from "./CompactionMarker";
import { useSessionStore } from "../../stores/sessionStore";
import type { ChatMessage, CompactionMarker } from "../../stores/sessionStore";

const RENDER_WINDOW = 150;
const OVERSCAN = 20;

interface Props { messages: ChatMessage[]; }

type FlatItem = { type: "message"; data: ChatMessage } | { type: "marker"; data: CompactionMarker };

export function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(RENDER_WINDOW);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const markers = useSessionStore(s => activeSessionId ? s.compactionMarkers[activeSessionId] || [] : []);

  const items: FlatItem[] = [];
  let markerIdx = 0;
  for (const msg of messages) {
    while (markerIdx < markers.length && markers[markerIdx].timestamp <= msg.timestamp) { items.push({ type: "marker", data: markers[markerIdx] }); markerIdx++; }
    items.push({ type: "message", data: msg });
  }
  while (markerIdx < markers.length) { items.push({ type: "marker", data: markers[markerIdx] }); markerIdx++; }

  const totalItems = items.length;
  const renderStart = Math.max(0, totalItems - visibleCount);
  const visibleItems = items.slice(renderStart);

  useEffect(() => {
    if (totalItems > 0) {
      const last = items[totalItems - 1];
      if (last.type === "message" && last.data.streaming) bottomRef.current?.scrollIntoView({ behavior: "auto" });
      else bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [totalItems]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 200 && visibleCount < totalItems) setVisibleCount(c => Math.min(c + OVERSCAN, totalItems));
  }, [visibleCount, totalItems]);

  useEffect(() => { setVisibleCount(RENDER_WINDOW); }, [activeSessionId]);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4">
      {totalItems === 0 ? (
        <div className="flex h-full items-center justify-center"><p className="text-[13px] text-gb-muted">Start a conversation</p></div>
      ) : (
        <div className="mx-auto max-w-3xl space-y-4">
          {renderStart > 0 && <div className="py-2 text-center text-[10px] text-gb-muted">↑ {renderStart} earlier messages</div>}
          {visibleItems.map(item => item.type === "message" ? <MessageItem key={item.data.id} message={item.data} /> : <CompactionMarkerItem key={item.data.id} marker={item.data} />)}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
