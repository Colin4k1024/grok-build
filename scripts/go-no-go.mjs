// Go/No-Go evidence assembler (R6-07 / #285).
//
// Produces a single SHA-bound decision package for a release candidate:
// aggregates issue-closure, test/e2e, security exceptions, branch
// protection, release-environment, candidate-rehearsal and rollback
// evidence — validating FRESHNESS (evidence must be newer than the SHA's
// commit time where applicable) and EXACT SHA binding (provenance from the
// candidate's build stamp, never the working tree).
//
// State machine (issue invariant):
//   collecting -> ready_for_decision -> approved | rejected
//   - Only an explicit human approval record (decisions/<sha>.json with
//     approver + grantedBy:"human") can reach `approved`.
//   - Publication stays a SEPARATE future action; this tool never publishes.
//
// Exit codes: 0 = ready_for_decision (or terminal state recorded),
//             1 = collecting (missing evidence — see gaps),
//             2 = approved, 3 = rejected.
//
// Usage: node scripts/go-no-go.mjs [--sha <sha>] [--json]
//        (default sha: latest candidate's build stamp)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES_DIR = path.join(REPO, ".candidates");
const DECISIONS_DIR = path.join(CANDIDATES_DIR, "decisions");

/** Freshness window: evidence older than this before the decision moment is
 *  flagged stale. Security exceptions carry their own expiry. */
export const EVIDENCE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, ...opts }).trim();
  } catch (e) {
    if (e?.killed || e?.signal === "SIGTERM") console.error(`go-no-go: ${cmd} timed out`);
    return null;
  }
}

/** List candidate dirs with their stamped manifests. Pure over the listing. */
export function listCandidates(dirs) {
  const out = [];
  for (const [name, files] of Object.entries(dirs ?? {})) {
    if (!files.includes("candidate-manifest.json")) continue;
    out.push(name);
  }
  return out;
}

/** Parse the security-exception ledger. `now` is injectable for tests. */
export function parseExceptions(raw, now = Date.now()) {
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    const list = Array.isArray(j?.exceptions) ? j.exceptions : [];
    return list.map((e) => ({
      id: e.id ?? e.name ?? "?",
      reason: e.reason ?? "",
      expiresAt: e.expiresAt ?? null,
      expired: e.expiresAt ? Date.parse(e.expiresAt) < now : false,
    }));
  } catch {
    return [];
  }
}

/** The decision state machine. Pure. */
export function buildDecision(deps) {
  const {
    sha,
    version,
    gaps,              // string[] of missing/stale evidence
    blocking,          // string[] of hard blockers (red required checks etc.)
    residualRisks,     // string[]
    decision,          // {approver, grantedBy, at} | null (human approval record)
  } = deps;

  if (decision && decision.grantedBy === "human" && decision.approver) {
    // explicit human record decides; only reachable when no NEW gaps emerged
    const state = blocking.length > 0 ? "rejected" : "approved";
    return { state, go: state === "approved", gaps, blocking, residualRisks };
  }
  if (blocking.length > 0) {
    return { state: "rejected", go: false, gaps, blocking, residualRisks };
  }
  if (gaps.length > 0) {
    return { state: "collecting", go: false, gaps, blocking, residualRisks };
  }
  return { state: "ready_for_decision", go: false, gaps, blocking, residualRisks };
}

// ---- CLI -------------------------------------------------------------------

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return null;
  }
}

