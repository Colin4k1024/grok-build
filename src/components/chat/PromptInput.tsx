import { useState, useRef, useEffect, KeyboardEvent } from "react";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);
    setText("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    <div className="border-t border-gb-border p-4">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none rounded border border-gb-border bg-gb-surface px-3 py-2 text-sm text-gb-text outline-none focus:border-gb-accent"
          rows={2}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline, ⌘+↑/↓ for history, Esc to cancel)"
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
