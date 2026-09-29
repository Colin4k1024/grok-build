/**
 * Session history reader — Electron port of src-tauri/src/commands/session.rs.
 *
 * The agent persists every conversation under ~/.grok/sessions/<encoded-cwd>/
 * <session-id>/ with summary.json as the index entry and chat_history.jsonl as
 * the raw model transcript (see crates/.../docs/user-guide/17-sessions.md).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
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
  /** False when the recorded cwd no longer exists on disk (R5-02). */
  workspace_exists: boolean;
}

/** One page of history (R5-02): cursor-paginated, stably sorted. */
export interface HistoryPage {
  items: HistorySession[];
  nextCursor: string | null;
  total: number;
}

export interface HistoryPageQuery {
  cursor?: string;
  limit?: number;
}

export const HISTORY_PAGE_DEFAULT_LIMIT = 100;
export const HISTORY_PAGE_MAX_LIMIT = 200;

/** Cursor = the last item's sort key, so pages stay stable while entries
 *  are added/renamed (an offset cursor would skip/duplicate rows). */
interface CursorPayload {
  u: number; // updated_at of the last item of the previous page
  i: string; // its id (tiebreak)
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    if (typeof parsed?.u !== "number" || !Number.isFinite(parsed.u)) throw new Error("bad u");
    if (typeof parsed?.i !== "string") throw new Error("bad i");
    return parsed as CursorPayload;
  } catch {
    throw new Error("session_list_history: invalid cursor");
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return HISTORY_PAGE_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("session_list_history: limit must be a number");
  }
  return Math.min(HISTORY_PAGE_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
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

/** Async sibling of `readJson`. A missing file is the normal case (a session
 *  dir with no summary yet), so only genuine parse/IO errors are logged. */
async function readJsonAsync(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[history] failed to read ${file}:`, e);
    }
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[history] failed to parse ${file}:`, e);
    return null;
  }
}

async function readDirSafe(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // missing root / unreadable dir == "no sessions here"
  }
}

/** Bounded concurrent map — a large history must not open thousands of file
 *  descriptors at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * List persisted threads, one cursor page at a time (R5-02).
 *
 * The full scan stays async + concurrency-bounded (the previous nested sync
 * loop blocked the main process), but only the returned page pays the
 * workspace_exists stat cost, and the IPC payload is bounded by `limit`
 * (default 100, max 200) instead of the whole history.
 *
 * Sort: updated_at DESC, id ASC (stable tiebreak). The cursor encodes the
 * last item's sort key; the next page is strictly after it — no duplicates
 * or skips while entries change between pages.
 */
export async function listHistorySessions(query: HistoryPageQuery = {}): Promise<HistoryPage> {
  const limit = clampLimit(query.limit);
  const after = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

  const root = sessionsRoot();
  const cwdDirs = (await readDirSafe(root))
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name));

  const perCwd = await mapLimit(cwdDirs, 16, async (cwdPath) => {
    const sessDirs = (await readDirSafe(cwdPath))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const rows = await mapLimit(sessDirs, 16, async (name) => {
      const raw = await readJsonAsync(path.join(cwdPath, name, "summary.json"));
      if (!raw) return null;
      const s = raw as SummaryJson;
      const id = s.info?.id ?? name;
      const lastActive = s.last_active_at ?? s.updated_at ?? "";
      return {
        id,
        session_id: id,
        title: s.generated_title || s.session_summary || "Untitled",
        cwd: s.info?.cwd ?? "",
        updated_at: Date.parse(lastActive) || 0,
        last_active_at: lastActive,
        model: s.current_model_id ?? "",
        num_messages: s.num_messages ?? 0,
        workspace_exists: false, // resolved for the returned page below
      } satisfies HistorySession;
    });
    return rows.filter((r): r is HistorySession => r !== null);
  });

  const all = perCwd.flat();
  all.sort((a, b) =>
    b.updated_at - a.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const total = all.length;

  const rest = after
    ? all.filter((s) => s.updated_at < after.u || (s.updated_at === after.u && s.id > after.i))
    : all;
  const items = rest.slice(0, limit);

  // Only the returned page pays the filesystem stat for workspace_exists.
  // Sessions without a cwd are a legitimate group of their own (not stale).
  await mapLimit(items, 16, async (s) => {
    s.workspace_exists = s.cwd === "" ? true : await dirExists(s.cwd);
  });

  const last = items[items.length - 1];
  const nextCursor = rest.length > limit && last
    ? encodeCursor({ u: last.updated_at, i: last.id })
    : null;
  return { items, nextCursor, total };
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

/** Session ids may only be plain path segments (uuid-like). Anything with a
 *  separator, drive letter, or traversal component is rejected BEFORE any
 *  path is built (R5-02: batch delete must never escape the sessions root). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Permanently delete a persisted thread from disk. Resolves the sessions
 * root via GROK_HOME (previously hardcoded to ~/.grok, which broke isolation
 * and deleted from the wrong root for GROK_HOME users).
 */
export function deleteHistorySession(sessionId: string): void {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error("session_delete_history: invalid sessionId");
  }
  const root = sessionsRoot();
  const candidates = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name, sessionId))
    : [];
  // Defense in depth: the resolved path must stay inside the root.
  const target = candidates.find((p) => {
    const resolved = path.resolve(p);
    return resolved.startsWith(path.resolve(root) + path.sep) && fs.existsSync(p);
  });
  if (!target) throw new Error(`No persisted session found for ${sessionId}`);
  fs.rmSync(target, { recursive: true, force: true });
}
