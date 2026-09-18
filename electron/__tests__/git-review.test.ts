// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { turnSnapshot, diffSince, conflictedFiles } from "../git-review";

let tmp = "";

function sh(args: string[]) {
  execFileSync("git", args, { cwd: tmp, stdio: "pipe" });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-gitreview-"));
  sh(["init", "-b", "main"]);
  sh(["config", "user.email", "test@example.com"]);
  sh(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(tmp, "a.txt"), "one\n");
  sh(["add", "-A"]);
  sh(["commit", "-m", "base"]);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("turnSnapshot / diffSince (ISS-080)", () => {
  it("clean tree → null snapshot; diffSince(HEAD) empty", async () => {
    expect(await turnSnapshot(tmp)).toBeNull();
    expect(await diffSince(tmp, null)).toBe("");
  });

  it("dirty tree → dangling snapshot sha; diff vs it shows later changes only", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\ntwo\n");
    const sha = await turnSnapshot(tmp);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // change MORE after the snapshot — the turn diff contains only the delta
    fs.writeFileSync(path.join(tmp, "b.txt"), "new file\n");
    const d = await diffSince(tmp, sha);
    expect(d).toContain("b.txt");
    expect(d).not.toContain("+two"); // pre-snapshot change stays out of the turn diff
  });

  it("diffSince with a vanished snapshot degrades gracefully, not a crash", async () => {
    const d = await diffSince(tmp, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    // tracked-diff fails against a dead sha; untracked listing still works —
    // the result never throws and never invents tracked-file hunks.
    expect(typeof d).toBe("string");
    expect(d).not.toContain("+two");
  });

  it("binary files surface as binary markers, not torn text", async () => {
    fs.writeFileSync(path.join(tmp, "blob.bin"), Buffer.from([0, 159, 146, 150, 0, 1]));
    const sha = await turnSnapshot(tmp);
    fs.writeFileSync(path.join(tmp, "blob.bin"), Buffer.from([0, 159, 146, 150, 0, 2]));
    const d = await diffSince(tmp, sha);
    expect(d).toMatch(/Binary files|GIT binary patch/);
  });
});

describe("conflictedFiles (ISS-080)", () => {
  it("lists unresolved merge conflicts; empty when none", async () => {
    expect(await conflictedFiles(tmp)).toEqual([]);

    sh(["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(tmp, "a.txt"), "feature version\n");
    sh(["add", "-A"]);
    sh(["commit", "-m", "feature"]);
    sh(["checkout", "main"]);
    fs.writeFileSync(path.join(tmp, "a.txt"), "main version\n");
    sh(["add", "-A"]);
    sh(["commit", "-m", "main-side"]);
    try {
      sh(["merge", "feature"]);
    } catch {
      // merge exits non-zero on conflict — expected
    }
    const conflicts = await conflictedFiles(tmp);
    expect(conflicts).toContain("a.txt");
  });
});
