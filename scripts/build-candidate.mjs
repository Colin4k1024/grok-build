#!/usr/bin/env node
// Release-candidate builder (R6-06 / #284).
//
// Wraps the pack + checksums/SBOM steps and freezes the result into an
// immutable candidate directory: .candidates/<version>-<sha8>-<ts>/
// The stamped candidate-manifest.json records the SHA/version the artifacts
// were BUILT from — the rehearsal's provenance source (it never trusts the
// working-tree HEAD). Files are made read-only as a best-effort immutability
// guard; mutating a candidate requires deliberately undoing permissions.
//
// Usage: npm run build:candidate

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(REPO, "release");
const CANDIDATES_DIR = path.join(REPO, ".candidates");

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", env: process.env, ...opts });
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8"));
const version = pkg.version;
const id = `${version}-${sha.slice(0, 8)}-${Date.now().toString(36)}`;

console.log(`build:candidate — ${id}`);
console.log("  step 1/4: npm run electron:pack");
sh("npm", ["run", "electron:pack"]);

console.log("  step 2/4: checksums + SBOM (scripts/release-checksums.sh)");
sh("bash", [path.join(REPO, "scripts", "release-checksums.sh"), "release"]);

console.log(`  step 3/4: freeze into .candidates/${id}/`);
const dest = path.join(CANDIDATES_DIR, id);
if (fs.existsSync(dest)) throw new Error(`candidate dir already exists: ${dest} (refusing to overwrite a candidate)`);
fs.mkdirSync(dest, { recursive: true });

// Move everything electron-builder/checksums produced except: rehearsal
// outputs (candidate-report.*, rehearsal-runs.jsonl — a PREVIOUS rehearsal's
// report must never leak into a new candidate as stale terminal state) and
// caches. Keep dmg/zip/yml/blockmap/checksums/sbom + the platform bundles.
const EXCLUDE = /^candidate-report\.|^rehearsal-runs\.jsonl$/;
const keep = (f) =>
  !EXCLUDE.test(f) &&
  (/(\.(dmg|zip|exe|AppImage|blockmap|yml|sha256|json))$/.test(f) || ["mac-arm64", "mac", "win-unpacked", "linux-unpacked"].includes(f));
for (const f of fs.readdirSync(RELEASE_DIR)) {
  if (!keep(f)) continue;
  fs.renameSync(path.join(RELEASE_DIR, f), path.join(dest, f));
}

console.log("  step 4/4: stamp candidate-manifest.json + freeze artifacts read-only");
// Everything the checksums/SBOM cover gets stamped and frozen. The report
// files a later rehearsal writes (candidate-report.*, rehearsal-runs.jsonl)
// are NOT artifacts and stay writable — freezing them would break evidence
// collection; the stamp's checksums are what make artifacts immutable.
const stampable = (f) => /\.(dmg|zip|exe|AppImage|blockmap|yml|sha256|json)$/.test(f);
const stamped = fs
  .readdirSync(dest)
  .filter((f) => stampable(f))
  .map((f) => ({ name: f, sha256: sha256File(path.join(dest, f)), size: fs.statSync(path.join(dest, f)).size }));
const stamp = {
  id,
  sha,
  version,
  builtAt: new Date().toISOString(),
  platforms: [`${process.platform}-${process.arch}`],
  files: stamped,
};
fs.writeFileSync(path.join(dest, "candidate-manifest.json"), JSON.stringify(stamp, null, 2));

// Best-effort immutability: strip ONLY the write bits — executables must keep
// their x bits or the app cannot launch for the e2e rehearsal. (Advisory on
// a local fs; the checksum verification in the rehearsal is the real check.)
function freeze(p) {
  const st = fs.statSync(p);
  try { fs.chmodSync(p, st.mode & ~0o222); } catch { /* advisory */ }
  if (st.isDirectory()) for (const c of fs.readdirSync(p)) freeze(path.join(p, c));
}
for (const e of stamped) freeze(path.join(dest, e.name));
if (fs.existsSync(path.join(dest, "mac-arm64"))) freeze(path.join(dest, "mac-arm64"));

console.log(`candidate frozen: ${dest}`);
console.log(`next: npm run test:e2e && npm run rehearse:candidate -- --id ${id}`);
