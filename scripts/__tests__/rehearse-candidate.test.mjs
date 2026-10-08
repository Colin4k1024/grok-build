// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  sha256File,
  findArtifacts,
  verifyCandidateFiles,
  parseE2eResults,
  classifySignature,
  classifySbom,
  buildReport,
  applyTerminalStickiness,
  REQUIRED_E2E_SUITES,
  main,
} from "../rehearse-candidate.mjs";

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-cand-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sha(b) {
  return crypto.createHash("sha256").update(b).digest("hex");
}

describe("rehearse-candidate primitives (R6-06 #284)", () => {
  it("sha256File computes the hash of a file (and null for missing)", () => {
    const f = path.join(tmp, "test.bin");
    fs.writeFileSync(f, "hello");
    expect(sha256File(f)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256File(path.join(tmp, "nope"))).toBeNull();
  });

  it("findArtifacts extracts dmg/zip + manifest + app from a dir listing", () => {
    const files = ["Grok-Build-0.1.0-arm64.dmg", "Grok-Build-0.1.0-arm64.zip", "latest-mac.yml", "mac-arm64", "builder-debug.yml"];
    const { artifacts, manifest, app } = findArtifacts(files);
    expect(artifacts).toHaveLength(2);
    expect(manifest).toBe("latest-mac.yml");
    expect(app).toBe("mac-arm64/Grok Build.app");
  });

  it("findArtifacts returns empty when no artifacts", () => {
    const { artifacts, manifest, app } = findArtifacts(["readme.txt"]);
    expect(artifacts).toEqual([]);
    expect(manifest).toBeNull();
    expect(app).toBeNull();
  });

  it("verifyCandidateFiles detects checksum drift (immutability check)", () => {
    const f = path.join(tmp, "a.dmg");
    fs.writeFileSync(f, "original");
    const ok = verifyCandidateFiles([{ name: "a.dmg", sha256: sha(Buffer.from("original")) }], (n) => path.join(tmp, n));
    expect(ok.ok).toBe(true);
    fs.writeFileSync(f, "tampered");
    const bad = verifyCandidateFiles([{ name: "a.dmg", sha256: sha(Buffer.from("original")) }], (n) => path.join(tmp, n));
    expect(bad.ok).toBe(false);
    expect(bad.drift[0].name).toBe("a.dmg");
  });
});

describe("parseE2eResults — completeness + staleness (Codex r2 P2-1/P2-4)", () => {
  const suites = REQUIRED_E2E_SUITES.map((f) => ({ file: `e2e/${f}` }));
  const base = { stats: { expected: 13, unexpected: 0, skipped: 0 }, suites };

  it("accepts a complete, fresh, unskipped run", () => {
    const r = parseE2eResults(base, {});
    expect(r.pass).toBe(true);
    expect(r.failed).toBe(false);
  });

  it("rejects unexpected failures as a hard failure", () => {
    const r = parseE2eResults({ ...base, stats: { expected: 13, unexpected: 2, skipped: 0 } }, {});
    expect(r.pass).toBe(false);
    expect(r.failed).toBe(true);
  });

  it("rejects skipped tests (partial suite is not evidence)", () => {
    const r = parseE2eResults({ ...base, stats: { expected: 13, unexpected: 0, skipped: 2 } }, {});
    expect(r.pass).toBe(false);
    expect(r.failed).toBe(false);
    expect(r.reason).toMatch(/skipped/);
  });

  it("rejects a run missing required spec files", () => {
    const r = parseE2eResults({ stats: base.stats, suites: suites.slice(0, 2) }, {});
    expect(r.pass).toBe(false);
    expect(r.missingSuites).toContain("accessibility-keyboard.spec.ts");
  });

  it("marks results older than the candidate build as stale", () => {
    const r = parseE2eResults(base, { candidateBuiltAt: 2000, resultsMtime: 1000 });
    expect(r.stale).toBe(true);
    expect(r.pass).toBe(false);
    expect(r.failed).toBe(false);
    expect(r.reason).toMatch(/stale/);
  });

  it("returns a structured verdict for unparseable input", () => {
    const r = parseE2eResults("{not json", {});
    expect(r.valid).toBe(false);
    expect(r.pass).toBe(false);
  });
});

describe("signature + SBOM classification (Codex r2 P2-2/P2-3)", () => {
  it("classifies signed / unsigned / cannot-check", () => {
    expect(classifySignature({ codesignAvailable: true, verifyExit: 0 }).status).toBe("signed");
    expect(classifySignature({ codesignAvailable: true, verifyExit: 1 }).status).toBe("unsigned");
    expect(classifySignature({ codesignAvailable: false, verifyExit: null }).status).toBe("cannot-check");
  });

  it("SBOM verified when it lists every artifact; incomplete otherwise", () => {
    const sbom = { artifacts: ["a.dmg", "a.zip"], git_sha: "abc" };
    expect(classifySbom(sbom, ["a.dmg", "a.zip"]).status).toBe("verified");
    expect(classifySbom(sbom, ["a.dmg", "b.exe"]).status).toBe("incomplete");
    expect(classifySbom("{bad", ["a.dmg"]).status).toBe("incomplete");
  });
});

