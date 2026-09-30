// @vitest-environment node
//
// Unit tests for the R5 release gate (R5-10 / #266) core logic. The step list
// and command runner are injected, so these run fast — no real build/electron/
// pack. They verify: continue-on-failure, prereq-aware skipping, platform
// gating, and the report structure.
import { describe, it, expect } from "vitest";
import {
  runReleaseGate,
  runStep,
  buildReport,
  collectMeta,
  defineSteps,
  snapshotSessions,
  parseOutDirArg,
} from "../release-gate.mjs";

/** A runner that returns pass for everything. */
const passRunner = () => ({ status: 0, output: "ok" });
/** A runner that fails when the command includes `fail`, else passes. */
const failRunner = (cmd) => ({
  status: cmd.includes("fail") ? 1 : 0,
  output: cmd.join(" "),
});
/** A runner that throws (spawn error). */
const throwRunner = () => {
  throw new Error("boom");
};

const step = (id, opts = {}) => ({
  id,
  name: id,
  cmd: opts.cmd ?? [id],
  ...opts,
});

describe("runStep", () => {
  it("passes when the runner returns status 0", () => {
    const r = runStep(step("a"), passRunner);
    expect(r.status).toBe("pass");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails when the runner returns non-zero, capturing output", () => {
    const r = runStep(step("a", { cmd: ["fail"] }), failRunner);
    expect(r.status).toBe("fail");
    expect(r.output).toContain("fail");
  });

  it("skips when cmd is null (no artifact from a prerequisite)", () => {
    const r = runStep(step("a", { cmd: null }), passRunner);
    expect(r.status).toBe("skipped");
    expect(r.skipReason).toMatch(/artifact/);
  });

  it("captures a thrown runner error as a fail", () => {
    const r = runStep(step("a"), throwRunner);
    expect(r.status).toBe("fail");
    expect(r.output).toContain("boom");
  });
});

describe("runReleaseGate", () => {
  it("runs every step and reports all-pass", () => {
    const steps = [step("a"), step("b", { prereqs: ["a"] }), step("c", { prereqs: ["b"] })];
    const g = runReleaseGate({ steps, runner: passRunner });
    expect(g.failed).toEqual([]);
    expect(g.passed).toEqual(["a", "b", "c"]);
    expect(g.skipped).toEqual([]);
  });

  it("skips dependents of a failed step but still runs independent steps (complete summary)", () => {
    const steps = [
      step("build", { cmd: ["fail"] }), // fails
      step("pack", { prereqs: ["build"] }), // skipped (prereq failed)
      step("unit"), // independent — still runs + passes
    ];
    const g = runReleaseGate({ steps, runner: failRunner });
    expect(g.failed).toEqual(["build"]);
    expect(g.skipped).toEqual(["pack"]);
    expect(g.passed).toEqual(["unit"]);
    const pack = g.results.find((r) => r.id === "pack");
    expect(pack.skipReason).toMatch(/prerequisite build did not pass/);
  });

  it("skips platform-gated steps on non-matching platforms", () => {
    const steps = [
      step("pack"),
      step("macos-smoke", { platform: "darwin", prereqs: ["pack"] }),
      step("linux-smoke", { platform: "linux" }),
    ];
    const g = runReleaseGate({ steps, runner: passRunner, platform: "darwin" });
    const mac = g.results.find((r) => r.id === "macos-smoke");
    const linux = g.results.find((r) => r.id === "linux-smoke");
    expect(mac.status).toBe("pass"); // darwin on darwin, after pack
    expect(linux.status).toBe("skipped");
    expect(linux.skipReason).toMatch(/platform darwin/);
  });

  it("skips a step declared before its prereq (misordered), rather than running it vacuously", () => {
    // Robustness: a prereq that hasn't executed yet is NOT satisfied, so a
    // misordered step (before its prereq) is skipped instead of running against
    // a not-yet-produced artifact — guards the e2e-before-pack class of bug.
    const steps = [
      step("e2e", { prereqs: ["pack"] }), // declared before pack — must skip
      step("pack"),
    ];
    const g = runReleaseGate({ steps, runner: passRunner });
    const e2e = g.results.find((r) => r.id === "e2e");
    expect(e2e.status).toBe("skipped");
    expect(e2e.skipReason).toMatch(/prerequisite pack did not pass/);
    expect(g.passed).toEqual(["pack"]);
  });

  it("skips a null-cmd step (no artifact) without failing dependents that also have null cmd", () => {
    const steps = [
      step("pack"),
      step("feed-verify", { cmd: null, prereqs: ["pack"] }), // no manifest — pack passed
    ];
    const g = runReleaseGate({ steps, runner: passRunner });
    const feed = g.results.find((r) => r.id === "feed-verify");
    expect(feed.status).toBe("skipped");
    expect(feed.skipReason).toMatch(/artifact/);
    expect(g.failed).toEqual([]);
  });
});

