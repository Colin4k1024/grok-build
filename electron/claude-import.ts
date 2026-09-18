/**
 * Selective import from Claude Code data (ISS-083, codex /import parity).
 *
 * The source tree is READ-ONLY throughout. Everything that would write
 * (session import markers, instruction merges) is gated behind the
 * caller's preview-and-confirm step; this module just reports what's
 * available, parses defensively, and records what was imported so repeats
 * are idempotent.
 *
 * Source layout probed:
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl   (transcripts)
 *   ~/.claude/CLAUDE.md                                     (instructions)
 *   ~/.claude/commands/*.md, ~/.claude/agents/*.md          (docs)
 *
 * Import registry: ~/.grok/imports/claude.json — marks sessions already
 * imported (idempotency) and per-project instruction merges.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function claudeHome(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function registryPath(): string {
  return path.join(grokHome(), "imports", "claude.json");
}

interface ImportRegistry {
  sessions: string[];
  instructionsMerged: string[];
}

function readRegistry(): ImportRegistry {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), "utf-8")) as Partial<ImportRegistry>;
    return {
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      instructionsMerged: Array.isArray(raw.instructionsMerged) ? raw.instructionsMerged : [],
    };
  } catch {
    return { sessions: [], instructionsMerged: [] };
  }
}

function writeRegistry(reg: ImportRegistry): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(reg, null, 2));
}

/** Session ids come from our own directory listings; anything that isn't a
 *  plain filename token is rejected before it reaches a path join. */
function isValidSourceId(sourceId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceId) && !sourceId.includes("..");
}

// ---- probe --------------------------------------------------------------------

export interface ClaudeProbe {
  available: boolean;
  root: string;
  sessions: number;
  projects: number;
  hasInstructions: boolean;
  docs: number;
}

export function probeClaudeSources(): ClaudeProbe {
  const root = claudeHome();
  const projectsDir = path.join(root, "projects");
  let sessions = 0;
  let projects = 0;
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      projects += 1;
      const dir = path.join(projectsDir, entry.name);
      sessions += fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl")).length;
    }
  }
  const docsDirs = [path.join(root, "commands"), path.join(root, "agents")];
  let docs = 0;
  for (const d of docsDirs) {
    if (fs.existsSync(d)) docs += fs.readdirSync(d).filter((f) => f.endsWith(".md")).length;
  }
  return {
    available: fs.existsSync(root),
    root,
    sessions,
    projects,
    hasInstructions: fs.existsSync(path.join(root, "CLAUDE.md")),
    docs,
  };
}

// ---- session listing / parsing -------------------------------------------------

export interface ClaudeSessionInfo {
  sourceId: string;
  cwd: string;
  title: string;
  mtime: number;
  size: number;
  /** True when this source already has an imported destination — the UI
   *  must not offer a second import (idempotency, review round 2). */
  imported: boolean;
}

/** Decode a claude projects dir name ("-Users-x-work" → "/Users/x/work"). */
function decodeCwd(dirName: string): string {
  return dirName.replace(/-/g, "/");
}

export function listClaudeSessions(limit = 50): ClaudeSessionInfo[] {
  const projectsDir = path.join(claudeHome(), "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const importedSet = new Set(readRegistry().sessions);
  const out: ClaudeSessionInfo[] = [];
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cwd = decodeCwd(entry.name);
    const dir = path.join(projectsDir, entry.name);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const sourceId = file.replace(/\.jsonl$/, "");
      if (!isValidSourceId(sourceId)) continue;
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        out.push({
          sourceId,
          cwd,
          title: `${cwd.split("/").filter(Boolean).pop() ?? cwd} · ${sourceId.slice(0, 8)}`,
          mtime: st.mtimeMs,
          size: st.size,
          imported: importedSet.has(sourceId),
        });
      } catch {
        // stat failed — skip
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

export interface ImportedEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ParseReport {
  entries: ImportedEntry[];
  skippedLines: number;
}

/** Defensive JSONL parse: corrupted lines are skipped and reported, never
 *  fatal (partial import + explicit report per ISS-083). */
export function parseClaudeSession(sourceId: string): ParseReport & { error?: string } {
  if (!isValidSourceId(sourceId)) {
    return { entries: [], skippedLines: 0, error: "invalid session id" };
  }
  const projectsDir = path.join(claudeHome(), "projects");
  if (!fs.existsSync(projectsDir)) return { entries: [], skippedLines: 0, error: "no claude projects dir" };
  let file: string | null = null;
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, `${sourceId}.jsonl`);
    if (fs.existsSync(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) return { entries: [], skippedLines: 0, error: `session ${sourceId} not found` };

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    return { entries: [], skippedLines: 0, error: `unreadable: ${(e as Error).message}` };
  }

  const entries: ImportedEntry[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const type = parsed.type as string | undefined;
    if (type !== "user" && type !== "assistant") continue;
    const message = parsed.message as { content?: unknown } | undefined;
    const content = extractText(message?.content);
    if (!content) continue;
    entries.push({
      role: type,
      content,
      timestamp: typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) || 0 : 0,
    });
  }
  return { entries, skippedLines: skipped };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in (c as Record<string, unknown>)
          ? String((c as { text?: unknown }).text ?? "")
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && "text" in (content as Record<string, unknown>)) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return "";
}

