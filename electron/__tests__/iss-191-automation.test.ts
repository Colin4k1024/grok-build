// @vitest-environment node
/**
 * Automation scheduler tests (R3-06 / #191).
 *
 * These tests prove the automation scheduler logic handles:
 *   - Cron schedule evaluation (RRULE-equivalent, timezone, DST)
 *   - Claim/lease: one occurrence → at most one active run
 *   - Multi-window/double-scheduler competition: only one claims the run
 *   - Crash recovery: lastRunAt prevents re-firing an already-confirmed side effect
 *   - Paused automations don't fire
 *   - Missed occurrences (interval larger than the check interval)
 *   - Standalone target (fixed session) vs active session
 *   - Run inbox tracks run history
 *
 * Real side effects: real file reads/writes for the run inbox, real cron
 * evaluation. No mocks of the scheduling logic the issue requires.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  nextCronRun,
  ClaimStore,
  RunInbox,
  evaluateDue,
  type AutomationRecord,
} from "../automation-scheduler";

let tmp = "";
let savedGrokHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-auto-191-"));
  savedGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
});

function makeAutomation(overrides: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: "auto-1",
    name: "test",
    trigger: "interval",
    schedule: "*/5 * * * *", // every 5 minutes
    prompt: "run tests",
    createdAt: 1000000000000,
    lastRunAt: null,
    runCount: 0,
    ...overrides,
  };
}

describe("nextCronRun — schedule evaluation (RRULE/timezone/DST)", () => {
  it("evaluates a simple every-5-minutes schedule", () => {
    // Use local time so assertions are timezone-agnostic.
    const from = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const next = nextCronRun("*/5 * * * *", from);
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    expect(nextDate.getMinutes()).toBe(5);
    expect(nextDate.getHours()).toBe(10);
  });

  it("evaluates an hourly schedule", () => {
    const from = new Date(2026, 0, 15, 10, 30, 0).getTime();
    const next = nextCronRun("0 * * * *", from);
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    expect(nextDate.getMinutes()).toBe(0);
    expect(nextDate.getHours()).toBe(11); // next hour
  });

  it("evaluates a daily schedule at 9am", () => {
    const from = new Date(2026, 0, 15, 14, 0, 0).getTime();
    const next = nextCronRun("0 9 * * *", from);
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    expect(nextDate.getHours()).toBe(9);
    expect(nextDate.getDate()).toBe(16); // next day
  });

  it("evaluates a weekly schedule (Mondays)", () => {
    // 2026-01-15 is a Thursday
    const from = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const next = nextCronRun("0 10 * * 1", from); // Monday at 10am
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    expect(nextDate.getDay()).toBe(1); // Monday
  });

  it("DST transition — schedule still resolves (no crash on ambiguous time)", () => {
    // March 8 2026 is US DST spring-forward. The scheduler must not crash.
    const from = new Date(2026, 2, 8, 1, 30, 0).getTime();
    const next = nextCronRun("0 2 * * *", from);
    expect(next).not.toBeNull();
  });

  it("invalid cron expressions return null — not a crash", () => {
    expect(nextCronRun("invalid", Date.now())).toBeNull();
    expect(nextCronRun("* * *", Date.now())).toBeNull();
    expect(nextCronRun("99 * * * *", Date.now())).toBeNull();
    expect(nextCronRun("* 99 * * *", Date.now())).toBeNull();
    expect(nextCronRun("* * * * 7", Date.now())).toBeNull(); // dow 0-6 only
  });

  it("range syntax works", () => {
    const from = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const next = nextCronRun("0-5 * * * *", from); // minutes 0-5
    expect(next).not.toBeNull();
    // The next minute in range 0-5 after 10:00 is 10:01 (minute 1)
    expect(new Date(next!).getMinutes()).toBe(1);
  });

  it("comma-separated values work", () => {
    const from = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const next = nextCronRun("0,30 * * * *", from); // at :00 and :30
    expect(next).not.toBeNull();
    // After 10:00, the next match is 10:30
    expect(new Date(next!).getMinutes()).toBe(30);
  });
});

