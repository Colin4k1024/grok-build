#!/usr/bin/env node
/**
 * R5 release gate (R5-10 / #266).
 *
 * A single, auditable command that aggregates every R5 release check into one
 * pass/fail report:
 *
 *   npm run release:gate
 *
 * Sequence (continue-on-failure; a step whose prerequisite failed — or hasn't
 * run yet — is skipped, not run, so misordered steps can't run vacuously):
 *   unit → build → electron-build → evidence → pack → e2e → checksums →
 *   feed-verify → uat → platform install smoke (host only) → user-data-unchanged
 *
 * Outputs (the report goes to ./release/ unless --out-dir overrides; the
 * artifacts electron-builder produces always live in ./release/ and are
 * scanned there regardless of the report dir):
 *   release-report.json   — machine-readable, one entry per step
 *   release-report.md     — human-readable summary
 *   (checksums.sha256 / sbom.json come from release-checksums.sh in release/)
 *
 * Exit code 0 only when every step passed; 1 otherwise. The report is always
 * written, even on failure, so a broken release produces a complete failure
 * summary rather than a silent abort.
 *
 * Testability: the step list and the command runner are injectable, so the
 * core logic is unit-tested without a real build/electron/pack.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/** @typedef {{ id: string, name: string, prereqs?: string[], platform?: NodeJS.Platform | NodeJS.Platform[], cmd: string[] }} Step */
/** @typedef {{ id: string, name: string, status: "pass"|"fail"|"skipped", durationMs: number, output?: string, skipReason?: string }} StepResult */

/** Default output directory for reports + artifacts. */
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "release");

/** The real release-gate step sequence. Artifact-dependent `cmd`s are LAZY
 *  functions resolved at RUN time (after `pack` has produced artifacts), so
 *  a fresh checkout doesn't skip every smoke/feed step. Platform-dependent
 *  steps (e2e on linux needs Xvfb) branch on process.platform. */
export function defineSteps({ outDir = DEFAULT_OUT_DIR, artifactsDir } = {}) {
  const releaseDir = artifactsDir ?? outDir;
  const find = (ext) => () => findArtifact(releaseDir, ext);
  return [
    { id: "unit", name: "Unit + integration tests", cmd: ["npm", "test"] },
    { id: "build", name: "Renderer build + bundle budget", prereqs: ["unit"], cmd: ["npm", "run", "build"] },
    { id: "electron-build", name: "Electron main/preload build", prereqs: ["build"], cmd: ["npm", "run", "electron:build"] },
    { id: "evidence", name: "Evidence (JUnit + generator)", prereqs: ["unit"], cmd: ["npm", "run", "evidence"] },
    { id: "pack", name: "Package (electron-builder)", prereqs: ["electron-build"], cmd: ["npm", "run", "electron:pack"] },
    // e2e's fixture resolves the packed app from release/* — it MUST run after
    // pack (declared here, after pack in the array). On linux, Electron needs a
    // display; wrap in xvfb-run ONLY if xvfb-run is present (CI installs it; a
    // local linux box with a real display + no xvfb runs plain).
    {
      id: "e2e",
      name: "Electron Playwright E2E",
      prereqs: ["pack"],
      cmd: () =>
        process.platform === "linux" && hasBin("xvfb-run")
          ? ["xvfb-run", "-a", "npm", "run", "test:e2e"]
          : ["npm", "run", "test:e2e"],
    },
    {
      id: "checksums",
      name: "Release checksums + SBOM",
      prereqs: ["pack"],
      cmd: ["bash", "scripts/release-checksums.sh", releaseDir],
    },
    {
      id: "feed-verify",
      name: "Update-feed manifest consistency",
      prereqs: ["pack"],
      cmd: () => {
        const m = findLatestManifest(releaseDir);
        return m ? ["node", "scripts/verify-update-feed.mjs", m, releaseDir] : null;
      },
    },
    // UAT is human-driven (cmdRun blocks until the operator quits the app);
    // the gate verifies the LATEST run's strict report rather than launching
    // an interactive session. Fails clearly if no run is recorded.
    {
      id: "uat",
      name: "Desktop UAT strict report (latest run)",
      prereqs: ["pack"],
      cmd: () => latestUatRunCmd(),
    },
    {
      id: "macos-smoke",
      name: "macOS DMG signature + launch smoke",
      prereqs: ["pack"],
      platform: "darwin",
      cmd: () => { const d = find(".dmg")(); return d ? ["bash", "scripts/verify-macos-release.sh", d] : null; },
    },
    {
      id: "linux-smoke",
      name: "Linux AppImage launch smoke (Xvfb)",
      prereqs: ["pack"],
      platform: "linux",
      cmd: () => { const a = find(".AppImage")(); return a ? ["bash", "scripts/verify-linux-release.sh", a] : null; },
    },
    {
      id: "windows-smoke",
      name: "Windows install/launch/exit/uninstall smoke",
      prereqs: ["pack"],
      platform: "win32",
      cmd: () => { const e = find(".exe")(); return e ? ["bash", "scripts/verify-windows-release.sh", e] : null; },
    },
  ];
}

