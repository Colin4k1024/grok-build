// @vitest-environment node
/**
 * Managed worktree integration tests (R3-05 / #190).
 *
 * These tests prove the managed worktree registry really handles:
 *   - Creating managed worktrees from HEAD/branch/dirty working tree
 *   - Local↔Worktree handoff (ownership transfer)
 *   - Snapshot/restore of uncommitted changes (byte-for-byte preservation)
 *   - Ownership/orphan detection (real owner not orphaned; cleanup preserves branches)
 *   - Concurrent creation (locking/idempotency)
 *   - Crash recovery (half-created state identifiable; reconcileFromGit)
 *
 * Real side effects: real `git worktree add`, real `git stash create/apply`,
 * real file reads/writes. No mocks of the git operations the issue requires.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readRegistry,
  registerWorktree,
  unregisterWorktree,
  handoffWorktree,
  snapshotWorktree,
  restoreSnapshot,
  listOrphans,
  pruneOrphans,
  reconcileFromGit,
  worktreeCount,
  clearRegistryCache,
  type ManagedWorktree,
} from "../worktree-registry";

const execFileAsync = promisify(execFile);

let tmp = "";
let repo = "";
let savedGrokHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-wt-190-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "pipe" });
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "pipe" });
  // Point GROK_HOME at tmp so the registry file lands there, not ~/.grok.
  savedGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = tmp;
  // Clear the in-memory cache so each test reads from disk.
  clearRegistryCache();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
  clearRegistryCache();
});

/** Create a real git worktree + register it in the managed registry.
 *  If the branch already exists, checks it out (no -b flag). */
async function createManagedWorktree(
  repoRoot: string,
  branch: string,
  wtPath: string,
  ownerSessionId: string | null,
  branchExists = false
): Promise<ManagedWorktree> {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const argv = branchExists
    ? ["worktree", "add", wtPath, branch] // checkout existing branch
    : ["worktree", "add", "-b", branch, wtPath]; // create new branch
  await execFileAsync("git", argv, { cwd: repoRoot });
  return registerWorktree({
    path: wtPath,
    branch,
    repo: repoRoot,
    createdAt: Date.now(),
    ownerSessionId,
  });
}

function gitWorktreeList(cwd: string): string {
  return execFileSync("git", ["worktree", "list"], { cwd }).toString();
}

describe("managed worktree creation (R3-05 #190)", () => {
  it("creates a managed worktree from HEAD and registers it", async () => {
    const wt = path.join(tmp, "wt-head");
    const entry = await createManagedWorktree(repo, "feature-a", wt, "sess-1");
    expect(entry.path).toBe(wt);
    expect(entry.branch).toBe("feature-a");
    expect(entry.ownerSessionId).toBe("sess-1");
    // The worktree really exists on disk.
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);
    // The registry tracks it.
    expect(worktreeCount()).toBe(1);
    // git worktree list shows it.
    expect(gitWorktreeList(repo)).toContain(wt);
  });

  it("creates from an existing branch (not just new branches)", async () => {
    // Create a branch first
    execFileSync("git", ["branch", "existing-branch"], { cwd: repo, stdio: "pipe" });
    const wt = path.join(tmp, "wt-existing");
    await createManagedWorktree(repo, "existing-branch", wt, "sess-2", true);
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);
    expect(gitWorktreeList(repo)).toContain(wt);
  });

  it("creating from a dirty working tree preserves uncommitted changes", async () => {
    // Make the main repo dirty
    fs.writeFileSync(path.join(repo, "uncommitted.txt"), "dirty work\n");
    // Create a worktree — the dirty changes stay in the main repo, not the worktree
    const wt = path.join(tmp, "wt-dirty");
    await createManagedWorktree(repo, "feature-dirty", wt, "sess-3");
    // The worktree is a clean checkout (no uncommitted.txt)
    expect(fs.existsSync(path.join(wt, "uncommitted.txt"))).toBe(false);
    // The main repo is still dirty — no silent loss
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
    expect(status).toContain("uncommitted.txt");
  });
});

