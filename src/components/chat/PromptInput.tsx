import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { SlashComplete } from "./SlashComplete";
import type { SlashCommand } from "../../data/slashCommands";
import { useVoiceInput } from "../../hooks/useVoiceInput";

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

  const { isRecording, interimText, toggleRecording, stopRecording, language, setLanguage } =
    useVoiceInput((transcript, isFinal) => {
      setText((prev) => {
        if (isFinal) {
          // Append final transcript at the end
          return prev + transcript;
        }
        // For interim, replace the last interim portion
        const withoutInterim = prev.replace(/\s*\[…\]\s*$/, "");
        return withoutInterim + transcript;
      });
    });

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text]);

  const slashQuery = text.startsWith("/") && !text.includes(" ") ? text : null;
  useEffect(() => {
    setShowSlash(slashQuery !== null);
  }, [slashQuery]);

  const handleSlashSelect = (cmd: SlashCommand) => {
    setText(`/${cmd.name} `);
    setShowSlash(false);
    textareaRef.current?.focus();
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    if (isRecording) stopRecording();
    onSend(trimmed);
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);
    setText("");
    setShowSlash(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    <div className="relative border-t border-gb-border p-4">
      {showSlash && slashQuery && (
        <SlashComplete
          query={slashQuery}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlash(false)}
          anchorBottom={120}
        />
      )}

      {/* Voice recording indicator */}
      {isRecording && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-gb-red/30 bg-gb-red/5 px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-xs text-gb-red">
            <span className="h-2 w-2 animate-pulse rounded-full bg-gb-red" />
            Recording...
          </span>
          <span className="flex-1 truncate text-[11px] text-gb-muted">
            {interimText || "Listening..."}
          </span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as "auto" | "zh-CN" | "en-US")}
            className="rounded border border-gb-border bg-gb-bg px-1 py-0.5 text-[10px] text-gb-text outline-none"
          >
            <option value="auto">Auto</option>
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Voice button */}
        <button
          className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded border transition-colors ${
            isRecording
              ? "border-gb-red bg-gb-red/10 text-gb-red"
              : "border-gb-border bg-gb-surface text-gb-muted hover:text-gb-text"
          }`}
          onClick={toggleRecording}
          title="Voice input (Cmd+Shift+V)"
          disabled={disabled}
        >
          {isRecording ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="5" y="3" width="6" height="8" rx="3" fill="currentColor" />
              <path d="M3 7a5 5 0 0010 0M8 12v2" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 1a2.5 2.5 0 00-2.5 2.5v4a2.5 2.5 0 005 0v-4A2.5 2.5 0 008 1z" fill="currentColor" />
              <path d="M3.5 7a4.5 4.5 0 009 0M8 11.5v3" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>

        <textarea
          ref={textareaRef}
          className="flex-1 resize-none rounded border border-gb-border bg-gb-surface px-3 py-2 text-sm text-gb-text outline-none focus:border-gb-accent"
          rows={2}
          placeholder="Type a message or / for commands... (Enter to send, Shift+Enter newline, ⌘⇧V for voice)"
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
            className="shrink-0 rounded bg-gb-red px-4 py-2 text-sm text-white hover:opacity-80"
            onClick={onCancel}
          >
            Stop
          </button>
        ) : (
          <button
            className="shrink-0 rounded bg-gb-accent px-4 py-2 text-sm text-white hover:opacity-80 disabled:opacity-40"
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
