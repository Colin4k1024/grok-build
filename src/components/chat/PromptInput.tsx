import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { SlashComplete } from "./SlashComplete";
import type { SlashCommand } from "../../data/slashCommands";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { useImagePaste } from "../../hooks/useImagePaste";
import { ProjectSelector } from "./ProjectSelector";
import { ModelEffortSelect } from "./composer/ModelEffortSelect";
import { ApprovalModeSelect } from "./composer/ApprovalModeSelect";
import { WorkModeSelect } from "./composer/WorkModeSelect";
import { BranchSelect } from "./composer/BranchSelect";
import { listRepoFiles, listSkills, type ConfigSnapshot, type SkillInfo } from "../../lib/tauri";
import { useSessionStore, type ApprovalMode, type WorkMode } from "../../stores/sessionStore";

interface Props {
  onSend: (message: string, images: { data: string; mime_type: string }[]) => void;
  onCancel: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  cwd?: string;
  onSwitchProject?: (newCwd: string) => void;
  config?: ConfigSnapshot | null;
  onModelEffortChange?: (model: string, effort: SessionTabEffort) => void;
  onWorkModeChange?: (mode: WorkMode, branch?: string) => void;
  /** Queue the current text for the next turn (codex Tab semantics). */
  onQueue?: (text: string) => void;
}

type SessionTabEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface Trigger {
  char: "@" | "$";
  idx: number;
  query: string;
}

