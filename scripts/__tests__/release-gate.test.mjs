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
      step("macos-smoke", { platform: "darwin", prereqs: ["pack"] }),
      step("pack"),
      step("linux-smoke", { platform: "linux" }),
    ];
    const g = runReleaseGate({ steps, runner: passRunner, platform: "darwin" });
    const mac = g.results.find((r) => r.id === "macos-smoke");
    const linux = g.results.find((r) => r.id === "linux-smoke");
    expect(mac.status).toBe("pass"); // darwin on darwin
    expect(linux.status).toBe("skipped");
    expect(linux.skipReason).toMatch(/platform darwin/);
  });

  it("skips a null-cmd step (no artifact) without failing dependents that also have null cmd", () => {
    const steps = [
      step("feed-verify", { cmd: null, prereqs: ["pack"] }), // no manifest
      step("pack"),
    ];
    const g = runReleaseGate({ steps, runner: passRunner });
    const feed = g.results.find((r) => r.id === "feed-verify");
    expect(feed.status).toBe("skipped");
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

  it("feed-verify cmd is null when no manifest exists (skips gracefully)", () => {
    const steps = defineSteps({ outDir: "/tmp/nope-no-artifacts" });
    const feed = steps.find((s) => s.id === "feed-verify");
    expect(feed.cmd).toBeNull();
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
