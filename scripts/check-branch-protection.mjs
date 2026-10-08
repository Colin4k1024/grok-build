// Branch-protection verification (R6-04 / #282).
//
// Verifies the `main` branch protection ruleset enforces the required-checks +
// review + no-force-push + no-deletion policy. Pure functions operate on a
// ruleset descriptor (the GET /repos/{o}/{r}/rulesets response shape); main()
// fetches the live ruleset via gh API and checks it. The emergency bypass is a
// documented admin-disable procedure (docs/adr/0008-branch-protection.md), NOT
// a permanent bypass actor — so this verifier also asserts no bypass_actors.
//
// Usage: node scripts/check-branch-protection.mjs [--json]
//        node scripts/check-branch-protection.mjs --ruleset-file <path>   # offline/testable

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Stable required checks (GitHub-hosted jobs that run on every PR). The e2e job
// runs on a self-hosted runner ([self-hosted, macos-selfhosted]) and is
// monitored but NOT a hard merge gate — requiring it would block PRs when the
// runner is offline (documented in docs/adr/0008-branch-protection.md).
export const REQUIRED_CHECKS = [
  "Test + Typecheck + Build",
  "Rust PTY controller (ubuntu-latest)",
  "Rust PTY controller (macos-latest)",
];

export const RULESET_NAME = "main-protection";

/** Find the main-protection ruleset in a list of rulesets. Pure. */
export function findRuleset(rulesets, name = RULESET_NAME) {
  if (!Array.isArray(rulesets)) return null;
  return rulesets.find((r) => r.name === name) || null;
}

/** Extract the rule of a given type from a ruleset. Pure. */
export function getRule(ruleset, type) {
  if (!ruleset || !Array.isArray(ruleset.rules)) return null;
  return ruleset.rules.find((r) => r.type === type) || null;
}

/**
 * Verify a ruleset enforces the policy. Pure — no IO.
 * @returns {{ ok: boolean; checks: {name:string; ok:boolean; detail:string}[] }}
 */
export function verifyRuleset(ruleset, { requiredChecks = REQUIRED_CHECKS, targetBranch = "main" } = {}) {
  const checks = [];
  if (!ruleset) {
    return { ok: false, checks: [{ name: "ruleset exists", ok: false, detail: `ruleset "${RULESET_NAME}" not found` }] };
  }
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push("enforcement active", ruleset.enforcement === "active", `enforcement=${ruleset.enforcement}`);
  const conds = ruleset.conditions?.ref_name;
  push("targets main", Array.isArray(conds?.include) && conds.include.includes(`refs/heads/${targetBranch}`), `include=${conds?.include?.join(",") || "(none)"}`);

  const pr = getRule(ruleset, "pull_request");
  // Assert not just that the rule exists, but that it enforces ≥1 review +
  // stale-review dismissal (Codex r1 P2: a drifted ruleset with count=0 or
  // dismissal=false would pass an existence-only check).
  const prOk = !!pr
    && (pr.parameters?.required_approving_review_count ?? 0) >= 1
    && pr.parameters?.dismiss_stale_reviews_on_push === true;
  push("requires pull request", prOk, pr ? `required_approving_review_count=${pr.parameters?.required_approving_review_count ?? "?"}, dismiss_stale=${pr.parameters?.dismiss_stale_reviews_on_push}` : "no pull_request rule");

  const rsc = getRule(ruleset, "required_status_checks");
  const configured = rsc?.parameters?.required_status_checks?.map((c) => c.context) || [];
  const missing = requiredChecks.filter((c) => !configured.includes(c));
  push("required status checks", rsc && missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `configured: ${configured.join(", ")}`);
  push("strict (head SHA == checked SHA)", !!rsc?.parameters?.strict_required_status_checks_policy, `strict=${rsc?.parameters?.strict_required_status_checks_policy}`);

  push("blocks deletion", !!getRule(ruleset, "deletion"), "deletion rule present");
  push("blocks force-push", !!getRule(ruleset, "non_fast_forward"), "non_fast_forward rule present");

  // No permanent bypass actor (emergency bypass is a documented admin-disable, not a standing bypass).
  const bypass = ruleset.bypass_actors || [];
  push("no permanent bypass", bypass.length === 0, bypass.length ? `bypass actors: ${bypass.map((b) => b.actor_id).join(",")}` : "none");

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Fetch the FULL ruleset (with rules/conditions/bypass_actors) by name.
 * The list endpoint (GET /rulesets) returns summaries only — it omits rules,
 * conditions, and bypass_actors (Codex r1 P1). So: fetch the list, find by name,
 * then fetch the full object via GET /rulesets/{id}.
 */
function fetchRulesetByName(name = RULESET_NAME) {
  const repo = process.env.GB_REPO || "Colin4k1024/grok-build";
  try {
    const listOut = execFileSync("gh", ["api", `repos/${repo}/rulesets`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    const list = JSON.parse(listOut);
    const found = (Array.isArray(list) ? list : []).find((r) => r.name === name);
    if (!found) return null;
    // Fetch the FULL ruleset (with rules/conditions/bypass_actors).
    const fullOut = execFileSync("gh", ["api", `repos/${repo}/rulesets/${found.id}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    return JSON.parse(fullOut);
  } catch {
    return null;
  }
}

export function main(argv) {
  const jsonOut = argv.includes("--json");

  // Parse --ruleset-file in BOTH forms: `--ruleset-file <path>` and
  // `--ruleset-file=<path>` (Codex r3 P2: the equals form was silently ignored
  // and fell through to the live fetch, verifying the wrong input).
  let rulesetFile = null;
  {
    const eq = argv.find((a) => a.startsWith("--ruleset-file="));
    const sp = argv.indexOf("--ruleset-file");
    if (eq) rulesetFile = eq.slice("--ruleset-file=".length);
    else if (sp >= 0) rulesetFile = sp + 1 < argv.length && !argv[sp + 1].startsWith("--") ? argv[sp + 1] : null;
  }
  const hasFlag = argv.some((a) => a.startsWith("--ruleset-file"));

  let ruleset;
  if (hasFlag) {
    if (!rulesetFile) {
      const msg = "check-branch-protection: --ruleset-file requires a value (use --ruleset-file <path> or --ruleset-file=<path>).";
      if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(msg);
      return 1;
    }
    try {
      ruleset = JSON.parse(fs.readFileSync(rulesetFile, "utf-8"));
    } catch (e) {
      const msg = `check-branch-protection: --ruleset-file ${rulesetFile} is not valid JSON or is unreadable: ${e.message}`;
      if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(msg);
      return 1;
    }
  } else {
    ruleset = fetchRulesetByName();
  }
  if (!ruleset) {
    const msg = "check-branch-protection: could not fetch the ruleset (gh API / network). Use --ruleset-file to pass a pre-generated ruleset.";
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    return 1;
  }
  const { ok, checks } = verifyRuleset(ruleset);

  if (jsonOut) {
    console.log(JSON.stringify({ ok, ruleset: ruleset?.name || null, checks }, null, 2));
  } else {
    console.log("Branch-protection verification (R6-04 #282)");
    console.log(`  ruleset: ${ruleset?.name || "(not found)"}`);
    for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  }
  return ok ? 0 : 1;
}

function invokedDirectly() {
  try {
    return fs.realpathSync(path.resolve(process.argv[1] || "")) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