describe("buildReport state machine (built→verified→rehearsed→accepted|partial|rejected)", () => {
  const provenance = { id: "cand", sha: "a".repeat(40), version: "0.1.0", builtAt: new Date().toISOString(), headSha: "a".repeat(40), headMismatch: false };
  const artifacts = [{ name: "x.dmg", sha256: "h", size: 100 }];
  const e2ePass = { valid: true, pass: true, failed: false, count: 13, skipped: 0, missingSuites: [], stale: false, reason: null };
  const ALL_SCENARIOS = ["launch-smoke", "install-uninstall", "update-interruption", "corrupt-package-reject", "restart-recovery", "rollback-last-known-good", "hard-kill-no-orphans"];
  const full = (over = {}) => buildReport({
    provenance,
    artifacts,
    drift: [],
    manifestOk: true,
    agentBinsOk: true,
    e2e: e2ePass,
    signature: { status: "signed", detail: "" },
    sbom: { status: "verified", detail: "" },
    platformsBuilt: ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"],
    scenariosExercised: ALL_SCENARIOS,
    ...over,
  });

  it("accepted only when every platform/scenario/e2e/signature/sbom is complete", () => {
    const r = full();
    expect(r.state).toBe("accepted");
    expect(r.accepted).toBe(true);
    expect(r.promotable).toBe(true);
  });

  it("PARTIAL when platforms are missing — macOS-only rehearsal is never accepted (Codex r2 P1-3)", () => {
    const r = full({ platformsBuilt: ["darwin-arm64"] });
    expect(r.state).toBe("partial");
    expect(r.accepted).toBe(false);
    expect(r.promotable).toBe(false);
    expect(r.report["missing-for-acceptance"].platforms).toEqual(["darwin-x64", "win32-x64", "linux-x64"]);
  });

  it("PARTIAL when scenarios are missing", () => {
    const r = full({ scenariosExercised: ["launch-smoke"] });
    expect(r.state).toBe("partial");
    expect(r.report["missing-for-acceptance"].scenarios).toContain("rollback-last-known-good");
  });

  it("REJECTED on checksum drift (corrupted candidate)", () => {
    const r = full({ drift: [{ name: "x.dmg", expected: "h1", actual: "h2" }] });
    expect(r.state).toBe("rejected");
    expect(r.accepted).toBe(false);
  });

  it("REJECTED on manifest verify failure / missing agent bins", () => {
    expect(full({ manifestOk: false }).state).toBe("rejected");
    expect(full({ agentBinsOk: false }).state).toBe("rejected");
  });

  it("REJECTED when e2e ran and failed (unexpected failures)", () => {
    const r = full({ e2e: { ...e2ePass, pass: false, failed: true, reason: "2 unexpected failure(s)" } });
    expect(r.state).toBe("rejected");
  });

  it("PARTIAL (not rejected) when e2e evidence is stale or absent", () => {
    const stale = full({ e2e: { ...e2ePass, pass: false, failed: false, stale: true, reason: "stale" } });
    expect(stale.state).toBe("partial");
    const absent = full({ e2e: { valid: false, pass: false, failed: false, count: 0, skipped: 0, missingSuites: REQUIRED_E2E_SUITES, stale: false, reason: "no e2e results.json" } });
    expect(absent.state).toBe("partial");
  });

  it("PARTIAL when SBOM is missing or incomplete", () => {
    expect(full({ sbom: { status: "missing", detail: "" } }).state).toBe("partial");
    expect(full({ sbom: { status: "incomplete", detail: "sbom missing artifacts: x.dmg" } }).state).toBe("partial");
  });

  it("provenance mismatch (HEAD ≠ build SHA) is reported, not fatal", () => {
    const r = full({ provenance: { ...provenance, headSha: "b".repeat(40), headMismatch: true, headMismatchNote: "note" } });
    expect(r.state).toBe("accepted"); // rehearsing an older candidate is legitimate
    expect(r.report.candidate.headMismatch).toBe(true);
  });
});

describe("applyTerminalStickiness — rejected candidates can never be promoted (Codex r2 P1-2)", () => {
  it("a previously rejected candidate stays rejected even if a re-run would pass", () => {
    const acceptedNow = { state: "accepted", accepted: true, promotable: true, report: {} };
    const sticky = applyTerminalStickiness({ state: "rejected" }, acceptedNow);
    expect(sticky.state).toBe("rejected");
    expect(sticky.promotable).toBe(false);
    expect(sticky.report.note).toMatch(/sticky/);
  });

  it("a previously accepted candidate stays accepted on a failing re-run", () => {
    const sticky = applyTerminalStickiness({ state: "accepted" }, { state: "rejected", accepted: false, promotable: false, report: {} });
    expect(sticky.state).toBe("accepted");
  });

  it("non-terminal previous states pass through untouched", () => {
    const out = applyTerminalStickiness({ state: "partial" }, { state: "accepted", accepted: true, promotable: true, report: {} });
    expect(out.state).toBe("accepted");
  });
});

