// @vitest-environment node
import { describe, it, expect } from "vitest";
import { checkCreds, REQUIRED_SECRETS, main } from "../check-release-creds.mjs";

const VALID = {
  CSC_LINK: "A".repeat(64), // base64-ish p12 blob (≥32)
  CSC_KEY_PASSWORD: "p@ssw0rd",
  APPLE_API_KEY: "B".repeat(64), // base64-ish .p8 blob (≥32)
  APPLE_API_KEY_ID: "ABCDE12345", // 10-char alnum App Store Connect key ID
  APPLE_API_ISSUER: "12345678-1234-1234-1234-123456789012", // UUID
};

describe("check-release-creds (R6-05 #283)", () => {
  it("passes when all required secrets are present + well-formed", () => {
    const r = checkCreds(VALID);
    expect(r.ok).toBe(true);
    expect(r.passed).toHaveLength(5);
    expect(r.failures).toEqual([]);
  });

  it("fails closed on a missing secret", () => {
    const r = checkCreds({ ...VALID, CSC_LINK: undefined });
    expect(r.ok).toBe(false);
    expect(r.failures.find((f) => f.name === "CSC_LINK").reason).toMatch(/missing/);
  });

  it("fails closed on a malformed secret (wrong shape)", () => {
    const r = checkCreds({ ...VALID, APPLE_API_KEY_ID: "too-short" });
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.name === "APPLE_API_KEY_ID");
    expect(f).toBeTruthy();
    expect(f.reason).toMatch(/malformed|alphanumeric/);
  });

  it("fails closed on an empty secret", () => {
    const r = checkCreds({ ...VALID, CSC_KEY_PASSWORD: "" });
    expect(r.ok).toBe(false);
    expect(r.failures.find((f) => f.name === "CSC_KEY_PASSWORD")).toBeTruthy();
  });

  it("lists all 5 required secrets", () => {
    // copy before sort so the module-level export isn't mutated in place
    // (shared-state pollution in a security-invariant test file, Codex r3 P3).
    expect([...REQUIRED_SECRETS].sort()).toEqual(
      ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "CSC_KEY_PASSWORD", "CSC_LINK"].sort(),
    );
  });

  describe("REDACTION INVARIANT — values never appear in any output path (Codex #283 non-goal)", () => {
    // A real-looking sensitive value must not leak into failures/reasons.
    const SECRET_VALUE = "SUPER-SECRET-P12-DATA-1234567890";
    it("checkCreds failures carry only names + generic reasons, not values", () => {
      // missing CSC_LINK (others valid including a sensitive APPLE_API_KEY)
      const creds = { ...VALID, CSC_LINK: undefined, APPLE_API_KEY: SECRET_VALUE };
      const r = checkCreds(creds);
      const serialized = JSON.stringify(r);
      expect(serialized).not.toContain(SECRET_VALUE);
      // the present secrets' values are not echoed anywhere
      expect(r.passed).toContain("APPLE_API_KEY"); // name is fine
      expect(serialized).not.toContain("p@ssw0rd");
    });

    it("main() stdout/stderr never print a value (missing-secret path)", () => {
      const origEnv = { ...process.env };
      const origOut = console.log, origErr = console.error;
      process.env = { ...VALID, CSC_LINK: undefined, APPLE_API_KEY: SECRET_VALUE };
      const out = [], err = [];
      console.log = (s) => out.push(String(s));
      console.error = (s) => err.push(String(s));
      const code = main([]);
      console.log = origOut;
      console.error = origErr;
      process.env = origEnv;
      const all = out.join(" ") + " " + err.join(" ");
      expect(code).toBe(1); // fail closed
      expect(all).not.toContain(SECRET_VALUE); // no value leak
      expect(all).toMatch(/CSC_LINK/); // name is reported
    });

    it("main() --json never prints a value (all-valid path)", () => {
      const origEnv = { ...process.env };
      const origOut = console.log;
      process.env = { ...VALID, CSC_LINK: SECRET_VALUE };
      const out = [];
      console.log = (s) => out.push(String(s));
      const code = main(["--json"]);
      console.log = origOut;
      process.env = origEnv;
      const json = out.join(" ");
      expect(code).toBe(0);
      expect(json).not.toContain(SECRET_VALUE); // no value in the JSON report
      expect(json).toMatch(/"CSC_LINK"/); // name only
    });
  });
});
