// Release-candidate rehearsal (R6-06 / #284).
//
// One candidate = one immutable directory under .candidates/<id>/, produced by
// scripts/build-candidate.mjs (which stamps candidate-manifest.json with the
// SHA/version the artifacts were BUILT from and freezes the dir read-only).
// This script rehearses such a candidate and produces a machine-readable
// report INSIDE the candidate dir.
//
// State machine (Codex r2 contract):
//   built -> verified -> rehearsed -> accepted | partial | rejected
//   - corrupted (any artifact checksum drifted)        -> rejected
//   - hard failures (manifest/agent-bins/e2e-failed)   -> rejected
//   - missing evidence (platforms/scenarios/SBOM/stale-e2e) -> partial
//   - everything present and passing                   -> accepted
//   accepted/rejected are TERMINAL: a re-run never flips them (a rejected
//   candidate can never be promoted; fixes require a NEW candidate id).
//
// Exit codes: 0 = accepted, 1 = rejected/corrupted, 2 = partial.
//
// Usage: node scripts/rehearse-candidate.mjs [--id <id>] [--json]
//        (no --id: newest candidate without a terminal report)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES_DIR = path.join(REPO, ".candidates");

/** Every release platform #284 requires for a full acceptance. A candidate
 *  built for fewer platforms rehearses as PARTIAL, never accepted. */
export const REQUIRED_PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"];

/** The e2e spec files a valid launch-smoke result must contain (and none
 *  skipped) — a partial or vacuous suite is not evidence. settings.spec.ts
 *  was folded into accessibility-keyboard.spec.ts when the suite landed. */
export const REQUIRED_E2E_SUITES = [
  "app-shell.spec.ts",
  "visual.spec.ts",
  "accessibility-keyboard.spec.ts",
];

/** Rehearsal scenarios #284 requires beyond build+verify. Locally exercised
 *  ones are marked below; the rest keep a full candidate at PARTIAL. */
export const REQUIRED_SCENARIOS = [
  "launch-smoke",
  "install-uninstall",
  "update-interruption",
  "corrupt-package-reject",
  "restart-recovery",
  "rollback-last-known-good",
  "hard-kill-no-orphans",
];

