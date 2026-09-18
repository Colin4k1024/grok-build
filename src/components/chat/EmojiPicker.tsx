import { useState, useRef, useEffect } from "react";

const EMOJI_GROUPS: { label: string; emojis: { char: string; name: string }[] }[] = [
  { label: "笑脸", emojis: [
    { char: "😀", name: "grinning" }, { char: "😄", name: "smile happy" },
    { char: "😂", name: "joy laugh tears" }, { char: "🤣", name: "rofl rolling" },
    { char: "😊", name: "blush smile" }, { char: "😍", name: "heart eyes love" },
    { char: "🤔", name: "thinking hmm" }, { char: "🙃", name: "upside down silly" },
    { char: "😴", name: "sleeping tired" }, { char: "🤯", name: "mind blown exploding" },
  ]},
  { label: "手势", emojis: [
    { char: "👍", name: "thumbs up yes approve" }, { char: "👎", name: "thumbs down no" },
    { char: "👏", name: "clap applause" }, { char: "🙌", name: "raise hands celebrate" },
    { char: "🙏", name: "pray thanks please" }, { char: "💪", name: "muscle strong flex" },
    { char: "🤝", name: "handshake deal" }, { char: "✌️", name: "peace victory" },
    { char: "👌", name: "ok perfect" }, { char: "🫡", name: "salute respect" },
  ]},
  { label: "物品", emojis: [
    { char: "💡", name: "lightbulb idea" }, { char: "🔥", name: "fire hot lit" },
    { char: "✨", name: "sparkles sparkle magic" }, { char: "🎉", name: "party tada celebrate" },
    { char: "🎊", name: "confetti celebrate" }, { char: "📌", name: "pin pushpin" },
    { char: "📎", name: "paperclip attach" }, { char: "🔧", name: "wrench tool fix" },
    { char: "🔨", name: "hammer build" }, { char: "🐛", name: "bug insect" },
  ]},
  { label: "符号", emojis: [
    { char: "❤️", name: "red heart love" }, { char: "💯", name: "hundred points perfect" },
    { char: "✅", name: "check mark done" }, { char: "❌", name: "cross mark no" },
    { char: "⚠️", name: "warning caution" }, { char: "🚀", name: "rocket launch ship" },
    { char: "⭐", name: "star favorite" }, { char: "🔔", name: "bell notification" },
    { char: "🏁", name: "checkered flag finish" }, { char: "🎯", name: "target bullseye" },
  ]},
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

  const q = search.trim().toLowerCase();
  const filtered = q
    ? EMOJI_GROUPS.map((g) => ({
        ...g,
        emojis: g.emojis.filter(
          (e) => e.char.includes(q) || e.name.toLowerCase().includes(q)
        ),
      })).filter((g) => g.emojis.length > 0)
    : EMOJI_GROUPS;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="表情选择器"
      className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-lg border border-gb-border/10 bg-gb-surface-solid shadow-xl"
    >
      <div className="border-b border-gb-border/8 p-2">
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索表情…"
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
                  key={e.char}
                  type="button"
                  title={e.name}
                  onClick={() => {
                    onSelect(e.char);
                    onClose();
                  }}
                  className="rounded p-1 text-base hover:bg-gb-surface-hover"
                >
                  {e.char}
                </button>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="py-4 text-center text-[11px] text-gb-muted">未找到表情</p>
        )}
      </div>
    </div>
  );
}
