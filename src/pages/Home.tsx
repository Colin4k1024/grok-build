import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useImagePaste } from "../hooks/useImagePaste";

export type ComposerMode = "chat" | "agent";

interface HomeProps {
  onStart: (prompt: string, mode: ComposerMode, images: { data: string; mime_type: string }[]) => void;
  onOpenSession: (id: string) => void;
  creating: boolean;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function Home({ onStart, onOpenSession, creating }: HomeProps) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ComposerMode>("chat");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const tabs = useSessionStore((s) => s.tabs);
  const { images, onDrop, onDragOver, removeImage, clearImages } = useImagePaste();

  // Show the 6 most recently active sessions as a preview strip.
  const recent = useMemo(
    () =>
      [...tabs]
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 6),
    [tabs]
  );

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [text]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || creating) return;
    const outgoing = images.map((img) => ({ data: img.base64, mime_type: img.mimeType }));
    onStart(trimmed, mode, outgoing);
    setText("");
    clearImages();
  }, [text, images, creating, mode, onStart, clearImages]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSend();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-12">
      <div className="w-full max-w-2xl">
        <h1 className="mb-2 text-center text-2xl font-semibold text-gb-text">
          What do you want to build?
        </h1>
        <p className="mb-8 text-center text-[13px] text-gb-muted">
          Start a new session, or pick up a recent one below.
        </p>

        {/* Floating composer */}
        <div
          className="rounded-2xl border border-gb-border/10 bg-gb-surface-solid shadow-2xl"
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "chat"
                ? "Ask anything… (Enter to send, Shift+Enter for newline)"
                : "Describe the task; the agent will use tools autonomously…"
            }
            disabled={creating}
            rows={3}
            className="w-full resize-none bg-transparent px-4 pt-4 text-[14px] leading-relaxed text-gb-text placeholder:text-gb-muted focus:outline-none disabled:opacity-40"
          />

          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pb-2">
              {images.map((img) => (
                <div key={img.id} className="relative">
                  <img
                    src={`data:${img.mimeType};base64,${img.base64}`}
                    alt="attachment"
                    className="h-14 w-14 rounded border border-gb-border/20 object-cover"
                  />
                  <button
                    className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gb-red text-[10px] text-white"
                    onClick={() => removeImage(img.id)}
                    aria-label="Remove image"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Composer bottom bar: mode toggle + send */}
          <div className="flex items-center justify-between border-t border-gb-border/8 px-3 py-2">
            <div
              role="tablist"
              aria-label="Composer mode"
              className="flex items-center gap-0.5 rounded-md bg-gb-bg p-0.5"
            >
              <button
                role="tab"
                aria-selected={mode === "chat"}
                onClick={() => setMode("chat")}
                className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  mode === "chat"
                    ? "bg-gb-surface-solid text-gb-text shadow-sm"
                    : "text-gb-muted hover:text-gb-text"
                }`}
              >
                Chat
              </button>
              <button
                role="tab"
                aria-selected={mode === "agent"}
                onClick={() => setMode("agent")}
                className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  mode === "agent"
                    ? "bg-gb-surface-solid text-gb-text shadow-sm"
                    : "text-gb-muted hover:text-gb-text"
                }`}
              >
                Agent
              </button>
            </div>

            <button
              onClick={handleSend}
              disabled={creating || (!text.trim() && images.length === 0)}
              className="rounded-md bg-gb-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-30"
            >
              {creating ? "Starting…" : "Send"}
            </button>
          </div>
        </div>

        {/* Recent sessions */}
        {recent.length > 0 && (
          <div className="mt-10">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gb-muted">
              Recent sessions
            </h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recent.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => onOpenSession(tab.id)}
                  className="group flex flex-col rounded-lg border border-gb-border/10 bg-gb-surface-solid/50 p-3 text-left transition-colors hover:border-gb-border/20 hover:bg-gb-surface-solid"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-gb-text group-hover:text-gb-accent">
                      {tab.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-gb-muted">
                      {formatRelativeTime(tab.lastActiveAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-gb-muted">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="currentColor"
                      className="shrink-0 opacity-60"
                    >
                      <path d="M0 1.5C0 .7.7 0 1.5 0h3l1.5 1.5h2.5C9.3 1.5 10 2.2 10 3v5.5c0 .8-.7 1.5-1.5 1.5h-7C.7 10 0 9.3 0 8.5v-7z" />
                    </svg>
                    <span className="truncate">{tab.cwd || "."}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
