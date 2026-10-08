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
  if (exc.severity && !(exc.severity in SEVERITY_RANK)) {
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
  const excByName = new Map((exceptionsDoc?.exceptions || []).map((e) => [e.package, e]));
  const unowned = [];
  const owned = [];
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] < minRank) continue; // below the bar — report only
    const exc = excByName.get(f.name);
    if (!exc) {
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
    });
    return JSON.parse(out);
  } catch (e) {
    // npm audit exits non-zero when vulnerabilities exist; the JSON is on stdout.
    const stdout = e?.stdout ? String(e.stdout) : "";
    if (stdout) {
      try { return JSON.parse(stdout); } catch { /* fall through */ }
    }
    return null;
  }
}

export function main(argv) {
  const jsonOut = argv.includes("--json");
  const auditFileIdx = argv.indexOf("--audit-file");
  const auditFile = auditFileIdx >= 0 ? argv[auditFileIdx + 1] : null;

  let audit;
  if (auditFile) {
    audit = JSON.parse(fs.readFileSync(auditFile, "utf-8"));
  } else {
    audit = runNpmAudit();
  }
  if (!audit) {
    const msg = "check-deps-audit: could not obtain npm audit output (network/registry). Use --audit-file to pass a pre-generated report.";
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    return 1;
  }

  const exceptionsDoc = fs.existsSync(EXCEPTIONS_FILE)
    ? JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, "utf-8"))
    : { exceptions: [] };

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
