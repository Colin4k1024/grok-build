import { useState, useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import {
  loadAutomations,
  saveAutomations,
  nextCronRun,
  startAutomationScheduler,
  type Automation,
} from "../lib/automation";

/**
 * Automations page — schedule prompts to run in the current session on an
 * interval. Codex parity: `automations-page`.
 */
export function AutomationsPage({ onClose }: { onClose: () => void }) {
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
        <h2 className="text-[13px] font-medium">自动化</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded bg-gb-accent px-3 py-1 text-[12px] font-medium text-gb-bg hover:opacity-85"
          >
            {showForm ? "取消" : "+ 新建自动化"}
          </button>
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
            onClick={onClose}
          >
            ← 返回
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {showForm && (
          <div className="mb-4 space-y-3 rounded-lg border border-gb-border bg-gb-surface p-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="自动化名称"
              className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-[12px] text-gb-text outline-none focus:border-gb-accent/50"
            />
            <input
              value={schedule}
              onChange={(e) => {
                setSchedule(e.target.value);
                setScheduleError(null);
              }}
              placeholder="Cron 表达式（例如 0 9 * * *）"
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
              placeholder="触发时发送的提示词"
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
                      title={activeSessionId ? "在当前会话中运行" : "暂无活跃会话"}
                    >
                      ▶ 运行
                    </button>
                    <button
                      onClick={() => handleDelete(a.id)}
                      className="rounded px-2 py-1 text-[11px] text-gb-red hover:bg-gb-red/10"
                    >
                      删除
                    </button>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] text-gb-text-secondary">{a.prompt}</p>
                <p className="mt-1 text-[10px] text-gb-muted">
                  {a.runCount > 0
                    ? `${a.runCount} 次运行 · 最近一次 ${
                        a.lastRunAt ? new Date(a.lastRunAt).toLocaleString() : "从未"
                      }`
                    : "从未运行"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
