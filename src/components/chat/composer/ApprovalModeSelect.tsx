import { useState, useRef, useEffect } from "react";
import type { ApprovalMode } from "../../../stores/sessionStore";

interface Props {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
}

const OPTIONS: { id: ApprovalMode; label: string; hint: string }[] = [
  { id: "full-access", label: "Full access", hint: "Edit files and run commands without asking" },
  { id: "ask", label: "Ask before edits", hint: "Propose changes and wait for approval" },
  { id: "read-only", label: "Read only", hint: "Analyze and plan; deny write actions" },
];

/** Codex-style approval gate picker (composer-embedded). */
export function ApprovalModeSelect({ mode, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current = OPTIONS.find((o) => o.id === mode) ?? OPTIONS[1];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gb-text-secondary transition-colors hover:bg-gb-surface-hover hover:text-gb-text"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Approval mode"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="opacity-70">
          <path d="M6 1l4 2v3c0 2.5-1.7 4.4-4 5-2.3-.6-4-2.5-4-5V3l4-2z" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span>{current.label}</span>
        <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" className="opacity-40"><path d="M1 3l3 3 3-3z" /></svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-50 mb-1.5 w-64 overflow-hidden rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg"
        >
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              role="option"
              aria-selected={o.id === mode}
              onClick={() => { onChange(o.id); setOpen(false); }}
              className={`flex w-full flex-col px-2.5 py-1.5 text-left hover:bg-gb-surface-hover ${
                o.id === mode ? "text-gb-accent" : "text-gb-text"
              }`}
            >
              <span className="flex w-full items-center justify-between text-[12px] font-medium">
                {o.label}
                {o.id === mode && <span className="text-gb-accent">✓</span>}
              </span>
              <span className="text-[10px] text-gb-muted">{o.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
