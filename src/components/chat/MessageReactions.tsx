import { useState, useCallback } from "react";
import type { ChatMessage } from "../../stores/sessionStore";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "🤔", "👀"];

interface MessageReactionsProps {
  message: ChatMessage;
}

/**
 * Inline emoji reactions on a message. Local state only — reactions are
 * per-client and not persisted (Codex parity: thread-emoji-picker-content).
 * Hover a message bubble to reveal the reaction row.
 */
export function MessageReactions({ message: _message }: MessageReactionsProps) {
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [showPicker, setShowPicker] = useState(false);

  const handlePick = useCallback((emoji: string) => {
    setPicked((prev) => {
      const next = { ...prev };
      if (next[emoji]) {
        // Toggle off if the user clicks the same emoji again.
        next[emoji] -= 1;
        if (next[emoji] <= 0) delete next[emoji];
      } else {
        next[emoji] = 1;
      }
      return next;
    });
    setShowPicker(false);
  }, []);

  const entries = Object.entries(picked);
  if (entries.length === 0 && !showPicker) {
    return (
      <button
        onClick={() => setShowPicker(true)}
        aria-label="Add reaction"
        className="mt-1 hidden rounded px-1.5 py-0.5 text-[11px] text-gb-muted opacity-0 transition-opacity hover:bg-gb-surface-hover hover:text-gb-text group-hover:opacity-100 group-hover:block"
      >
        + React
      </button>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, count]) => (
        <button
          key={emoji}
          onClick={() => handlePick(emoji)}
          className="flex items-center gap-0.5 rounded-full border border-gb-border/20 bg-gb-surface px-1.5 py-0.5 text-[11px] hover:border-gb-accent/40"
        >
          <span>{emoji}</span>
          <span className="text-[10px] text-gb-muted">{count}</span>
        </button>
      ))}
      <div className="relative">
        <button
          onClick={() => setShowPicker((v) => !v)}
          aria-label="Add reaction"
          className="rounded px-1.5 py-0.5 text-[11px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
        >
          +
        </button>
        {showPicker && (
          <div className="absolute left-0 top-full z-50 mt-1 flex gap-0.5 rounded-md border border-gb-border/10 bg-gb-surface-solid p-1 shadow-lg">
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => handlePick(e)}
                className="rounded px-1 py-0.5 text-sm hover:bg-gb-surface-hover"
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