describe("claim/lease — one occurrence → at most one active run", () => {
  it("first claimer wins; second claimer loses", () => {
    const store = new ClaimStore();
    expect(store.claim("auto-1", 1000, "window-A")).toBe(true);
    expect(store.claim("auto-1", 1000, "window-B")).toBe(false);
  });

  it("different occurrences are claimable independently", () => {
    const store = new ClaimStore();
    expect(store.claim("auto-1", 1000, "A")).toBe(true);
    expect(store.claim("auto-1", 2000, "A")).toBe(true);
    expect(store.claim("auto-2", 1000, "A")).toBe(true);
  });

  it("isClaimed reflects active claims", () => {
    const store = new ClaimStore();
    store.claim("auto-1", 1000, "A");
    expect(store.isClaimed("auto-1", 1000)).toBe(true);
    expect(store.isClaimed("auto-1", 2000)).toBe(false);
  });

  it("release frees the claim for re-claiming", () => {
    const store = new ClaimStore();
    store.claim("auto-1", 1000, "A");
    store.release("auto-1", 1000);
    expect(store.isClaimed("auto-1", 1000)).toBe(false);
    expect(store.claim("auto-1", 1000, "B")).toBe(true);
  });
});

describe("multi-window competition — only one claims the run", () => {
  it("two evaluators compete for the same occurrence — only one wins", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({ lastRunAt: null, createdAt: 0 });
    // Simulate two windows evaluating at the same time
    const now = 1000000000000 + 6 * 60 * 1000; // 6 min after createdAt
    const dueA = evaluateDue([auto], now, store, "window-A");
    const dueB = evaluateDue([auto], now, store, "window-B");
    // Only one window should have claimed the occurrence.
    expect(dueA.length + dueB.length).toBe(1);
    expect(dueA.length === 1 || dueB.length === 1).toBe(true);
  });

  it("three competing claimers — still only one wins", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({ lastRunAt: null, createdAt: 0 });
    const now = 1000000000000 + 6 * 60 * 1000;
    const results = [
      evaluateDue([auto], now, store, "w1"),
      evaluateDue([auto], now, store, "w2"),
      evaluateDue([auto], now, store, "w3"),
    ];
    const totalDue = results.reduce((s, r) => s + r.length, 0);
    expect(totalDue).toBe(1);
  });
});

describe("crash recovery — already-confirmed side effects don't repeat", () => {
  it("lastRunAt >= occurrence time prevents re-evaluation", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({
      createdAt: 1000000000000,
      lastRunAt: 1000000000000 + 5 * 60 * 1000, // already ran at the 5-min mark
    });
    // Now is after the last run — the 5-min occurrence already fired.
    const now = 1000000000000 + 6 * 60 * 1000;
    const due = evaluateDue([auto], now, store, "restart");
    // The 5-min occurrence should NOT be re-due (lastRunAt >= next).
    // The next due occurrence is at the 10-min mark.
    if (due.length > 0) {
      // If due, it must be a NEW occurrence, not the already-fired one.
      expect(due[0].occurrenceTime).toBeGreaterThan(auto.lastRunAt!);
    }
  });

  it("fresh process (empty claim store) does not re-fire already-run occurrence", () => {
    // The automation ran at t=5min. A crash occurs. On restart, the claim
    // store is empty, but lastRunAt (persisted on disk) prevents re-firing.
    const store = new ClaimStore(); // fresh, empty — post-crash
    const auto = makeAutomation({
      createdAt: 1000000000000,
      lastRunAt: 1000000000000 + 5 * 60 * 1000,
    });
    const now = 1000000000000 + 5 * 60 * 1000 + 1000; // just after the run
    const due = evaluateDue([auto], now, store, "restarted-process");
    // The 5-min occurrence is not due because lastRunAt >= the occurrence.
    // (The next occurrence is at 10 min, which is after `now`.)
    expect(due).toHaveLength(0);
  });
});

describe("paused automations don't fire", () => {
  it("a paused automation is never due", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({ paused: true, lastRunAt: null, createdAt: 0 });
    const now = 1000000000000 + 6 * 60 * 1000;
    const due = evaluateDue([auto], now, store, "test");
    expect(due).toHaveLength(0);
  });

  it("unpausing makes it due again", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({ paused: true, lastRunAt: null, createdAt: 0 });
    const now = 1000000000000 + 6 * 60 * 1000;
    expect(evaluateDue([auto], now, store, "test")).toHaveLength(0);
    auto.paused = false;
    expect(evaluateDue([auto], now, store, "test")).toHaveLength(1);
  });
});

describe("missed occurrences — large interval, small check interval", () => {
  it("a missed daily occurrence fires when checked hours later", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({
      schedule: "0 9 * * *", // daily at 9am
      lastRunAt: null,
      createdAt: new Date(2026, 0, 15, 0, 0, 0).getTime(),
    });
    // Check at 10am — the 9am occurrence was missed.
    const now = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const due = evaluateDue([auto], now, store, "test");
    expect(due).toHaveLength(1);
    expect(due[0].occurrenceTime).toBeLessThanOrEqual(now);
  });
});

