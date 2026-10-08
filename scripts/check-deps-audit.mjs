// Dependency security audit gate (R6-03 / #281).
//
// Enforces an auditable dependency-risk baseline: every critical/high npm-audit
// finding must be either fixed OR listed in security/audit-exceptions.json with
// a named owner, a mitigation, and a non-expired expiry. Findings not listed
// (unowned) or exceptions missing owner/expiry/expired fail the gate. Moderate
// and below are reported but not required to be owned (the desktop RC baseline
// targets critical/high; dev/build exposure is NOT equated to runtime exposure
// — the Non-goal in #281).
//
// State machine: finding states new -> triaged -> fixed|accepted-temporarily;
// acceptance cannot omit expiry or owner.
//
// Usage:
//   node scripts/check-deps-audit.mjs                 # run `npm audit` live, gate
//   node scripts/check-deps-audit.mjs --audit-file f  # read pre-generated audit JSON
//   node scripts/check-deps-audit.mjs --json          # emit JSON report

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXCEPTIONS_FILE = path.join(REPO, "security", "audit-exceptions.json");
// The project's default registry is a mirror that doesn't implement the audit
// endpoint; always query the official registry so the gate is correct in CI
// and locally alike.
const OFFICIAL_REGISTRY = "https://registry.npmjs.org";

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const MIN_OWNED_SEVERITY = "high"; // critical + high must be owned

/**
 * A valid `npm audit --json` report has a `vulnerabilities` object and/or an
 * `auditReportVersion`. An npm/registry ERROR (network outage, ENOAUDIT, mirror
 * 404) exits non-zero with error-shaped JSON (`{message, error, ...}`) that has
 * NO `vulnerabilities` key — without this shape check the gate would parse the
 * error payload into zero findings and PASS (fail-open, Codex r1 P1). The gate
 * must FAIL CLOSED when it cannot obtain a real audit report.
 */
export function isAuditReport(payload) {
  return !!(
    payload &&
    typeof payload === "object" &&
    (payload.vulnerabilities !== undefined || payload.auditReportVersion !== undefined)
  );
}

/** Parse `npm audit --json` into a flat findings list + totals. Pure. */
export function parseAudit(auditJson) {
  if (!auditJson || typeof auditJson !== "object") return { findings: [], totals: {} };
  const vulns = auditJson.vulnerabilities || {};
  const findings = Object.entries(vulns).map(([name, v]) => ({
    name,
    severity: v.severity,
    via: (v.via || []).map((x) => (typeof x === "string" ? x : x.name)).filter(Boolean),
    fixAvailable: v.fixAvailable === true
      ? { available: true }
      : v.fixAvailable
        ? { available: true, name: v.fixAvailable.name, version: v.fixAvailable.version, isSemVerMajor: !!v.fixAvailable.isSemVerMajor }
        : { available: false },
    range: v.range || "",
  }));
  return { findings, totals: auditJson.metadata?.vulnerabilities || {} };
}

/**
 * Validate a single exception entry. Required: package, severity, exposure,
 * owner, mitigation, expires (YYYY-MM-DD, not expired). Pure.
 * @returns {{ ok: boolean; errors: string[] }}
 */
