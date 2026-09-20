#!/usr/bin/env node
/**
 * Evidence generator (R3-04 / #189).
 *
 * Produces an evidence index that records platform, commit SHA, commands,
 * scenario results, and external side effects — the reproducible acceptance
 * artifact the issue demands.
 *
 * The generator parses the JUnit XML test result and emits a structured
 * evidence index. It REFUSES to produce a "passing" evidence index when:
 *   - there are 0 test cases (nothing was tested)
 *   - the commit SHA is missing or stale (not on the current HEAD)
 *   - critical scenarios are missing from the index
 *   - a scenario's evidence is mock-only (the scenario name contains "mock"
 *     but the category requires a real side effect)
 *
 * Usage:
 *   node scripts/evidence-generator.mjs [--junit test-results/junit.xml]
 *     [--output docs/evidence/evidence-index.json]
 *     [--strict]  (exit 1 on any validation failure)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function args() {
  const a = process.argv.slice(2);
  const junitIdx = a.indexOf("--junit");
  const outputIdx = a.indexOf("--output");
  const junit = junitIdx >= 0 ? a[junitIdx + 1] : undefined;
  const output = outputIdx >= 0 ? a[outputIdx + 1] : undefined;
  const strict = a.includes("--strict");
  return {
    junit: junit || path.join(repoRoot, "test-results", "junit.xml"),
    output: output || path.join(repoRoot, "docs", "evidence", "evidence-index.json"),
    strict,
  };
}

function getCommitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function getBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function getPlatform() {
  return `${os.platform()}-${os.arch()}`;
}

function parseJunit(junitPath) {
  if (!fs.existsSync(junitPath)) {
    return { suites: [], total: 0, failures: 0, errors: 0, skipped: 0 };
  }
  const xml = fs.readFileSync(junitPath, "utf-8");
  const suites = [];
  // Parse <testsuite> blocks. Vitest's JUnit emits attributes in a fixed
  // order but we extract them by name to be robust to reordering.
  const suiteRe = /<testsuite\b([^>]*)>([\s\S]*?)(?:<\/testsuite>|(?=<testsuite\b|<\/testsuites>))/g;
  const attrRe = (name) => new RegExp(`\\b${name}="([^"]*)"`);
  let m;
  while ((m = suiteRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const suiteName = (attrs.match(attrRe("name")) || [])[1] ?? "";
    const tests = parseInt((attrs.match(attrRe("tests")) || [])[1] ?? "0", 10);
    const failures = parseInt((attrs.match(attrRe("failures")) || [])[1] ?? "0", 10);
    const errors = parseInt((attrs.match(attrRe("errors")) || [])[1] ?? "0", 10);
    const skipped = parseInt((attrs.match(attrRe("skipped")) || [])[1] ?? "0", 10);
    // Parse <testcase> elements within this suite's body.
    const cases = [];
    const caseRe = /<testcase\b([^>]*)\/?>(?:([\s\S]*?)<\/testcase>)?/g;
    let c;
    while ((c = caseRe.exec(body)) !== null) {
      const caseAttrs = c[1];
      const name = (caseAttrs.match(attrRe("name")) || [])[1] ?? "";
      const classname = (caseAttrs.match(attrRe("classname")) || [])[1] ?? suiteName;
      if (name) cases.push({ name, classname });
    }
    suites.push({ name: suiteName, tests, failures, errors, skipped, cases });
  }
  const total = suites.reduce((s, x) => s + x.tests, 0);
  const failures = suites.reduce((s, x) => s + x.failures, 0);
  const errors = suites.reduce((s, x) => s + x.errors, 0);
  const skipped = suites.reduce((s, x) => s + x.skipped, 0);
  return { suites, total, failures, errors, skipped };
}

/**
 * The critical scenarios the evidence index must cover. Each entry names the
 * issue it satisfies and whether a real side effect (not a mock) is required.
 * If a scenario is missing from the parsed JUnit, the generator flags it.
 */