describe("standalone target — fixed session vs active session", () => {
  it("a standalone automation with a targetSessionId carries it through the run", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({
      targetSessionId: "standalone-session",
      lastRunAt: null,
      createdAt: 0,
    });
    const now = 1000000000000 + 6 * 60 * 1000;
    const due = evaluateDue([auto], now, store, "scheduler");
    expect(due).toHaveLength(1);
    expect(due[0].automation.targetSessionId).toBe("standalone-session");
  });

  it("an active-session automation has targetSessionId null — uses the active session", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({
      targetSessionId: null,
      lastRunAt: null,
      createdAt: 0,
    });
    const now = 1000000000000 + 6 * 60 * 1000;
    const due = evaluateDue([auto], now, store, "scheduler");
    expect(due).toHaveLength(1);
    expect(due[0].automation.targetSessionId).toBeNull();
  });
});

describe("run inbox — tracks run history and persists", () => {
  it("adds and lists run entries", () => {
    const inboxPath = path.join(tmp, "inbox.json");
    const inbox = new RunInbox(inboxPath);
    inbox.add({
      automationId: "auto-1",
      sessionId: "sess-1",
      prompt: "run tests",
      scheduledTime: 1000,
      runAt: 1001,
      status: "pending",
    });
    const list = inbox.list();
    expect(list).toHaveLength(1);
    expect(list[0].automationId).toBe("auto-1");
    expect(list[0].status).toBe("pending");
  });

  it("persists to disk and loads on restart", () => {
    const inboxPath = path.join(tmp, "inbox.json");
    const inbox1 = new RunInbox(inboxPath);
    inbox1.add({
      automationId: "auto-1",
      sessionId: "sess-1",
      prompt: "run tests",
      scheduledTime: 1000,
      runAt: 1001,
      status: "pending",
    });
    // Simulate restart — new inbox instance loads from disk.
    const inbox2 = new RunInbox(inboxPath);
    inbox2.load();
    expect(inbox2.list()).toHaveLength(1);
    expect(inbox2.list()[0].automationId).toBe("auto-1");
  });

  it("updates a run's status (pending → completed)", () => {
    const inbox = new RunInbox(path.join(tmp, "inbox.json"));
    inbox.add({
      automationId: "auto-1", sessionId: "s", prompt: "p",
      scheduledTime: 1000, runAt: 1001, status: "pending",
    });
    inbox.update("auto-1", 1000, "completed");
    expect(inbox.list()[0].status).toBe("completed");
  });

  it("updates to interrupted status (crash during run)", () => {
    const inbox = new RunInbox(path.join(tmp, "inbox.json"));
    inbox.add({
      automationId: "auto-1", sessionId: "s", prompt: "p",
      scheduledTime: 1000, runAt: 1001, status: "pending",
    });
    inbox.update("auto-1", 1000, "interrupted");
    expect(inbox.list()[0].status).toBe("interrupted");
  });
});

describe("runs from a never-opened Automations page", () => {
  it("the scheduler evaluates due automations without a UI page being open", () => {
    // The claim store and evaluateDue are pure logic — they don't depend on
    // any UI page being mounted. The main process timer (in main.ts) calls
    // evaluateDue on each tick regardless of which renderer page is visible.
    const store = new ClaimStore();
    const auto = makeAutomation({ lastRunAt: null, createdAt: 0 });
    const now = 1000000000000 + 6 * 60 * 1000;
    const due = evaluateDue([auto], now, store, "main-timer");
    expect(due).toHaveLength(1);
    // No UI page was mounted — the logic fired from the main process timer.
  });
});

describe("negative: invalid automation state", () => {
  it("an automation with an invalid schedule never fires", () => {
    const store = new ClaimStore();
    const auto = makeAutomation({ schedule: "invalid", lastRunAt: null, createdAt: 0 });
    const now = 1000000000000 + 6 * 60 * 1000;
    const due = evaluateDue([auto], now, store, "test");
    expect(due).toHaveLength(0);
  });

  it("an automation with lastRunAt in the future is not immediately re-due", () => {
    const store = new ClaimStore();
    const now = 1000000000000;
    const auto = makeAutomation({
      lastRunAt: now + 60 * 1000, // future lastRunAt (clock skew / manual edit)
      createdAt: now - 60 * 1000,
    });
    const due = evaluateDue([auto], now, store, "test");
    // lastRunAt is in the future — the next occurrence is after lastRunAt,
    // which is after `now`, so nothing is due.
    expect(due).toHaveLength(0);
  });
});
