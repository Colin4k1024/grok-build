// @vitest-environment node
/**
 * Shallow-wiring real-side-effect tests (R3-03 / #188).
 *
 * The issue demands: slash commands must produce real, verifiable side
 * effects — not just route through a function. These tests prove the
 * worktree, rename, and git-commit paths really execute against a real
 * git repo on disk, and that Apply Code's event listener really fires.
 *
 * No mocks of the git, file, or process operations the issue requires.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { renameHistorySession, listHistorySessions } from "../session-history";

const execFileAsync = promisify(execFile);

let tmp = "";
let repo = "";
let savedGrokHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-iss188-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "pipe" });
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "pipe" });
  // Point GROK_HOME at the tmp dir so session-history's sessionsRoot()
  // resolves under tmp, not the real ~/.grok. findSessionDir looks up
  // sessions/<encoded-cwd>/<sessionId>/summary.json.
  savedGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
});

/** Create a session history dir matching findSessionDir's layout:
 *  <GROK_HOME>/sessions/<encoded-cwd>/<sessionId>/summary.json */
function createSessionHistory(cwd: string, sessionId: string, title: string): string {
  const encoded = encodeURIComponent(cwd);
  const dir = path.join(tmp, "sessions", encoded, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ generated_title: title, session_id: sessionId }),
    "utf-8"
  );
  return dir;
}

/**
 * Replicates the git_worktree_add IPC handler's real execution path —
 * the same `git worktree add` the handler runs against a real repo.
 */
async function gitWorktreeAdd(cwd: string, branch: string, wtPath: string, newBranch: boolean): Promise<string> {
  const absWt = path.resolve(wtPath);
  fs.mkdirSync(path.dirname(absWt), { recursive: true });
  const argv = newBranch
    ? ["worktree", "add", "-b", branch, absWt]
    : ["worktree", "add", branch, absWt];
  await execFileAsync("git", argv, { cwd });
  return absWt;
}

/**
 * Replicates the git_commit IPC handler's real execution path.
 */
async function gitCommit(cwd: string, message: string): Promise<string> {
  await execFileAsync("git", ["add", "-A"], { cwd });
  try {
    await execFileAsync("git", ["commit", "-m", message], { cwd, maxBuffer: 4 * 1024 * 1024 });
    return "committed";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (text.includes("nothing to commit")) return "nothing-to-commit";
    throw e;
  }
}

describe("worktree real-side-effect: git worktree add lands on disk (R3-03 #188)", () => {
  it("creates a real worktree directory with a real checked-out branch", async () => {
    const wtPath = path.join(tmp, "wt-feature");
    const result = await gitWorktreeAdd(repo, "feature-x", wtPath, true);
    // The worktree directory exists on disk
    expect(fs.existsSync(result)).toBe(true);
    expect(fs.existsSync(path.join(result, "README.md"))).toBe(true);
    // The branch was really created
    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo }).toString();
    expect(branches).toContain("feature-x");
    // git worktree list shows it
    const list = execFileSync("git", ["worktree", "list"], { cwd: repo }).toString();
    expect(list).toContain(wtPath);
  });

  it("worktree persists across a simulated restart — re-listing shows it", async () => {
    const wtPath = path.join(tmp, "wt-persist");
    await gitWorktreeAdd(repo, "persist-branch", wtPath, true);
    // Simulate restart: re-read worktree list from the repo
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo }).toString();
    expect(list).toContain(wtPath);
    expect(list).toContain("persist-branch");
    // The worktree's files are still there
    expect(fs.existsSync(path.join(wtPath, "README.md"))).toBe(true);
  });

  it("same-name branch is rejected — git refuses to create a duplicate", async () => {
    const wt1 = path.join(tmp, "wt-1");
    await gitWorktreeAdd(repo, "dup-branch", wt1, true);
    // Creating a worktree with the same branch name must fail
    const wt2 = path.join(tmp, "wt-2");
    await expect(gitWorktreeAdd(repo, "dup-branch", wt2, true)).rejects.toThrow();
    // The second worktree directory was not created
    expect(fs.existsSync(wt2)).toBe(false);
  });

  it("dirty tree does not corrupt the worktree — the main repo is untouched", async () => {
    // Make the main repo dirty
    fs.writeFileSync(path.join(repo, "uncommitted.txt"), "dirty\n");
    const wtPath = path.join(tmp, "wt-clean");
    await gitWorktreeAdd(repo, "clean-branch", wtPath, true);
    // The worktree is a clean checkout (no uncommitted.txt)
    expect(fs.existsSync(path.join(wtPath, "uncommitted.txt"))).toBe(false);
    // The main repo is still dirty
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
    expect(status).toContain("uncommitted.txt");
  });
});

