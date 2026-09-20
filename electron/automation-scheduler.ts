/**
 * Automation scheduler logic (R3-06 / #191) — extracted from main.ts so it
 * can be tested with a fake clock without spawning the Electron main process.
 *
 * The scheduler evaluates cron schedules against a reference time, claims
 * occurrences atomically (one occurrence → at most one active run), and
 * persists state so a crash/restart does not re-fire an already-confirmed
 * side effect.
 *
 * Claim/lease semantics:
 *   - Each occurrence (automation id + scheduled time) can be claimed at most once.
 *   - A claim records the claimer and a lease timestamp; expired leases are reclaimable.
 *   - On restart, the claim store is empty (in-memory) — any occurrence that
 *     already fired (lastRunAt >= occurrence time) is NOT re-claimed. This
 *     is the crash-invalidation invariant: a stale claim from a dead process
 *     cannot authorize a duplicate run.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface AutomationRecord {
  id: string;
  name: string;
  trigger: "interval";
  schedule: string;
  prompt: string;
  createdAt: number;
  lastRunAt: number | null;
  runCount: number;
  /** Fixed target session (standalone) or null (uses active session). */
  targetSessionId?: string | null;
  /** Fixed target worktree path (isolated execution). */
  targetWorktree?: string | null;
  paused?: boolean;
}

export interface RunInboxEntry {
  automationId: string;
  sessionId: string;
  prompt: string;
  scheduledTime: number;
  runAt: number;
  status: "pending" | "completed" | "failed" | "interrupted";
  claimer?: string | null;
}

export interface ClaimRecord {
  automationId: string;
  occurrenceTime: number;
  claimedBy: string;
  claimedAt: number;
  /** Lease expiry — a claim is reclaimable after this time. */
  leaseExpiresAt: number;
}

/**
 * Parse a 5-field cron expression and return the next run time (ms epoch).
 * Supports wildcard, step (slash-N), ranges, and comma-separated values.
 */
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
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || lo < min || hi > max) return null;
        for (let i = lo; i <= hi; i++) out.push(i);
        continue;
      }
      if (!/^\d+$/.test(part)) return null;
      const n = parseInt(part, 10);
      if (!Number.isFinite(n) || n < min || n > max) return null;
      out.push(n);
    }
    return out.length > 0 ? out : null;
  };

  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const doms = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const dows = parseField(fields[4], 0, 6);
  if (!minutes || !hours || !doms || !months || !dows) return null;

  const from = new Date(fromMs);
  // Start from the next minute.
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1, 0, 0);
  // Scan up to 366 days for the next matching time (handles Feb 29 etc.).
  for (let t = start.getTime(); t < fromMs + 366 * 24 * 60 * 60 * 1000; t += 60 * 1000) {
    const d = new Date(t);
    if (
      minutes.includes(d.getMinutes()) &&
      hours.includes(d.getHours()) &&
      doms.includes(d.getDate()) &&
      months.includes(d.getMonth() + 1) &&
      dows.includes(d.getDay())
    ) {
      return t;
    }
  }
  return null;
}

/**
 * The claim store — in-memory only (no persistence). A fresh process starts
 * with an empty store. The automation's lastRunAt (persisted on disk) is the
 * authoritative record of whether an occurrence already fired.
 */
export class ClaimStore {
  private claims = new Map<string, ClaimRecord>();
  private leaseDurationMs: number;

  constructor(leaseDurationMs = 5 * 60 * 1000) {
    this.leaseDurationMs = leaseDurationMs;
  }

  private key(automationId: string, occurrenceTime: number): string {
    return `${automationId}@${occurrenceTime}`;
  }

  /**
   * Try to claim an occurrence. Returns true if this caller won the claim,
   * false if another caller already holds an active lease.
   */
  claim(automationId: string, occurrenceTime: number, claimer: string): boolean {
    const k = this.key(automationId, occurrenceTime);
    const existing = this.claims.get(k);
    const now = Date.now();
    if (existing && existing.leaseExpiresAt > now) {
      // Active lease held by someone else — reject.
      return existing.claimedBy === claimer;
    }
    this.claims.set(k, {
      automationId,
      occurrenceTime,
      claimedBy: claimer,
      claimedAt: now,
      leaseExpiresAt: now + this.leaseDurationMs,
    });
    return true;
  }

  /** Release a claim after the run completes (or fails). */
  release(automationId: string, occurrenceTime: number): void {
    this.claims.delete(this.key(automationId, occurrenceTime));
  }

  /** Check if an occurrence is currently claimed. */
  isClaimed(automationId: string, occurrenceTime: number): boolean {
    const c = this.claims.get(this.key(automationId, occurrenceTime));
    return !!c && c.leaseExpiresAt > Date.now();
  }

  /** Clear all claims (for tests). */
  clear(): void {
    this.claims.clear();
  }
}

/**
 * Evaluate which automations are due at the given reference time, considering
 * lastRunAt (the persisted authoritative record). An occurrence is due if its
 * scheduled time is <= now AND it's after lastRunAt AND the automation is not
 * paused.
 *
 * The claim store prevents two callers from claiming the same occurrence.
 */
export function evaluateDue(
  automations: AutomationRecord[],
  nowMs: number,
  claimStore: ClaimStore,
  claimer: string
): { automation: AutomationRecord; occurrenceTime: number }[] {
  const due: { automation: AutomationRecord; occurrenceTime: number }[] = [];
  for (const a of automations) {
    if (a.paused) continue;
    const baseline = a.lastRunAt ?? a.createdAt;
    const next = nextCronRun(a.schedule, baseline);
    if (next !== null && next <= nowMs) {
      // Check if this occurrence already fired (lastRunAt >= occurrence time).
      if (a.lastRunAt !== null && a.lastRunAt >= next) continue;
      // Try to claim — prevents duplicate runs across competing callers.
      if (claimStore.claim(a.id, next, claimer)) {
        due.push({ automation: a, occurrenceTime: next });
      }
    }
  }
  return due;
}

/**
 * Run inbox — tracks the history of automation runs. Persisted to disk so
 * a restart shows the run history (but does NOT re-fire runs).
 */
export class RunInbox {
  private entries: RunInboxEntry[] = [];
  private inboxPath: string;

  constructor(inboxPath?: string) {
    this.inboxPath = inboxPath || path.join(
      process.env.GROK_HOME || path.join(os.homedir(), ".grok"),
      "automation-inbox.json"
    );
  }

  add(entry: RunInboxEntry): void {
    this.entries.push(entry);
    this.persist();
  }

  update(automationId: string, scheduledTime: number, status: RunInboxEntry["status"]): void {
    const e = this.entries.find(
      (x) => x.automationId === automationId && x.scheduledTime === scheduledTime
    );
    if (e) {
      e.status = status;
      this.persist();
    }
  }

  list(): RunInboxEntry[] {
    return [...this.entries];
  }

  load(): void {
    try {
      if (fs.existsSync(this.inboxPath)) {
        this.entries = JSON.parse(fs.readFileSync(this.inboxPath, "utf-8"));
      }
    } catch { /* start empty */ }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.inboxPath), { recursive: true });
      fs.writeFileSync(this.inboxPath, JSON.stringify(this.entries, null, 2));
    } catch { /* best-effort */ }
  }

  clear(): void {
    this.entries = [];
  }
}