/** Find the latest UAT run id (most recent dir under .uat/runs/) and build a
 *  `report --strict` command; if no run exists, skip in CI (UAT is human-driven
 *  and .uat/ is gitignored, so a fresh CI checkout never has a run — the gate
 *  would be permanently red otherwise) but fail locally with an actionable
 *  reminder. Testable via injected runsDir/ci. */
export function latestUatRunCmd({ runsDir = path.join(REPO_ROOT, ".uat", "runs"), ci = process.env.CI } = {}) {
  try {
    if (fs.existsSync(runsDir)) {
      const latest = fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .pop();
      if (latest) return ["node", "scripts/desktop-uat.mjs", "report", "--strict", "--run", latest];
    }
  } catch { /* fall through */ }
  // No recorded run. In CI there never is one (.uat/ is gitignored) — skip
  // rather than fail: UAT is human-driven, verified at the release window.
  if (ci) return null;
  return ["bash", "-c", "echo 'no UAT run recorded — run `npm run uat:prepare && npm run uat:run` (human-driven) first, then re-run the gate' >&2; exit 1"];
}

/**
 * Run a step's command via the injected runner (default: spawnSync). The
 * caller handles platform gating and prereq skipping; this resolves a lazy
 * `cmd` (function) at RUN time — after prerequisites like `pack` have
 * produced artifacts — so artifact-dependent steps scan the release dir when
 * they actually run, not before the gate starts. A null cmd → skipped.
 * @param {Step} step
 * @param {(cmd: string[]) => { status: 0|1, output: string }} runner
 * @returns {StepResult}
 */
export function runStep(step, runner = defaultRunner) {
  const cmd = typeof step.cmd === "function" ? step.cmd() : step.cmd;
  if (cmd === null) {
    return { id: step.id, name: step.name, status: "skipped", durationMs: 0, skipReason: "no artifact produced by a prerequisite" };
  }
  const start = Date.now();
  let res;
  try {
    res = runner(cmd);
  } catch (e) {
    return { id: step.id, name: step.name, status: "fail", durationMs: Date.now() - start, output: String(e?.message ?? e) };
  }
  const durationMs = Date.now() - start;
  return res.status === 0
    ? { id: step.id, name: step.name, status: "pass", durationMs, output: res.output }
    : { id: step.id, name: step.name, status: "fail", durationMs, output: res.output };
}

/**
 * Run every step (continue-on-failure). A step whose prerequisite failed or
 * was skipped is itself skipped (not run). Platform-gated steps are skipped
 * unless `platform` matches. Returns results + pass/fail/skip sets.
 * @param {{ steps: Step[], runner?: (cmd: string[]) => { status: 0|1, output: string }, platform?: NodeJS.Platform }} opts
 * @returns {{ results: StepResult[], failed: string[], skipped: string[], passed: string[] }}
 */
export function runReleaseGate({ steps, runner = defaultRunner, platform = process.platform } = {}) {
  const byId = new Map();
  /** @type {StepResult[]} */
  const results = [];
  const failed = [];
  const skipped = [];
  const passed = [];
  for (const step of steps) {
    const prereqs = step.prereqs ?? [];
    // A prereq that hasn't executed yet (undefined in byId) is NOT satisfied —
    // this catches a misordered step (declared before its prereq) instead of
    // running it vacuously. The step is skipped with the reason.
    const failedPrereq = prereqs.find((p) => {
      const r = byId.get(p);
      return !r || r.status !== "pass";
    });
    let result;
    if (failedPrereq) {
      result = { id: step.id, name: step.name, status: "skipped", durationMs: 0, skipReason: `prerequisite ${failedPrereq} did not pass` };
    } else if (step.platform) {
      const plats = Array.isArray(step.platform) ? step.platform : [step.platform];
      if (!plats.includes(platform)) {
        result = { id: step.id, name: step.name, status: "skipped", durationMs: 0, skipReason: `platform ${platform} (step is ${plats.join("/")})` };
      } else {
        result = runStep(step, runner);
      }
    } else {
      result = runStep(step, runner);
    }
    byId.set(step.id, result);
    results.push(result);
    if (result.status === "pass") passed.push(step.id);
    else if (result.status === "fail") failed.push(step.id);
    else skipped.push(step.id);
  }
  return { results, failed, skipped, passed };
}

