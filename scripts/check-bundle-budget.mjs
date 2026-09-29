#!/usr/bin/env node
/**
 * Renderer bundle budget gate (R5-06 / #262).
 *
 *   node scripts/check-bundle-budget.mjs [distDir]
 *
 * Reads the entry script from dist/index.html (never a filename heuristic)
 * and asserts:
 *   - entry chunk: raw < 500 KB and gzip < 200 KB
 *   - every non-entry chunk: raw < 350 KB
 * Prints a per-chunk table; exits non-zero on any violation.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const ENTRY_RAW_MAX = 500 * 1024;
const ENTRY_GZIP_MAX = 200 * 1024;
const CHUNK_RAW_MAX = 350 * 1024;

export function checkBundleBudget(distDir) {
  const indexHtml = path.join(distDir, "index.html");
  if (!fs.existsSync(indexHtml)) {
    return { ok: false, reason: `no index.html in ${distDir}`, rows: [] };
  }
  const html = fs.readFileSync(indexHtml, "utf-8");
  // The entry is the module script index.html loads from ./assets/.
  const entryMatch = html.match(/src="\.\/(assets\/[^"]+\.js)"/);
  if (!entryMatch) {
    return { ok: false, reason: "no module entry script in index.html", rows: [] };
  }
  const entryRel = entryMatch[1];

  const assetsDir = path.join(distDir, "assets");
  const files = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"))
    : [];
  if (files.length === 0) {
    return { ok: false, reason: `no js chunks in ${assetsDir}`, rows: [] };
  }

  const rows = files.map((f) => {
    const rel = path.join("assets", f);
    const buf = fs.readFileSync(path.join(distDir, rel));
    return {
      file: rel,
      raw: buf.length,
      gzip: zlib.gzipSync(buf).length,
      isEntry: rel === entryRel,
    };
  });

  const failures = [];
  for (const row of rows) {
    if (row.isEntry) {
      if (row.raw >= ENTRY_RAW_MAX) failures.push(`${row.file} entry raw ${row.raw} >= ${ENTRY_RAW_MAX}`);
      if (row.gzip >= ENTRY_GZIP_MAX) failures.push(`${row.file} entry gzip ${row.gzip} >= ${ENTRY_GZIP_MAX}`);
    } else if (row.raw >= CHUNK_RAW_MAX) {
      failures.push(`${row.file} chunk raw ${row.raw} >= ${CHUNK_RAW_MAX}`);
    }
  }
  return { ok: failures.length === 0, reason: failures.join("; ") || null, rows, entry: entryRel };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const distDir = process.argv[2] ?? "dist";
  const r = checkBundleBudget(distDir);
  for (const row of r.rows.sort((a, b) => b.raw - a.raw)) {
    console.log(
      `${row.isEntry ? "[entry]" : "       "} ${row.file}  raw=${(row.raw / 1024).toFixed(1)}KB gzip=${(row.gzip / 1024).toFixed(1)}KB`
    );
  }
  if (!r.ok) {
    console.error(`bundle budget FAILED: ${r.reason}`);
    process.exit(1);
  }
  console.log("bundle budget OK");
}
