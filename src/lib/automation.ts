/**
 * Automation scheduling primitives — pure TypeScript, no React imports, so
 * this module can be imported by both the UI (AutomationsPage) and the
 * background scheduler without breaking React Fast Refresh.
 *
 * ISS-191: Scheduling is now driven from the Electron main process so it
 * survives page reloads.  The renderer keeps a local copy and syncs it to
 * main via `automations_sync` whenever it changes.  Run events arrive on the
 * `automation_run` IPC channel.
 */

import { invoke, safeListen } from "./tauri";

export interface Automation {
  id: string;
  name: string;
  trigger: "interval";
  schedule: string;
  prompt: string;
  createdAt: number;
  lastRunAt: number | null;
  runCount: number;
}

// ---- In-memory cache (renderer-side) ----

let _items: Automation[] = [];

export function getCachedAutomations(): Automation[] {
  return _items;
}

// ---- IPC sync ----

/** Push the current list to main and persist it on disk. */
export async function syncAutomations(items: Automation[]): Promise<void> {
  _items = items;
  try {
    await invoke("automations_sync", { items });
  } catch (e) {
    console.error("[automation] sync failed:", e);
  }
}

/** Pull the canonical list from main (e.g. on cold start or after reload). */
export async function loadAutomations(): Promise<Automation[]> {
  try {
    const list = await invoke<Automation[]>("automations_get");
    _items = Array.isArray(list) ? list : [];
  } catch {
    _items = [];
  }
  return _items;
}

/** Tell the main-process timer which session is active. */
export async function setActiveSession(sessionId: string | null): Promise<void> {
  try {
    await invoke("automations_set_active_session", { sessionId });
  } catch (e) {
    console.error("[automation] setActiveSession failed:", e);
  }
}

/** "Run Now" — immediately dispatch one automation through the main process. */
export async function runNow(automationId: string): Promise<void> {
  try {
    await invoke("automations_run_now", { automationId });
  } catch (e) {
    console.error("[automation] runNow failed:", e);
  }
}

/** Listen for run events dispatched by the main-process timer. */
export function onAutomationRun(
  handler: (payload: { automationId: string; sessionId: string; prompt: string }) => void
): Promise<() => void> {
  return safeListen<{ automationId: string; sessionId: string; prompt: string }>(
    "automation_run",
    handler
  );
}

/** Listen for the "list changed" signal so the UI can re-read. */
export function onAutomationsChanged(handler: () => void): Promise<() => void> {
  return safeListen("automations_changed", handler);
}

// ---- Cron parser (kept here so the UI can validate expressions) ----

/** Parse a 5-field cron expression and return the next run time (ms epoch),
 *  or null if the expression is invalid or yields no future run within the
 *  next year. Supports asterisk, step (asterisk-slash-N), ranges, and comma
 *  mixes. */
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
      const stepStr = f.slice(2);
      if (!/^\d+$/.test(stepStr)) return null;
      const step = parseInt(stepStr, 10);
      if (!Number.isFinite(step) || step <= 0) return null;
      const arr: number[] = [];
      for (let i = min; i <= max; i += step) arr.push(i);
      return arr;
    }
    if (f.includes("/")) return null;
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
      if (!/^\d+$/.test(part)) return null;
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

  const cap = fromMs + 366 * 24 * 60 * 60 * 1000;
  let t = new Date(fromMs);
  t.setSeconds(0, 0);
  t = new Date(t.getTime() + 60_000);
  while (t.getTime() < cap) {
    const m = t.getMinutes();
    const h = t.getHours();
    const d = t.getDate();
    const mo = t.getMonth() + 1;
    const w = t.getDay();
    const domRestricted = fields[2] !== "*";
    const dowRestricted = fields[4] !== "*";
    const domMatch = days.includes(d);
    const dowMatch = weekdays.includes(w) || (weekdays.includes(7) && w === 0);
    const dayOk = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (minutes.includes(m) && hours.includes(h) && months.includes(mo) && dayOk) {
      return t.getTime();
    }
    t = new Date(t.getTime() + 60_000);
  }
  return null;
}