describe("buildReport", () => {
  it("produces a structured JSON + Markdown report with metadata", () => {
    const steps = [step("a"), step("b", { prereqs: ["a"] })];
    const g = runReleaseGate({ steps, runner: passRunner });
    const meta = {
      commit: "abc123",
      branch: "main",
      platform: "darwin",
      arch: "arm64",
      node: "20.0.0",
      npm: "10.0.0",
      electron: "30.0.0",
      generatedAt: "2026-09-30T00:00:00Z",
    };
    const { json, md } = buildReport(g, meta, {
      signature: "verified",
      uatStatus: "pass",
      artifacts: [{ name: "app.dmg", path: "release/app.dmg", size: 1024 }],
      checksumsFile: "release/checksums.sha256",
    });
    const report = JSON.parse(json);
    expect(report.overall).toBe("pass");
    expect(report.meta.commit).toBe("abc123");
    expect(report.summary.total).toBe(2);
    expect(report.signature).toBe("verified");
    expect(report.artifacts[0].name).toBe("app.dmg");
    expect(md).toContain("# R5 Release Gate Report");
    expect(md).toContain("PASS");
    expect(md).toContain("abc123");
    expect(md).toContain("app.dmg");
  });

  it("marks overall fail when any step failed", () => {
    const steps = [step("a", { cmd: ["fail"] }), step("b", { prereqs: ["a"] })];
    const g = runReleaseGate({ steps, runner: failRunner });
    const meta = {
      commit: "x", branch: "main", platform: "darwin", arch: "arm64",
      node: "n", npm: "n", electron: "e", generatedAt: "t",
    };
    const { json } = buildReport(g, meta);
    const report = JSON.parse(json);
    expect(report.overall).toBe("fail");
    expect(report.summary.failed).toBe(1);
    expect(report.summary.skipped).toBe(1);
  });

  it("summary counts always add up (passed + failed + skipped == total)", () => {
    // Guards against the user-data-unchanged counting bug: a step pushed into
    // results must also be counted in passed/failed/skipped.
    const steps = [step("a"), step("b", { cmd: ["fail"] }), step("c", { prereqs: ["b"] }), step("d", { platform: "linux" })];
    const g = runReleaseGate({ steps, runner: failRunner, platform: "darwin" });
    const meta = { commit: "x", branch: "m", platform: "darwin", arch: "arm64", node: "n", npm: "n", electron: "e", generatedAt: "t" };
    const report = JSON.parse(buildReport(g, meta).json);
    expect(report.summary.passed + report.summary.failed + report.summary.skipped).toBe(report.summary.total);
  });
});