// ---- import bookkeeping ---------------------------------------------------------

export type ImportOutcome =
  | { status: "imported"; entries: ImportedEntry[]; skippedLines: number }
  | { status: "already-imported" }
  | { status: "conflict" }
  | { status: "error"; message: string };

/**
 * Peek at a session WITHOUT registering it (preview step): lets the caller
 * create the destination thread first and only mark the import on success —
 * a failed thread creation stays retryable (review P1).
 */
export function peekClaudeSession(sourceId: string): ParseReport & { error?: string } {
  return parseClaudeSession(sourceId);
}

/** Mark a source id as imported (call only after the destination exists). */
export function markClaudeImported(sourceId: string): void {
  if (!isValidSourceId(sourceId)) throw new Error("invalid session id");
  const reg = readRegistry();
  if (!reg.sessions.includes(sourceId)) {
    reg.sessions.push(sourceId);
    writeRegistry(reg);
  }
}

/**
 * Idempotent session import: parses the source (read-only), registers the
 * sourceId, and returns the transcript for the caller to seed a new thread.
 * Repeats return already-imported; a collision with a live grok session id
 * is reported as a conflict.
 */
export function importClaudeSession(
  sourceId: string,
  opts: { existingGrokSessionIds?: string[] } = {}
): ImportOutcome {
  const reg = readRegistry();
  if (reg.sessions.includes(sourceId)) return { status: "already-imported" };
  // Conflict: the would-be destination id already exists as a live session.
  if ((opts.existingGrokSessionIds ?? []).includes(sourceId)) return { status: "conflict" };

  const parsed = parseClaudeSession(sourceId);
  if (parsed.error) return { status: "error", message: parsed.error };
  if (parsed.entries.length === 0) {
    return { status: "error", message: "no importable messages (corrupted or empty source)" };
  }
  reg.sessions.push(sourceId);
  writeRegistry(reg);
  return { status: "imported", entries: parsed.entries, skippedLines: parsed.skippedLines };
}

/**
 * Merge ~/.claude/CLAUDE.md into a project's AGENTS.md under a marked
 * section. The target FILENAME is fixed (AGENTS.md) — only the project root
 * varies — and the merge is idempotent per project root. The caller must
 * have shown the preview and collected confirmation: this is the ONLY
 * write path in the module.
 */
export function importClaudeInstructions(projectRoot: string): { status: "merged" | "already" | "error"; message?: string } {
  const source = path.join(claudeHome(), "CLAUDE.md");
  let body: string;
  try {
    body = fs.readFileSync(source, "utf-8");
  } catch (e) {
    return { status: "error", message: `CLAUDE.md unreadable: ${(e as Error).message}` };
  }
  const absTarget = path.join(path.resolve(projectRoot), "AGENTS.md");
  const reg = readRegistry();
  if (reg.instructionsMerged.includes(absTarget)) return { status: "already" };

  const marker = "<!-- imported from ~/.claude/CLAUDE.md -->";
  let existing = "";
  try {
    existing = fs.readFileSync(absTarget, "utf-8");
  } catch {
    // no AGENTS.md yet — create
  }
  if (existing.includes(marker)) {
    reg.instructionsMerged.push(absTarget);
    writeRegistry(reg);
    return { status: "already" };
  }
  const next = `${existing.trimEnd()}\n\n${marker}\n${body.trim()}\n`;
  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  fs.writeFileSync(absTarget, next);
  reg.instructionsMerged.push(absTarget);
  writeRegistry(reg);
  return { status: "merged" };
}
