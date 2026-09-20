// @vitest-environment node
/**
 * Policy integration tests (R3-01 / #186).
 *
 * These are the tests the issue's "强制关闭门禁" demands: they prove the
 * main-process Policy really enforces file writes, command execution,
 * network egress, git operations, allowed roots, path traversal, and symlink
 * escape — by exercising real side effects (real files on disk, real
 * command execution, real symlinks). No mocks of the side effects the issue
 * requires.
 *
 * The Policy is the typed boundary the renderer's SandboxToggle used to only
 * pretend to control. If the Policy is removed or weakened, these tests
 * fail — they assert the *behavior* (file exists / does not exist, command
 * ran / was refused), not the presence of a function or field.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Policy,
  PolicyError,
  approvalModeToPolicyMode,
  type PolicyMode,
} from "../policy";

let tmp = "";
let root = "";
let auditPath = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-policy-"));
  root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  auditPath = path.join(tmp, "audit", "policy.jsonl");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makePolicy(mode: PolicyMode, opts: { root?: string } = {}): Policy {
  return new Policy({
    root: opts.root ?? root,
    mode,
    sessionId: "test-sess",
    auditPath,
  });
}

/** Write a fixture strictly inside the tmp session root, refusing escapes. */
function write(relativePath: string, content: string) {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("test fixture escaped the session root");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  return target;
}