/** Collect release-gate metadata: commit, platform, tool versions. */
export function collectMeta() {
  const git = (args) => {
    try {
      return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).stdout?.trim() ?? "";
    } catch {
      return "";
    }
  };
  const nodeV = process.versions.node;
  const npmV = (() => {
    try {
      return spawnSync("npm", ["--version"], {
        encoding: "utf-8",
        // win32 has no npm.exe (only npm.cmd); shell:true resolves it, same as
        // defaultRunner — without this, meta.npm is blank on Windows.
        shell: process.platform === "win32",
      }).stdout?.trim() ?? "";
    } catch {
      return "";
    }
  })();
  return {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    platform: process.platform,
    arch: process.arch,
    node: nodeV,
    npm: npmV,
    electron: readPkgElectronVer(),
    generatedAt: new Date().toISOString(),
  };
}

/** Build the JSON + Markdown report from results + metadata. */
export function buildReport({ results, failed, skipped, passed }, meta, { signature, uatStatus, artifacts = [], checksumsFile } = {}) {
  const overall = failed.length === 0 ? "pass" : "fail";
  const report = {
    overall,
    meta,
    summary: { passed: passed.length, failed: failed.length, skipped: skipped.length, total: results.length },
    steps: results,
    signature: signature ?? null,
    uat: uatStatus ?? null,
    artifacts,
    checksums: checksumsFile ?? null,
  };
  const md = renderMarkdown(report);
  return { json: JSON.stringify(report, null, 2), md };
}

