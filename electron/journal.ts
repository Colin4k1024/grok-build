/**
 * Client-side transcript journal.
 *
 * The agent core's own persistence never records assistant replies: its
 * updates.jsonl carries user chunks plus lifecycle noise (hooks, retries),
 * and the session/load replay only replays what the core still has — so a
 * resumed thread opened empty or user-side-only. The journal records the
 * live ACP stream as it flows through the main process so every future
 * resume can rebuild the full transcript.
 *
 * Storage: <journalRoot>/transcripts/<acpSessionId>.jsonl, one JSON line per
 * event — { t, kind: "user" | "assistant" | "turn_end", text }. It lives in
 * the app's own data dir, never inside ~/.grok (the agent owns that tree).
 * Only live events are journaled; replayed history was journaled by the
 * original turn.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type JournalKind = "user" | "assistant" | "turn_end";

export interface JournalEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

function journalRoot(): string {
  if (process.env.GB_JOURNAL_DIR) return process.env.GB_JOURNAL_DIR;
  try {
    // Lazy require: this module is also imported by node-env tests where
    // "electron" resolves to its install path, not the runtime API.
    const electron = require("electron") as { app?: { getPath: (n: string) => string } };
    const dir = electron.app?.getPath("userData");
    if (dir) return path.join(dir, "transcripts");
  } catch {
    /* fall through to the neutral default */
  }
  return path.join(os.homedir(), ".grok-build", "transcripts");
}

/** Same id policy as transcript-store: opaque id chars only, no traversal. */
function journalFile(acpSessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(acpSessionId)) {
    throw new Error("journal: invalid session id");
  }
  const root = path.resolve(journalRoot());
  const file = path.join(root, `${acpSessionId}.jsonl`);
  if (!file.startsWith(root + path.sep)) {
    throw new Error("journal: path escaped the transcripts root");
  }
  return file;
}

/** mkdir is idempotent but still a syscall — do it once per directory. */
const ensuredDirs = new Set<string>();
function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (ensuredDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

function entry(kind: JournalKind, text: string): string {
  return `${JSON.stringify({ t: Date.now(), kind, text })}\n`;
}

// ---- Buffered write path ----------------------------------------------------
//
// Assistant text arrives as one ACP TextDelta per token — tens to hundreds per
// second. Journaling each with mkdirSync + appendFileSync blocked the Electron
// main process (which also serves every renderer IPC) with 2-3 synchronous
// syscalls per delta, so the whole app stalled behind the stream. Deltas are
// coalesced in memory and written with ONE async append per flush tick.

const FLUSH_INTERVAL_MS = 250;

interface Pending {
  file: string;
  lines: string[];
}

const pending = new Map<string, Pending>();
/** Per-session write chain — appends for one file must stay ordered. */
const writeChain = new Map<string, Promise<void>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueWrite(id: string, file: string, payload: string): Promise<void> {
  const prev = writeChain.get(id) ?? Promise.resolve();
  const next = prev
    .then(() => fs.promises.appendFile(file, payload, "utf-8"))
    .then(() => undefined)
    .catch(() => {
      /* journaling is best-effort — never reject into the stream path */
    });
  writeChain.set(id, next);
  return next;
}

/** Queue a live-stream event for the next batched flush. Validates eagerly so
 *  callers see the same contract as `appendJournal`. */
export function queueJournal(acpSessionId: string, kind: JournalKind, text: string): void {
  const file = journalFile(acpSessionId); // throws on traversal / invalid id
  let p = pending.get(acpSessionId);
  if (!p) {
    p = { file, lines: [] };
    pending.set(acpSessionId, p);
  }
  p.lines.push(entry(kind, text));
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushAllJournals();
    }, FLUSH_INTERVAL_MS);
    // Never hold the event loop open just to journal.
    flushTimer.unref?.();
  }
}

/** Flush one session's buffered lines. Resolves once they are on disk. */
export function flushJournal(acpSessionId: string): Promise<void> {
  const p = pending.get(acpSessionId);
  if (!p || p.lines.length === 0) {
    pending.delete(acpSessionId);
    return writeChain.get(acpSessionId) ?? Promise.resolve();
  }
  pending.delete(acpSessionId);
  ensureDir(p.file);
  return enqueueWrite(acpSessionId, p.file, p.lines.join(""));
}

/** Flush every session's buffered lines — call on app quit. */
export function flushAllJournals(): Promise<void> {
  const ids = [...pending.keys()];
  return Promise.all(ids.map((id) => flushJournal(id))).then(() => undefined);
}

/** Blocking flush for the quit path, where there is no later tick to await.
 *  One write per dirty session, once per app lifetime. */
export function flushAllJournalsSync(): void {
  for (const id of [...pending.keys()]) {
    try {
      drainSync(id);
    } catch {
      /* best-effort */
    }
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/** Synchronously drain one session's buffer so an immediate write stays
 *  ordered after the deltas that preceded it. */
function drainSync(acpSessionId: string): void {
  const p = pending.get(acpSessionId);
  if (!p || p.lines.length === 0) {
    pending.delete(acpSessionId);
    return;
  }
  pending.delete(acpSessionId);
  ensureDir(p.file);
  fs.appendFileSync(p.file, p.lines.join(""), "utf-8");
}

/** Append one live-stream event immediately. Never throws to callers that
 *  wrap it. Buffered deltas for the same session are drained first so line
 *  order matches arrival order. */
export function appendJournal(acpSessionId: string, kind: JournalKind, text: string): void {
  const file = journalFile(acpSessionId);
  drainSync(acpSessionId);
  ensureDir(file);
  fs.appendFileSync(file, entry(kind, text), "utf-8");
}

/**
 * Rebuild the transcript from the journal: consecutive assistant lines merge
 * into one message; a turn_end or the next user line closes the current
 * assistant message (one assistant reply per turn). Lenient on unknown ids
 * and corrupted lines — callers treat the journal as best-effort history.
 */
export function readJournal(acpSessionId: string): JournalEntry[] {
  let raw: string;
  try {
    const file = journalFile(acpSessionId);
    // Buffered deltas must be on disk before we read, or a resume that races
    // the live stream silently loses the tail of the transcript.
    drainSync(acpSessionId);
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  // True when the current assistant message is closed: the next assistant
  // line opens a new reply instead of merging into the previous one.
  let assistantClosed = true;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { t?: number; kind?: string; text?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = parsed.kind;
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (kind === "user" && text) {
      entries.push({ role: "user", content: text, timestamp: parsed.t ?? 0 });
      assistantClosed = true;
    } else if (kind === "assistant" && text) {
      const last = entries[entries.length - 1];
      if (!assistantClosed && last && last.role === "assistant") {
        last.content += text;
      } else {
        entries.push({ role: "assistant", content: text, timestamp: parsed.t ?? 0 });
        assistantClosed = false;
      }
    } else if (kind === "turn_end") {
      assistantClosed = true;
    }
  }
  return entries;
}
