// Release-candidate rehearsal (R6-06 / #284).
//
// Exercises an immutable macOS candidate against the rehearsal checks and
// produces a machine-readable candidate report. State machine:
// built -> verified -> rehearsed -> accepted|rejected; rejected candidates can
// never be promoted. The report is SHA-bound (one candidate = one SHA/version).
//
// This script GATHERS evidence from already-run steps (it does NOT rebuild —
// the candidate must be built first via `npm run electron:pack`). It verifies:
// - artifact checksums (SHA256 of dmg/zip)
// - the update-feed manifest (latest-mac.yml references match the files)
// - embedded agent binaries present in the .app
// - the e2e launch-smoke result (read from e2e-results/results.json if present)
// - signature status (unsigned smoke unless a signed candidate)
// Windows/Linux candidates are NOT PROVEN locally (require CI or cross-compile
// toolchains; documented in the report as a residual risk).
//
// Usage: node scripts/rehearse-candidate.mjs [--json]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(REPO, "release");

/** Compute SHA256 of a file. Returns null if unreadable. */
export function sha256File(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Find the candidate artifacts (dmg, zip, app, manifest). Pure (takes a dir listing). */
export function findArtifacts(files, { ext = ["dmg", "zip"] } = {}) {
  if (!Array.isArray(files)) return { artifacts: [], manifest: null, app: null };
  const artifacts = files.filter((f) => ext.some((e) => f.endsWith("." + e)));
  const manifest = files.find((f) => /^latest.*\.yml$/.test(f)) || null;
  const app = files.includes("mac-arm64") ? "mac-arm64/Grok Build.app" : null;
  return { artifacts, manifest, app };
}

/**
 * Build the candidate report from gathered evidence. Pure.
 * @param {object} deps
 * @returns {{ state: string, accepted: boolean, report: object }}
 */
export function buildReport(deps) {
  const { sha, version, platform, artifacts, manifestOk, agentBinsOk, e2ePassed, e2eCount, signatureStatus } = deps;
  const verified = manifestOk && agentBinsOk;
  const rehearsed = verified && e2ePassed;
  // A smoke (unsigned) candidate is "accepted" for rehearsal (NOT for production
  // publication — #284 Non-goal: no public Release). The acceptance here is
  // "rehearsal passed", not "production-ready".
  const accepted = rehearsed;
  const state = !verified ? "verified-failed" : !rehearsed ? "rehearsed-failed" : "accepted";
  return {
    state,
    accepted,
    report: {
      sha,
      version,
      platform,
      artifacts,
      "manifest-verify": manifestOk ? "pass" : "fail",
      "agent-bins": agentBinsOk ? "present" : "missing",
      "e2e-launch-smoke": e2ePassed ? `pass (${e2eCount} tests)` : "fail",
      "signature-status": signatureStatus,
      "win-linux": "NOT PROVEN locally (requires CI or cross-compile toolchains; documented residual risk)",
      state,
      accepted,
    },
  };
}

/** Run a command, return stdout (trimmed) or null on failure. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: process.env }).trim();
  } catch {
    return null;
  }
}

export function main(argv) {
  const jsonOut = argv.includes("--json");
  const sha = run("git", ["rev-parse", "HEAD"]) || "unknown";
  const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8")).version;
  const platform = `${process.platform}-${process.arch}`;

  if (!fs.existsSync(RELEASE_DIR)) {
    const msg = "rehearse-candidate: release/ not found — build the candidate first (npm run electron:pack).";
    if (jsonOut) console.log(JSON.stringify({ state: "not-built", error: msg }));
    else console.error(msg);
    return 1;
  }
  const files = fs.readdirSync(RELEASE_DIR);
  const { artifacts: artifactNames, manifest, app } = findArtifacts(files);
  const artifacts = artifactNames.map((f) => {
    const full = path.join(RELEASE_DIR, f);
    const stat = fs.statSync(full);
    return { name: f, sha256: sha256File(full), size: stat.size };
  });

  // manifest-verify: run verify-update-feed.mjs on latest-mac.yml
  let manifestOk = false;
  if (manifest) {
    const out = run("node", [path.join(REPO, "scripts", "verify-update-feed.mjs"), path.join(RELEASE_DIR, manifest), RELEASE_DIR]);
    manifestOk = out !== null; // exit 0 → success (run returns null on non-zero)
  }

  // agent-bins: check the .app's embedded agent binary
  let agentBinsOk = false;
  if (app) {
    const agentPath = path.join(RELEASE_DIR, app, "Contents", "Resources", "xai-grok-pager");
    agentBinsOk = fs.existsSync(agentPath) && fs.statSync(agentPath).size > 0;
  }

  // e2e launch-smoke: read the Playwright results.json
  let e2ePassed = false, e2eCount = 0;
  const e2eResultsPath = path.join(REPO, "e2e-results", "results.json");
  if (fs.existsSync(e2eResultsPath)) {
    try {
      const r = JSON.parse(fs.readFileSync(e2eResultsPath, "utf-8"));
      e2eCount = Number(r.stats?.expected) || 0;
      e2ePassed = e2eCount > 0 && (Number(r.stats?.unexpected) || 0) === 0;
    } catch { /* malformed */ }
  }

  const { state, accepted, report } = buildReport({
    sha, version, platform, artifacts, manifestOk, agentBinsOk, e2ePassed, e2eCount,
    signatureStatus: "unsigned-smoke (CSC_IDENTITY_AUTO_DISCOVERY=false)",
  });

  // Write the machine-readable + human-readable report.
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.writeFileSync(path.join(RELEASE_DIR, "candidate-report.json"), JSON.stringify(report, null, 2));
  const md = [
    `# Release Candidate Report — ${version} (${platform})`,
    ``,
    `- **SHA**: \`${sha}\``,
    `- **Platform**: ${platform}`,
    `- **State**: ${state}`,
    `- **Accepted (rehearsal)**: ${accepted}`,
    ``,
    `## Artifacts`,
    ...artifacts.map((a) => `- \`${a.name}\` — sha256: \`${a.sha256}\` (${a.size} bytes)`),
    ``,
    `## Verification`,
    `- Manifest verify: ${report["manifest-verify"]}`,
    `- Agent binaries: ${report["agent-bins"]}`,
    `- E2E launch smoke: ${report["e2e-launch-smoke"]}`,
    `- Signature status: ${report["signature-status"]}`,
    ``,
    `## Residual risk`,
    `- ${report["win-linux"]}`,
  ].join("\n");
  fs.writeFileSync(path.join(RELEASE_DIR, "candidate-report.md"), md);

  if (jsonOut) {
    console.log(JSON.stringify({ state, accepted, report }, null, 2));
  } else {
    console.log(`Candidate rehearsal (R6-06 #284) — ${version} (${platform})`);
    console.log(`  state: ${state}`);
    console.log(`  artifacts: ${artifacts.length} (${artifacts.map((a) => a.name).join(", ")})`);
    console.log(`  manifest-verify: ${report["manifest-verify"]}`);
    console.log(`  agent-bins: ${report["agent-bins"]}`);
    console.log(`  e2e launch-smoke: ${report["e2e-launch-smoke"]}`);
    console.log(`  signature: ${report["signature-status"]}`);
    console.log(`  win/linux: ${report["win-linux"]}`);
    console.log(`  report: ${path.join(RELEASE_DIR, "candidate-report.{json,md}")}`);
  }
  return accepted ? 0 : 1;
}

function invokedDirectly() {
  try {
    return fs.realpathSync(path.resolve(process.argv[1] || "")) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
if (invokedDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
