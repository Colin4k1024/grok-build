import { useState, useRef, useEffect } from "react";
import type { ConfigSnapshot } from "../../../lib/tauri";

type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface Props {
  config: ConfigSnapshot | null;
  model: string;
  effort: Effort;
  onChange: (model: string, effort: Effort) => void;
}

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "none", label: "None" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
];

/** Codex-style combined model + reasoning-effort control — one button showing
 *  "Model · Effort", one popover to pick both. */
export function ModelEffortSelect({ config, model, effort, onChange }: Props) {
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

  const models = config?.models.filter((m) => !m.hidden) ?? [];
  const modelName = config?.models.find((m) => m.id === model)?.name || model || "Model";
  const effortLabel = EFFORTS.find((e) => e.id === effort)?.label ?? "Medium";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gb-text-secondary transition-colors hover:bg-gb-surface-hover hover:text-gb-text"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Model and reasoning effort"
      >
        <span className="max-w-[150px] truncate">{modelName}</span>
        <span className="text-gb-muted">·</span>
        <span>{effortLabel}</span>
        <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" className="opacity-40"><path d="M1 3l3 3 3-3z" /></svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-50 mb-1.5 w-60 overflow-hidden rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg"
        >
          <div className="max-h-56 overflow-y-auto py-0.5">
            {models.map((m) => (
              <button
                key={m.id}
                role="option"
                aria-selected={m.id === model}
                onClick={() => onChange(m.id, effort)}
                className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-gb-surface-hover ${
                  m.id === model ? "text-gb-accent" : "text-gb-text"
                }`}
              >
                <span className="truncate">{m.name}</span>
                {m.id === model && <span className="text-gb-accent">✓</span>}
              </button>
            ))}
          </div>
          <div className="border-t border-gb-border/8 px-2 py-1.5">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-gb-muted">Effort</p>
            <div className="flex flex-wrap gap-1">
              {EFFORTS.map((e) => (
                <button
                  key={e.id}
                  onClick={() => onChange(model, e.id)}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                    e.id === effort
                      ? "bg-gb-accent/15 text-gb-accent"
                      : "text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
                  }`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