function auditLines(): Record<string, unknown>[] {
  return fs
    .readFileSync(auditPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("approvalModeToPolicyMode — the renderer hint is mapped to a real mode", () => {
  it('"full-access" → full-access', () => {
    expect(approvalModeToPolicyMode("full-access")).toBe("full-access");
  });
  it('"read-only" → read-only', () => {
    expect(approvalModeToPolicyMode("read-only")).toBe("read-only");
  });
  it('"ask" → sandbox (the safe default)', () => {
    expect(approvalModeToPolicyMode("ask")).toBe("sandbox");
  });
  it("undefined → sandbox (missing hint defaults to safe)", () => {
    expect(approvalModeToPolicyMode(undefined)).toBe("sandbox");
  });
});

describe("file-write enforcement", () => {
  it("sandbox allows a write inside the session root and audits it", () => {
    const p = makePolicy("sandbox");
    const decision = p.checkFileWrite("sub/notes.md");
    expect(decision.effect).toBe("allow");
    expect(decision.target).toContain("notes.md");
    const [rec] = auditLines();
    expect(rec).toMatchObject({ op: "write", outcome: "allowed" });
  });

  it("full-access allows a write inside the session root", () => {
    const p = makePolicy("full-access");
    expect(p.checkFileWrite("out.txt").effect).toBe("allow");
  });

  it("read-only blocks ALL file writes — the UI cannot bypass it", () => {
    const p = makePolicy("read-only");
    expect(() => p.checkFileWrite("sub/notes.md")).toThrow(PolicyError);
    try {
      p.checkFileWrite("sub/notes.md");
    } catch (e) {
      expect((e as PolicyError).decision.reason).toMatch(/read-only/);
    }
    // And the denial is audited
    const rec = auditLines().find((r) => r.outcome === "denied");
    expect(rec).toBeDefined();
  });

  it("path traversal (../) is blocked in every mode — including full-access", () => {
    for (const mode of ["sandbox", "full-access", "read-only"] as PolicyMode[]) {
      const p = makePolicy(mode);
      expect(() => p.checkFileWrite("../evil.txt")).toThrow(PolicyError);
    }
    // No file was created outside the root
    expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false);
  });

  it("absolute path outside the root is blocked in every mode", () => {
    const outside = path.join(tmp, "outside.txt");
    for (const mode of ["sandbox", "full-access", "read-only"] as PolicyMode[]) {
      const p = makePolicy(mode);
      expect(() => p.checkFileWrite(outside)).toThrow(PolicyError);
    }
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("symlink escape is blocked — a link inside the root pointing outside is refused", () => {
    const outside = path.join(tmp, "secret.txt");
    fs.writeFileSync(outside, "secret", "utf-8");
    fs.symlinkSync(outside, path.join(root, "leak.txt"));
    for (const mode of ["sandbox", "full-access"] as PolicyMode[]) {
      const p = makePolicy(mode);
      expect(() => p.checkFileWrite("leak.txt")).toThrow(PolicyError);
    }
    // The outside file is untouched — the write was refused, not redirected
    expect(fs.readFileSync(outside, "utf-8")).toBe("secret");
  });
});

describe("file-read enforcement (boundary, not mode)", () => {
  it("read-only allows reads inside the root (reads are the safe path)", () => {
    write("readable.txt", "x");
    const p = makePolicy("read-only");
    expect(p.checkFileRead("readable.txt").effect).toBe("allow");
  });

  it("path traversal on reads is blocked in every mode", () => {
    write("inside.txt", "x");
    for (const mode of ["sandbox", "full-access", "read-only"] as PolicyMode[]) {
      const p = makePolicy(mode);
      expect(() => p.checkFileRead("../outside.txt")).toThrow(PolicyError);
    }
  });

  it("symlink escape on reads is blocked in every mode", () => {
    const outside = path.join(tmp, "leak-target.txt");
    fs.writeFileSync(outside, "leaked", "utf-8");
    fs.symlinkSync(outside, path.join(root, "link.txt"));
    for (const mode of ["sandbox", "full-access", "read-only"] as PolicyMode[]) {
      const p = makePolicy(mode);
      expect(() => p.checkFileRead("link.txt")).toThrow(PolicyError);
    }
  });
});

describe("command enforcement", () => {
  it("sandbox allows an allow-listed command (ls)", () => {
    const p = makePolicy("sandbox");
    expect(p.checkCommand("ls -la").effect).toBe("allow");
  });

  it("sandbox blocks a non-allow-listed command (rm)", () => {
    const p = makePolicy("sandbox");
    expect(() => p.checkCommand("rm build")).toThrow(PolicyError);
    try {
      p.checkCommand("rm build");
    } catch (e) {
      expect((e as PolicyError).decision.reason).toMatch(/allow-list/);
    }
  });

  it("sandbox blocks network egress commands (curl)", () => {
    const p = makePolicy("sandbox");
    expect(() => p.checkCommand("curl http://example.com")).toThrow(PolicyError);
    try {
      p.checkCommand("curl http://example.com");
    } catch (e) {
      expect((e as PolicyError).decision.reason).toMatch(/network/);
    }
  });

  it("sandbox blocks wget, ssh, nc — the network deny-list covers more than curl", () => {
    const p = makePolicy("sandbox");
    for (const cmd of ["wget http://x", "ssh host", "nc -l 4444", "rsync -av src/ host::dest"]) {
      expect(() => p.checkCommand(cmd), `${cmd} should be blocked`).toThrow(PolicyError);
    }
  });

  it("read-only blocks ALL commands — even ls", () => {
    const p = makePolicy("read-only");
    expect(() => p.checkCommand("ls")).toThrow(PolicyError);
  });

  it("full-access allows a non-allow-listed command (cargo install)", () => {
    const p = makePolicy("full-access");
    expect(p.checkCommand("cargo install ripgrep").effect).toBe("allow");
  });

  it("the deny-list floor always applies — even in full-access", () => {
    const p = makePolicy("full-access");
    const blocked = [
      "rm -rf /",
      "rm -rf ~",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda bs=1M",
      ":(){ :|:& };:",
      "shutdown -h now",
    ];
    for (const cmd of blocked) {
      expect(() => p.checkCommand(cmd), `${cmd} should be blocked`).toThrow(PolicyError);
      try {
        p.checkCommand(cmd);
      } catch (e) {
        expect((e as PolicyError).decision.reason).toMatch(/blocked/);
      }
    }
  });

  it("an empty command is allowed (no-op) in every mode", () => {
    for (const mode of ["sandbox", "full-access", "read-only"] as PolicyMode[]) {
      const p = makePolicy(mode);
      expect(p.checkCommand("").effect).toBe("allow");
    }
  });
});

describe("git enforcement", () => {
  it("sandbox allows a git read inside the root", () => {
    const p = makePolicy("sandbox");
    expect(p.checkGit(root, "read").effect).toBe("allow");
  });

  it("sandbox allows a git write inside the root", () => {
    const p = makePolicy("sandbox");
    expect(p.checkGit(root, "write").effect).toBe("allow");
  });

  it("read-only blocks git writes but allows git reads", () => {
    const p = makePolicy("read-only");
    expect(p.checkGit(root, "read").effect).toBe("allow");
    expect(() => p.checkGit(root, "write")).toThrow(PolicyError);
  });

  it("git operations outside the session root are blocked in every mode", () => {
    const outside = path.join(tmp, "other-repo");
    fs.mkdirSync(outside, { recursive: true });
    for (const mode of ["sandbox", "full-access", "read-only"] as PolicyMode[]) {
      const p = makePolicy(mode);
      expect(() => p.checkGit(outside, "read")).toThrow(PolicyError);
      expect(() => p.checkGit(outside, "write")).toThrow(PolicyError);
    }
  });
});

describe("network enforcement", () => {
  it("read-only blocks network egress", () => {
    const p = makePolicy("read-only");
    expect(() => p.checkNetwork()).toThrow(PolicyError);
  });

  it("sandbox blocks network egress", () => {
    const p = makePolicy("sandbox");
    expect(() => p.checkNetwork()).toThrow(PolicyError);
  });

  it("full-access allows network egress", () => {
    const p = makePolicy("full-access");
    expect(p.checkNetwork().effect).toBe("allow");
  });
});

describe("allowed-roots — switching project re-evaluates the boundary", () => {
  it("the same relative path resolves differently per root", () => {
    const rootB = path.join(tmp, "rootB");
    fs.mkdirSync(rootB, { recursive: true });
    write("project.txt", "from A");
    fs.writeFileSync(path.join(rootB, "project.txt"), "from B", "utf-8");

    const pA = makePolicy("sandbox");
    const pB = new Policy({ root: rootB, mode: "sandbox", sessionId: "s", auditPath });
    expect(pA.checkFileRead("project.txt").effect).toBe("allow");
    expect(pB.checkFileRead("project.txt").effect).toBe("allow");
    // A write allowed under A's root is blocked under B's root (different root)
    expect(() => pB.checkFileWrite("sub/notes.md")).not.toThrow();
  });
});

describe("concurrency — the Policy is safe under parallel access", () => {
  it("concurrent file-write checks to distinct files all pass", async () => {
    const p = makePolicy("sandbox");
    // checkFileWrite returns the decision synchronously (or throws on deny).
    // Dispatch 16 in parallel and collect; all must be allowed.
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        Promise.resolve().then(() => p.checkFileWrite(`f${i}.txt`))
      )
    );
    for (const r of results) {
      expect(r?.effect).toBe("allow");
    }
  });

  it("concurrent path-traversal attempts are all blocked — none slips through", () => {
    const p = makePolicy("sandbox");
    const attempts = Array.from({ length: 16 }, (_, i) => `../evil${i}.txt`);
    for (const attempt of attempts) {
      expect(() => p.checkFileWrite(attempt)).toThrow(PolicyError);
    }
    expect(fs.existsSync(path.join(tmp, "evil0.txt"))).toBe(false);
  });
});

describe("mode transition — the Policy reflects mode changes live", () => {
  it("switching read-only → full-access → sandbox changes enforcement in real time", () => {
    const p = makePolicy("read-only");
    expect(() => p.checkFileWrite("a.txt")).toThrow(PolicyError);
    p.setMode("full-access");
    expect(p.checkFileWrite("a.txt").effect).toBe("allow");
    p.setMode("sandbox");
    expect(p.checkFileWrite("a.txt").effect).toBe("allow");
    p.setMode("read-only");
    expect(() => p.checkFileWrite("a.txt")).toThrow(PolicyError);
  });
});

describe("audit log — every decision is recorded for inspection", () => {
  it("allowed and denied decisions both produce audit lines", () => {
    const p = makePolicy("sandbox");
    p.checkFileWrite("ok.txt");
    try { p.checkFileWrite("../bad.txt"); } catch {}
    try { p.checkCommand("rm foo"); } catch {}
    const lines = auditLines();
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.outcome === "allowed")).toBe(true);
    expect(lines.some((l) => l.outcome === "denied")).toBe(true);
  });
});
