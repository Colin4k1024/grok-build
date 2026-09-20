/**
 * Managed worktree registry (R3-05).
 *
 * The existing git worktree wrappers are thin CLI pass-throughs — no
 * directory management, handoff, or recovery. This registry persists
 * a catalog of managed worktrees so the app can:
 *
 * 1. Track which worktrees belong to this app (avoid clobbering manual ones)
 * 2. Recover orphaned worktrees after a crash or unclean shutdown
 * 3. Clean up stale worktrees with a prune command
 * 4. Handoff a worktree from one session to another (later: IPC-based)
 *
 * Stored as JSON at `~/.grok/worktrees.json` — the same directory the
 * backend already uses for config and API keys.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ManagedWorktree {
  /** Absolute path to the worktree root on disk. */
  path: string;
  /** Branch name (e.g. "feat/my-change"). */
  branch: string;
  /** Parent repository root. */
  repo: string;
  /** When this worktree was created (epoch ms). */
  createdAt: number;
  /** When this worktree was last accessed for review (epoch ms). */
  lastAccessedAt: number;
  /** Session ID that owns this worktree (null if orphaned). */
  ownerSessionId: string | null;
  /** Arbitrary metadata (e.g. PR URL, review notes). */
  notes?: string;
}

export interface WorktreeRegistry {
  worktrees: ManagedWorktree[];
  /** Version number — incremented on schema changes. */
  version: number;
}

function registryPath(): string {
  return process.env.GROK_HOME
    ? path.join(process.env.GROK_HOME, "worktrees.json")
    : path.join(os.homedir(), ".grok", "worktrees.json");
}

let _cache: WorktreeRegistry | null = null;

export function readRegistry(): WorktreeRegistry {
  if (_cache) return _cache;
  const p = registryPath();
  try {
    if (fs.existsSync(p)) {
      _cache = JSON.parse(fs.readFileSync(p, "utf-8")) as WorktreeRegistry;
      return _cache!;
    }
  } catch { /* missing or corrupt — start fresh */ }
  _cache = { worktrees: [], version: 1 };
  return _cache;
}

function writeRegistry(reg: WorktreeRegistry): void {
  const p = registryPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.worktrees.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  _cache = reg;
}

/** Register a worktree created via git worktree add. */
export function registerWorktree(wt: Omit<ManagedWorktree, "lastAccessedAt">): ManagedWorktree {
  const reg = readRegistry();
  const existing = reg.worktrees.find((w) => w.path === wt.path);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    existing.ownerSessionId = wt.ownerSessionId ?? existing.ownerSessionId;
    writeRegistry(reg);
    return existing;
  }
  const entry: ManagedWorktree = { ...wt, lastAccessedAt: Date.now() };
  reg.worktrees.push(entry);
  writeRegistry(reg);
  return entry;
}

/** Unregister a worktree (called after git worktree remove). */
export function unregisterWorktree(wtPath: string): void {
  const reg = readRegistry();
  reg.worktrees = reg.worktrees.filter((w) => w.path !== wtPath);
  writeRegistry(reg);
}

/** Touch access time (called when opening a worktree for review). */
export function touchWorktree(wtPath: string): void {
  const reg = readRegistry();
  const wt = reg.worktrees.find((w) => w.path === wtPath);
  if (wt) {
    wt.lastAccessedAt = Date.now();
    writeRegistry(reg);
  }
}

/** List orphaned worktrees (no owning session, likely from a crash). */
export function listOrphans(): ManagedWorktree[] {
  return readRegistry().worktrees.filter((w) => !w.ownerSessionId);
}

/** Prune orphaned worktrees — remove from registry WITHOUT deleting on disk.
 *  Caller should run `git worktree remove` separately. */
export function pruneOrphans(): string[] {
  const reg = readRegistry();
  const orphans = reg.worktrees.filter((w) => !w.ownerSessionId);
  reg.worktrees = reg.worktrees.filter((w) => !!w.ownerSessionId);
  writeRegistry(reg);
  return orphans.map((w) => w.path);
}

/** Get the total count of managed worktrees. */
export function worktreeCount(): number {
  return readRegistry().worktrees.length;
}