describe("main() integration (Codex r2 P3-1)", () => {
  /** Fixture candidate dir with a consistent feed manifest + embedded agent. */
  function writeFixture({ withApp = true, withSbom = true, corrupt = false } = {}) {
    const candDir = path.join(tmp, "candidates", "cand-1");
    fs.mkdirSync(candDir, { recursive: true });
    const dmg = Buffer.from("dmg-bytes");
    fs.writeFileSync(path.join(candDir, "a.dmg"), corrupt ? Buffer.from("tampered") : dmg);
    const zip = Buffer.from("zip-bytes");
    fs.writeFileSync(path.join(candDir, "a.zip"), zip);
    const manifest = [
      "version: 0.1.0",
      "files:",
      "  - url: a.zip",
      `    sha512: ${crypto.createHash("sha512").update(zip).digest("base64")}`,
      `    size: ${zip.length}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(candDir, "latest-mac.yml"), manifest);
    if (withApp) {
      const agent = path.join(candDir, "mac-arm64", "Grok Build.app", "Contents", "Resources", "xai-grok-pager");
      fs.mkdirSync(path.dirname(agent), { recursive: true });
      fs.writeFileSync(agent, "agent-bin");
    }
    const sbomBody = JSON.stringify({ git_sha: "fix", artifacts: ["a.dmg", "a.zip"] });
    if (withSbom) {
      fs.writeFileSync(path.join(candDir, "sbom.json"), sbomBody);
    }
    const stamp = {
      id: "cand-1",
      sha: "f".repeat(40),
      version: "0.1.0",
      builtAt: new Date(Date.now() - 60_000).toISOString(),
      platforms: ["darwin-arm64"],
      files: [
        { name: "a.dmg", sha256: sha(dmg), size: dmg.length },
        { name: "a.zip", sha256: sha(zip), size: zip.length },
        ...(withSbom ? [{ name: "sbom.json", sha256: sha(Buffer.from(sbomBody)), size: sbomBody.length }] : []),
      ],
    };
    fs.writeFileSync(path.join(candDir, "candidate-manifest.json"), JSON.stringify(stamp));
    // fresh e2e results (mtime now > builtAt)
    const e2eDir = path.join(tmp, "e2e-results");
    fs.mkdirSync(e2eDir, { recursive: true });
    fs.writeFileSync(
      path.join(e2eDir, "results.json"),
      JSON.stringify({
        stats: { expected: 13, unexpected: 0, skipped: 0 },
        suites: REQUIRED_E2E_SUITES.map((f) => ({ file: `e2e/${f}` })),
      })
    );
    return { candDir, e2eResultsPath: path.join(e2eDir, "results.json") };
  }

  it("macOS-only fixture → PARTIAL (exit 2), report persisted with the build-stamp SHA", () => {
    const { candDir, e2eResultsPath } = writeFixture();
    const candidatesDir = path.dirname(candDir);
    const code = main(["--id", "cand-1"], { candidatesDir, e2eResultsPath });
    expect(code).toBe(2);
    const report = JSON.parse(fs.readFileSync(path.join(candDir, "candidate-report.json"), "utf-8"));
    expect(report.state).toBe("partial");
    expect(report.candidate.sha).toBe("f".repeat(40)); // provenance = BUILD stamp, not HEAD
    expect(report["missing-for-acceptance"].platforms).toContain("win32-x64");
    expect(fs.existsSync(path.join(candDir, "candidate-report.md"))).toBe(true);
    expect(fs.existsSync(path.join(candDir, "rehearsal-runs.jsonl"))).toBe(true);
  });

  it("corrupted artifact → REJECTED (exit 1) and the terminal state sticks across a re-run", () => {
    const { candDir, e2eResultsPath } = writeFixture({ corrupt: true });
    const candidatesDir = path.dirname(candDir);
    expect(main(["--id", "cand-1"], { candidatesDir, e2eResultsPath })).toBe(1);
    // fix the artifact, re-run: still rejected (sticky)
    fs.writeFileSync(path.join(candDir, "a.dmg"), "dmg-bytes");
    expect(main(["--id", "cand-1"], { candidatesDir, e2eResultsPath })).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(candDir, "candidate-report.json"), "utf-8"));
    expect(report.state).toBe("rejected");
    expect(report.note).toMatch(/sticky|never be promoted/);
  });

  it("missing SBOM → PARTIAL with the gap recorded", () => {
    const { candDir, e2eResultsPath } = writeFixture({ withSbom: false });
    const code = main(["--id", "cand-1"], { candidatesDir: path.dirname(candDir), e2eResultsPath });
    expect(code).toBe(2);
    const report = JSON.parse(fs.readFileSync(path.join(candDir, "candidate-report.json"), "utf-8"));
    expect(report["missing-for-acceptance"].sbom.length).toBeGreaterThan(0);
  });
});
