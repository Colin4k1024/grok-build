/**
 * Session history reader — Electron port of src-tauri/src/commands/session.rs.
 *
 * The agent persists every conversation under ~/.grok/sessions/<encoded-cwd>/
 * <session-id>/ with summary.json as the index entry and chat_history.jsonl as
 * the raw model transcript (see crates/.../docs/user-guide/17-sessions.md).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJournal } from "./journal";

/** Mirror the agent's GROK_HOME resolution ("Set GROK_HOME to override"). */
function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function sessionsRoot(): string {
  return path.join(grokHome(), "sessions");
}

export interface HistorySession {
  id: string;
  session_id: string;
  title: string;
  cwd: string;
  updated_at: number;
  last_active_at: string;
  model: string;
  num_messages: number;
}

export interface ChatHistoryEntry {
  role: string;
  content: string;
  timestamp: number;
}

interface SummaryJson {
  info?: { id?: string; cwd?: string };
  generated_title?: string;
  session_summary?: string;
  current_model_id?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  num_messages?: number;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch (e) {
    console.error(`[history] failed to read ${file}:`, e);
  }
  return null;
}

export function listHistorySessions(): HistorySession[] {
  if (!fs.existsSync(sessionsRoot())) return [];

  const out: HistorySession[] = [];
  for (const cwdEntry of fs.readdirSync(sessionsRoot(), { withFileTypes: true })) {
    if (!cwdEntry.isDirectory()) continue;
    const cwdPath = path.join(sessionsRoot(), cwdEntry.name);
    for (const sessEntry of fs.readdirSync(cwdPath, { withFileTypes: true })) {
      if (!sessEntry.isDirectory()) continue;
      const raw = readJson(path.join(cwdPath, sessEntry.name, "summary.json"));
      if (!raw) continue;
      const s = raw as SummaryJson;
      const id = s.info?.id ?? sessEntry.name;
      const lastActive = s.last_active_at ?? s.updated_at ?? "";
      out.push({
        id,
        session_id: id,
        title: s.generated_title || s.session_summary || "Untitled",
        cwd: s.info?.cwd ?? "",
        updated_at: Date.parse(lastActive) || 0,
        last_active_at: lastActive,
        model: s.current_model_id ?? "",
        num_messages: s.num_messages ?? 0,
      });
    }
  }

  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item && typeof item === "object" && "text" in (item as Record<string, unknown>)
          ? String((item as { text?: unknown }).text ?? "")
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  // Single content block, e.g. { type: "text", text: "..." }
  if (content && typeof content === "object" && "text" in (content as Record<string, unknown>)) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return "";
}

/** Rebuild the transcript from updates.jsonl — the authoritative ACP update
 *  stream (same source session/load replays), so the read-only fallback shows
 *  both sides of the conversation in order. */
function historyFromUpdates(file: string): ChatHistoryEntry[] | null {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const entries: ChatHistoryEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: {
      params?: { update?: { sessionUpdate?: string; content?: unknown } };
      timestamp?: number;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const update = parsed.params?.update;
    const kind = update?.sessionUpdate;
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const text = extractText(update?.content);
      if (text) {
        entries.push({
          role: kind === "user_message_chunk" ? "user" : "assistant",
          content: text,
          timestamp: parsed.timestamp ?? 0,
        });
      }
    }
  }
  return entries;
}

function historyFromChatHistory(file: string): ChatHistoryEntry[] {
  const content = fs.readFileSync(file, "utf-8");
  const entries: ChatHistoryEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { type?: string; content?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // Only show user and assistant messages (skip system prompts).
    if (parsed.type === "system" || !parsed.type) continue;
    entries.push({
      role: parsed.type,
      content: extractText(parsed.content),
      timestamp: 0,
    });
  }
  return entries;
}

export function getSessionHistory(sessionId: string, cwd: string): ChatHistoryEntry[] {
  // Our own live-stream journal first: it is the only source that records
  // assistant replies (the agent core's persistence never writes them, so
  // threads that predate the journal open empty or user-side-only).
  const journaled = readJournal(sessionId);
  if (journaled.length > 0) return journaled;

  const dirHit = findSessionDir(sessionId, cwd);
  if (!dirHit) throw new Error(`No history found for session ${sessionId}`);

  // Agent-core streams next. An EMPTY updates.jsonl result must fall through
  // to chat_history.jsonl — `[]` is not nullish, so `??` never did.
  const fromUpdates = historyFromUpdates(path.join(dirHit, "updates.jsonl"));
  if (fromUpdates && fromUpdates.length > 0) return fromUpdates;
  return historyFromChatHistory(path.join(dirHit, "chat_history.jsonl"));
}

/** Locate a persisted session dir: encoded cwd first, then a group scan. */
function findSessionDir(sessionId: string, cwd: string): string | null {
  const encoded = encodeURIComponent(cwd);
  const inCwd = (name: string) => path.join(sessionsRoot(), encoded, sessionId, name);
  if (fs.existsSync(inCwd("summary.json"))) {
    return path.join(sessionsRoot(), encoded, sessionId);
  }
  // A missing sessions root must fail with the clean business error, not a
  // raw ENOENT from readdirSync (ISS-075 test round: #164).
  if (!fs.existsSync(sessionsRoot())) return null;
  return (
    fs
      .readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(sessionsRoot(), d.name, sessionId))
      .find((p) => fs.existsSync(path.join(p, "summary.json"))) ?? null
  );
}

const MAX_TITLE_LEN = 200;

/** Sanitize a user-supplied thread title (shared rename rules). */
export function sanitizeTitle(title: string): string {
  const cleaned = (title ?? "")
    // strip control chars
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LEN);
  return cleaned;
}

/**
 * Persist a thread rename into its summary.json (ISS-079). Atomic
 * tmp+rename; the transcript on disk is never touched. Last write wins —
 * concurrent renames converge on whichever write lands last, and readers
 * re-read the file, so UI and disk agree after refresh.
 */
export function renameHistorySession(sessionId: string, cwd: string, title: string): string {
  const dirHit = findSessionDir(sessionId, cwd);
  if (!dirHit) throw new Error(`No history found for session ${sessionId}`);
  const clean = sanitizeTitle(title);
  if (!clean) throw new Error("rename requires a non-empty title");

  const summaryPath = path.join(dirHit, "summary.json");
  const raw = readJson(summaryPath);
  if (!raw) throw new Error(`summary.json unreadable for session ${sessionId}`);

  const next = { ...(raw as Record<string, unknown>), generated_title: clean };
  const tmp = path.join(dirHit, ".summary.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, summaryPath);
  return clean;
}
