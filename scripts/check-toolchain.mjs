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

// The preflight runs BEFORE `npm ci` (fail-fast on unsupported runtimes), so it
// must not import any package that lives in node_modules. The version checks
// below use a tiny inline comparator instead of the `semver` package.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_LOCKFILE_VERSION = 3;
// The protoc version the contract pins (ADR 0005). CI (arduino/setup-protoc)
// and dev (bin/protoc dotslash) must both resolve this; checkProtoc enforces
// equality so a half-done bump (CI without bin/protoc, or vice-versa) is caught.
const EXPECTED_PROTOC_VERSION = "29.3";

/** Parse a "X.Y.Z" (extra pre-release/build metadata ignored) into [maj,min,pat]. */
export function parseVersion(v) {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two [maj,min,pat] arrays. */
function cmpVersion(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Minimal `semver.satisfies` covering the ranges this contract uses: one or
 * more space-separated clauses, each `>=|>|<=|<|= X.Y.Z`. (No `^`/`~`/`*` —
 * the contract pins explicit floors like ">=22.12.0".)
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  return String(range).split(/\s+/).filter(Boolean).every((clause) => {
    const m = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})$/.exec(clause.trim());
    if (!m) return false;
    const op = m[1] || "=";
    const operand = m[2].split(".").map(Number);
    while (operand.length < 3) operand.push(0);
    const c = cmpVersion(v, operand);
    if (op === ">=") return c >= 0;
    if (op === ">") return c > 0;
    if (op === "<=") return c <= 0;
    if (op === "<") return c < 0;
    return c === 0;
  });
}

/** True if `v` is a concrete "X.Y.Z" version (not a named channel like "stable"). */
export function isValidVersion(v) {
  return parseVersion(v) != null;
}

/**
 * Parse the `--require` flag from argv. Accepts BOTH forms:
 *   --require protoc,rust   (space-separated — what the workflows use)
 *   --require=protoc,rust   (equals form)
 * Pure so it can be unit-tested (Codex r1 P1: the prior code only handled the
 * `=` form, so the space form used by every workflow silently no-op'd.)
 */
export function parseRequire(argv) {
  const eq = argv.find((a) => a.startsWith("--require="));
  if (eq) {
    const names = eq.slice("--require=".length).split(",").map((s) => s.trim()).filter(Boolean);
    // `--require=` with no/empty value is a silent-no-op hazard (the gate would
    // degrade to node+lockfile). Return [""] so computeFailures rejects it as an
    // unknown name — same loud-failure class as a typo (Codex r5 P3).
    return names.length ? names : [""];
  }
  const sp = argv.indexOf("--require");
  if (sp >= 0) {
    // bare `--require` (no following token, or an empty token) — same hazard.
    if (sp + 1 < argv.length && argv[sp + 1] !== "") {
      return argv[sp + 1].split(",").map((s) => s.trim()).filter(Boolean);
    }
    return [""];
  }
  return [];
}

/**
 * Probe protoc the way the build does — mirror crates/build/xai-proto-build/
 * src/find_protoc.rs: $PROTOC → bin/protoc (dotslash) → PATH. (Codex r1 P3: the
 * prior code only checked PATH, so a local dev setup using `bin/protoc` with no
 * system protoc falsely failed.)
 */
