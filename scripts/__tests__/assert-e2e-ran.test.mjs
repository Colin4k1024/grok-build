// @vitest-environment node
import { describe, it, expect } from "vitest";
import { checkReport } from "../assert-e2e-ran.mjs";

describe("assert-e2e-ran (R6-01 #279)", () => {
  it("fails when there is no report object (Playwright never ran)", () => {
    expect(checkReport(null).ok).toBe(false);
    expect(checkReport(undefined).ok).toBe(false);
    expect(checkReport("string").ok).toBe(false);
  });

  it("fails when the report has no stats block", () => {
    expect(checkReport({ suites: [] }).ok).toBe(false);
    expect(checkReport({ stats: null }).ok).toBe(false);
  });

  it("fails when zero tests ran as expected — vacuous pass blocked", () => {
    // all-skipped: Playwright exits 0 but no test executed
    const allSkipped = { stats: { expected: 0, skipped: 3, passed: 0, failed: 0 } };
    expect(checkReport(allSkipped).ok).toBe(false);
    expect(checkReport(allSkipped).reason).toMatch(/vacuous/);
    // no tests matched at all
    const none = { stats: { expected: 0, skipped: 0, passed: 0, failed: 0 } };
    expect(checkReport(none).ok).toBe(false);
  });

  it("passes when at least one test ran to an expected outcome", () => {
    const ok = { stats: { expected: 4, skipped: 0, passed: 4, failed: 0, unexpected: 0 } };
    expect(checkReport(ok).ok).toBe(true);
    // some failures but tests ran — Playwright itself failed the job; the guard
    // only blocks the vacuous case, not legitimate failures
    const withFailure = { stats: { expected: 4, skipped: 0, passed: 3, failed: 1, unexpected: 1 } };
    expect(checkReport(withFailure).ok).toBe(true);
  });

  it("rejects non-numeric / missing expected counts defensively", () => {
    expect(checkReport({ stats: { expected: undefined } }).ok).toBe(false);
    expect(checkReport({ stats: { expected: "lots" } }).ok).toBe(false);
    expect(checkReport({ stats: {} }).ok).toBe(false);
  });
});
