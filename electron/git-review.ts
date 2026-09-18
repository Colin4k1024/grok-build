/**
 * Review-workflow git primitives (ISS-080). All read-only against the
 * worktree except the documented snapshot call:
 *
 *   - turnSnapshot: `git stash create` — builds a dangling commit of the
 *     current worktree WITHOUT touching any file or moving any ref. It is
 *     the turn base for "changes since this turn started" diffs.
 *   - diffSince: worktree diff against a snapshot (or HEAD when null).
 *   - conflictedFiles: files in an unresolved merge-conflict state.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MAX_DIFF = 4 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: path.resolve(cwd),
    maxBuffer: MAX_DIFF,
  });
  return stdout;
}

/** git diff --no-index exits 1 when files differ — stdout is still the diff. */
async function gitTolerant(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    return typeof out === "string" ? out : "";
  }
}

/** Dangling snapshot commit of the worktree; null when the tree is clean. */
export async function turnSnapshot(cwd: string): Promise<string | null> {
  try {
    const sha = (await git(cwd, ["stash", "create"])).trim();
    return sha || null;
  } catch {
    return null; // not a repo / git missing — degrade to HEAD-based diffs
  }
}

/** Worktree diff vs a snapshot sha (null → HEAD), untracked files included. */
export async function diffSince(cwd: string, sha: string | null): Promise<string> {
  const base = sha ?? "HEAD";
  const parts: string[] = [];
  try {
    parts.push(await git(cwd, ["diff", base, "--"]));
  } catch {
    // vanished snapshot or not-a-repo → fall through to untracked-only
  }
  try {
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 100);
    for (const f of untracked) {
      const d = await gitTolerant(cwd, ["diff", "--no-index", "--", "/dev/null", f]);
      if (d) parts.push(d);
    }
  } catch {
    /* untracked listing failed — tracked diff still returned */
  }
  return parts.filter(Boolean).join("\n");
}

/** Files with unresolved merge conflicts (empty when none). */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