function probeProtoc() {
  const envProtoc = process.env.PROTOC;
  if (envProtoc) {
    const out = run(envProtoc, ["--version"]);
    if (out) return out;
  }
  const binProtoc = path.join(REPO, "bin", "protoc");
  // bin/protoc is a dotslash manifest; only resolves where dotslash is
  // installed. On systems without it, run() returns null → fall through.
  const binOut = run(binProtoc, ["--version"]);
  if (binOut) return binOut;
  return run("protoc", ["--version"]);
}

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
  if (!satisfies(nodeVersion, range)) {
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

/**
 * @param {string|null} protocOutput
 * @param {string} [expectedVersion]  if provided, enforce equality (the ADR
 *   declares a single aligned protoc version; presence-only would let dev/CI
 *   drift — the exact gap R6-02 set out to close)
 * @returns {CheckResult}
 */
export function checkProtoc(protocOutput, expectedVersion) {
  const v = parseProtocVersion(protocOutput);
  if (!v) {
    return {
      ok: false,
      reason: "protoc not found. CI uses arduino/setup-protoc; locally use `bin/protoc` (dotslash) or set $PROTOC. The build resolves $PROTOC → bin/protoc → PATH.",
    };
  }
  if (expectedVersion && v !== expectedVersion) {
    return {
      ok: false,
      reason: `protoc ${v} does not match the pinned ${expectedVersion} (ADR 0005). Align CI (arduino/setup-protoc version) and bin/protoc to ${expectedVersion}.`,
    };
  }
  return { ok: true, reason: `protoc ${v}${expectedVersion ? ` (== ${expectedVersion})` : ""}.` };
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
  if (isValidVersion(expectedChannel)) {
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
    protoc: checkProtoc(deps.protocOutput, EXPECTED_PROTOC_VERSION),
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
  const failures = Object.entries(results)
    .filter(([name, r]) => req.has(name) && !r.ok)
    .map(([name, r]) => `[${name}] ${r.reason}`);
  // A typo'd --require name (e.g. "protc") matches nothing and would silently
  // weaken the gate — the same silent-no-op class the space-form parser bug
  // belonged to. Fail loudly so a workflow typo is caught (Codex r4 P3).
  const valid = new Set(Object.keys(results));
  for (const name of require) {
    if (!valid.has(name)) {
      failures.push(`[require] unknown check "${name}" — valid: ${[...valid].join(", ")}`);
    }
  }
  return failures;
}

/**
 * Resolve a dependency's exact pinned version from package-lock.json, falling
 * back to the declared range in package.json. (Codex r6 P3: recording the
 * declared range "^44.4.1" as "the version" is misleading in the evidence
 * chain; the lockfile pins the exact version actually used.)
 */
export function resolvedVersion(lockfile, name, declared) {
  const v = lockfile?.packages?.[`node_modules/${name}`]?.version;
  return v ?? declared ?? null;
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: opts.shell ?? false,
      env: opts.env ?? process.env,
    }).trim();
  } catch {
    return null;
  }
}

export function main(argv) {
  // --require accepts both `--require protoc,rust` (workflows) and
  // `--require=protoc,rust`. Default required = node, lockfile; --require adds
  // extras so a job that doesn't need protoc/rust isn't failed for their
  // absence. (Codex r1 P1: the prior parser only handled the `=` form, so the
  // space form used by every workflow silently no-op'd.)
  const require = parseRequire(argv);
  // Only suppress rustup auto-install when rust is NOT required — a no-Rust job
  // (e.g. frontend) shouldn't pay for a multi-hundred-MB toolchain it doesn't
  // use. When rust IS required, allow auto-install so the rustup proxy can
  // fetch the rust-toolchain.toml-pinned toolchain (Codex r3 P1: blanket
  // RUSTUP_AUTO_INSTALL=0 broke rust-pty/e2e/release-gate, where the pin
  // isn't installed until the proxy resolves it).
  const rustRequired = require.includes("rust");

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
    // win32: npm is npm.cmd; since Node's CVE-2024-27980 fix, spawning a .cmd
    // without a shell throws, so use shell:true on Windows to actually capture
    // the npm version (Codex r2 P3).
    npmVersion: run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["--version"],
      { shell: process.platform === "win32" },
    ),
    nodeRange,
    lockfile,
    protocOutput: probeProtoc(),
    // Probe rustc with RUSTUP_AUTO_INSTALL=0 ONLY when rust isn't required, so
    // a no-Rust job doesn't trigger a toolchain auto-install via the rustup
    // proxy + rust-toolchain.toml. When rust IS required, allow auto-install
    // so the pinned toolchain can be fetched and reported (Codex r3 P1).
    rustcOutput: run("rustc", ["--version"], { env: rustRequired ? process.env : { ...process.env, RUSTUP_AUTO_INSTALL: "0" } }),
    rustChannel: parseRustToolchainChannel(rustToml),
    electronVersion: resolvedVersion(lockfile, "electron", pkg.devDependencies?.electron),
    electronBuilderVersion: resolvedVersion(lockfile, "electron-builder", pkg.devDependencies?.["electron-builder"]),
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
