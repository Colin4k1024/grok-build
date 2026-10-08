// Asserts the Playwright e2e suite actually executed tests (R6-01 #279).
//
// A skipped/empty Playwright invocation would otherwise exit 0 and pass CI
// silently — the original R6-01 bug had the pack step halt before Playwright
// ran, so the e2e job never exercised the app. This guard reads the JSON
// report and fails the job when fewer than one test ran as expected.
//
// Usage: node scripts/assert-e2e-ran.mjs [path/to/results.json]
//   (default path: e2e-results/results.json relative to repo root)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_REPORT = path.resolve(
  process.cwd(),
  "e2e-results/results.json",
);

/**
 * @param {unknown} report
 * @returns {{ ok: boolean; reason: string }}
 */
export function checkReport(report) {
  if (!report || typeof report !== "object") {
    return { ok: false, reason: "Playwright produced no results object — suite did not run." };
  }
  const stats = /** @type {any} */ (report).stats;
  if (!stats || typeof stats !== "object") {
    return { ok: false, reason: "Playwright report has no stats block — suite did not run." };
  }
  // `expected` = tests that matched their expected outcome (passed, or
  // expected-failures that failed); `unexpected` = tests that failed when
  // expected to pass; `flaky` = tests that passed after a retry. Counting all
  // three means "at least one test actually executed". A vacuous run —
  // all-skipped, no tests matched, or Playwright never started — has all three
  // at 0 and must be blocked. (Using only `expected` would misreport a real
  // all-failure run as vacuous, since a failing suite has expected=0.)
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const executed = num(stats.expected) + num(stats.unexpected) + num(stats.flaky);
  if (executed < 1) {
    const skipped = num(stats.skipped);
    return {
      ok: false,
      reason: `Playwright executed 0 tests (expected=${num(stats.expected)}, unexpected=${num(stats.unexpected)}, skipped=${skipped}) — vacuous pass blocked.`,
    };
  }
  return { ok: true, reason: `Playwright executed ${executed} test(s).` };
}

export function main(argv) {
  const file = argv[0] ? path.resolve(argv[0]) : DEFAULT_REPORT;
  if (!fs.existsSync(file)) {
    console.error(`assert-e2e-ran: FAIL — results file not found: ${file}`);
    console.error("assert-e2e-ran: Playwright never produced a report (did it run?).");
    return 1;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    console.error(`assert-e2e-ran: FAIL — results file is not valid JSON: ${file}`);
    console.error(`assert-e2e-ran: ${e?.message ?? e}`);
    return 1;
  }
  const { ok, reason } = checkReport(parsed);
  if (ok) {
    console.log(`assert-e2e-ran: OK — ${reason}`);
    return 0;
  }
  console.error(`assert-e2e-ran: FAIL — ${reason}`);
  return 1;
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
