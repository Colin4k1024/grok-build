// Toolchain runtime-contract preflight (R6-02 / #280).
//
// Ensures local, CI, packaging, and release-gate executions resolve the same
// supported toolchain family and fail early on unsupported runtimes — before
// expensive builds. State machine: unknown -> validated -> executing;
// execution cannot begin from `unsupported`.
//
// Usage: node scripts/check-toolchain.mjs [--json]
//   --json  emit the recorded versions as JSON on stdout (still exits non-zero
//           on any contract violation)
//
// Checks:
//   - Node satisfies package.json `engines.node` (Electron 44 requires
//     >=22.12.0; workflows + .nvmrc pin the 22 LTS family).
//   - package-lock.json `lockfileVersion` === 3 (npm 7+ / `npm ci` contract).
//   - protoc is on PATH (the Rust proto build needs it; CI uses
//     arduino/setup-protoc, locally `bin/protoc`).
//   - rustc matches the `channel` pinned in rust-toolchain.toml (cargo honors
//     rust-toolchain.toml; this catches drift if a workflow forces a different
//     channel).
// Records node/npm/protoc/rustc/electron/electron-builder versions for evidence.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import semver from "semver";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_LOCKFILE_VERSION = 3;

/** Extract the `channel = "X"` value from rust-toolchain.toml content. */
export function parseRustToolchainChannel(toml) {
  if (typeof toml !== "string") return null;
  const m = toml.match(/^channel\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/** "rustc 1.94.0 (deadbeef 2026-01-01)" -> "1.94.0". */
export function parseRustcVersion(rustcOutput) {
  if (typeof rustcOutput !== "string") return null;
  const m = rustcOutput.match(/rustc\s+(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** "libprotoc 29.3" -> "29.3". */
export function parseProtocVersion(protocOutput) {
  if (typeof protocOutput !== "string") return null;
  const m = protocOutput.match(/libprotoc\s+(\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * @typedef {{ ok: boolean; reason: string }} CheckResult
 */

/** @param {string} nodeVersion @param {string} range @returns {CheckResult} */
export function checkNode(nodeVersion, range) {
  if (!nodeVersion) return { ok: false, reason: "Node version unavailable." };
  if (!range) return { ok: false, reason: "package.json has no engines.node range." };
  if (!semver.satisfies(nodeVersion, range)) {
    return {
      ok: false,
      reason: `Node ${nodeVersion} does not satisfy engines.node "${range}" (Electron 44 requires >=22.12.0). Install Node 22 (see .nvmrc: \`nvm install\`).`,
    };
  }
  return { ok: true, reason: `Node ${nodeVersion} satisfies "${range}".` };
}

/** @param {{ lockfileVersion?: number } | null} lockfile @returns {CheckResult} */
export function checkLockfile(lockfile) {
  if (!lockfile) return { ok: false, reason: "package-lock.json missing — run `npm install`." };
  const v = Number(lockfile.lockfileVersion);
  if (v !== EXPECTED_LOCKFILE_VERSION) {
    return {
      ok: false,
      reason: `package-lock.json lockfileVersion is ${v} (expected ${EXPECTED_LOCKFILE_VERSION}). Regenerate with a supported npm.`,
    };
  }
  return { ok: true, reason: `lockfileVersion ${v}.` };
}

/** @param {string|null} protocOutput @returns {CheckResult} */
export function checkProtoc(protocOutput) {
  const v = parseProtocVersion(protocOutput);
  if (!v) {
    return {
      ok: false,
      reason: "protoc not found on PATH. CI uses arduino/setup-protoc; locally use `bin/protoc` or install protoc.",
    };
  }
  return { ok: true, reason: `protoc ${v}.` };
}

/** @param {string|null} rustcOutput @param {string|null} expectedChannel @returns {CheckResult} */
export function checkRust(rustcOutput, expectedChannel) {
  const actual = parseRustcVersion(rustcOutput);
  if (!actual) return { ok: false, reason: "rustc not found on PATH. Install Rust (rustup)." };
  if (!expectedChannel) {
    return { ok: false, reason: "rust-toolchain.toml has no `channel` — cannot verify Rust pin." };
  }
  // Compare major.minor.patch; rust-toolchain.toml channel may be a version
  // ("1.94.0") or a named channel ("stable"). Only version channels are
  // checked for equality; named channels are recorded but not rejected.
  if (semver.valid(expectedChannel)) {
    if (actual !== expectedChannel) {
      return {
        ok: false,
        reason: `rustc ${actual} does not match rust-toolchain.toml channel "${expectedChannel}". Run \`rustup install ${expectedChannel}\`.`,
      };
    }
    return { ok: true, reason: `rustc ${actual} matches pinned channel.` };
  }
  return { ok: true, reason: `rustc ${actual} (channel "${expectedChannel}" is a named channel, not version-pinned).` };
}

/**
 * Run every check against gathered inputs. Pure — no IO. Returns per-check
 * results + recorded versions. Which checks are REQUIRED (vs informational) is
 * decided by `computeFailures` based on the calling job's needs, so a job that
 * doesn't need protoc/rust isn't failed for their absence.
 * @param {object} deps
 * @returns {{ results: Record<string, CheckResult>; versions: object }}
 */
export function checkAll(deps) {
  const versions = {
    node: deps.nodeVersion,
    npm: deps.npmVersion,
    protoc: parseProtocVersion(deps.protocOutput),
    rustc: parseRustcVersion(deps.rustcOutput),
    rustChannel: deps.rustChannel,
    electron: deps.electronVersion,
    electronBuilder: deps.electronBuilderVersion,
  };
  const results = {
    node: checkNode(deps.nodeVersion, deps.nodeRange),
    lockfile: checkLockfile(deps.lockfile),
    protoc: checkProtoc(deps.protocOutput),
    rust: checkRust(deps.rustcOutput, deps.rustChannel),
  };
  return { results, versions };
}

/**
 * Failures for the required checks that are not ok. The required set is always
 * node + lockfile (universal) PLUS any extras in `require` (e.g. ["rust"] for a
 * rust job, ["protoc","rust"] for a packaging job), so a job that doesn't need
 * protoc/rust isn't failed for their absence, while a job that does can opt in.
 * @param {Record<string, CheckResult>} results
 * @param {string[]} require  extra check names to require beyond node+lockfile
 */
export function computeFailures(results, require) {
  const req = new Set(["node", "lockfile", ...require]);
  return Object.entries(results)
    .filter(([name, r]) => req.has(name) && !r.ok)
    .map(([name, r]) => `[${name}] ${r.reason}`);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function main(argv) {
  // --require a,b,c : which checks must pass (default: node,lockfile). Jobs
  // that need protoc/rust pass `--require protoc,rust` so a missing protoc or
  // drifted rustc fails the preflight; a job that doesn't need them isn't
  // failed for their absence.
  const requireArg = argv.find((a) => a.startsWith("--require"));
  const require = requireArg ? requireArg.slice("--require".length).replace(/^=/, "").split(",").map((s) => s.trim()).filter(Boolean) : [];

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8"));
  const nodeRange = pkg.engines?.node;
  let lockfile = null;
  const lockPath = path.join(REPO, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    try { lockfile = JSON.parse(fs.readFileSync(lockPath, "utf-8")); } catch { /* malformed */ }
  }
  let rustToml = "";
  const rustTomlPath = path.join(REPO, "rust-toolchain.toml");
  if (fs.existsSync(rustTomlPath)) rustToml = fs.readFileSync(rustTomlPath, "utf-8");

  const deps = {
    nodeVersion: process.versions.node,
    npmVersion: run(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
    nodeRange,
    lockfile,
    protocOutput: run("protoc", ["--version"]),
    rustcOutput: run("rustc", ["--version"]),
    rustChannel: parseRustToolchainChannel(rustToml),
    electronVersion: pkg.devDependencies?.electron,
    electronBuilderVersion: pkg.devDependencies?.["electron-builder"],
  };

  const { results, versions } = checkAll(deps);
  const failures = computeFailures(results, require);

  const json = argv.includes("--json");
  const requiredAll = ["node", "lockfile", ...require];
  if (json) {
    console.log(JSON.stringify({ ok: failures.length === 0, required: requiredAll, versions, results }, null, 2));
  } else {
    const req = new Set(requiredAll);
    console.log("Toolchain contract preflight (R6-02 #280)");
    for (const [name, r] of Object.entries(results)) {
      const tag = r.ok ? "PASS" : req.has(name) ? "FAIL" : "WARN";
      console.log(`  ${tag} ${name}: ${r.reason}`);
    }
    console.log("  versions:", JSON.stringify(versions));
  }

  if (failures.length > 0) {
    if (!json) {
      console.error("\ntoolchain contract NOT satisfied:");
      for (const f of failures) console.error("  " + f);
      console.error("Fix the above before expensive builds.");
    }
    return 1;
  }
  if (!json) console.log("\ntoolchain contract OK — validated.");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
