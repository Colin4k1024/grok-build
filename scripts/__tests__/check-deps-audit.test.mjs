// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  parseAudit,
  validateException,
  validateExceptions,
  checkFindings,
} from "../check-deps-audit.mjs";

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
});
