// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listCandidates, parseExceptions, buildDecision, main } from "../go-no-go.mjs";

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-gonogo-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("primitives (R6-07 #285)", () => {
  it("listCandidates picks dirs carrying a stamped manifest", () => {
    const dirs = { "cand-a": ["candidate-manifest.json", "a.dmg"], "junk": ["x"] };
    expect(listCandidates(dirs)).toEqual(["cand-a"]);
  });

  it("parseExceptions flags expired entries", () => {
    const ex = parseExceptions(
      JSON.stringify({
        exceptions: [
          { id: "old", reason: "r", expiresAt: "2000-01-01T00:00:00Z" },
          { id: "new", reason: "r", expiresAt: "2099-01-01T00:00:00Z" },
        ],
      })
    );
    expect(ex.find((e) => e.id === "old").expired).toBe(true);
    expect(ex.find((e) => e.id === "new").expired).toBe(false);
    expect(parseExceptions("{bad")).toEqual([]);
  });
});

describe("buildDecision state machine (collecting → ready_for_decision → approved|rejected)", () => {
  const base = { sha: "a".repeat(40), version: "0.1.0", residualRisks: [] };

  it("collecting while evidence gaps remain", () => {
    const r = buildDecision({ ...base, gaps: ["no e2e"], blocking: [], decision: null });
    expect(r.state).toBe("collecting");
    expect(r.go).toBe(false);
  });

  it("rejected on hard blockers", () => {
    const r = buildDecision({ ...base, gaps: [], blocking: ["rehearsal rejected"], decision: null });
    expect(r.state).toBe("rejected");
    expect(r.go).toBe(false);
  });

  it("ready_for_decision when evidence is complete and no human record exists", () => {
    const r = buildDecision({ ...base, gaps: [], blocking: [], decision: null });
    expect(r.state).toBe("ready_for_decision");
    expect(r.go).toBe(false); // ready ≠ go
  });

  it("approved ONLY via an explicit human record", () => {
    const r = buildDecision({ ...base, gaps: [], blocking: [], decision: { approver: "fanjia2", grantedBy: "human", at: "now" } });
    expect(r.state).toBe("approved");
    expect(r.go).toBe(true);
  });

  it("a human record cannot override new hard blockers", () => {
    const r = buildDecision({ ...base, gaps: [], blocking: ["expired exception"], decision: { approver: "x", grantedBy: "human", at: "now" } });
    expect(r.state).toBe("rejected");
    expect(r.go).toBe(false);
  });

  it("tooling can never self-approve (grantedBy must be human)", () => {
    // the CLI treats non-human records as absent AND blocks malformed ones;
    // buildDecision itself only honors grantedBy==='human'
    const r = buildDecision({ ...base, gaps: [], blocking: [], decision: { approver: "bot", grantedBy: "automation", at: "now" } });
    expect(r.state).toBe("ready_for_decision");
    expect(r.go).toBe(false);
  });
});

