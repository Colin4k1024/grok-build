import { useEffect, useRef } from "react";
import { MessageItem } from "./MessageItem";
import { CompactionMarkerItem } from "./CompactionMarker";
import { useSessionStore } from "../../stores/sessionStore";
import type { ChatMessage, CompactionMarker } from "../../stores/sessionStore";

interface Props {
  messages: ChatMessage[];
}

export function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const markers = useSessionStore((s) =>
    activeSessionId ? s.compactionMarkers[activeSessionId] || [] : []
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, markers]);

  // Interleave compaction markers into the message stream based on timestamp
  const items: Array<{ type: "message"; data: ChatMessage } | { type: "marker"; data: CompactionMarker }> = [];
  let markerIdx = 0;
  for (const msg of messages) {
    while (markerIdx < markers.length && markers[markerIdx].timestamp <= msg.timestamp) {
      items.push({ type: "marker", data: markers[markerIdx] });
      markerIdx++;
    }
    items.push({ type: "message", data: msg });
  }
  while (markerIdx < markers.length) {
    items.push({ type: "marker", data: markers[markerIdx] });
    markerIdx++;
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {messages.length === 0 && markers.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <p className="text-gb-muted">No messages yet. Start a conversation.</p>
        </div>
      ) : (
        <div className="mx-auto max-w-4xl space-y-4">
          {items.map((item) =>
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
  );
}