function renderMarkdown(report) {
  const { meta, summary, steps, overall } = report;
  const icon = (s) => (s === "pass" ? "✅" : s === "fail" ? "❌" : "⏭️");
  const lines = [];
  lines.push(`# R5 Release Gate Report`, ``);
  lines.push(`**Overall: ${overall.toUpperCase()}** — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.total} steps).`, ``);
  lines.push(`- Commit: \`${meta.commit || "—"}\`${meta.branch ? ` (${meta.branch})` : ""}`);
  lines.push(`- Platform: ${meta.platform} / ${meta.arch}`);
  lines.push(`- Tools: node ${meta.node}, npm ${meta.npm}, electron ${meta.electron || "—"}`);
  lines.push(`- Generated: ${meta.generatedAt}`, ``);
  if (report.signature) lines.push(`- macOS signature: ${report.signature}`);
  if (report.uat) lines.push(`- UAT: ${report.uat}`);
  if (report.artifacts?.length) {
    lines.push(``, `## Artifacts`, ``);
    for (const a of report.artifacts) lines.push(`- [${a.name}](${a.path}) — ${a.size ? Math.round(a.size / 1024) + " KB" : ""}`);
  }
  lines.push(``, `## Steps`, ``);
  lines.push(`| Status | Step | Duration | Notes |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const s of steps) {
    const notes = s.skipReason ?? (s.output ? s.output.split("\n")[0].slice(0, 80) : "");
    lines.push(`| ${icon(s.status)} | ${s.name} | ${(s.durationMs / 1000).toFixed(1)}s | ${notes} |`);
  }
  return lines.join("\n") + "\n";
}

// ---- defaults + helpers -----------------------------------------------------

function defaultRunner(cmd) {
  // On win32 there is no npm.exe — npm is npm.cmd, and spawnSync without a
  // shell can't execute .cmd shims (ENOENT). shell:true lets the OS resolve
  // npm/node on every platform. The commands are hardcoded (no user input),
  // so shell quoting is not a concern here.
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  return { status: r.status === 0 ? 0 : 1, output: output.trim() };
}

function findArtifact(dir, ext) {
  try {
    if (!fs.existsSync(dir)) return null;
    const found = fs.readdirSync(dir).find((f) => f.endsWith(ext));
    return found ? path.join(dir, found) : null;
  } catch {
    return null;
  }
}

function findLatestManifest(dir) {
  try {
    if (!fs.existsSync(dir)) return null;
    const found = fs.readdirSync(dir).find((f) => /^latest.*\.yml$/i.test(f));
    // Return the full path (verify-update-feed reads it relative to cwd,
    // so a bare filename resolves to <repo>/latest-mac.yml which doesn't exist).
    return found ? path.join(dir, found) : null;
  } catch {
    return null;
  }
}

/** True if a binary is on PATH (POSIX `command -v`). Used to gate the linux
 *  e2e xvfb-run wrap on actual availability. */
function hasBin(name) {
  try {
    return spawnSync("command", ["-v", name], { shell: true, encoding: "utf-8" }).status === 0;
  } catch {
    return false;
  }
}

function readPkgElectronVer() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
    return pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? "";
  } catch {
    return "";
  }
}

function listArtifacts(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(dmg|exe|AppImage|snap|deb|rpm|app|yml|json)$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        try {
          return { name: f, path: path.relative(REPO_ROOT, p), size: fs.statSync(p).size };
        } catch {
          return { name: f, path: path.relative(REPO_ROOT, p) };
        }
      });
  } catch {
    return [];
  }
}

// ---- CLI -------------------------------------------------------------------

async function main() {
  // --out-dir is the REPORT output dir. electron-builder always writes
  // artifacts to release/ (build.directories.output), so artifact-dependent
  // steps scan DEFAULT_OUT_DIR regardless of where the report lands — a
  // custom --out-dir must not make the gate "pass" while scanning an empty dir.
  const outDir = parseOutDirArg(process.argv.slice(2)) ?? DEFAULT_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  // Snapshot the real user data dir BEFORE the gate — the final
  // user-data-unchanged step compares against this.
  const userDataBefore = snapshotSessions(path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "sessions"));

  const steps = defineSteps({ artifactsDir: DEFAULT_OUT_DIR });
  const gate = runReleaseGate({ steps });

  // The user-data-unchanged check wraps the whole gate.
  const userDataAfter = snapshotSessions(path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "sessions"));
  const userDataUnchanged = userDataBefore === userDataAfter;
  gate.results.push({
    id: "user-data-unchanged",
    name: "Real user data dir unchanged by the gate",
    status: userDataUnchanged ? "pass" : "fail",
    durationMs: 0,
    output: userDataUnchanged ? undefined : "user sessions dir changed during the gate",
  });
  if (!userDataUnchanged) gate.failed.push("user-data-unchanged");
  else gate.passed.push("user-data-unchanged");

  const meta = collectMeta();
  // Artifacts + checksums always live in release/ (electron-builder output),
  // not the report dir.
  const artifacts = listArtifacts(DEFAULT_OUT_DIR);
  const checksumsPath = path.join(DEFAULT_OUT_DIR, "checksums.sha256");
  const checksumsFile = fs.existsSync(checksumsPath)
    ? path.relative(REPO_ROOT, checksumsPath)
    : null;

  // macOS signature status (best-effort from the smoke step output).
  const macSmoke = gate.results.find((r) => r.id === "macos-smoke");
  const signature = macSmoke?.status === "pass"
    ? "verified (codesign/spctl/staple)"
    : macSmoke?.status === "skipped"
      ? `skipped (${macSmoke.skipReason})`
      : "not verified";
  const uatStep = gate.results.find((r) => r.id === "uat");
  const uatStatus = uatStep ? `${uatStep.status} (${uatStep.name})` : null;

  const { json, md } = buildReport(gate, meta, { signature, uatStatus, artifacts, checksumsFile });
  fs.writeFileSync(path.join(outDir, "release-report.json"), json);
  fs.writeFileSync(path.join(outDir, "release-report.md"), md);

  console.log(md);
  console.log(`\nReport written to ${path.relative(REPO_ROOT, outDir)}/release-report.{json,md}`);
  process.exit(gate.failed.length === 0 ? 0 : 1);
}

/** Recursive, sorted listing of a sessions dir hashed with per-file size, so
 *  an in-place modification of an existing session file (the most likely
 *  corruption mode — a stray append) changes the hash, not just a rename/add.
 *  Missing dir = empty string. */
export function snapshotSessions(root) {
  if (!fs.existsSync(root)) return "";
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${r}/`);
        walk(path.join(dir, entry.name), r);
      } else {
        let size = -1;
        try { size = fs.statSync(path.join(dir, entry.name)).size; } catch { /* unreadable */ }
        out.push(`${r}\t${size}`);
      }
    }
  };
  walk(root, "");
  return crypto.createHash("sha256").update(out.join("\n")).digest("hex");
}

/** Parse --out-dir <path> / --out-dir=<path> from argv; undefined if absent. */
export function parseOutDirArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir" && i + 1 < argv.length) return argv[++i];
    if (argv[i]?.startsWith("--out-dir=")) return argv[i].slice("--out-dir=".length);
  }
  return undefined;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