describe("main() integration (R6-07 #285)", () => {
  function fixture({ rehearsalState = "partial", decision = null, builtAt = new Date().toISOString(), rehearsalSha = "f".repeat(40) } = {}) {
    const candDir = path.join(tmp, "candidates", "cand-1");
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(
      path.join(candDir, "candidate-manifest.json"),
      JSON.stringify({ id: "cand-1", sha: "f".repeat(40), version: "0.1.0", builtAt, platforms: ["darwin-arm64"], files: [] })
    );
    fs.writeFileSync(
      path.join(candDir, "candidate-report.json"),
      JSON.stringify({
        state: rehearsalState,
        accepted: rehearsalState === "accepted",
        candidate: { sha: rehearsalSha },
        "missing-for-acceptance": rehearsalState === "partial" ? { platforms: ["win32-x64"] } : {},
        note: rehearsalState === "rejected" ? "corrupted" : "incomplete",
      })
    );
    if (decision) {
      const dDir = path.join(tmp, "decisions");
      fs.mkdirSync(dDir, { recursive: true });
      fs.writeFileSync(path.join(dDir, `${"f".repeat(40)}.json`), JSON.stringify(decision));
    }
    return { candidatesDir: path.dirname(candDir), decisionsDir: path.join(tmp, "decisions") };
  }

  /** Full evidence env so only the tested dimension varies. */
  function fullEnv(cand) {
    // fresh e2e results + valid runbook + empty exceptions
    const e2e = path.join(tmp, "e2e-results");
    fs.mkdirSync(e2e, { recursive: true });
    fs.writeFileSync(path.join(e2e, "results.json"), "{}");
    const runbook = path.join(tmp, "runbook.md");
    fs.writeFileSync(runbook, "# runbook\nrollback procedure: ...\n");
    const exceptions = path.join(tmp, "exceptions.json");
    fs.writeFileSync(exceptions, JSON.stringify({ exceptions: [] }));
    return { e2eResultsPath: path.join(e2e, "results.json"), runbookPath: runbook, securityExceptionsPath: exceptions, skipBranchProtection: true, ...cand };
  }

  it("partial rehearsal + no decision → collecting (exit 1) with gaps recorded", () => {
    const { candidatesDir, decisionsDir } = fixture();
    const code = main([], { candidatesDir, decisionsDir, ...fullEnv({}) });
    expect(code).toBe(1);
    const log = fs.readFileSync(path.join(candidatesDir, "cand-1", "go-no-go-runs.jsonl"), "utf-8");
    expect(log).toMatch(/collecting/);
  });

  it("rejected rehearsal → rejected (exit 3) regardless of evidence gaps", () => {
    const { candidatesDir, decisionsDir } = fixture({ rehearsalState: "rejected" });
    expect(main([], { candidatesDir, decisionsDir, ...fullEnv({}) })).toBe(3);
  });

  it("complete evidence + no decision → ready_for_decision (exit 0)", () => {
    const { candidatesDir, decisionsDir } = fixture({ rehearsalState: "accepted" });
    expect(main([], { candidatesDir, decisionsDir, ...fullEnv({}) })).toBe(0);
  });

  it("complete evidence + human decision → approved (exit 2)", () => {
    const { candidatesDir, decisionsDir } = fixture({
      rehearsalState: "accepted",
      decision: { approver: "fanjia2", grantedBy: "human", at: "2026-10-08T00:00:00Z" },
    });
    expect(main([], { candidatesDir, decisionsDir, ...fullEnv({}) })).toBe(2);
  });

  it("malformed decision (grantedBy automation) is a blocker, not an approval", () => {
    const { candidatesDir, decisionsDir } = fixture({
      rehearsalState: "accepted",
      decision: { approver: "bot", grantedBy: "automation", at: "now" },
    });
    expect(main([], { candidatesDir, decisionsDir, ...fullEnv({}) })).toBe(3);
  });

  it("rehearsal provenance SHA mismatch → rejected", () => {
    const { candidatesDir, decisionsDir } = fixture({ rehearsalState: "accepted", rehearsalSha: "e".repeat(40) });
    expect(main([], { candidatesDir, decisionsDir, ...fullEnv({}) })).toBe(3);
  });

  it("stale e2e evidence (older than candidate build) → collecting gap", () => {
    const { candidatesDir, decisionsDir } = fixture({ rehearsalState: "accepted", builtAt: new Date(Date.now() + 60_000).toISOString() });
    // candidate built "in the future" ⇒ any existing results file is stale
    expect(main([], { candidatesDir, decisionsDir, ...fullEnv({}) })).toBe(1);
  });

  it("--sha selects only the candidate built from that SHA", () => {
    const { candidatesDir, decisionsDir } = fixture();
    expect(main(["--sha", "e".repeat(40)], { candidatesDir, decisionsDir, ...fullEnv({}) })).toBe(1); // no candidate → collecting
  });

  it("reruns append to the decision log (evidence never overwritten)", () => {
    const { candidatesDir, decisionsDir } = fixture();
    const opts = { candidatesDir, decisionsDir, ...fullEnv({}) };
    main([], opts);
    main([], opts);
    const lines = fs.readFileSync(path.join(candidatesDir, "cand-1", "go-no-go-runs.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("missing exceptions ledger → operator gap, no crash", () => {
    const { candidatesDir, decisionsDir } = fixture({ rehearsalState: "accepted" });
    const env = fullEnv({});
    const code = main([], { candidatesDir, decisionsDir, ...env, securityExceptionsPath: path.join(tmp, "nope.json") });
    expect(code).toBe(1); // gap recorded, not a throw
  });
});
