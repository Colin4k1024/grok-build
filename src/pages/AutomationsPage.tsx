import { useState, useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";

interface Automation {
  id: string;
  name: string;
  trigger: "interval";
  schedule: string;
  prompt: string;
  createdAt: number;
  lastRunAt: number | null;
  runCount: number;
}

const STORAGE_KEY = "gb-automations";

function loadAutomations(): Automation[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveAutomations(list: Automation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota */
  }
}

/** Parse a 5-field cron expression and return the next run time (ms epoch),
 *  or null if the expression is invalid or yields no future run within the
 *  next year. Only supports asterisk, single numbers, and step forms like
 *  asterisk-slash-N. */
export function nextCronRun(expr: string, fromMs: number = Date.now()): number | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const parseField = (f: string, min: number, max: number): number[] | null => {
    if (f === "*") {
      const arr: number[] = [];
      for (let i = min; i <= max; i++) arr.push(i);
      return arr;
    }
    if (f.startsWith("*/")) {
      const step = parseInt(f.slice(2), 10);
      if (!Number.isFinite(step) || step <= 0) return null;
      const arr: number[] = [];
      for (let i = min; i <= max; i += step) arr.push(i);
      return arr;
    }
    // Support ranges like "1-5" and comma mixes like "1,5,9-11".
    const out: number[] = [];
    for (const part of f.split(",")) {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || lo < min || hi > max) {
          return null;
        }
        for (let i = lo; i <= hi; i++) out.push(i);
        continue;
      }
      const n = parseInt(part, 10);
      if (!Number.isFinite(n) || n < min || n > max) return null;
      out.push(n);
    }
    return out;
  };

  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const days = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const weekdays = parseField(fields[4], 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return null;

  // Walk forward minute-by-minute from `fromMs` until we hit a match, with a
  // hard cap so we don't loop forever on impossible combos (e.g. Feb 31).
  const cap = fromMs + 366 * 24 * 60 * 60 * 1000;
  let t = new Date(fromMs);
  t.setSeconds(0, 0);
  t = new Date(t.getTime() + 60_000); // next minute boundary
  while (t.getTime() < cap) {
    const m = t.getMinutes();
    const h = t.getHours();
    const d = t.getDate();
    const mo = t.getMonth() + 1;
    const w = t.getDay(); // 0 = Sunday
    if (
      minutes.includes(m) &&
      hours.includes(h) &&
      days.includes(d) &&
      months.includes(mo) &&
      (weekdays.includes(w) || (weekdays.includes(7) && w === 0))
    ) {
      return t.getTime();
    }
    t = new Date(t.getTime() + 60_000);
  }
  return null;
}

/**
 * Automations page — schedule prompts to run in the current session on an
 * interval or when an event fires. Codex parity: `automations-page`.
 */
// Module-level scheduler: keeps firing even when the user navigates away
// from the Automations page. State lives in localStorage; each tick computes
// purely, then dispatches events as a separate side effect.
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startAutomationScheduler(getActiveSessionId: () => string | null) {
  if (schedulerTimer) return; // already running
  schedulerTimer = setInterval(() => {
    const items = loadAutomations();
    const now = Date.now();
    const activeSessionId = getActiveSessionId();

    // Pure pass: compute next state.
    const updated: Automation[] = [];
    const toFire: Automation[] = [];
    let changed = false;
    for (const a of items) {
      const baseline = a.lastRunAt ?? a.createdAt;
      const nextRun = nextCronRun(a.schedule, baseline);
      if (nextRun !== null && nextRun <= now) {
        changed = true;
        const bumped = { ...a, lastRunAt: now, runCount: a.runCount + 1 };
        updated.push(bumped);
        toFire.push(bumped);
      } else {
        updated.push(a);
      }
    }

    if (!changed) return;

    // Side effects — outside the pure pass.
    saveAutomations(updated);
    for (const a of toFire) {
      if (activeSessionId) {
        window.dispatchEvent(
          new CustomEvent("grok:automation-run", {
            detail: { automationId: a.id, sessionId: activeSessionId, prompt: a.prompt },
          })
        );
      }
    }

    // Notify any open AutomationsPage to re-read localStorage.
    window.dispatchEvent(new CustomEvent("grok:automations-changed"));
  }, 30_000);
}

