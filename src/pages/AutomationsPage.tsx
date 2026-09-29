import { useState, useEffect, useCallback } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { PageShell } from "../components/layout/PageShell";
import { AsyncState, Button, Card, Input } from "../components/ui";
import { toast } from "../components/ui";
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
 * Automations page (R4-09 #242): schedule prompts to run in the current
 * session on an interval. Unified with the other destination pages via
 * PageShell + AsyncState (loading/empty/error+retry) + toast feedback for
 * every async operation (create/run/delete) + consistent Card layout.
 *
 * Each card expresses schedule, last run, next run (computed client-side via
 * nextCronRun) and an enable/disable toggle; a failure (lastError) surfaces
 * inline with a recovery Run. ISS-191: scheduling is main-process driven.
 */
export function AutomationsPage() {
  const [items, setItems] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  // Per-session streaming — disables Run while the active session is mid-turn
  // (a dispatched run is silently dropped for a streaming session, so offering
  // it would be a misleading success).
  const streamingMap = useSessionStore((s) => s.streaming);
  const activeStreaming = activeSessionId ? streamingMap[activeSessionId] === true : false;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await loadAutomations();
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    setActiveSession(activeSessionId).catch(() => {});
  }, [activeSessionId]);

  // Re-read when the main-process timer fires so runCount/lastRunAt stay live.
  useEffect(() => {
    const p = onAutomationsChanged(() => {
      loadAutomations().then(setItems).catch(() => {});
    });
    return () => {
      p.then((fn) => fn());
    };
  }, []);

  const isValidCron = (expr: string): boolean => {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    if (!fields.every((f) => /^[\d*,\-/]+$/.test(f))) return false;
    return nextCronRun(expr) !== null;
  };

  const persist = async (updated: Automation[], successMsg: string): Promise<boolean> => {
    const prev = items;
    setItems(updated);
    try {
      // lastError is a renderer-side transient failure indicator — never
      // persist it (a later sync would otherwise write it to disk, where it
      // survives restarts and is never cleared by scheduled runs).
      const toSync = updated.map(({ lastError: _le, ...rest }) => rest);
      await syncAutomations(toSync);
      if (successMsg) toast.success(successMsg); // skip the blank toast on no-message ops (e.g. toggle — the badge is the feedback)
      return true;
    } catch (e) {
      setItems(prev); // rollback the optimistic update
      toast.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) return;
    if (!isValidCron(schedule)) {
      setScheduleError("无效 cron 表达式 — 格式 '分 时 日 月 周'（如 '0 9 * * *'）。");
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
      enabled: true,
      lastError: null,
    };
    const ok = await persist([...items, next], `已创建自动化「${next.name}」`);
    if (!ok) return; // keep the draft + form open so the user can retry
    setShowForm(false);
    setName("");
    setPrompt("");
    setSchedule("0 9 * * *");
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("删除该自动化？")) return;
    await persist(
      items.filter((a) => a.id !== id),
      "已删除自动化",
    );
  };

  const handleToggle = async (id: string) => {
    // Flip the EFFECTIVE state: a pre-existing automation has `enabled ===
    // undefined` (treated as enabled), so `!a.enabled` would write `true`
    // (still enabled) — the user would have to click twice. Mirror the
    // display predicate (enabled !== false) so the first click disables.
    const updated = items.map((a) =>
      a.id === id ? { ...a, enabled: a.enabled !== false ? false : true } : a,
    );
    await persist(updated, "");
  };

  const handleRunNow = async (id: string) => {
    setBusyId(id);
    try {
      await runNow(id);
      toast.success("已触发运行");
      // Re-fetch the canonical list so the card's run bookkeeping
      // (lastRunAt/runCount) reflects the main's updated record. The main
      // does NOT broadcast automations_changed after a manual run, so without
      // this reload the stats stay stale. (Do NOT syncAutomations — that would
      // push the renderer's stale lastRunAt back and risk duplicate fires.)
      if (items.find((a) => a.id === id)?.lastError) {
        setItems((prev) => prev.map((a) => (a.id === id ? { ...a, lastError: null } : a)));
      }
      loadAutomations().then(setItems).catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`运行失败：${msg}`);
      // lastError is a renderer-side transient failure indicator (the run
      // dispatch failed, so the main has no new bookkeeping to clobber).
      // The next automations_changed reload clears it from the canonical list.
      setItems((prev) => prev.map((a) => (a.id === id ? { ...a, lastError: msg } : a)));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PageShell
      toolbar={
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "取消" : "+ 新建"}
        </Button>
      }
    >
      {showForm && (
        <Card className="mb-4 space-y-3">
          <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" />
          <Input
            label="计划（cron）"
            value={schedule}
            onChange={(e) => {
              setSchedule(e.target.value);
              setScheduleError(null);
            }}
            error={scheduleError ?? undefined}
            placeholder="0 9 * * *"
          />
          <div className="flex flex-col gap-1">
            <label className="text-gb-xs font-medium text-gb-text-secondary">提示词</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="触发时发送的提示词（支持多行）"
              rows={3}
              className="w-full resize-none rounded-gb-md border gb-border-control gb-hover-border-control bg-gb-canvas px-3 py-1.5 text-gb-sm text-gb-text-primary outline-none transition-colors duration-gb-fast ease-gb focus:border-gb-accent"
            />
          </div>
          <Button size="sm" onClick={handleCreate} disabled={!name.trim() || !prompt.trim()}>
            创建
          </Button>
        </Card>
      )}

      <AsyncState
        loading={loading}
        error={error ?? undefined}
        onRetry={reload}
        empty={items.length === 0}
        emptyTitle="还没有自动化"
        emptyDescription="创建一个自动化，按计划在会话中运行提示词。"
        emptyAction={
          <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>
            新建自动化
          </Button>
        }
      >
        <div className="space-y-2">
          {items.map((a) => {
            const enabled = a.enabled !== false;
            const next = nextCronRun(a.schedule);
            return (
              <Card key={a.id} className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-gb-sm font-medium ${enabled ? "" : "text-gb-text-muted"}`}>
                        {a.name}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          enabled
                            ? "bg-gb-success/10 text-gb-success-text"
                            : "bg-gb-surface-hover text-gb-text-muted"
                        }`}
                      >
                        {enabled ? "启用" : "已停用"}
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-gb-text-muted">{a.schedule}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRunNow(a.id)}
                      disabled={!activeSessionId || activeStreaming || busyId === a.id}
                      loading={busyId === a.id}
                    >
                      运行
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleToggle(a.id)}>
                      {enabled ? "停用" : "启用"}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleDelete(a.id)}>
                      删除
                    </Button>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-gb-xs text-gb-text-secondary">{a.prompt}</p>
                {a.lastError && (
                  <p role="alert" className="mt-1 text-[10px] text-gb-danger-text">
                    上次失败：{a.lastError}
                  </p>
                )}
                <p className="mt-1 text-[10px] text-gb-text-muted">
                  {a.runCount > 0
                    ? `${a.runCount} 次运行 · 上次 ${a.lastRunAt ? new Date(a.lastRunAt).toLocaleString() : "无"}`
                    : "从未运行"}
                  {enabled && next ? ` · 下次 ${new Date(next).toLocaleString()}` : ""}
                </p>
              </Card>
            );
          })}
        </div>
      </AsyncState>
    </PageShell>
  );
}
