/**
 * Automation scheduling primitives — pure TypeScript, no React imports, so
 * this module can be imported by both the UI (AutomationsPage) and the
 * background scheduler without breaking React Fast Refresh.
 */

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

const STORAGE_KEY = "gb-automations";

export function loadAutomations(): Automation[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveAutomations(list: Automation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota */
  }
}

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
    // Reject compound "1-10/2" — we don't implement stepped ranges.
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

  // Walk forward minute-by-minute from `fromMs` until we hit a match, with a
  // hard cap so we don't loop forever on impossible combos (e.g. Feb 31).
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

// Module-level scheduler: keeps firing even when the user navigates away
// from the Automations page.
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startAutomationScheduler(getActiveSessionId: () => string | null) {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    const items = loadAutomations();
    const now = Date.now();
    const activeSessionId = getActiveSessionId();

    const updated: Automation[] = [];
    const toFire: Automation[] = [];
    let changed = false;
    for (const a of items) {
      const baseline = a.lastRunAt ?? a.createdAt;
      const nextRun = nextCronRun(a.schedule, baseline);
      if (nextRun !== null && nextRun <= now && activeSessionId) {
        changed = true;
        const bumped = { ...a, lastRunAt: now, runCount: a.runCount + 1 };
        updated.push(bumped);
        toFire.push(bumped);
      } else {
        updated.push(a);
      }
    }

    if (!changed) return;

    saveAutomations(updated);
    for (const a of toFire) {
      window.dispatchEvent(
        new CustomEvent("grok:automation-run", {
          detail: { automationId: a.id, sessionId: activeSessionId, prompt: a.prompt },
        })
      );
    }
    window.dispatchEvent(new CustomEvent("grok:automations-changed"));
  }, 30_000);
}

export function stopAutomationScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
