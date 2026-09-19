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

/** Append one live-stream event. Never throws to callers that wrap it. */
export function appendJournal(acpSessionId: string, kind: JournalKind, text: string): void {
  const file = journalFile(acpSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), kind, text })}\n`, "utf-8");
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
    raw = fs.readFileSync(journalFile(acpSessionId), "utf-8");
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
