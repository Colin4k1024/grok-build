import { useState, useEffect, useRef, useMemo } from "react";
import { SLASH_COMMANDS, fuzzyMatch, type SlashCommand } from "../../data/slashCommands";

interface SlashCompleteProps {
  query: string;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
  anchorBottom: number;
}

export function SlashComplete({ query, onSelect, onClose, anchorBottom }: SlashCompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.slice(1);
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((cmd) => fuzzyMatch(cmd, q));
  }, [query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [filtered, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (filtered.length === 0) {
    return (
      <div
        className="absolute left-0 right-0 rounded-lg border border-gb-border bg-gb-surface p-3 text-xs text-gb-muted shadow-xl"
        style={{ bottom: anchorBottom }}
      >
        No matching commands for "{query.slice(1)}"
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="absolute left-0 right-0 max-h-60 overflow-y-auto rounded-lg border border-gb-border bg-gb-surface py-1 shadow-xl"
      style={{ bottom: anchorBottom }}
    >
      {filtered.map((cmd, index) => (
        <div
          key={cmd.name}
          className={`flex cursor-pointer items-start gap-2 px-3 py-2 ${
            index === selectedIndex ? "bg-gb-accent/15" : "hover:bg-gb-bg"
          }`}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium ${index === selectedIndex ? "text-gb-accent" : "text-gb-text"}`}>
                /{cmd.name}
              </span>
              {cmd.aliases && cmd.aliases.length > 0 && (
                <span className="text-[10px] text-gb-muted">
                  {cmd.aliases.map((a) => `/${a}`).join(" ")}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-gb-muted">{cmd.description}</p>
            {cmd.argumentHint && (
              <p className="mt-0.5 font-mono text-[10px] text-gb-border">{cmd.argumentHint}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
