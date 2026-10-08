// Release credential preflight (R6-05 / #283).
//
// Proves credential READINESS for a tag release without ever exposing secret
// values: checks presence + conservative format for the Apple Developer / App
// Store Connect signing secrets the release-mac job needs. State machine:
// unapproved -> approved(commit-SHA-scoped) -> preflight; there is no path
// from unapproved to secret-bearing execution — the `release` environment's
// approval rules gate secret access, and this preflight runs AFTER approval,
// reads the injected env, and FAILS CLOSED on any missing/malformed secret.
//
// REDACTION INVARIANT: this script only ever prints secret NAMES and PASS/FAIL
// + a generic reason — NEVER a value. The redaction is unit-tested (a real-
// looking value must not appear in any output path).
//
// Usage: node scripts/check-release-creds.mjs        # read env, gate
//        node scripts/check-release-creds.mjs --json  # JSON report
// Env: CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Conservative format validators — catch obvious typos/malformation without
// false-failing real Apple-issued secrets. Apple API Key IDs are 10-char
// alnum; Issuer IDs are UUIDs; CSC_LINK/APPLE_API_KEY are large base64 blobs.
function present(v) { return typeof v === "string" && v.length > 0; }
const VALIDATORS = {
  CSC_LINK: (v) => present(v) && v.length >= 32 ? { ok: true } : { ok: false, reason: "missing or too short (expected a base64 p12 blob)" },
  CSC_KEY_PASSWORD: (v) => present(v) ? { ok: true } : { ok: false, reason: "missing (p12 password)" },
  APPLE_API_KEY: (v) => present(v) && v.length >= 32 ? { ok: true } : { ok: false, reason: "missing or too short (expected a base64 .p8 blob)" },
  APPLE_API_KEY_ID: (v) => present(v) && /^[A-Za-z0-9]{8,14}$/.test(v) ? { ok: true } : { ok: false, reason: "missing or malformed (expected an 8-14 char alphanumeric App Store Connect key ID)" },
  APPLE_API_ISSUER: (v) => present(v) && /^[\da-fA-F-]{8,40}$/.test(v) ? { ok: true } : { ok: false, reason: "missing or malformed (expected a UUID/numeric issuer ID)" },
};

export const REQUIRED_SECRETS = Object.keys(VALIDATORS);

/**
 * Validate a creds map. Pure — no IO, no printing. Returns per-secret results.
 * @param {Record<string, string|undefined>} creds
 * @returns {{ ok: boolean; failures: {name:string; reason:string}[]; passed: string[] }}
 */
export function checkCreds(creds) {
  const failures = [];
  const passed = [];
  for (const name of REQUIRED_SECRETS) {
    const v = creds?.[name];
    const r = VALIDATORS[name](v);
    if (r.ok) passed.push(name);
    else failures.push({ name, reason: r.reason });
  }
  return { ok: failures.length === 0, failures, passed };
}

export function main(argv) {
  const jsonOut = argv.includes("--json");
  const creds = {};
  for (const name of REQUIRED_SECRETS) creds[name] = process.env[name];
  const { ok, failures, passed } = checkCreds(creds);

  if (jsonOut) {
    // JSON report carries only names + PASS/FAIL + generic reasons — no values.
    console.log(JSON.stringify({ ok, passed, failures }, null, 2));
  } else {
    console.log("Release credential preflight (R6-05 #283)");
    for (const name of passed) console.log(`  PASS ${name}`);
    for (const f of failures) console.log(`  FAIL ${f.name}: ${f.reason}`);
  }
  if (!ok && !jsonOut) {
    console.error("\nrelease credentials NOT ready — tag release requires all signing secrets in the protected 'release' environment.");
  }
  return ok ? 0 : 1;
}

// Run only when invoked directly. Compare realpaths so symlinked invocation
// (macOS /tmp, runner workspaces) still runs main (no vacuous-pass exit 0).
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
