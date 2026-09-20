import { useState, useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import {
  loadAutomations,
  syncAutomations,
  nextCronRun,
  setActiveSession,
  runNow,
  onAutomationsChanged,
  type Automation,
} from "../lib/automation";

/**
 * Automations page — schedule prompts to run in the current session on an
 * interval. Codex parity: `automations-page`.
 *
 * ISS-191: Scheduling is driven by the Electron main process so it survives
 * page reloads. The renderer syncs its list via `automations_sync` and
 * receives run events on the `automation_run` IPC channel.
 */
export function AutomationsPage({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Automation[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  // Load from main process on mount.
  useEffect(() => {
    loadAutomations().then(setItems);
  }, []);

  // Keep main-process active session in sync.
  useEffect(() => {
    setActiveSession(activeSessionId);
  }, [activeSessionId]);

  // Re-read when the main-process timer fires an automation so the UI
  // stays in sync (runCount, lastRunAt).
  useEffect(() => {
    const p = onAutomationsChanged(() => {
      loadAutomations().then(setItems);
    });
    return () => { p.then((fn) => fn()); };
  }, []);

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
    syncAutomations(updated);
    setShowForm(false);
    setName("");
    setPrompt("");
    setSchedule("0 9 * * *");
  };

  const handleDelete = (id: string) => {
    const updated = items.filter((a) => a.id !== id);
    setItems(updated);
    syncAutomations(updated);
  };

  const handleRunNow = (id: string) => {
    runNow(id);
  };

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      {/* macOS traffic-light clearance */}
      <div className="app-drag h-9 shrink-0" />
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-gb-border/8 pl-24 pr-4">
        <h2 className="text-[13px] font-medium">Automations</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded bg-gb-accent px-3 py-1 text-[12px] font-medium text-gb-bg hover:opacity-85"
          >
            {showForm ? "Cancel" : "+ New"}
          </button>
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
            onClick={onClose}
          >
            Back
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {showForm && (
          <div className="mb-4 space-y-3 rounded-lg border border-gb-border bg-gb-surface p-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-[12px] text-gb-text outline-none focus:border-gb-accent/50"
            />
            <input
              value={schedule}
              onChange={(e) => {
                setSchedule(e.target.value);
                setScheduleError(null);
              }}
              placeholder="Cron expression (e.g. 0 9 * * *)"
              className={`w-full rounded border bg-gb-bg px-3 py-1.5 font-mono text-[12px] text-gb-text outline-none ${
                scheduleError ? "border-red-500" : "border-gb-border focus:border-gb-accent/50"
              }`}
            />
            {scheduleError && (
              <p className="text-[11px] text-red-500">{scheduleError}</p>
            )}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Prompt to send on trigger"
              rows={3}
              className="w-full resize-none rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-[12px] text-gb-text outline-none focus:border-gb-accent/50"
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim() || !prompt.trim()}
              className="rounded bg-gb-accent px-3 py-1.5 text-[12px] font-medium text-gb-bg disabled:opacity-40"
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
                      title={activeSessionId ? "Run in current session" : "No active session"}
                    >
                      Run
                    </button>
                    <button
                      onClick={() => handleDelete(a.id)}
                      className="rounded px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] text-gb-text-secondary">{a.prompt}</p>
                <p className="mt-1 text-[10px] text-gb-muted">
                  {a.runCount > 0
                    ? `${a.runCount} runs · Last ${
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
