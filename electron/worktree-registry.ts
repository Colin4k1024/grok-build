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

/** Clear the in-memory cache — for tests that change GROK_HOME between cases. */
export function clearRegistryCache(): void {
  _cache = null;
}

/**
 * Handoff a worktree from one session to another (R3-05).
 *
 * Transfers ownership atomically: the previous owner loses it, the new owner
 * gains it. Idempotent — handing off to the same session is a no-op. If the
 * worktree is orphaned (no owner), the new session claims it.
 *
 * Returns the updated worktree, or null if the path is not registered.
 */
export function handoffWorktree(wtPath: string, fromSessionId: string | null, toSessionId: string): ManagedWorktree | null {
  const reg = readRegistry();
  const wt = reg.worktrees.find((w) => w.path === wtPath);
  if (!wt) return null;
  // Idempotent: if the new owner already owns it, no-op.
  if (wt.ownerSessionId === toSessionId) {
    wt.lastAccessedAt = Date.now();
    writeRegistry(reg);
    return wt;
  }
  // If fromSessionId is specified and doesn't match, it's a stolen handoff —
  // we still allow it (the caller asserts authority) but log the mismatch.
  if (fromSessionId && wt.ownerSessionId && wt.ownerSessionId !== fromSessionId) {
    console.warn(`[worktree] handoff from ${fromSessionId} but owner is ${wt.ownerSessionId} — proceeding`);
  }
  wt.ownerSessionId = toSessionId;
  wt.lastAccessedAt = Date.now();
  writeRegistry(reg);
  return wt;
}

/**
 * Snapshot the dirty state of a worktree (uncommitted changes) using
 * `git stash create` (R3-05). The snapshot is a dangling commit SHA — it
 * does not touch any file or move any ref. The caller can restore it with
 * `restoreSnapshot` after a handoff or crash.
 *
 * Returns null if the tree is clean (nothing to snapshot).
 */
export async function snapshotWorktree(wtPath: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync("git", ["stash", "create"], {
      cwd: wtPath,
      maxBuffer: 4 * 1024 * 1024,
    });
    const sha = stdout.trim();
    // Register the snapshot in the worktree's notes.
    const reg = readRegistry();
    const wt = reg.worktrees.find((w) => w.path === wtPath);
    if (wt) {
      wt.notes = `snapshot:${sha}`;
      wt.lastAccessedAt = Date.now();
      writeRegistry(reg);
    }
    return sha || null;
  } catch {
    return null; // not a repo / git missing — degrade gracefully
  }
}

/**
 * Restore a snapshot (dangling commit from git stash create) into a worktree
 * (R3-05). This applies the snapshot's changes WITHOUT creating a stash entry.
 * Uses `git stash apply <sha>` which is non-destructive — the dangling commit
 * persists until GC, so the restore is retry-safe.
 *
 * Returns true if the restore succeeded, false if the snapshot is empty/invalid.
 */
export async function restoreSnapshot(wtPath: string, sha: string): Promise<boolean> {
  if (!sha) return false;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync("git", ["stash", "apply", sha], {
      cwd: wtPath,
      maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch {
    return false; // snapshot vanished or conflicts — caller handles
  }
}

/**
 * Rebuild the registry from `git worktree list` (R3-05 crash recovery).
 * Scans the actual git worktree state and reconciles with the registry:
 *   - worktrees in git but not in registry → adopted (ownerSessionId=null)
 *   - worktrees in registry but not in git → pruned (removed from registry)
 *
 * Returns the reconciled registry.
 */
export async function reconcileFromGit(repoRoot: string): Promise<WorktreeRegistry> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const reg = readRegistry();
  let gitPaths: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    gitPaths = stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim())
      .filter(Boolean);
  } catch {
    // not a repo — return as-is
    return reg;
  }
  // Prune registry entries whose paths are no longer in git.
  reg.worktrees = reg.worktrees.filter((w) => gitPaths.includes(w.path));
  // Adopt worktrees in git but not in registry (orphans from crash).
  // Skip the first entry — it's the main repo, not a managed worktree.
  for (let i = 1; i < gitPaths.length; i++) {
    const p = gitPaths[i];
    if (!reg.worktrees.find((w) => w.path === p)) {
      reg.worktrees.push({
        path: p,
        branch: "",
        repo: repoRoot,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        ownerSessionId: null, // orphaned — needs claiming
        notes: "adopted-from-git-reconcile",
      });
    }
  }
  writeRegistry(reg);
  return reg;
}