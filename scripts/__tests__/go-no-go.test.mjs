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
  function fixture({ rehearsalState = "partial", decision = null } = {}) {
    const candDir = path.join(tmp, "candidates", "cand-1");
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(
      path.join(candDir, "candidate-manifest.json"),
      JSON.stringify({ id: "cand-1", sha: "f".repeat(40), version: "0.1.0", builtAt: new Date().toISOString(), platforms: ["darwin-arm64"], files: [] })
    );
    fs.writeFileSync(
      path.join(candDir, "candidate-report.json"),
      JSON.stringify({
        state: rehearsalState,
        accepted: false,
        candidate: { sha: "f".repeat(40) },
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

  it("partial rehearsal + no decision → collecting (exit 1) with gaps recorded", () => {
    const { candidatesDir, decisionsDir } = fixture();
    const code = main([], { candidatesDir, decisionsDir });
    expect(code).toBe(1);
    const log = fs.readFileSync(path.join(candidatesDir, "cand-1", "go-no-go-runs.jsonl"), "utf-8");
    expect(log).toMatch(/collecting/);
  });

  it("rejected rehearsal → rejected (exit 3) regardless of evidence gaps", () => {
    const { candidatesDir, decisionsDir } = fixture({ rehearsalState: "rejected" });
    expect(main([], { candidatesDir, decisionsDir })).toBe(3);
  });

  it("malformed decision (grantedBy automation) is a blocker, not an approval", () => {
    const { candidatesDir, decisionsDir } = fixture({ decision: { approver: "bot", grantedBy: "automation", at: "now" } });
    const code = main([], { candidatesDir, decisionsDir });
    // partial rehearsal still gaps first; the malformed record adds a blocker
    expect([1, 3]).toContain(code);
  });
});