describe("Local↔Worktree handoff (R3-05 #190)", () => {
  it("handoff transfers ownership from one session to another", async () => {
    const wt = path.join(tmp, "wt-handoff");
    await createManagedWorktree(repo, "feature-handoff", wt, "sess-a");
    expect(readRegistry().worktrees[0].ownerSessionId).toBe("sess-a");

    const updated = handoffWorktree(wt, "sess-a", "sess-b");
    expect(updated?.ownerSessionId).toBe("sess-b");
    expect(readRegistry().worktrees[0].ownerSessionId).toBe("sess-b");
  });

  it("handoff is idempotent — handing off to the same session is a no-op", async () => {
    const wt = path.join(tmp, "wt-idem");
    await createManagedWorktree(repo, "feature-idem", wt, "sess-x");
    const result = handoffWorktree(wt, "sess-x", "sess-x");
    expect(result?.ownerSessionId).toBe("sess-x");
    // Registry unchanged.
    expect(worktreeCount()).toBe(1);
  });

  it("handoff of an orphaned worktree — new session claims it", async () => {
    const wt = path.join(tmp, "wt-orphan-handoff");
    await createManagedWorktree(repo, "feature-orphan", wt, null);
    expect(readRegistry().worktrees[0].ownerSessionId).toBeNull();

    const result = handoffWorktree(wt, null, "sess-claimer");
    expect(result?.ownerSessionId).toBe("sess-claimer");
  });

  it("handoff of an unregistered path returns null — no phantom entry", () => {
    const result = handoffWorktree("/nonexistent/path", "sess-a", "sess-b");
    expect(result).toBeNull();
  });
});

describe("snapshot/restore — uncommitted changes preserved byte-for-byte (R3-05 #190)", () => {
  it("snapshot captures dirty state and restore brings it back", async () => {
    const wt = path.join(tmp, "wt-snap");
    await createManagedWorktree(repo, "feature-snap", wt, "sess-snap");
    // Make the worktree dirty — only modify TRACKED files (git stash create
    // only captures tracked changes; untracked files are not in the snapshot).
    fs.writeFileSync(path.join(wt, "README.md"), "modified content\n");

    // Snapshot
    const sha = await snapshotWorktree(wt);
    expect(sha).toBeTruthy();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // Clean the worktree (simulate handoff or crash)
    execFileSync("git", ["checkout", "--", "."], { cwd: wt, stdio: "pipe" });
    // Verify clean
    expect(fs.readFileSync(path.join(wt, "README.md"), "utf-8")).toBe("init\n");

    // Restore
    const restored = await restoreSnapshot(wt, sha!);
    expect(restored).toBe(true);
    // Byte-for-byte: the tracked file is back with the exact content
    expect(fs.readFileSync(path.join(wt, "README.md"), "utf-8")).toBe("modified content\n");
  });

  it("snapshot of a clean tree returns null — nothing to preserve", async () => {
    const wt = path.join(tmp, "wt-clean-snap");
    await createManagedWorktree(repo, "feature-clean-snap", wt, "sess-clean");
    const sha = await snapshotWorktree(wt);
    expect(sha).toBeNull();
  });

  it("restore of an invalid/empty SHA returns false", async () => {
    const wt = path.join(tmp, "wt-restore-fail");
    await createManagedWorktree(repo, "feature-restore", wt, "sess-rf");
    expect(await restoreSnapshot(wt, "")).toBe(false);
    expect(await restoreSnapshot(wt, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(false);
  });
});

describe("ownership/orphan detection (R3-05 #190)", () => {
  it("a worktree with an owner is NOT an orphan", async () => {
    const wt = path.join(tmp, "wt-owned");
    await createManagedWorktree(repo, "feature-owned", wt, "sess-owner");
    expect(listOrphans()).toHaveLength(0);
  });

  it("an ownerless worktree IS an orphan", async () => {
    const wt = path.join(tmp, "wt-orphan");
    await createManagedWorktree(repo, "feature-orphan", wt, null);
    const orphans = listOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0].path).toBe(wt);
  });

  it("prune removes orphans from the registry but does NOT delete the branch on disk", async () => {
    const wt = path.join(tmp, "wt-prune");
    await createManagedWorktree(repo, "feature-prune", wt, null);
    expect(listOrphans()).toHaveLength(1);

    const pruned = pruneOrphans();
    expect(pruned).toContain(wt);
    expect(listOrphans()).toHaveLength(0);
    // The branch still exists on disk — prune only removes from the registry.
    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo }).toString();
    expect(branches).toContain("feature-prune");
    // The worktree directory still exists — cleanup is the caller's job.
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("unregister removes a worktree from the registry", async () => {
    const wt = path.join(tmp, "wt-unreg");
    await createManagedWorktree(repo, "feature-unreg", wt, "sess-u");
    expect(worktreeCount()).toBe(1);
    unregisterWorktree(wt);
    expect(worktreeCount()).toBe(0);
  });
});

