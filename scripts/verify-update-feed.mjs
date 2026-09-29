#!/usr/bin/env node
/**
 * Update-feed consistency gate (R5-07 / #263).
 *
 * Verifies an electron-builder update manifest against the artifacts on disk:
 * every file the manifest references must exist, and its size + base64
 * sha512 must match the manifest exactly. A feed whose manifest drifts from
 * the artifacts (e.g. `Grok-Build-*` in latest-mac.yml vs `Grok Build-*` on
 * disk) fails here BEFORE anything is uploaded — auto-update 404s and
 * corrupted installs become impossible to publish.
 *
 * Usage:
 *   node scripts/verify-update-feed.mjs <manifest.yml> [artifactsDir]
 *
 * Exit code 0 = every referenced file verified; 1 = any inconsistency.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

/** Stream the file into a sha512 hash and byte counter — installers are
 *  hundreds of MB; never buffer them whole. */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    let size = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha512: hash.digest("base64"), size }));
  });
}

/** Pull every referenced artifact out of the manifest: the files[] list plus
 *  the legacy top-level path/sha512 pair. files[] entries must carry BOTH
 *  sha512 and size; legacy entries must carry sha512 — missing integrity
 *  metadata is a hard failure, never a skipped check. */
function collectFeedEntries(manifest) {
  const entries = [];
  const seen = new Set();
  if (Array.isArray(manifest?.files)) {
    for (const f of manifest.files) {
      if (!f || typeof f.url !== "string") continue;
      seen.add(f.url);
      entries.push({
        url: f.url,
        sha512: typeof f.sha512 === "string" && f.sha512 ? f.sha512 : null,
        size: typeof f.size === "number" ? f.size : null,
        requiresSize: true,
      });
    }
  }
  if (typeof manifest?.path === "string" && !seen.has(manifest.path)) {
    entries.push({
      url: manifest.path,
      sha512: typeof manifest.sha512 === "string" && manifest.sha512 ? manifest.sha512 : null,
      size: null, // the legacy single-file shape has no size field
      requiresSize: false,
    });
  }
  return entries;
}

/** Resolve a manifest-referenced name inside artifactsDir, refusing absolute
 *  paths and `..` traversal — a crafted manifest must never make the verifier
 *  hash files outside the release directory. */
function resolveArtifactPath(artifactsDir, urlName) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlName);
  } catch {
    throw new Error(`not a valid URL-encoded name: ${urlName}`);
  }
  const base = path.resolve(artifactsDir);
  const resolved = path.resolve(base, decoded);
  if (path.isAbsolute(decoded) || resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`absolute path or traversal rejected: ${urlName}`);
  }
  return resolved;
}

export async function verifyUpdateFeed(manifestPath, artifactsDir = path.dirname(manifestPath)) {
  const results = [];
  let manifest;
  try {
    manifest = yaml.load(fs.readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    return { ok: false, results: [{ file: path.basename(manifestPath), ok: false, reason: `unparseable manifest: ${e.message}` }] };
  }
  if (!manifest || typeof manifest.version !== "string") {
    return { ok: false, results: [{ file: path.basename(manifestPath), ok: false, reason: "manifest has no version" }] };
  }
  const entries = collectFeedEntries(manifest);
  if (entries.length === 0) {
    return { ok: false, results: [{ file: path.basename(manifestPath), ok: false, reason: "manifest references no files" }] };
  }
  for (const entry of entries) {
    // Integrity metadata is mandatory — a manifest that omits it has NOT
    // verified anything, so it fails instead of silently skipping.
    if (!entry.sha512) {
      results.push({ file: entry.url, ok: false, reason: "manifest entry is missing sha512" });
      continue;
    }
    if (entry.requiresSize && entry.size === null) {
      results.push({ file: entry.url, ok: false, reason: "manifest entry is missing size" });
      continue;
    }
    let filePath;
    try {
      filePath = resolveArtifactPath(artifactsDir, entry.url);
    } catch (e) {
      results.push({ file: entry.url, ok: false, reason: e.message });
      continue;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      results.push({ file: entry.url, ok: false, reason: `artifact not found at ${filePath}` });
      continue;
    }
    const actual = await hashFile(filePath);
    if (entry.size !== null && actual.size !== entry.size) {
      results.push({ file: entry.url, ok: false, reason: `size mismatch: manifest ${entry.size}, disk ${actual.size}` });
      continue;
    }
    if (actual.sha512 !== entry.sha512) {
      results.push({ file: entry.url, ok: false, reason: `sha512 mismatch for ${path.basename(filePath)}` });
      continue;
    }
    results.push({ file: entry.url, ok: true, reason: `size=${actual.size} sha512 verified` });
  }
  return { ok: results.every((r) => r.ok), results };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const [, , manifestPath, artifactsDir] = process.argv;
  if (!manifestPath) {
    console.error("usage: node scripts/verify-update-feed.mjs <manifest.yml> [artifactsDir]");
    process.exit(1);
  }
  verifyUpdateFeed(manifestPath, artifactsDir ?? path.dirname(manifestPath))
    .then(({ ok, results }) => {
      for (const r of results) {
        console.log(`${r.ok ? "PASS" : "FAIL"} ${r.file} — ${r.reason}`);
      }
      if (!ok) {
        console.error("update feed verification FAILED — refusing to treat this feed as publishable");
        process.exit(1);
      }
      console.log(`update feed verification OK (${results.length} file(s))`);
    })
    .catch((e) => {
      console.error(`verify-update-feed: ${e.message}`);
      process.exit(1);
    });
}
