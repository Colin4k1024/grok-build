import { useState, useRef, useCallback } from "react";
import { SlashComplete } from "./SlashComplete";
import type { SlashCommand } from "../../data/slashCommands";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { useImagePaste } from "../../hooks/useImagePaste";
import { ProjectSelector } from "./ProjectSelector";
import { ComposerEditor, type ComposerApi } from "./ComposerEditor";

interface Props {
  onSend: (message: string, images: { data: string; mime_type: string }[]) => void;
  onCancel: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  /** Active session cwd (project) shown in the bottom-left project selector. */
  cwd?: string;
  /** Called when the user picks a different project/worktree from the selector. */
  onSwitchProject?: (newCwd: string) => void;
}

export function PromptInput({ onSend, onCancel, isStreaming, disabled, cwd, onSwitchProject }: Props) {
  const [resetKey, setResetKey] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const composerApiRef = useRef<ComposerApi | null>(null);

  const { images, onDrop, onDragOver, removeImage, clearImages } = useImagePaste();
  const { isRecording, interimText, toggleRecording, stopRecording, language, setLanguage } = useVoiceInput((transcript) => {
    composerApiRef.current?.insertText(transcript);
  });

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if ((!trimmed && images.length === 0) || isStreaming) return;
      if (isRecording) stopRecording();
      onSend(trimmed, images.map((img) => ({ data: img.base64, mime_type: img.mimeType })));
      // Remount the editor to reset state cleanly.
      setResetKey((k) => k + 1);
      setSlashQuery(null);
      setMentionQuery(null);
      clearImages();
    },
    [images, isStreaming, isRecording, onSend, stopRecording, clearImages]
  );

  const handleCancel = useCallback(() => {
    if (isStreaming) onCancel();
    else {
      setSlashQuery(null);
      setMentionQuery(null);
    }
  }, [isStreaming, onCancel]);

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      // Replace the current "/partial" with "/cmd " in the editor.
      // Simplest correct path: clear editor and insert the full command.
      composerApiRef.current?.clear();
      composerApiRef.current?.insertText(`/${cmd.name} `);
      setSlashQuery(null);
      composerApiRef.current?.focus();
    },
    []
  );

  return (
    <div className="relative px-4 pb-3 pt-2" onDrop={onDrop} onDragOver={onDragOver}>
      {slashQuery !== null && (
        <SlashComplete
          query={slashQuery}
          onSelect={handleSlashSelect}
          onClose={() => setSlashQuery(null)}
          anchorBottom={140}
        />
      )}

      {isRecording && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-gb-red/10 px-2.5 py-1">
          <span className="flex items-center gap-1.5 text-[11px] text-gb-red">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gb-red" />
            Recording
          </span>
          <span className="flex-1 truncate text-[11px] text-gb-muted">{interimText || "Listening…"}</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as "auto" | "zh-CN" | "en-US")}
            className="rounded bg-transparent px-1 text-[10px] text-gb-muted outline-none"
          >
            <option value="auto">Auto</option>
            <option value="zh-CN">中文</option>
            <option value="en-US">EN</option>
          </select>
        </div>
      )}

      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img) => (
            <div key={img.id} className="group relative">
              <img src={img.dataUrl} alt={img.name} className="h-16 w-16 rounded-md object-cover" />
              <button
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gb-red text-[8px] text-white opacity-0 group-hover:opacity-100"
                onClick={() => removeImage(img.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-lg border border-gb-border/10 bg-gb-surface/50 px-3 py-2 focus-within:border-gb-accent/40">
        <button
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
            isRecording ? "text-gb-red" : "text-gb-muted hover:text-gb-text"
          }`}
          onClick={toggleRecording}
          disabled={disabled}
          aria-label={isRecording ? "Stop recording" : "Start voice input"}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2a2 2 0 00-2 2v3a2 2 0 004 0V4a2 2 0 00-2-2z" fill="currentColor" />
            <path d="M4 7a4 4 0 008 0M8 11v3" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>

        <ComposerEditor
          resetKey={resetKey}
          placeholder="Send a message… (@file, @project, @skill, /command)"
          disabled={disabled || isStreaming}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onSlashQuery={setSlashQuery}
          onMentionQuery={setMentionQuery}
          onReady={(api) => {
            composerApiRef.current = api;
          }}
        />

        {isStreaming ? (
          <button
            className="shrink-0 rounded-md bg-gb-red/15 px-3 py-1.5 text-[12px] font-medium text-gb-red hover:bg-gb-red/25"
            onClick={onCancel}
          >
            Stop
          </button>
        ) : (
          <button
            className="shrink-0 rounded-md bg-gb-accent px-3.5 py-1.5 text-[12px] font-medium text-white hover:opacity-80 disabled:opacity-20"
            onClick={() => {
              const text = composerApiRef.current?.getText() ?? "";
              handleSubmit(text);
            }}
            disabled={disabled}
            aria-label="Send"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 8l11-5-4.5 11-1.5-4.5L2 8z" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>

      {/* Composer bottom toolbar — project selector on the left, hints on the right. */}
      {(cwd !== undefined || onSwitchProject) && (
        <div className="mt-1.5 flex items-center justify-between px-1">
          <ProjectSelector cwd={cwd || "."} onSwitchProject={(p) => onSwitchProject?.(p)} variant="full" />
          <span className="text-[10px] text-gb-muted">
            {mentionQuery !== null ? `@${mentionQuery}` : "⏎ send · ⇧⏎ newline"}
          </span>
        </div>
      )}
    </div>
  );
}