describe("concurrent creation — idempotency and no double-registration (R3-05 #190)", () => {
  it("registering the same path twice does not create two entries", async () => {
    const wt = path.join(tmp, "wt-conc");
    await createManagedWorktree(repo, "feature-conc", wt, "sess-c1");
    // Second registration (simulating a concurrent caller)
    const entry2 = registerWorktree({
      path: wt,
      branch: "feature-conc",
      repo,
      createdAt: Date.now(),
      ownerSessionId: "sess-c2",
    });
    expect(worktreeCount()).toBe(1);
    // The second registration updates the owner.
    expect(entry2.ownerSessionId).toBe("sess-c2");
  });

  it("two concurrent worktree adds with different paths both succeed", async () => {
    const wt1 = path.join(tmp, "wt-conc-1");
    const wt2 = path.join(tmp, "wt-conc-2");
    await Promise.all([
      createManagedWorktree(repo, "branch-1", wt1, "sess-a"),
      createManagedWorktree(repo, "branch-2", wt2, "sess-b"),
    ]);
    expect(worktreeCount()).toBe(2);
    expect(fs.existsSync(wt1)).toBe(true);
    expect(fs.existsSync(wt2)).toBe(true);
  });

  it("same-name branch for two worktrees — second fails, no phantom entry", async () => {
    const wt1 = path.join(tmp, "wt-dup-1");
    const wt2 = path.join(tmp, "wt-dup-2");
    await createManagedWorktree(repo, "dup-branch", wt1, "sess-a");
    // Second worktree with the same branch name must fail (git refuses)
    await expect(createManagedWorktree(repo, "dup-branch", wt2, "sess-b")).rejects.toThrow();
    // Only one registered.
    expect(worktreeCount()).toBe(1);
    expect(fs.existsSync(wt2)).toBe(false);
  });
});

describe("crash recovery — reconcileFromGit (R3-05 #190)", () => {
  it("reconciles: adopts git worktrees not in registry, prunes registry entries not in git", async () => {
    const wt = path.join(tmp, "wt-reconcile");
    await createManagedWorktree(repo, "feature-reconcile", wt, "sess-r");

    // Simulate a crash: clear the registry cache and write an empty registry
    clearRegistryCache();
    fs.writeFileSync(path.join(tmp, "worktrees.json"), JSON.stringify({ worktrees: [], version: 1 }));

    // Reconcile from git — should adopt the worktree
    const reg = await reconcileFromGit(repo);
    expect(reg.worktrees).toHaveLength(1);
    // git may realpath the path (macOS /var → /private/var); compare loosely.
    expect(fs.realpathSync(reg.worktrees[0].path)).toBe(fs.realpathSync(wt));
    expect(reg.worktrees[0].ownerSessionId).toBeNull(); // orphaned after crash
  });

  it("prunes registry entries whose git worktree was deleted on disk", async () => {
    const wt = path.join(tmp, "wt-pruned");
    await createManagedWorktree(repo, "feature-pruned", wt, "sess-p");
    expect(worktreeCount()).toBe(1);

    // Delete the worktree from git
    execFileSync("git", ["worktree", "remove", wt, "--force"], { cwd: repo, stdio: "pipe" });
    // Clear cache so reconcile reads fresh
    clearRegistryCache();

    const reg = await reconcileFromGit(repo);
    expect(reg.worktrees).toHaveLength(0); // pruned
  });
});

describe("negative: non-repo, path conflicts, dirty (R3-05 #190)", () => {
  it("snapshot on a non-repo returns null — graceful degradation", async () => {
    const notARepo = path.join(tmp, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    expect(await snapshotWorktree(notARepo)).toBeNull();
  });

  it("worktree add on a non-repo fails — no phantom entry", async () => {
    const notARepo = path.join(tmp, "not-a-repo-2");
    fs.mkdirSync(notARepo, { recursive: true });
    await expect(
      createManagedWorktree(notARepo, "branch", path.join(tmp, "wt-fail"), "sess")
    ).rejects.toThrow();
    expect(worktreeCount()).toBe(0);
  });
});