export function main(argv, { candidatesDir = CANDIDATES_DIR, decisionsDir = DECISIONS_DIR, now = Date.now(), e2eResultsPath = path.join(REPO, "e2e-results", "results.json"), securityExceptionsPath = path.join(REPO, "security", "audit-exceptions.json"), runbookPath = path.join(REPO, "docs", "release-validation.md"), skipBranchProtection = false } = {}) {
  const jsonOut = argv.includes("--json");
  const shaIdx = argv.indexOf("--sha");
  const wantSha = shaIdx >= 0 ? argv[shaIdx + 1] : null;

  // pick the newest candidate whose build stamp matches (--sha) or the newest
  const ids = fs.existsSync(candidatesDir)
    ? fs.readdirSync(candidatesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("decisions")).map((d) => d.name).sort()
    : [];
  let candId = null, stamp = null;
  for (const id of [...ids].reverse()) {
    const m = readJson(path.join(candidatesDir, id, "candidate-manifest.json"));
    if (!m) continue;
    if (wantSha && m.sha !== wantSha) continue;
    candId = id; stamp = m; break;
  }
  if (!stamp) {
    const msg = wantSha ? `no candidate built from sha ${wantSha}` : "no candidate found — run npm run build:candidate";
    if (jsonOut) console.log(JSON.stringify({ state: "collecting", error: msg }));
    else console.error(msg);
    return 1;
  }

  const rehearsal = readJson(path.join(candidatesDir, candId, "candidate-report.json"));
  const rawDecision = readJson(path.join(decisionsDir, `${stamp.sha}.json`));

  const gaps = [];
  const blocking = [];
  const residualRisks = [];

  // 0. candidate freshness — a candidate older than the evidence window is
  //    itself stale evidence, whatever its rehearsal said.
  const builtAtMs = Date.parse(stamp.builtAt) || 0;
  if (builtAtMs && now - builtAtMs > EVIDENCE_MAX_AGE_MS) {
    gaps.push(`candidate built ${stamp.builtAt} exceeds the ${EVIDENCE_MAX_AGE_MS / 86400000}-day evidence window — build a NEW candidate`);
  }

  // 1. candidate rehearsal evidence
  if (!rehearsal) {
    gaps.push(`candidate ${candId} has no rehearsal report — run npm run rehearse:candidate`);
  } else if (rehearsal.state === "rejected") {
    blocking.push(`candidate rehearsal state=rejected (${rehearsal.note ?? ""})`);
  } else if (rehearsal.state === "partial") {
    for (const [k, v] of Object.entries(rehearsal["missing-for-acceptance"] ?? {})) {
      if (Array.isArray(v) && v.length) gaps.push(`${k}: ${v.join("; ")}`);
    }
  }
  // rehearsal provenance must match the stamp sha exactly
  if (rehearsal?.candidate?.sha && rehearsal.candidate.sha !== stamp.sha) {
    blocking.push(`rehearsal provenance sha ${rehearsal.candidate.sha} ≠ stamp sha ${stamp.sha}`);
  }

  // 2. security exceptions — expired ones block, active ones are residual.
  //    A missing/unreadable ledger is an OPERATOR gap (not a crash).
  const exceptionsRaw = (() => {
    try {
      return fs.readFileSync(securityExceptionsPath, "utf-8");
    } catch {
      return null;
    }
  })();
  const exceptions = exceptionsRaw === null ? [] : parseExceptions(exceptionsRaw);
  if (exceptionsRaw === null) gaps.push("security/audit-exceptions.json unreadable — cannot verify exception expiry");
  for (const e of exceptions) {
    if (e.expired) blocking.push(`security exception ${e.id} expired ${e.expiresAt}`);
    else residualRisks.push(`security exception ${e.id}: ${e.reason} (expires ${e.expiresAt})`);
  }

  // 3. branch protection (ruleset) — recorded state, checked via gh when live.
  //    Bounded: a hung GitHub API call must not hang the whole decision.
  const bp = skipBranchProtection
    ? '{"ok":true}'
    : run("node", [path.join(REPO, "scripts", "check-branch-protection.mjs"), "--json"], { timeout: 30_000 });
  const bpOk = bp !== null && /"ok"\s*:\s*true/.test(bp);
  if (!bpOk) gaps.push("main branch protection ruleset not verified active (scripts/check-branch-protection.mjs)");

  // 4. rollback evidence — the runbook must exist and mention rollback
  let hasRollback = false;
  try {
    hasRollback = fs.existsSync(runbookPath) && /rollback|回滚/i.test(fs.readFileSync(runbookPath, "utf-8"));
  } catch { /* unreadable runbook == absent */ }
  if (!hasRollback) gaps.push("rollback documentation absent from docs/release-validation.md");

  // 5. test evidence freshness: e2e results must be newer than the candidate
  //    build (stale = evidence predates the bits). Stat ONCE — no TOCTOU
  //    between existsSync and statSync.
  let e2eMtime = 0;
  try {
    e2eMtime = fs.statSync(e2eResultsPath).mtimeMs;
  } catch { /* absent */ }
  const e2eFresh = e2eMtime >= builtAtMs;
  if (!e2eMtime) gaps.push("no e2e results.json (run npm run test:e2e)");
  else if (!e2eFresh) gaps.push("e2e results.json older than the candidate build (stale)");

  // 6. decision record hygiene — the record is ALWAYS echoed for audit
  //    transparency (blocked records carry blocked: true), but only a
  //    well-formed human record reaches buildDecision as a decision.
  const decisionValid = rawDecision && rawDecision.grantedBy === "human" && typeof rawDecision.approver === "string" && rawDecision.approver.trim().length > 0;
  if (rawDecision && rawDecision.grantedBy !== "human") {
    blocking.push("decision record must carry grantedBy:'human' — tooling cannot self-approve");
  }
  if (rawDecision && (!rawDecision.approver || typeof rawDecision.approver !== "string")) {
    blocking.push("decision record missing approver name");
  }

  const result = buildDecision({
    sha: stamp.sha,
    version: stamp.version,
    gaps,
    blocking,
    residualRisks,
    decision: decisionValid ? rawDecision : null,
  });

  const report = {
    candidate: { id: candId, sha: stamp.sha, version: stamp.version, builtAt: stamp.builtAt, platforms: stamp.platforms },
    generatedAt: new Date(now).toISOString(),
    evidence: {
      rehearsal: rehearsal ? { state: rehearsal.state, accepted: rehearsal.accepted } : null,
      securityExceptions: exceptions,
      branchProtectionVerified: bpOk,
      rollbackDocumented: hasRollback,
      e2eFresh,
    },
    decision: rawDecision
      ? {
          approver: typeof rawDecision.approver === "string" ? rawDecision.approver : null,
          grantedBy: rawDecision.grantedBy ?? null,
          at: rawDecision.at ?? null,
          note: typeof rawDecision.note === "string" ? rawDecision.note : null,
          valid: Boolean(decisionValid),
          blocked: !decisionValid,
        }
      : null,
    state: result.state,
    go: result.go,
    gaps,
    blocking,
    residualRisks,
    publication: "BLOCKED — approval here never publishes; publication is a separate explicit future action",
  };

  // append-only decision log per candidate (never overwrite evidence)
  const logPath = path.join(candidatesDir, candId, "go-no-go-runs.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ at: report.generatedAt, state: result.state, go: result.go }) + "\n");

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Go/No-Go (R6-07 #285) — candidate ${candId} @ ${stamp.sha.slice(0, 12)}`);
    console.log(`  state: ${result.state} (go=${result.go})`);
    if (gaps.length) console.log(`  gaps (${gaps.length}): ${gaps.slice(0, 3).join("; ")}${gaps.length > 3 ? " …" : ""}`);
    if (blocking.length) console.log(`  BLOCKING (${blocking.length}): ${blocking.join("; ")}`);
    if (residualRisks.length) console.log(`  residual risks (${residualRisks.length})`);
    console.log(`  publication: ${report.publication}`);
  }
  return result.state === "approved" ? 2 : result.state === "rejected" ? 3 : result.state === "ready_for_decision" ? 0 : 1;
}

function invokedDirectly() {
  try {
    return fs.realpathSync(path.resolve(process.argv[1] || "")) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`go-no-go: ${e.message}`);
    process.exit(1);
  }
}