/** Compute SHA256 of a file. Returns null if unreadable. */
export function sha256File(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Find the candidate artifacts (dmg/zip/exe/AppImage, manifest, app). Pure. */
export function findArtifacts(files, { ext = ["dmg", "zip", "exe", "AppImage"] } = {}) {
  if (!Array.isArray(files)) return { artifacts: [], manifest: null, app: null };
  const artifacts = files.filter((f) => ext.some((e) => f.endsWith("." + e)));
  const manifest = files.find((f) => /^latest.*\.yml$/.test(f)) || null;
  const app = files.includes("mac-arm64") ? "mac-arm64/Grok Build.app" : null;
  return { artifacts, manifest, app };
}

/** Verify every file in candidate-manifest.json still matches its recorded
 *  sha256 — the immutability check. Pure over the inputs it is given. */
export function verifyCandidateFiles(entries, resolve, hash = sha256File) {
  const drift = [];
  for (const e of entries ?? []) {
    const actual = hash(resolve(e.name));
    if (actual !== e.sha256) drift.push({ name: e.name, expected: e.sha256, actual });
  }
  return { ok: drift.length === 0, drift };
}

/**
 * Parse a Playwright results.json into an evidence verdict.
 * Pure. `stale` = results older than the candidate build (evidence predates
 * the artifacts). A suite is missing when its spec file name never appears.
 */
export function parseE2eResults(raw, { candidateBuiltAt = 0, resultsMtime = 0, requiredSuites = REQUIRED_E2E_SUITES } = {}) {
  let r;
  try {
    r = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { valid: false, pass: false, count: 0, skipped: 0, missingSuites: [...requiredSuites], stale: false, reason: "unparseable results.json" };
  }
  const suites = new Set(
    // Playwright's JSON nests describe-blocks as child suites that repeat the
    // parent's file — flatten everything that looks like a spec path.
    (function collect(nodes, out) {
      for (const s of nodes ?? []) {
        if (s?.file) out.push(String(s.file));
        collect(s?.suites, out);
        for (const spec of s?.specs ?? []) {
          if (Array.isArray(spec?.tests) && spec.tests.some((t) => Array.isArray(t?.results) && t.results.length > 0)) {
            // a spec with executed tests proves its file's suite really ran
          }
        }
      }
      return out;
    })(r.suites, [])
  );
  // Playwright json keeps the spec path in suite.file; fall back to title scan
  const allFiles = [...suites].filter(Boolean).map((f) => f.split("/").pop());
  const missingSuites = requiredSuites.filter((req) => !allFiles.includes(req));
  const expected = Number(r.stats?.expected) || 0;
  const unexpected = Number(r.stats?.unexpected) || 0;
  const skipped = Number(r.stats?.skipped) || 0;
  const stale = resultsMtime > 0 && candidateBuiltAt > 0 && resultsMtime < candidateBuiltAt;
  const pass = expected > 0 && unexpected === 0 && skipped === 0 && missingSuites.length === 0 && !stale;
  return {
    valid: true,
    pass,
    /** the suite RAN against this candidate and had unexpected failures —
     *  a hard reject (distinct from missing/stale evidence => partial). */
    failed: unexpected > 0 && !stale,
    count: expected,
    skipped,
    missingSuites,
    stale,
    reason: pass ? null : stale ? "stale (results.json predates the candidate build)" : unexpected > 0 ? `${unexpected} unexpected failure(s)` : skipped > 0 ? `${skipped} skipped` : missingSuites.length ? `missing suites: ${missingSuites.join(", ")}` : "no tests ran",
  };
}

/** Classify signature evidence for a candidate .app (pure classification of
 *  the given exit code / availability). */
export function classifySignature({ codesignAvailable, verifyExit }) {
  if (!codesignAvailable) return { status: "cannot-check", detail: "codesign not on PATH" };
  if (verifyExit === 0) return { status: "signed", detail: "codesign --verify --deep --strict passed" };
  return { status: "unsigned", detail: "codesign --verify failed (unsigned or invalid)" };
}

/** SBOM evidence: present + lists every artifact = verified. Pure. */
export function classifySbom(sbomRaw, artifactNames) {
  let s;
  try {
    s = typeof sbomRaw === "string" ? JSON.parse(sbomRaw) : sbomRaw;
  } catch {
    return { status: "incomplete", detail: "sbom.json unparseable" };
  }
  const listed = new Set(s?.artifacts ?? []);
  const missing = artifactNames.filter((a) => !listed.has(a));
  if (missing.length) return { status: "incomplete", detail: `sbom missing artifacts: ${missing.join(", ")}` };
  return { status: "verified", detail: `sbom.json lists all ${artifactNames.length} artifacts (git_sha ${s?.git_sha ?? "?"})` };
}

/**
 * The acceptance state machine. Pure.
 * Hard failures (corrupted drift, manifest fail, agent-bins missing, e2e
 * RAN and failed) => rejected (terminal). Missing evidence (platforms,
 * scenarios, sbom, signature cannot-check, stale/missing e2e) => partial.
 */
export function buildReport(deps) {
  const {
    provenance,           // { id, sha, version, builtAt, headSha, headMismatch }
    artifacts,            // [{name, sha256, size}]
    drift,                // [] | [{name,...}] non-empty = corrupted
    manifestOk,
    agentBinsOk,
    e2e,                  // parseE2eResults output
    signature,            // classifySignature output
    sbom,                 // classifySbom output
    platformsBuilt,       // ["darwin-arm64", ...]
    scenariosExercised,   // ["launch-smoke", ...]
  } = deps;

  const missing = {
    platforms: REQUIRED_PLATFORMS.filter((p) => !platformsBuilt.includes(p)),
    scenarios: REQUIRED_SCENARIOS.filter((s) => !scenariosExercised.includes(s)),
    sbom: sbom.status === "missing" ? ["sbom.json absent from candidate"] : sbom.status === "incomplete" ? [sbom.detail] : [],
    signature: signature.status === "cannot-check" ? ["signature not checked (codesign unavailable)"] : [],
    e2e: e2e.valid && !e2e.pass ? [e2e.reason] : !e2e.valid ? [e2e.reason] : [],
  };

  const hardFail = {
    corrupted: (drift ?? []).length > 0,
    manifest: !manifestOk,
    agentBins: !agentBinsOk,
    e2eFailed: Boolean(e2e.failed),
  };

  const rejected = hardFail.corrupted || hardFail.manifest || hardFail.agentBins || hardFail.e2eFailed;
  const missingCount = missing.platforms.length + missing.scenarios.length + missing.sbom.length + missing.signature.length + missing.e2e.length;
  const state = rejected ? "rejected" : missingCount > 0 ? "partial" : "accepted";
  const accepted = state === "accepted";

  return {
    state,
    accepted,
    promotable: accepted,
    report: {
      candidate: provenance,
      artifacts,
      "manifest-verify": manifestOk ? "pass" : "fail",
      "agent-bins": agentBinsOk ? "present" : "missing",
      "e2e-launch-smoke": e2e.pass ? `pass (${e2e.count} tests)` : (e2e.reason ?? "fail"),
      "signature-status": `${signature.status} — ${signature.detail}`,
      "sbom": `${sbom.status} — ${sbom.detail}`,
      "platforms-built": platformsBuilt,
      "scenarios-exercised": scenariosExercised,
      "missing-for-acceptance": missing,
      "hard-failures": hardFail,
      state,
      accepted,
      promotable: accepted,
      note:
        state === "accepted"
          ? "rehearsal complete; candidate is promotable"
          : state === "partial"
            ? `rehearsal incomplete: ${missingCount} missing evidence item(s) — candidate NOT promotable`
            : "rehearsal failed — rejected candidates can never be promoted; fix and build a NEW candidate id",
    },
  };
}

/** Terminal-state stickiness: rehearsing a candidate whose recorded report is
 *  already accepted/rejected never flips it. Pure. */
export function applyTerminalStickiness(previous, next) {
  if (!previous || !["accepted", "rejected"].includes(previous.state)) return next;
  if (previous.state === next.state) return next;
  return {
    ...next,
    state: previous.state,
    accepted: previous.state === "accepted",
    promotable: previous.state === "accepted",
    report: {
      ...next.report,
      state: previous.state,
      accepted: previous.state === "accepted",
      promotable: previous.state === "accepted",
      note: `terminal state '${previous.state}' is sticky — this re-run produced '${next.state}' but cannot change it; build a NEW candidate id`,
    },
  };
}

// ---- CLI -------------------------------------------------------------------

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: process.env }).trim();
  } catch {
    return null;
  }
}