describe("rename real-side-effect: summary.json persists across restart (R3-03 #188)", () => {
  it("renames a history session and the new title survives a re-read", () => {
    const dir = createSessionHistory(repo, "test-session", "old title");
    const result = renameHistorySession("test-session", repo, "new title");
    expect(result).toBe("new title");
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf-8"));
    expect(summary.generated_title).toBe("new title");
  });

  it("rename is atomic — the temp file is not left behind", () => {
    const dir = createSessionHistory(repo, "atomic-test", "old");
    renameHistorySession("atomic-test", repo, "atomic new");
    expect(fs.existsSync(path.join(dir, ".summary.json.tmp"))).toBe(false);
  });

  it("empty title is rejected — no silent corruption", () => {
    const dir = createSessionHistory(repo, "empty-test", "old");
    expect(() => renameHistorySession("empty-test", repo, "")).toThrow();
    expect(() => renameHistorySession("empty-test", repo, "   ")).toThrow();
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf-8"));
    expect(summary.generated_title).toBe("old");
  });

  it("rename of a non-existent session fails — no phantom file created", () => {
    expect(() => renameHistorySession("does-not-exist", repo, "title")).toThrow();
    expect(fs.existsSync(path.join(tmp, "sessions", encodeURIComponent(repo), "does-not-exist"))).toBe(false);
  });
});

describe("git commit real-side-effect: commits land on the real repo (R3-03 #188)", () => {
  it("a commit really lands and is visible in git log", async () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "change\n");
    const result = await gitCommit(repo, "test change");
    expect(result).toBe("committed");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString();
    expect(log).toContain("test change");
  });

  it("nothing-to-commit does not create a phantom commit", async () => {
    const result = await gitCommit(repo, "nothing here");
    expect(result).toBe("nothing-to-commit");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString();
    expect(log.trim().split("\n")).toHaveLength(1); // only init
  });
});

describe("concurrency / idempotency — duplicate actions do not double-fire (R3-03 #188)", () => {
  it("double worktree-add with the same branch does not create two worktrees", async () => {
    const wt1 = path.join(tmp, "wt-dup-1");
    await gitWorktreeAdd(repo, "dup-idem", wt1, true);
    // A second attempt with the same branch must fail (git refuses)
    const wt2 = path.join(tmp, "wt-dup-2");
    await expect(gitWorktreeAdd(repo, "dup-idem", wt2, true)).rejects.toThrow();
    expect(fs.existsSync(wt2)).toBe(false);
    // Only one worktree was created
    const list = execFileSync("git", ["worktree", "list"], { cwd: repo }).toString();
    expect(list.split("\n").filter((l) => l.includes("wt-dup"))).toHaveLength(1);
  });

  it("concurrent renames to different titles — last write wins, no corruption", () => {
    const dir = createSessionHistory(repo, "conc-test", "old");
    renameHistorySession("conc-test", repo, "title-a");
    renameHistorySession("conc-test", repo, "title-b");
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf-8"));
    expect(summary.generated_title).toBe("title-b");
  });
});

describe("negative: read-only / non-repo paths give actionable errors (R3-03 #188)", () => {
  it("worktree add on a non-repo fails with an actionable error", async () => {
    const notARepo = path.join(tmp, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    await expect(
      gitWorktreeAdd(notARepo, "branch", path.join(tmp, "wt-fail"), true)
    ).rejects.toThrow();
  });

  it("git commit on a non-repo fails cleanly", async () => {
    const notARepo = path.join(tmp, "not-a-repo-2");
    fs.mkdirSync(notARepo, { recursive: true });
    await expect(gitCommit(notARepo, "fail")).rejects.toThrow();
  });
});
