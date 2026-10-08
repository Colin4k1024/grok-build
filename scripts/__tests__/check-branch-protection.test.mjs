// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRuleset, getRule, verifyRuleset, main, REQUIRED_CHECKS, RULESET_NAME } from "../check-branch-protection.mjs";

const GOOD_RULESET = {
  name: RULESET_NAME,
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: REQUIRED_CHECKS.map((c) => ({ context: c })) } },
    { type: "deletion" },
    { type: "non_fast_forward" },
  ],
  bypass_actors: [],
};

describe("check-branch-protection (R6-04 #282)", () => {
  it("findRuleset locates by name", () => {
    expect(findRuleset([GOOD_RULESET, { name: "other" }])?.name).toBe(RULESET_NAME);
    expect(findRuleset([])).toBeNull();
    expect(findRuleset(null)).toBeNull();
  });

  it("getRule extracts a rule by type", () => {
    expect(getRule(GOOD_RULESET, "deletion")?.type).toBe("deletion");
    expect(getRule(GOOD_RULESET, "non_fast_forward")?.type).toBe("non_fast_forward");
    expect(getRule(GOOD_RULESET, "nonexistent")).toBeNull();
  });

  it("verifyRuleset passes a fully-compliant ruleset", () => {
    const { ok, checks } = verifyRuleset(GOOD_RULESET);
    expect(ok).toBe(true);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("verifyRuleset fails when the ruleset is missing", () => {
    const { ok, checks } = verifyRuleset(null);
    expect(ok).toBe(false);
    expect(checks[0].name).toBe("ruleset exists");
  });

  it("verifyRuleset fails when enforcement is not active (e.g. disabled for emergency)", () => {
    const r = { ...GOOD_RULESET, enforcement: "disabled" };
    const { ok } = verifyRuleset(r);
    expect(ok).toBe(false);
  });

  it("verifyRuleset fails when a required check is missing", () => {
    const r = JSON.parse(JSON.stringify(GOOD_RULESET));
    r.rules[1].parameters.required_status_checks = [{ context: "Test + Typecheck + Build" }];
    const { ok, checks } = verifyRuleset(r);
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === "required status checks").ok).toBe(false);
  });

  it("verifyRuleset fails when strict policy is off (stale SHA could merge)", () => {
    const r = JSON.parse(JSON.stringify(GOOD_RULESET));
    r.rules[1].parameters.strict_required_status_checks_policy = false;
    const { ok, checks } = verifyRuleset(r);
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === "strict (head SHA == checked SHA)").ok).toBe(false);
  });

  it("verifyRuleset fails when force-push is allowed (no non_fast_forward rule)", () => {
    const r = { ...GOOD_RULESET, rules: GOOD_RULESET.rules.filter((rule) => rule.type !== "non_fast_forward") };
    const { ok, checks } = verifyRuleset(r);
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === "blocks force-push").ok).toBe(false);
  });

  it("verifyRuleset fails when a permanent bypass actor exists", () => {
    const r = { ...GOOD_RULESET, bypass_actors: [{ actor_id: 123, actor_type: "User" }] };
    const { ok, checks } = verifyRuleset(r);
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === "no permanent bypass").ok).toBe(false);
  });

  it("verifyRuleset fails when it doesn't target main", () => {
    const r = { ...GOOD_RULESET, conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } } };
    const { ok, checks } = verifyRuleset(r);
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === "targets main").ok).toBe(false);
  });

  describe("PR parameter assertions (Codex r1 P2)", () => {
    it("fails when required_approving_review_count is 0", () => {
      const r = JSON.parse(JSON.stringify(GOOD_RULESET));
      r.rules[0].parameters.required_approving_review_count = 0;
      const { ok, checks } = verifyRuleset(r);
      expect(ok).toBe(false);
      expect(checks.find((c) => c.name === "requires pull request").ok).toBe(false);
    });

    it("fails when dismiss_stale_reviews_on_push is false", () => {
      const r = JSON.parse(JSON.stringify(GOOD_RULESET));
      r.rules[0].parameters.dismiss_stale_reviews_on_push = false;
      const { ok } = verifyRuleset(r);
      expect(ok).toBe(false);
    });
  });

  describe("full-ruleset fetch (Codex r1 P1)", () => {
    it("main() with --ruleset-file reads a single full ruleset object (not a list)", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-ruleset-"));
      const file = path.join(tmp, "ruleset.json");
      fs.writeFileSync(file, JSON.stringify(GOOD_RULESET));
      const orig = console.log;
      const out = [];
      console.log = (s) => out.push(String(s));
      const code = main(["--ruleset-file", file]);
      console.log = orig;
      fs.rmSync(tmp, { recursive: true, force: true });
      expect(code).toBe(0); // GOOD_RULESET is fully compliant
      expect(out.join(" ")).toMatch(/PASS.*enforcement active/);
    });
  });
});
