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
  /**
   * Home/New-chat variant: no live session exists yet, so the embedded
   * project / model / approval controls are driven by local state and their
   * choices ride along with session creation.
   */
  home?: {
    cwd: string;
    model: string;
    effort: SessionTabEffort;
    approval: ApprovalMode;
    onCwdChange: (cwd: string) => void;
    onPatch: (patch: { model?: string; effort?: SessionTabEffort; approval?: ApprovalMode }) => void;
  };
}

type SessionTabEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface Trigger {
  char: "@" | "$";
  idx: number;
  query: string;
}

export function PromptInput({
  onSend, onCancel, isStreaming, disabled, cwd, onSwitchProject,
  config, onModelEffortChange, onWorkModeChange, onQueue, home,
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
  const { isRecording, interimText, toggleRecording, startRecording, stopRecording, language, setLanguage } = useVoiceInput((transcript) => {
    setText(prev => prev + transcript);
  });

  // Ctrl+M hold-to-talk (codex dictation gesture).
  useEffect(() => {
    const down = (e: Event) => {
      const ke = e as globalThis.KeyboardEvent;
      if (ke.ctrlKey && ke.key.toLowerCase() === "m" && !isRecording) {
        ke.preventDefault();
        startRecording();
      }
    };
    const up = (e: Event) => {
      const ke = e as globalThis.KeyboardEvent;
      if (ke.ctrlKey && ke.key.toLowerCase() === "m" && isRecording) {
        ke.preventDefault();
        stopRecording();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [isRecording, startRecording, stopRecording]);

  // Composer-embedded session controls read live state from the store so the
  // control row never goes stale across tab switches.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeSessionId));
  const queuedCount = useSessionStore((s) => (activeSessionId ? s.queuedPrompts[activeSessionId]?.length ?? 0 : 0));
  const tokenUsage = useSessionStore((s) => (activeSessionId ? s.tokenUsage[activeSessionId] : undefined));
  const contextPct = tokenUsage && tokenUsage.size > 0 ? tokenUsage.used / tokenUsage.size : 0;

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

  const showSessionControls = home ? true : cwd !== undefined && !!activeTab;
  // Control values: live tab in thread view, home state on the home screen.
  const ctrlCwd = home ? home.cwd : cwd;
  const ctrlModel = home ? home.model : activeTab?.model;
  const ctrlEffort = home ? home.effort : activeTab?.reasoningEffort;
  const ctrlApproval = home ? home.approval : (activeTab?.approvalMode ?? "ask");
  const ctrlWorkMode = home ? "local" as WorkMode : (activeTab?.workMode ?? "local");

  return (
    <div className="relative mx-auto w-full max-w-3xl px-6 pb-5 pt-2" onDrop={onDrop} onDragOver={onDragOver}>
      {showSlash && slashQuery && <SlashComplete query={slashQuery} onSelect={handleSlashSelect} onClose={() => setShowSlash(false)} anchorBottom={120} />}

      {trigger && (
        <div className="absolute bottom-full left-4 z-50 mb-1 w-80 overflow-hidden rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg" role="listbox">
          <p className="border-b border-gb-border/8 px-2.5 py-1 text-[10px] uppercase tracking-wide text-gb-muted">
            {trigger.char === "@" ? "文件" : "技能"}
          </p>
          {triggerMatches.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-gb-muted">
              {trigger.char === "@" ? "无匹配文件" : "无匹配技能"}
            </p>
          )}
          {triggerMatches.map((m, i) => {
            const desc = trigger.char === "$" ? skills.find((sk) => sk.name === m)?.description : undefined;
            return (
            <button
              key={m}
              role="option"
              aria-selected={i === pickIdx}
              onMouseDown={(e) => { e.preventDefault(); applyTriggerSelection(m); }}
              className={`block w-full px-2.5 py-1.5 text-left text-[12px] ${
                i === pickIdx ? "bg-gb-surface-hover text-gb-text" : "text-gb-text-secondary"
              }`}
            >
              <span className="block truncate">{trigger.char === "$" ? `$${m}` : m}</span>
              {desc && <span className="block truncate text-[10px] text-gb-muted">{desc}</span>}
            </button>
            );
          })}
        </div>
      )}

      {isRecording && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-gb-red/10 px-2.5 py-1">
          <span className="flex items-center gap-1.5 text-[11px] text-gb-red"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gb-red" />录音中</span>
          <span className="flex-1 truncate text-[11px] text-gb-muted">{interimText || "正在聆听…"}</span>
          <select value={language} onChange={e => setLanguage(e.target.value as "auto"|"zh-CN"|"en-US")} className="rounded bg-transparent px-1 text-[10px] text-gb-muted outline-none"><option value="auto">自动</option><option value="zh-CN">中文</option><option value="en-US">EN</option></select>
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

      {contextPct > 0.8 && (
        <div className="mx-1 mb-1 h-0.5 rounded-full bg-gb-border/10">
          <div
            className="h-0.5 rounded-full bg-gradient-to-r from-gb-yellow to-gb-red"
            style={{ width: `${Math.min(100, contextPct * 100)}%` }}
            title="上下文窗口将满 — 建议使用 /compact"
          />
        </div>
      )}

      <div
        className="rounded-2xl border border-gb-border bg-gb-surface px-3.5 py-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.06)] focus-within:border-gb-muted/60"
        title={tokenUsage ? `上下文：${(tokenUsage.used / 1000).toFixed(1)}k / ${(tokenUsage.size / 1000).toFixed(0)}k tokens` : undefined}
      >
        <textarea ref={textareaRef} className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-gb-text outline-none placeholder:text-gb-muted" rows={1} placeholder={isStreaming ? "运行中 — Enter 插入追问 · Tab 排队" : "发送消息…（@ 文件 · $ 技能 · / 命令）"} value={text} onChange={e => handleTextChange(e.target.value)} onKeyDown={handleKeyDown} disabled={disabled} />

        <div className="mt-1 flex items-center gap-1" data-no-drag>
          {showSessionControls && ctrlCwd && onSwitchProject && (
            <ProjectSelector cwd={ctrlCwd} onSwitchProject={(p) => onSwitchProject?.(p)} variant="compact" />
          )}
          {showSessionControls && ctrlCwd && onWorkModeChange && !home && (
            <WorkModeSelect
              cwd={ctrlCwd}
              mode={ctrlWorkMode}
              branch={activeTab!.branch}
              onChange={(m, b) => onWorkModeChange(m, b)}
              onError={(msg) => console.error("[workmode]", msg)}
            />
          )}
          {showSessionControls && ctrlCwd && !home && ctrlWorkMode === "worktree" && onWorkModeChange && (
            <BranchSelect cwd={ctrlCwd} branch={activeTab!.branch} onPickBranch={(b) => onWorkModeChange("worktree", b)} />
          )}
          {showSessionControls && config && (
            <ModelEffortSelect
              config={config}
              model={ctrlModel || config.default_model || config.models[0]?.id || ""}
              effort={ctrlEffort ?? "medium"}
              onChange={(m, e) => {
                if (home) home.onPatch({ model: m, effort: e });
                else onModelEffortChange?.(m, e);
              }}
            />
          )}
          {showSessionControls && (
            <ApprovalModeSelect
              mode={ctrlApproval}
              onChange={(m: ApprovalMode) => {
                if (home) home.onPatch({ approval: m });
                else if (activeSessionId) useSessionStore.getState().setTabApprovalMode(activeSessionId, m);
              }}
            />
          )}

          <div className="flex-1" />

          {queuedCount > 0 && (
            <span className="rounded-full bg-gb-accent/10 px-1.5 py-0.5 text-[10px] text-gb-accent" title="已排队的追问（Tab）">
              {queuedCount} 排队中
            </span>
          )}
          <button
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${isRecording ? "text-gb-red" : "text-gb-muted hover:text-gb-text"}`}
            onClick={toggleRecording} disabled={disabled} title="语音输入"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2a2 2 0 00-2 2v3a2 2 0 004 0V4a2 2 0 00-2-2z" fill="currentColor" /><path d="M4 7a4 4 0 008 0M8 11v3" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          {isStreaming ? (
            <button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gb-red text-white hover:opacity-85" onClick={onCancel} title="停止 (Esc)"><svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="8" height="8" rx="1.5" /></svg></button>
          ) : (
            <button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gb-text text-gb-bg hover:opacity-80 disabled:opacity-20" onClick={handleSend} disabled={(!text.trim() && images.length === 0) || disabled} title="发送 (Enter)">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 12V2M3 6l4-4 4 4" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
