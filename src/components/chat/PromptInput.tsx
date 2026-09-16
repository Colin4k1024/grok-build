import { useState, useRef, KeyboardEvent } from "react";

interface Props {
  onSend: (message: string) => void;
  onCancel: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function PromptInput({ onSend, onCancel, isStreaming, disabled }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setText("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape" && isStreaming) {
      onCancel();
    }
  };

  return (
    <div className="border-t border-gb-border p-4">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none rounded border border-gb-border bg-gb-surface px-3 py-2 text-sm text-gb-text outline-none focus:border-gb-accent"
          rows={2}
          placeholder="Type a message... (⌘+Enter to send, Esc to cancel)"
          value={text}
          onChange={(e) => setText(e.target.value)}
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