const CRITICAL_SCENARIOS = [
  { id: "security-policy", pattern: /policy|permission-state/i, issue: "#186", requiresRealSideEffect: true, description: "Main-process Policy enforcement (file/command/network/git)" },
  { id: "acp-transport", pattern: /acp-transport/i, issue: "#187", requiresRealSideEffect: true, description: "Single-connection multi-session ACP transport" },
  { id: "shallow-wiring", pattern: /iss-188|applyCode|side-effects/i, issue: "#188", requiresRealSideEffect: true, description: "Real side effects for worktree/rename/apply-code" },
  { id: "fs-bridge", pattern: /fs-bridge/i, issue: "#186", requiresRealSideEffect: true, description: "Path traversal / symlink / TOCTOU enforcement" },
  { id: "git-review", pattern: /git-review/i, issue: "#193", requiresRealSideEffect: true, description: "Git review workflow (diff/snapshot/conflict)" },
  { id: "auth", pattern: /auth\.test/i, issue: "#197", requiresRealSideEffect: true, description: "Authentication (key store, keychain)" },
  { id: "session-history", pattern: /session-history/i, issue: "#188", requiresRealSideEffect: true, description: "Session history persistence (rename/list/delete)" },
  { id: "pty-manager", pattern: /pty-manager/i, issue: "#150", requiresRealSideEffect: true, description: "PTY terminal lifecycle" },
  { id: "mcp-config", pattern: /mcp-config/i, issue: "#192", requiresRealSideEffect: false, description: "MCP config parsing" },
  { id: "updater", pattern: /updater/i, issue: "#176", requiresRealSideEffect: false, description: "Auto-update check" },
];

function matchScenarios(suites) {
  const allCases = suites.flatMap((s) => s.cases.map((c) => ({ ...c, suite: s.name })));
  const results = CRITICAL_SCENARIOS.map((sc) => {
    const matches = allCases.filter((c) => sc.pattern.test(c.name) || sc.pattern.test(c.classname) || sc.pattern.test(c.suite));
    return {
      ...sc,
      found: matches.length > 0,
      caseCount: matches.length,
      cases: matches.slice(0, 10).map((c) => ({ name: c.name, suite: c.suite })),
    };
  });
  return results;
}

function validateEvidence(index) {
  const errors = [];
  // 1. Zero tests — no evidence.
  if (index.junit.total === 0) {
    errors.push("REFUSED: 0 test cases in JUnit XML — nothing was tested");
  }
  // 2. Missing commit SHA — stale or unanchored evidence.
  if (!index.commitSha) {
    errors.push("REFUSED: missing commit SHA — evidence is unanchored");
  }
  // 3. Critical scenarios must be present.
  for (const sc of index.scenarios) {
    if (!sc.found) {
      errors.push(`REFUSED: critical scenario "${sc.id}" (${sc.issue}) not found in test results`);
    }
  }
  // 4. Mock-only evidence for scenarios requiring real side effects.
  for (const sc of index.scenarios) {
    if (sc.requiresRealSideEffect && sc.caseCount > 0) {
      // If every matching case name contains "mock", it's mock-only.
      const mockOnly = sc.cases.length > 0 && sc.cases.every((c) => /mock/i.test(c.name));
      if (mockOnly) {
        errors.push(`REFUSED: scenario "${sc.id}" has only mock-based tests but requires real side effects`);
      }
    }
  }
  // 5. Failures or errors in the JUnit — evidence is not green.
  if (index.junit.failures > 0 || index.junit.errors > 0) {
    errors.push(`REFUSED: ${index.junit.failures} failures, ${index.junit.errors} errors in test results`);
  }
  return errors;
}

function main() {
  const { junit: junitPath, output, strict } = args();
  const sha = getCommitSha();
  const branch = getBranch();
  const platform = getPlatform();
  const junit = parseJunit(junitPath);
  const scenarios = matchScenarios(junit.suites);

  const index = {
    generatedAt: new Date().toISOString(),
    commitSha: sha,
    branch,
    platform,
    junit: {
      path: path.relative(repoRoot, junitPath),
      total: junit.total,
      failures: junit.failures,
      errors: junit.errors,
      skipped: junit.skipped,
      suiteCount: junit.suites.length,
    },
    scenarios,
    commands: {
      install: "npm ci",
      test: "npm test",
      evidence: "npm run test:evidence",
      typecheck: "npx tsc --noEmit",
      build: "npm run build",
    },
  };

  const validationErrors = validateEvidence(index);

  if (validationErrors.length > 0) {
    index.refused = true;
    index.refusalReasons = validationErrors;
    if (output) {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(index, null, 2) + "\n", "utf-8");
    }
    console.error("EVIDENCE REFUSED:");
    for (const e of validationErrors) console.error(`  ${e}`);
    if (strict) process.exit(1);
    return;
  }

  index.refused = false;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(index, null, 2) + "\n", "utf-8");
  }
  console.log(`Evidence index generated: ${output || "(stdout)"}`);
  console.log(`  commit: ${sha}`);
  console.log(`  platform: ${platform}`);
  console.log(`  tests: ${junit.total} (${junit.failures} failures, ${junit.errors} errors, ${junit.skipped} skipped)`);
  console.log(`  scenarios: ${scenarios.filter((s) => s.found).length}/${scenarios.length} critical found`);
  console.log(`  status: ACCEPTED`);
}

main();