export function PromptInput({
  onSend, onCancel, isStreaming, disabled, cwd, onSwitchProject,
  config, onModelEffortChange, onWorkModeChange, onQueue,
}: Props) {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [showSlash, setShowSlash] = useState(false);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [pickIdx, setPickIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skillsLoaded = useRef(false);

  const { images, onDrop, onDragOver, removeImage, clearImages } = useImagePaste();
  const { isRecording, interimText, toggleRecording, stopRecording, language, setLanguage } = useVoiceInput((transcript) => {
    setText(prev => prev + transcript);
  });

  // Composer-embedded session controls read live state from the store so the
  // control row never goes stale across tab switches.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeSessionId));
  const queuedCount = useSessionStore((s) => (activeSessionId ? s.queuedPrompts[activeSessionId]?.length ?? 0 : 0));

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text]);

  const slashQuery = text.startsWith("/") && !text.includes(" ") ? text : null;
  useEffect(() => { setShowSlash(slashQuery !== null); }, [slashQuery]);

  // ---- @ / $ trigger detection -------------------------------------------
  const detectTrigger = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    const dollar = before.lastIndexOf("$");
    const idx = Math.max(at, dollar);
    if (idx < 0) return null;
    const char = before[idx] === "@" ? "@" : "$";
    const query = before.slice(idx + 1);
    if (/[\s@]/.test(query) || query.length > 64) return null;
    return { char, idx, query } as Trigger;
  };

  const handleTextChange = (value: string) => {
    setText(value);
    setHistoryIdx(-1);
    const caret = textareaRef.current?.selectionStart ?? value.length;
    setTrigger(detectTrigger(value, caret));
    setPickIdx(0);
    if (value.includes("@") && cwd) {
      // Lazy-load the tracked-file list once per directory.
      if (repoFiles.length === 0) listRepoFiles(cwd).then(setRepoFiles).catch(() => {});
    }
    if (value.includes("$") && !skillsLoaded.current) {
      skillsLoaded.current = true;
      listSkills().then(setSkills).catch(() => {});
    }
  };

  const triggerMatches: string[] = trigger
    ? trigger.char === "@"
      ? repoFiles.filter((f) => f.toLowerCase().includes(trigger.query.toLowerCase())).slice(0, 8)
      : skills.filter((s) => s.name.toLowerCase().includes(trigger.query.toLowerCase())).map((s) => s.name).slice(0, 8)
    : [];

  const applyTriggerSelection = (selection: string) => {
    if (!trigger) return;
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const insertion = `${trigger.char}${selection} `;
    const next = text.slice(0, trigger.idx) + insertion + text.slice(caret);
    setText(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      const pos = trigger.idx + insertion.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  const handleSlashSelect = (cmd: SlashCommand) => { setText(`/${cmd.name} `); setShowSlash(false); textareaRef.current?.focus(); };

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    if (isRecording) stopRecording();
    // While a turn runs this is a codex-style mid-turn injection: the agent
    // receives the message immediately instead of the input being blocked.
    onSend(trimmed, images.map(img => ({ data: img.base64, mime_type: img.mimeType })));
    if (trimmed) setHistory(prev => [...prev, trimmed]);
    setHistoryIdx(-1); setText(""); setShowSlash(false); setTrigger(null); clearImages();
  };

  const handleQueue = () => {
    const trimmed = text.trim();
    if (!trimmed || !onQueue) return;
    onQueue(trimmed);
    setText("");
    setTrigger(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && triggerMatches.length > 0 && ["ArrowUp","ArrowDown","Enter","Escape","Tab"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Escape") setTrigger(null);
      else if (e.key === "ArrowUp") setPickIdx((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowDown") setPickIdx((i) => Math.min(triggerMatches.length - 1, i + 1));
      else applyTriggerSelection(triggerMatches[pickIdx]);
      return;
    }
    if (showSlash && ["ArrowUp","ArrowDown","Enter","Escape"].includes(e.key)) { e.preventDefault(); if (e.key === "Escape") setShowSlash(false); return; }
    if (e.key === "Tab" && isStreaming && text.trim()) { e.preventDefault(); handleQueue(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); }
    else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleSend(); }
    else if (e.key === "Escape" && isStreaming) { onCancel(); }
    else if (e.key === "ArrowUp" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!history.length) return; const i = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1); setHistoryIdx(i); setText(history[i]); }
    else if (e.key === "ArrowDown" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (historyIdx === -1) return; const i = historyIdx + 1; if (i >= history.length) { setHistoryIdx(-1); setText(""); } else { setHistoryIdx(i); setText(history[i]); } }
  };

  const showSessionControls = cwd !== undefined && !!activeTab;

  return (
    <div className="relative px-4 pb-3 pt-2" onDrop={onDrop} onDragOver={onDragOver}>
      {showSlash && slashQuery && <SlashComplete query={slashQuery} onSelect={handleSlashSelect} onClose={() => setShowSlash(false)} anchorBottom={120} />}

      {trigger && triggerMatches.length > 0 && (
        <div className="absolute bottom-full left-4 z-50 mb-1 w-80 overflow-hidden rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg" role="listbox">
          <p className="border-b border-gb-border/8 px-2.5 py-1 text-[10px] uppercase tracking-wide text-gb-muted">
            {trigger.char === "@" ? "Files" : "Skills"}
          </p>
          {triggerMatches.map((m, i) => (
            <button
              key={m}
              role="option"
              aria-selected={i === pickIdx}
              onMouseDown={(e) => { e.preventDefault(); applyTriggerSelection(m); }}
              className={`block w-full truncate px-2.5 py-1.5 text-left text-[12px] ${
                i === pickIdx ? "bg-gb-surface-hover text-gb-text" : "text-gb-text-secondary"
              }`}
            >
              {trigger.char === "$" ? `$${m}` : m}
            </button>
          ))}
        </div>
      )}

      {isRecording && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-gb-red/10 px-2.5 py-1">
          <span className="flex items-center gap-1.5 text-[11px] text-gb-red"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gb-red" />Recording</span>
          <span className="flex-1 truncate text-[11px] text-gb-muted">{interimText || "Listening…"}</span>
          <select value={language} onChange={e => setLanguage(e.target.value as "auto"|"zh-CN"|"en-US")} className="rounded bg-transparent px-1 text-[10px] text-gb-muted outline-none"><option value="auto">Auto</option><option value="zh-CN">中文</option><option value="en-US">EN</option></select>
        </div>
      )}

      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map(img => (
            <div key={img.id} className="group relative">
              <img src={img.dataUrl} alt={img.name} className="h-16 w-16 rounded-md object-cover" />
              <button className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gb-red text-[8px] text-white opacity-0 group-hover:opacity-100" onClick={() => removeImage(img.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-gb-border/10 bg-gb-surface/50 px-3 py-2 focus-within:border-gb-accent/40">
        <textarea ref={textareaRef} className="w-full resize-none bg-transparent text-[13px] text-gb-text outline-none placeholder:text-gb-muted" rows={1} placeholder={isStreaming ? "Running — Enter injects · Tab queues" : "Send a message… (@ files · $ skills · / commands)"} value={text} onChange={e => handleTextChange(e.target.value)} onKeyDown={handleKeyDown} disabled={disabled} />

        <div className="mt-1 flex items-center gap-1" data-no-drag>
          {showSessionControls && cwd && onSwitchProject && (
            <ProjectSelector cwd={cwd} onSwitchProject={(p) => onSwitchProject?.(p)} variant="compact" />
          )}
          {showSessionControls && cwd && onWorkModeChange && (
            <WorkModeSelect
              cwd={cwd}
              mode={activeTab!.workMode ?? "local"}
              branch={activeTab!.branch}
              onChange={(m, b) => onWorkModeChange(m, b)}
              onError={(msg) => console.error("[workmode]", msg)}
            />
          )}
          {showSessionControls && cwd && activeTab!.workMode === "worktree" && onWorkModeChange && (
            <BranchSelect cwd={cwd} branch={activeTab!.branch} onPickBranch={(b) => onWorkModeChange("worktree", b)} />
          )}
          {showSessionControls && config && onModelEffortChange && (
            <ModelEffortSelect
              config={config}
              model={activeTab!.model}
              effort={activeTab!.reasoningEffort}
              onChange={(m, e) => onModelEffortChange(m, e)}
            />
          )}
          {showSessionControls && (
            <ApprovalModeSelect
              mode={activeTab!.approvalMode ?? "ask"}
              onChange={(m: ApprovalMode) => useSessionStore.getState().setTabApprovalMode(activeSessionId!, m)}
            />
          )}

          <div className="flex-1" />

          {queuedCount > 0 && (
            <span className="rounded-full bg-gb-accent/10 px-1.5 py-0.5 text-[10px] text-gb-accent" title="Queued prompts (Tab)">
              {queuedCount} queued
            </span>
          )}
          <button
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${isRecording ? "text-gb-red" : "text-gb-muted hover:text-gb-text"}`}
            onClick={toggleRecording} disabled={disabled} title="Voice input"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2a2 2 0 00-2 2v3a2 2 0 004 0V4a2 2 0 00-2-2z" fill="currentColor" /><path d="M4 7a4 4 0 008 0M8 11v3" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          {isStreaming ? (
            <button className="shrink-0 rounded-md bg-gb-red/15 px-3 py-1.5 text-[12px] font-medium text-gb-red hover:bg-gb-red/25" onClick={onCancel} title="Stop (Esc)">Stop</button>
          ) : (
            <button className="shrink-0 rounded-md bg-gb-accent px-3.5 py-1.5 text-[12px] font-medium text-white hover:opacity-80 disabled:opacity-20" onClick={handleSend} disabled={(!text.trim() && images.length === 0) || disabled} title="Send (Enter)">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 8l11-5-4.5 11-1.5-4.5L2 8z" fill="currentColor" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