describe("defineSteps", () => {
  it("produces the full ordered step sequence with prereqs", () => {
    const steps = defineSteps({ outDir: "/tmp/nope" });
    const ids = steps.map((s) => s.id);
    expect(ids).toContain("unit");
    expect(ids).toContain("build");
    expect(ids).toContain("pack");
    expect(ids).toContain("uat");
    expect(ids).toContain("macos-smoke");
    // pack depends on electron-build, which depends on build
    const pack = steps.find((s) => s.id === "pack");
    expect(pack.prereqs).toContain("electron-build");
    // platform smoke is gated
    const mac = steps.find((s) => s.id === "macos-smoke");
    expect(mac.platform).toBe("darwin");
  });

  it("feed-verify cmd resolves to null when no manifest exists (skips gracefully)", () => {
    const steps = defineSteps({ outDir: "/tmp/nope-no-artifacts" });
    const feed = steps.find((s) => s.id === "feed-verify");
    // cmd is a lazy function resolved at run time (after pack); call it.
    const resolved = typeof feed.cmd === "function" ? feed.cmd() : feed.cmd;
    expect(resolved).toBeNull();
  });

  it("resolves smoke/feed cmd lazily at run time (after pack), not at define time", () => {
    // A fresh dir has no artifacts; the lazy cmds return null (skip) until pack
    // produces them. This is the core fix for "smoke steps silently skipped."
    const tmp = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "gb-lazy-"));
    try {
      const steps = defineSteps({ outDir: tmp });
      const mac = steps.find((s) => s.id === "macos-smoke");
      const feed = steps.find((s) => s.id === "feed-verify");
      // Before any artifact: both resolve to null.
      expect((typeof mac.cmd === "function" ? mac.cmd() : mac.cmd)).toBeNull();
      expect((typeof feed.cmd === "function" ? feed.cmd() : feed.cmd)).toBeNull();
      // Simulate pack producing a manifest + DMG.
      require("node:fs").writeFileSync(require("node:path").join(tmp, "latest-mac.yml"), "version: 1.0\n");
      require("node:fs").writeFileSync(require("node:path").join(tmp, "x.dmg"), "dmg");
      expect((typeof feed.cmd === "function" ? feed.cmd() : feed.cmd)).not.toBeNull();
      expect((typeof mac.cmd === "function" ? mac.cmd() : mac.cmd)).not.toBeNull();
    } finally {
      require("node:fs").rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("collectMeta", () => {
  it("records platform, arch, node version, and a commit hash", () => {
    const meta = collectMeta();
    expect(meta.platform).toBe(process.platform);
    expect(meta.arch).toBe(process.arch);
    expect(meta.node).toBe(process.versions.node);
    expect(meta.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(meta.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("snapshotSessions", () => {
  it("detects in-place content/size changes, not just renames or adds", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-snap-"));
    try {
      fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
      const f = path.join(dir, "sessions", "a.json");
      fs.writeFileSync(f, "first");
      const before = snapshotSessions(path.join(dir, "sessions"));
      // Append — same file, different content + size. Must change the hash.
      fs.writeFileSync(f, "first plus more");
      const after = snapshotSessions(path.join(dir, "sessions"));
      expect(before).not.toBe(after);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is stable when nothing changes", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-snap-"));
    try {
      fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sessions", "a.json"), "stable");
      expect(snapshotSessions(path.join(dir, "sessions")))
        .toBe(snapshotSessions(path.join(dir, "sessions")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseOutDirArg", () => {
  it("parses --out-dir <path> and --out-dir=<path>", () => {
    expect(parseOutDirArg(["--out-dir", "x"])).toBe("x");
    expect(parseOutDirArg(["--out-dir=y"])).toBe("y");
    expect(parseOutDirArg([])).toBeUndefined();
  });
});

describe("latestUatRunCmd", () => {
  it("skips (null) in CI when no recorded run exists (.uat/ is gitignored)", () => {
    const { latestUatRunCmd } = require("../release-gate.mjs");
    // A fresh CI checkout has no .uat/runs — the step must skip, not fail, or
    // the release-gate job is permanently red on every tag push.
    expect(latestUatRunCmd({ runsDir: "/tmp/nope-no-uat", ci: "1" })).toBeNull();
  });

  it("fails locally (no CI) when no run exists, with an actionable reminder", () => {
    const { latestUatRunCmd } = require("../release-gate.mjs");
    const cmd = latestUatRunCmd({ runsDir: "/tmp/nope-no-uat", ci: undefined });
    expect(cmd).not.toBeNull();
    expect(cmd.join(" ")).toMatch(/no UAT run recorded/);
  });

  it("reports --strict on the latest run when one exists", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { latestUatRunCmd } = require("../release-gate.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-uat-"));
    try {
      fs.mkdirSync(path.join(dir, "runs", "run-3"), { recursive: true });
      fs.mkdirSync(path.join(dir, "runs", "run-1"), { recursive: true });
      const cmd = latestUatRunCmd({ runsDir: path.join(dir, "runs"), ci: "1" });
      expect(cmd).not.toBeNull();
      // Picks the lexically-latest run id.
      expect(cmd.join(" ")).toContain("run-3");
      expect(cmd.join(" ")).toContain("--strict");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