export function stopAutomationScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export function AutomationsPage({ onClose }: { onClose: () => void }) {
  // Lazy initializer so we don't re-parse localStorage on every render.
  const [items, setItems] = useState<Automation[]>(() => loadAutomations());
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  // Re-read when the module-level scheduler fires an automation so the UI
  // stays in sync (runCount, lastRunAt).
  useEffect(() => {
    const handler = () => setItems(loadAutomations());
    window.addEventListener("grok:automations-changed", handler);
    return () => window.removeEventListener("grok:automations-changed", handler);
  }, []);

  // Boot the module-level scheduler on mount (idempotent).
  useEffect(() => {
    startAutomationScheduler(() => useSessionStore.getState().activeSessionId);
  }, []);

  // Accept only plausible cron expressions: 5 space-separated fields with
  // digits, '*', ',', '-', '/'. Rejects free text. Then verify it actually
  // yields a future run via nextCronRun so obvious dead combos (e.g.
  // '99 99 99 99 99') are caught.
  const isValidCron = (expr: string): boolean => {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    if (!fields.every((f) => /^[\d*,\-/]+$/.test(f))) return false;
    return nextCronRun(expr) !== null;
  };

  const handleCreate = () => {
    if (!name.trim() || !prompt.trim()) return;
    if (!isValidCron(schedule)) {
      setScheduleError("Invalid cron expression — expected 'min hour day month weekday' (e.g. '0 9 * * *').");
      return;
    }
    setScheduleError(null);
    const next: Automation = {
      id: `auto-${Date.now()}`,
      name: name.trim(),
      trigger: "interval",
      schedule,
      prompt: prompt.trim(),
      createdAt: Date.now(),
      lastRunAt: null,
      runCount: 0,
    };
    const updated = [...items, next];
    setItems(updated);
    saveAutomations(updated);
    setShowForm(false);
    setName("");
    setPrompt("");
    setSchedule("0 9 * * *");
  };

  const handleDelete = (id: string) => {
    const updated = items.filter((a) => a.id !== id);
    setItems(updated);
    saveAutomations(updated);
  };

  const handleRunNow = (id: string) => {
    const updated = items.map((a) =>
      a.id === id ? { ...a, lastRunAt: Date.now(), runCount: a.runCount + 1 } : a
    );
    setItems(updated);
    saveAutomations(updated);
    // Dispatch the prompt into the active session as if the user typed it.
    const auto = updated.find((a) => a.id === id);
    if (auto && activeSessionId) {
      window.dispatchEvent(
        new CustomEvent("grok:automation-run", {
          detail: { automationId: id, sessionId: activeSessionId, prompt: auto.prompt },
        })
      );
    }
  };

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-gb-border/8 px-4">
        <h2 className="text-[13px] font-medium">Automations</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded bg-gb-accent px-3 py-1 text-[12px] font-medium text-white hover:opacity-85"
          >
            {showForm ? "Cancel" : "+ New automation"}
          </button>
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
            onClick={onClose}
          >
            ← Back
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {showForm && (
          <div className="mb-4 space-y-3 rounded-lg border border-gb-border bg-gb-surface p-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Automation name"
              className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-[12px] text-gb-text outline-none focus:border-gb-accent/50"
            />
            <input
              value={schedule}
              onChange={(e) => {
                setSchedule(e.target.value);
                setScheduleError(null);
              }}
              placeholder="Cron schedule (e.g. 0 9 * * *)"
              className={`w-full rounded border bg-gb-bg px-3 py-1.5 font-mono text-[12px] text-gb-text outline-none ${
                scheduleError ? "border-gb-red/50" : "border-gb-border focus:border-gb-accent/50"
              }`}
            />
            {scheduleError && (
              <p className="text-[11px] text-gb-red">{scheduleError}</p>
            )}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Prompt to send when triggered"
              rows={3}
              className="w-full resize-none rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-[12px] text-gb-text outline-none focus:border-gb-accent/50"
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim() || !prompt.trim()}
              className="rounded bg-gb-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
            >
              Create
            </button>
          </div>
        )}

        {items.length === 0 ? (
          <p className="py-12 text-center text-xs text-gb-muted">
            No automations yet. Create one to run a prompt on a schedule.
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((a) => (
              <div
                key={a.id}
                className="rounded-lg border border-gb-border bg-gb-surface p-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] font-medium text-gb-text">{a.name}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-gb-muted">{a.schedule}</p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleRunNow(a.id)}
                      disabled={!activeSessionId}
                      className="rounded border border-gb-border/20 px-2 py-1 text-[11px] text-gb-muted hover:text-gb-text disabled:opacity-40"
                      title={activeSessionId ? "Run in active session" : "No active session"}
                    >
                      ▶ Run
                    </button>
                    <button
                      onClick={() => handleDelete(a.id)}
                      className="rounded px-2 py-1 text-[11px] text-gb-red hover:bg-gb-red/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] text-gb-text-secondary">{a.prompt}</p>
                <p className="mt-1 text-[10px] text-gb-muted">
                  {a.runCount > 0
                    ? `${a.runCount} run${a.runCount === 1 ? "" : "s"} · last ${
                        a.lastRunAt ? new Date(a.lastRunAt).toLocaleString() : "never"
                      }`
                    : "Never run"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
