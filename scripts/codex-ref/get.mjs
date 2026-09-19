#!/usr/bin/env node
// Extract renderer modules from the ChatGPT.app asar by base module name.
//
//   node scripts/codex-ref/get.mjs composer-utility-bar thread-side-panel-tab-content
//   node scripts/codex-ref/get.mjs --list codex      # list module names matching a pattern
//   node scripts/codex-ref/get.mjs --top 30          # largest asset modules
//
// Files land in $CODEX_REF_DIR/out (default /tmp/codex-ref/out).
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.CODEX_REF_DIR || "/tmp/codex-ref";
const meta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "index.json"), "utf8"));
const fd = fs.openSync(meta.asarPath, "r");
const outDir = path.join(OUT_DIR, "out");
fs.mkdirSync(outDir, { recursive: true });

const moduleName = (p) => p.split("/").pop().replace(/-[0-9a-f]{8,}\.(js|css|map)$/, "");
const assets = meta.index.filter((e) => e.p.startsWith("/webview/assets/"));

const args = process.argv.slice(2);

if (args[0] === "--list") {
  const pat = new RegExp(args[1] || "", "i");
  const names = [...new Set(assets.filter((e) => e.p.endsWith(".js")).map((e) => moduleName(e.p)))]
    .filter((n) => pat.test(n))
    .sort();
  console.log(names.join("\n"));
  console.error(`${names.length} modules`);
  process.exit(0);
}

if (args[0] === "--top") {
  const n = Number(args[1] || 30);
  assets
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, n)
    .forEach((e) => console.log(`${(e.size / 1e6).toFixed(1)}MB  ${e.p}`));
  process.exit(0);
}

if (args.length === 0) {
  console.error("usage: get.mjs <module-name>... | --list <pattern> | --top <n>");
  process.exit(2);
}

let count = 0;
for (const want of args) {
  const matches = assets.filter((e) => moduleName(e.p) === want);
  if (matches.length === 0) console.error(`no match: ${want}`);
  for (const e of matches) {
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, meta.base + e.off);
    const out = path.join(outDir, e.p.split("/").pop());
    fs.writeFileSync(out, buf);
    console.log(`${want} -> ${out} (${(e.size / 1024).toFixed(0)}KB)`);
    count++;
  }
}
console.error(`${count} file(s) extracted to ${outDir}`);
