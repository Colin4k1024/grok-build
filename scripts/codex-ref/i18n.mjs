#!/usr/bin/env node
// Mine the Codex desktop i18n catalogue out of extracted renderer bundles.
//
// Message ids + defaultMessage strings are the most reliable specification of
// what the Codex desktop actually ships (every user-visible behaviour has one).
//
//   node scripts/codex-ref/get.mjs app-initial app-shared local-conversation-thread …
//   node scripts/codex-ref/i18n.mjs                     # mine everything in out/
//   node scripts/codex-ref/i18n.mjs --ns composer       # filter by namespace
//   node scripts/codex-ref/i18n.mjs --summary           # namespace histogram
//
// Output: $CODEX_REF_DIR/i18n.tsv  (id <TAB> defaultMessage)
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.CODEX_REF_DIR || "/tmp/codex-ref";
const srcDir = path.join(OUT_DIR, "out");
if (!fs.existsSync(srcDir)) {
  console.error(`no extracted bundles in ${srcDir} — run scripts/codex-ref/get.mjs first`);
  process.exit(1);
}

// Matches `id:\`some.key\`` optionally followed by `,defaultMessage:\`...\``.
const RE = /id:`([^`]+)`(?:,defaultMessage:`((?:[^`\\]|\\.)*)`)?/g;

/** @type {Map<string,string>} */
const map = new Map();
const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));
for (const f of files) {
  const text = fs.readFileSync(path.join(srcDir, f), "utf8");
  let m;
  while ((m = RE.exec(text))) {
    const id = m[1];
    const msg = (m[2] || "").replace(/\\`/g, "`");
    if (!map.has(id) || (!map.get(id) && msg)) map.set(id, msg);
  }
}

const rows = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
fs.writeFileSync(path.join(OUT_DIR, "i18n.tsv"), rows.map(([k, v]) => `${k}\t${v}`).join("\n"));

const args = process.argv.slice(2);
const nsFilter = args[0] === "--ns" ? args[1] : null;

if (args[0] === "--summary" || (!nsFilter && false)) {
  const ns = {};
  for (const [id] of rows) {
    const parts = id.split(".");
    const key = parts.length > 1 ? `${parts[0]}.${parts[1]}` : parts[0];
    ns[key] = (ns[key] || 0) + 1;
  }
  const top = Object.entries(ns).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of top) console.log(`${String(v).padStart(5)}  ${k}`);
  console.error(`${rows.length} ids from ${files.length} bundles`);
  process.exit(0);
}

const shown = nsFilter ? rows.filter(([id]) => id.startsWith(`${nsFilter}.`)) : rows;
for (const [id, msg] of shown) console.log(msg ? `${id}\t${msg}` : id);
console.error(`${shown.length} of ${rows.length} ids -> ${path.join(OUT_DIR, "i18n.tsv")}`);
