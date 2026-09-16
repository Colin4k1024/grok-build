import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { SlashComplete } from "./SlashComplete";
import type { SlashCommand } from "../../data/slashCommands";

interface Props {
  onSend: (message: string) => void;
  onCancel: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function PromptInput({ onSend, onCancel, isStreaming, disabled }: Props) {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [showSlash, setShowSlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text]);

  // Slash command detection: show when input starts with / and no space yet
  const slashQuery = text.startsWith("/") && !text.includes(" ") ? text : null;
  useEffect(() => {
    setShowSlash(slashQuery !== null);
  }, [slashQuery]);

  const handleSlashSelect = (cmd: SlashCommand) => {
    const newText = `/${cmd.name} `;
    setText(newText);
    setShowSlash(false);
    textareaRef.current?.focus();
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);
    setText("");
    setShowSlash(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // If slash complete is open, let it handle navigation keys
    if (showSlash && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      if (e.key === "Escape") setShowSlash(false);
      return;
    }

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape" && isStreaming) {
      onCancel();
    } else if (e.key === "ArrowUp" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (history.length === 0) return;
      const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(newIdx);
      setText(history[newIdx]);
    } else if (e.key === "ArrowDown" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (historyIdx === -1) return;
      const newIdx = historyIdx + 1;
      if (newIdx >= history.length) {
        setHistoryIdx(-1);
        setText("");
      } else {
        setHistoryIdx(newIdx);
        setText(history[newIdx]);
      }
    }
  };

  return (
    <div ref={containerRef} className="relative border-t border-gb-border p-4">
      {showSlash && slashQuery && (
        <SlashComplete
          query={slashQuery}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlash(false)}
          anchorBottom={120}
        />
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none rounded border border-gb-border bg-gb-surface px-3 py-2 text-sm text-gb-text outline-none focus:border-gb-accent"
          rows={2}
          placeholder="Type a message or / for commands... (Enter to send, Shift+Enter for newline)"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHistoryIdx(-1);
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
        />
        {isStreaming ? (
          <button
            className="rounded bg-gb-red px-4 py-2 text-sm text-white hover:opacity-80"
            onClick={onCancel}
          >
            Stop
          </button>
        ) : (
          <button
            className="rounded bg-gb-accent px-4 py-2 text-sm text-white hover:opacity-80 disabled:opacity-40"
            onClick={handleSend}
            disabled={!text.trim() || disabled}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