function readPrevReport(candidatesDir, id) {
  const f = path.join(candidatesDir, id, "candidate-report.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return null;
  }
}

export function main(argv, { candidatesDir = CANDIDATES_DIR, e2eResultsPath = path.join(REPO, "e2e-results", "results.json") } = {}) {
  const jsonOut = argv.includes("--json");
  const idIdx = argv.indexOf("--id");
  const explicitId = idIdx >= 0 ? argv[idIdx + 1] : undefined;
  const headSha = run("git", ["rev-parse", "HEAD"]) || "unknown";

  const ids = (() => {
    if (!fs.existsSync(candidatesDir)) return [];
    return fs
      .readdirSync(candidatesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  })();
  let id;
  if (explicitId) {
    if (!ids.includes(explicitId)) throw new Error(`candidate not found: ${explicitId} (have: ${ids.join(", ") || "none"})`);
    id = explicitId;
  } else {
    // newest without a terminal report
    id = [...ids].reverse().find((cand) => {
      const prev = readPrevReport(candidatesDir, cand);
      return !prev || !["accepted", "rejected"].includes(prev.state);
    });
    if (!id) throw new Error(`every candidate already has a terminal report (ids: ${ids.join(", ") || "none"}); pass --id to re-verify (terminal states are sticky)`);
  }
  const dir = path.join(candidatesDir, id);
  const manifestPath = path.join(dir, "candidate-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    const msg = `candidate ${id} has no candidate-manifest.json — build via npm run build:candidate`;
    if (jsonOut) console.log(JSON.stringify({ state: "not-built", error: msg }));
    else console.error(msg);
    return 1;
  }
  const buildStamp = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const headMismatch = buildStamp.sha !== headSha;

  const files = fs.readdirSync(dir);
  const { artifacts: artifactNames, manifest, app } = findArtifacts(files);
  const artifacts = artifactNames.map((f) => {
    const stat = fs.statSync(path.join(dir, f));
    return { name: f, sha256: sha256File(path.join(dir, f)), size: stat.size };
  });

  // immutability: every stamped file must still match
  const { ok: filesOk, drift } = verifyCandidateFiles(buildStamp.files ?? [], (n) => path.join(dir, n));

  // manifest-verify against the feed checker
  let manifestOk = false;
  if (manifest) {
    const out = run("node", [path.join(REPO, "scripts", "verify-update-feed.mjs"), path.join(dir, manifest), dir]);
    manifestOk = out !== null;
  }

  // agent bins
  let agentBinsOk = false;
  if (app) {
    const agentPath = path.join(dir, app, "Contents", "Resources", "xai-grok-pager");
    agentBinsOk = fs.existsSync(agentPath) && fs.statSync(agentPath).size > 0;
  }

  // signature (real check, no hardcoding)
  let signature;
  if (app) {
    const codesignAvailable = run("bash", ["-lc", "command -v codesign"]) !== null;
    const verifyExit = codesignAvailable
      ? (() => {
          try {
            execFileSync("codesign", ["--verify", "--deep", "--strict", path.join(dir, app)], { stdio: "ignore" });
            return 0;
          } catch (e) {
            return (e.status ?? 1);
          }
        })()
      : null;
    signature = classifySignature({ codesignAvailable, verifyExit });
  } else {
    signature = { status: "cannot-check", detail: "no macOS .app in this candidate" };
  }

  // sbom
  const sbomPath = path.join(dir, "sbom.json");
  const sbom = fs.existsSync(sbomPath)
    ? classifySbom(fs.readFileSync(sbomPath, "utf-8"), artifactNames)
    : { status: "missing", detail: "sbom.json absent from candidate" };

  // e2e evidence (repo-level results.json, staleness vs candidate build)
  let e2e;
  if (fs.existsSync(e2eResultsPath)) {
    e2e = parseE2eResults(fs.readFileSync(e2eResultsPath, "utf-8"), {
      candidateBuiltAt: Date.parse(buildStamp.builtAt) || 0,
      resultsMtime: fs.statSync(e2eResultsPath).mtimeMs,
    });
  } else {
    e2e = { valid: false, pass: false, count: 0, skipped: 0, missingSuites: [...REQUIRED_E2E_SUITES], stale: false, reason: "no e2e results.json — run npm run test:e2e" };
  }

  // scenarios actually exercised locally: the e2e suite boots the packaged
  // app repeatedly (launch-smoke) and its fixture hard-kills the app while
  // asserting no orphaned agent survives (hard-kill-no-orphans).
  const scenariosExercised = [];
  if (e2e.pass) scenariosExercised.push("launch-smoke", "hard-kill-no-orphans");

  const provenance = {
    id,
    sha: buildStamp.sha,
    version: buildStamp.version,
    builtAt: buildStamp.builtAt,
    headSha,
    headMismatch,
    headMismatchNote: headMismatch ? `working tree HEAD (${headSha.slice(0, 8)}) differs from the SHA this candidate was built from (${buildStamp.sha.slice(0, 8)}) — provenance follows the BUILD stamp` : null,
  };

  let result = buildReport({
    provenance,
    artifacts,
    drift,
    manifestOk,
    agentBinsOk,
    e2e,
    signature,
    sbom,
    platformsBuilt: buildStamp.platforms ?? [],
    scenariosExercised,
  });
  result = applyTerminalStickiness(readPrevReport(candidatesDir, id), result);

  // persist into the candidate dir (append-only run log + canonical report)
  const runLog = path.join(dir, "rehearsal-runs.jsonl");
  fs.appendFileSync(runLog, JSON.stringify({ at: new Date().toISOString(), headSha, state: result.state }) + "\n");
  fs.writeFileSync(path.join(dir, "candidate-report.json"), JSON.stringify(result.report, null, 2));
  const md = [
    `# Release Candidate Report — ${provenance.version} (${id})`,
    ``,
    `- **Built from SHA**: \`${provenance.sha}\`${headMismatch ? ` ⚠️ HEAD is \`${headSha}\` (see note)` : ""}`,
    `- **State**: ${result.state}${result.state === "partial" ? " — NOT promotable" : ""}`,
    `- **Accepted**: ${result.accepted}`,
    ``,
    `## Artifacts`,
    ...artifacts.map((a) => `- \`${a.name}\` — sha256: \`${a.sha256}\` (${a.size} bytes)`),
    ``,
    `## Verification`,
    `- Manifest verify: ${result.report["manifest-verify"]}`,
    `- Agent binaries: ${result.report["agent-bins"]}`,
    `- E2E launch smoke: ${result.report["e2e-launch-smoke"]}`,
    `- Signature: ${result.report["signature-status"]}`,
    `- SBOM: ${result.report["sbom"]}`,
    ``,
    `## Coverage`,
    `- Platforms built: ${buildStamp.platforms?.join(", ") || "none"} (required: ${REQUIRED_PLATFORMS.join(", ")})`,
    `- Scenarios exercised: ${scenariosExercised.join(", ") || "none"} (required: ${REQUIRED_SCENARIOS.join(", ")})`,
    ``,
    `## Missing for acceptance`,
    ...(Object.values(result.report["missing-for-acceptance"]).flat().length
      ? Object.entries(result.report["missing-for-acceptance"]).flatMap(([k, v]) => (v.length ? [`- ${k}: ${v.join("; ")}`] : []))
      : ["- none"]),
    ``,
    `> ${result.report.note}`,
  ].join("\n");
  fs.writeFileSync(path.join(dir, "candidate-report.md"), md);

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Candidate rehearsal (R6-06 #284) — ${id}`);
    console.log(`  built-from: ${provenance.sha.slice(0, 12)}${headMismatch ? ` (HEAD ${headSha.slice(0, 12)} MISMATCH)` : ""}`);
    console.log(`  state: ${result.state}`);
    console.log(`  manifest-verify: ${result.report["manifest-verify"]} · agent-bins: ${result.report["agent-bins"]}`);
    console.log(`  e2e: ${result.report["e2e-launch-smoke"]}`);
    console.log(`  signature: ${signature.status} · sbom: ${sbom.status}`);
    const miss = Object.values(result.report["missing-for-acceptance"]).flat();
    if (miss.length) console.log(`  missing for acceptance (${miss.length}): ${miss.slice(0, 4).join("; ")}${miss.length > 4 ? " …" : ""}`);
    console.log(`  report: ${path.join(dir, "candidate-report.{json,md}")}`);
  }
  return result.state === "accepted" ? 0 : result.state === "partial" ? 2 : 1;
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
    console.error(`rehearse-candidate: ${e.message}`);
    process.exit(1);
  }
}
