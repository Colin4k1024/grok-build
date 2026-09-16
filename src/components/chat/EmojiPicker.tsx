import { useState, useRef, useEffect } from "react";

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  { label: "Smileys", emojis: ["😀", "😄", "😂", "🤣", "😊", "😍", "🤔", "🙃", "😴", "🤯"] },
  { label: "Gestures", emojis: ["👍", "👎", "👏", "🙌", "🙏", "💪", "🤝", "✌️", "👌", "🫡"] },
  { label: "Objects", emojis: ["💡", "🔥", "✨", "🎉", "🎊", "📌", "📎", "🔧", "🔨", "🐛"] },
  { label: "Symbols", emojis: ["❤️", "💯", "✅", "❌", "⚠️", "🚀", "⭐", "🔔", "🏁", "🎯"] },
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filtered = search
    ? EMOJI_GROUPS.map((g) => ({
        ...g,
        emojis: g.emojis.filter((e) => e.includes(search)),
      })).filter((g) => g.emojis.length > 0)
    : EMOJI_GROUPS;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Emoji picker"
      className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-lg border border-gb-border/10 bg-gb-surface-solid shadow-xl"
    >
      <div className="border-b border-gb-border/8 p-2">
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji…"
          className="w-full rounded border border-gb-border/20 bg-gb-bg px-2 py-1 text-[12px] text-gb-text outline-none focus:border-gb-accent/50"
        />
      </div>
      <div className="max-h-56 overflow-y-auto p-2">
        {filtered.map((g) => (
          <div key={g.label} className="mb-2">
            <p className="mb-1 px-1 text-[9px] font-medium uppercase text-gb-muted">
              {g.label}
            </p>
            <div className="grid grid-cols-8 gap-0.5">
              {g.emojis.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    onSelect(e);
                    onClose();
                  }}
                  className="rounded p-1 text-base hover:bg-gb-surface-hover"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="py-4 text-center text-[11px] text-gb-muted">No emoji found</p>
        )}
      </div>
    </div>
  );
}