export function validateException(exc, now = new Date()) {
  const errors = [];
  if (!exc || typeof exc !== "object") return { ok: false, errors: ["exception is not an object"] };
  for (const f of ["package", "severity", "exposure", "owner", "mitigation", "expires"]) {
    if (!exc[f] || typeof exc[f] !== "string" || !exc[f].trim()) errors.push(`missing/empty "${f}"`);
  }
  if (exc.expires) {
    const d = new Date(exc.expires + "T23:59:59Z");
    if (Number.isNaN(d.getTime())) {
      errors.push(`expires "${exc.expires}" is not a valid date (YYYY-MM-DD)`);
    } else if (d < now) {
      errors.push(`exception expired ${exc.expires} — re-triage or remove the finding`);
    }
  }
  if (exc.severity && !Object.hasOwn(SEVERITY_RANK, exc.severity)) {
    errors.push(`severity "${exc.severity}" is not a known npm severity`);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate the whole exception file structure. Pure. */
export function validateExceptions(doc, now = new Date()) {
  const errors = [];
  if (!doc || typeof doc !== "object") return { ok: false, errors: ["exceptions file is not an object"] };
  if (!Array.isArray(doc.exceptions)) return { ok: false, errors: ["exceptions must be an array"] };
  doc.exceptions.forEach((exc, i) => {
    const r = validateException(exc, now);
    if (!r.ok) r.errors.forEach((e) => errors.push(`exceptions[${i}] (${exc?.package || "?"}): ${e}`));
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Find critical/high findings not covered by a valid exception (unowned), and
 * flag expired exceptions that still reference outstanding findings. Pure.
 * @param {object[]} findings
 * @param {object} exceptionsDoc
 * @param {{ minSeverity?: string; now?: Date }} opts
 */
export function checkFindings(findings, exceptionsDoc, opts = {}) {
  const minRank = SEVERITY_RANK[opts.minSeverity || MIN_OWNED_SEVERITY];
  const now = opts.now || new Date();
  // Tolerate a malformed exceptions file (non-array `exceptions`, null entries)
  // so validateExceptions' error list is reported cleanly instead of an
  // uncaught TypeError — the gate still fails closed (Codex r2 P3).
  const excList = Array.isArray(exceptionsDoc?.exceptions) ? exceptionsDoc.exceptions : [];
  const excByName = new Map(
    excList.filter((e) => e && typeof e === "object").map((e) => [e.package, e]),
  );
  const unowned = [];
  const owned = [];
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] < minRank) continue; // below the bar — report only
    const exc = excByName.get(f.name);
    // Object.hasOwn (not `in`) so a prototype-chain key like "constructor" in
    // exc.severity can't yield the Object constructor as a rank (Codex r5 P3).
    const excRank = Object.hasOwn(SEVERITY_RANK, exc?.severity) ? SEVERITY_RANK[exc.severity] : -1;
    // No exception, OR the exception's recorded severity doesn't cover this
    // finding's (a NEW higher-severity advisory on an excepted package) -> the
    // stale exception must NOT count as ownership; surface for re-triage
    // (Codex r3 P2: name-only matching silently accepted security regressions).
    if (!exc || excRank < SEVERITY_RANK[f.severity]) {
      unowned.push(f);
      continue;
    }
    const v = validateException(exc, now);
    if (!v.ok) {
      unowned.push({ ...f, _exceptionErrors: v.errors });
    } else {
      owned.push(f);
    }
  }
  return { unowned, owned, minSeverity: opts.minSeverity || MIN_OWNED_SEVERITY };
}

function runNpmAudit() {
  try {
    const out = execFileSync("npm", ["audit", "--json", `--registry=${OFFICIAL_REGISTRY}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
      // win32: npm is npm.cmd and cannot be spawned without a shell (Codex r1 P2;
      // same lesson as scripts/check-toolchain.mjs).
      shell: process.platform === "win32",
    });
    const parsed = JSON.parse(out);
    return isAuditReport(parsed) ? parsed : null;
  } catch (e) {
    // npm audit exits non-zero when vulnerabilities exist; the valid report is
    // on stdout in that case. A registry/transport error ALSO exits non-zero
    // but with error-shaped JSON (no `vulnerabilities` key) — isAuditReport
    // distinguishes them so the gate fails closed on a bad report (Codex r1 P1).
    const stdout = e?.stdout ? String(e.stdout) : "";
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        if (isAuditReport(parsed)) return parsed;
      } catch { /* not JSON */ }
    }
    return null;
  }
}

export function main(argv) {
  const jsonOut = argv.includes("--json");
  // Parse --audit-file in BOTH forms: `--audit-file <path>` and `--audit-file=<path>`.
  // A missing value (bare `--audit-file` or `--audit-file=`) must error rather
  // than silently fall back to a live audit — otherwise a typo'd flag gates on
  // the wrong input (Codex r6 P3, same arg-misparse class as --require).
  const fail = (msg) => {
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    return 1;
  };
  let auditFile = null;
  {
    const eq = argv.find((a) => a.startsWith("--audit-file="));
    const sp = argv.indexOf("--audit-file");
    if (eq) {
      auditFile = eq.slice("--audit-file=".length);
    } else if (sp >= 0) {
      auditFile = sp + 1 < argv.length ? argv[sp + 1] : null;
    }
  }
  if (argv.some((a) => a.startsWith("--audit-file")) && !auditFile) {
    return fail("check-deps-audit: --audit-file requires a value (use --audit-file <path> or --audit-file=<path>).");
  }

  let audit;
  if (auditFile) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(auditFile, "utf-8"));
    } catch (e) {
      return fail(`check-deps-audit: --audit-file ${auditFile} is not valid JSON: ${e.message}`);
    }
    audit = isAuditReport(parsed) ? parsed : null; // fail closed on a non-report payload
  } else {
    audit = runNpmAudit();
  }
  if (!audit) {
    return fail("check-deps-audit: could not obtain npm audit output (network/registry). Use --audit-file to pass a pre-generated report.");
  }

  let exceptionsDoc;
  if (fs.existsSync(EXCEPTIONS_FILE)) {
    try {
      exceptionsDoc = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, "utf-8"));
    } catch (e) {
      return fail(`check-deps-audit: ${EXCEPTIONS_FILE} is not valid JSON: ${e.message}`);
    }
  } else {
    exceptionsDoc = { exceptions: [] };
  }

  const { findings, totals } = parseAudit(audit);
  const { ok: excOk, errors: excErrors } = validateExceptions(exceptionsDoc);
  const { unowned, owned, minSeverity } = checkFindings(findings, exceptionsDoc);

  const report = {
    ok: excOk && unowned.length === 0,
    totals,
    minOwnedSeverity: minSeverity,
    exceptionCount: exceptionsDoc.exceptions?.length || 0,
    ownedCriticalHigh: owned.length,
    unownedCriticalHigh: unowned.length,
    unowned,
    exceptionErrors: excErrors,
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Dependency audit gate (R6-03 #281)");
    console.log("  totals:", JSON.stringify(totals));
    console.log(`  min owned severity: ${minSeverity} (critical+high must be fixed or have a valid exception)`);
    console.log(`  exceptions: ${report.exceptionCount} (${excOk ? "all valid" : "INVALID — " + excErrors.length + " error(s)"})`);
    console.log(`  owned critical/high: ${owned.length}`);
    console.log(`  unowned critical/high: ${unowned.length}`);
    if (excErrors.length) {
      console.error("\nexception file errors:");
      for (const e of excErrors) console.error("  " + e);
    }
    if (unowned.length) {
      console.error("\nunowned critical/high findings (fix or add to security/audit-exceptions.json with owner+expiry):");
      for (const f of unowned) console.error(`  [${f.severity}] ${f.name} (via ${f.via.join(",") || "-"})${f._exceptionErrors ? " — exception invalid: " + f._exceptionErrors.join("; ") : ""}`);
    }
  }

  return report.ok ? 0 : 1;
}

// Run only when invoked directly (not when imported by tests). Compare
// realpaths so invocation through a symlinked path (e.g. macOS /tmp, symlinked
// runner workspaces, IDE actions) still matches — otherwise the guard is false,
// main() never runs, and the gate silently exits 0 (vacuous pass, Codex r4 P2).
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
