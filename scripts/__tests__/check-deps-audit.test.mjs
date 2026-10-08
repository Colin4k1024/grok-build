// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  parseAudit,
  isAuditReport,
  validateException,
  validateExceptions,
  checkFindings,
  main,
} from "../check-deps-audit.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sampleAudit = {
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 1, total: 3 } },
  vulnerabilities: {
    vitest: { severity: "critical", via: [{ name: "tinypool" }], fixAvailable: { name: "vitest", version: "5.0.3", isSemVerMajor: true }, range: "<=4.1.10" },
    vite: { severity: "high", via: ["vite"], fixAvailable: { name: "vite", version: "8.3.3", isSemVerMajor: true }, range: "<=6.4.2" },
    "http-cache-semantics": { severity: "moderate", via: ["http-cache-semantics"], fixAvailable: true, range: "<=4.2.0" },
  },
};

describe("check-deps-audit (R6-03 #281)", () => {
  it("parseAudit flattens vulnerabilities + totals", () => {
    const { findings, totals } = parseAudit(sampleAudit);
    expect(findings).toHaveLength(3);
    expect(findings.find((f) => f.name === "vitest").severity).toBe("critical");
    expect(findings.find((f) => f.name === "vite").fixAvailable.isSemVerMajor).toBe(true);
    expect(findings.find((f) => f.name === "http-cache-semantics").fixAvailable.available).toBe(true);
    expect(totals.total).toBe(3);
  });

  it("parseAudit tolerates empty/invalid input", () => {
    expect(parseAudit(null).findings).toEqual([]);
    expect(parseAudit({}).findings).toEqual([]);
  });

  it("validateException passes a complete, non-expired entry", () => {
    const exc = { package: "vitest", severity: "critical", exposure: "dev", owner: "rel", mitigation: "upgrade", expires: "2099-01-01" };
    expect(validateException(exc, new Date("2026-01-01")).ok).toBe(true);
  });

  it("validateException fails on missing owner/expiry/mitigation", () => {
    const r = validateException({ package: "vitest", severity: "critical", exposure: "dev", expires: "2099-01-01" }, new Date("2026-01-01"));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/owner/);
  });

  it("validateException fails on an expired entry", () => {
    const r = validateException({ package: "vitest", severity: "critical", exposure: "dev", owner: "rel", mitigation: "x", expires: "2020-01-01" }, new Date("2026-01-01"));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/expired/);
  });

  it("validateException fails on a malformed date", () => {
    const r = validateException({ package: "vitest", severity: "critical", exposure: "dev", owner: "rel", mitigation: "x", expires: "not-a-date" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not a valid date/);
  });

  it("validateExceptions aggregates errors across the file", () => {
    const doc = { exceptions: [
      { package: "vitest", severity: "critical", exposure: "dev", owner: "rel", mitigation: "x", expires: "2099-01-01" },
      { package: "vite", severity: "high", exposure: "build", owner: "", mitigation: "x", expires: "2099-01-01" }, // missing owner
    ] };
    const r = validateExceptions(doc, new Date("2026-01-01"));
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/exceptions\[1\] \(vite\).*owner/);
  });

  it("checkFindings fails on an unowned critical/high finding (no matching exception)", () => {
    const { findings } = parseAudit(sampleAudit);
    const { unowned, owned } = checkFindings(findings, { exceptions: [] });
    // critical (vitest) + high (vite) above the bar; moderate (http-cache-semantics) below
    expect(unowned.length).toBe(2);
    expect(unowned.find((f) => f.name === "vitest")).toBeTruthy();
    expect(unowned.find((f) => f.name === "vite")).toBeTruthy();
    expect(owned.length).toBe(0);
  });

  it("checkFindings flags an owned finding whose exception is invalid (expired)", () => {
    const { findings } = parseAudit(sampleAudit);
    const doc = { exceptions: [
      { package: "vitest", severity: "critical", exposure: "dev", owner: "rel", mitigation: "x", expires: "2020-01-01" }, // expired
    ] };
    const { unowned } = checkFindings(findings, doc, { now: new Date("2026-01-01") });
    // vitest's exception is expired -> it counts as unowned; vite has no exception -> unowned
    expect(unowned.length).toBe(2);
    const vit = unowned.find((f) => f.name === "vitest");
    expect(vit._exceptionErrors.join(" ")).toMatch(/expired/);
  });

  it("checkFindings passes when every critical/high finding has a valid exception", () => {
    const { findings } = parseAudit(sampleAudit);
    const doc = { exceptions: [
      { package: "vitest", severity: "critical", exposure: "dev", owner: "rel", mitigation: "x", expires: "2099-01-01" },
      { package: "vite", severity: "high", exposure: "build", owner: "rel", mitigation: "x", expires: "2099-01-01" },
    ] };
    const { unowned, owned } = checkFindings(findings, doc, { now: new Date("2026-01-01") });
    expect(unowned).toEqual([]);
    expect(owned.length).toBe(2); // vitest + vite
  });

  it("checkFindings ignores moderate and below (below the owned bar)", () => {
    const { findings } = parseAudit(sampleAudit);
    const { unowned } = checkFindings(findings, { exceptions: [] });
    // http-cache-semantics is moderate -> not in unowned
    expect(unowned.find((f) => f.name === "http-cache-semantics")).toBeFalsy();
  });

  describe("fail closed on a non-report payload (Codex r1 P1)", () => {
    // npm audit on a registry/transport error exits non-zero with error-shaped
    // JSON (no `vulnerabilities` key). The gate must NOT parse this into zero
    // findings and pass — it must fail closed.
    const errorPayload = { message: "404 Not Found - POST .../audits/quick", error: "[NOT_IMPLEMENTED]" };

    it("isAuditReport rejects an npm/registry error payload", () => {
      expect(isAuditReport(errorPayload)).toBe(false);
      expect(isAuditReport(null)).toBe(false);
      expect(isAuditReport({})).toBe(false);
    });

    it("isAuditReport accepts a real audit report", () => {
      expect(isAuditReport(sampleAudit)).toBe(true);
      expect(isAuditReport({ auditReportVersion: "2.0", vulnerabilities: {} })).toBe(true);
    });

    it("parseAudit of an error payload yields zero findings (the hazard)", () => {
      // This is the vacuous-pass hazard: without isAuditReport gating upstream,
      // an error payload parses to 0 findings. main() must guard with isAuditReport.
      const { findings } = parseAudit(errorPayload);
      expect(findings).toEqual([]);
    });
  });

  describe("malformed exceptions file (Codex r2 P3)", () => {
    const { findings } = parseAudit(sampleAudit);

    it("checkFindings does not crash when exceptions is a non-array", () => {
      // a hand-edit mistake: exceptions as an object instead of an array
      expect(() => checkFindings(findings, { exceptions: { not: "an array" } })).not.toThrow();
      const { unowned } = checkFindings(findings, { exceptions: { not: "an array" } });
      // vitest (critical) + vite (high) are unowned because no valid exceptions
      expect(unowned.length).toBe(2);
    });

    it("checkFindings skips null/non-object entries without crashing", () => {
      expect(() => checkFindings(findings, { exceptions: [null, "nope", { package: "vitest", severity: "critical", exposure: "dev", owner: "r", mitigation: "x", expires: "2099-01-01" }] })).not.toThrow();
      const { unowned, owned } = checkFindings(findings, { exceptions: [null, "nope", { package: "vitest", severity: "critical", exposure: "dev", owner: "r", mitigation: "x", expires: "2099-01-01" }] }, { now: new Date("2026-01-01") });
      expect(owned.length).toBe(1); // vitest covered
      expect(unowned.length).toBe(1); // vite unowned
    });
  });

  describe("severity-cover matching (Codex r3 P2)", () => {
    // A NEW higher-severity advisory on an excepted package must be flagged
    // unowned for re-triage; name-only matching would silently accept it.
    it("a higher-severity finding on an excepted package is unowned", () => {
      const findings = [{ name: "electron-builder", severity: "critical", via: ["x"], fixAvailable: { available: false }, range: "" }];
      const doc = { exceptions: [{ package: "electron-builder", severity: "moderate", exposure: "build", owner: "r", mitigation: "x", expires: "2099-01-01" }] };
      const { unowned, owned } = checkFindings(findings, doc, { now: new Date("2026-01-01") });
      expect(owned.length).toBe(0);
      expect(unowned.length).toBe(1); // critical > moderate -> re-triage
    });

    it("an equal-or-lower severity finding on an excepted package is owned", () => {
      const findings = [{ name: "vite", severity: "high", via: ["x"], fixAvailable: { available: false }, range: "" }];
      const doc = { exceptions: [{ package: "vite", severity: "high", exposure: "build", owner: "r", mitigation: "x", expires: "2099-01-01" }] };
      const { unowned, owned } = checkFindings(findings, doc, { now: new Date("2026-01-01") });
      expect(owned.length).toBe(1);
      expect(unowned.length).toBe(0);
    });
  });

  describe("malformed JSON inputs fail closed with a named file (Codex r4 P3)", () => {
    it("main() returns 1 and names the file when --audit-file is invalid JSON", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-audit-"));
      const bad = path.join(tmp, "bad.json");
      fs.writeFileSync(bad, "{ not valid json");
      const orig = console.error;
      const errs = [];
      console.error = (s) => errs.push(String(s));
      const code = main(["--audit-file", bad]);
      console.error = orig;
      fs.rmSync(tmp, { recursive: true, force: true });
      expect(code).toBe(1);
      expect(errs.join(" ")).toMatch(/not valid JSON/);
      expect(errs.join(" ")).toContain(bad);
    });
  });

  describe("--audit-file arg parsing (Codex r6 P3)", () => {
    // both forms must work; a missing value must error rather than silently
    // fall back to a live audit (which would gate on the wrong input).
    // The fixture is created in beforeAll (NOT the describe body — that runs at
    // collection time, before `it`, so the file would be gone and the tests
    // would exercise the ENOENT path instead of the gating path, Codex r7 P2).
    // The fixture contains a ROGUE package NOT in the real exception file, so
    // the gate reaches the unowned-critical path (exit 1 + "unowned" on stderr),
    // distinguishing the gating path from the ENOENT error path.
    const rogueAudit = {
      auditReportVersion: "2",
      metadata: { vulnerabilities: { critical: 1, total: 1 } },
      vulnerabilities: { "rogue-critical-pkg": { severity: "critical", via: [], fixAvailable: { available: false }, range: "*" } },
    };
    const goodReport = path.join(os.tmpdir(), "gb-audit-rogue.json");
    beforeAll(() => fs.writeFileSync(goodReport, JSON.stringify(rogueAudit)));
    afterAll(() => fs.rmSync(goodReport, { force: true }));

    const capture = (args) => {
      const orig = console.error;
      const errs = [];
      console.error = (s) => errs.push(String(s));
      const code = main(args);
      console.error = orig;
      return { code, err: errs.join(" ") };
    };

    it("accepts the space form: --audit-file <path> (gating path, not ENOENT)", () => {
      const { code, err } = capture(["--audit-file", goodReport]);
      expect(code).toBe(1); // rogue-critical-pkg is unowned (not in the real exception file)
      expect(err).toMatch(/unowned critical\/high/); // gating path, not the ENOENT error path
    });

    it("accepts the equals form: --audit-file=<path> (gating path, not ENOENT)", () => {
      const { code, err } = capture([`--audit-file=${goodReport}`]);
      expect(code).toBe(1);
      expect(err).toMatch(/unowned critical\/high/);
    });

    it("errors on a missing value (bare --audit-file)", () => {
      const { code, err } = capture(["--audit-file"]);
      expect(code).toBe(1);
      expect(err).toMatch(/requires a value/);
    });

    it("errors on --audit-file= with an empty value", () => {
      const { code, err } = capture(["--audit-file="]);
      expect(code).toBe(1);
      expect(err).toMatch(/requires a value/);
    });
  });

  describe("prototype-chain severity bypass (Codex r5 P3)", () => {    // `in` matched inherited Object.prototype keys; "constructor"/"toString"
    // as a severity was treated as known and yielded the Object constructor as
    // a rank (function < N is NaN -> false -> silently owned any finding).
    it("validateException rejects a prototype-chain severity like 'constructor'", () => {
      const r = validateException({ package: "vite", severity: "constructor", exposure: "build", owner: "r", mitigation: "x", expires: "2099-01-01" });
      expect(r.ok).toBe(false);
      expect(r.errors.join(" ")).toMatch(/not a known npm severity/);
    });

    it("checkFindings treats a 'constructor'-severity exception as NOT covering (re-triage)", () => {
      const findings = [{ name: "vite", severity: "high", via: ["x"], fixAvailable: { available: false }, range: "" }];
      const doc = { exceptions: [{ package: "vite", severity: "constructor", exposure: "build", owner: "r", mitigation: "x", expires: "2099-01-01" }] };
      const { unowned, owned } = checkFindings(findings, doc, { now: new Date("2026-01-01") });
      expect(owned.length).toBe(0);
      expect(unowned.length).toBe(1); // not covered -> re-triage
    });
  });
});
