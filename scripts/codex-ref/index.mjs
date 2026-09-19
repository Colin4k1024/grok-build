#!/usr/bin/env node
// Build a file index (path -> size/offset) of the installed ChatGPT.app asar.
//
// The Codex desktop renderer ships inside ChatGPT.app; this index is the entry
// point for every other codex-ref tool. Output: /tmp/codex-ref/index.json
//
//   node scripts/codex-ref/index.mjs [path-to-app.asar]
//
// Pure asar-header parsing (no @electron/asar dependency) so it runs anywhere.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ASAR = "/Applications/ChatGPT.app/Contents/Resources/app.asar";
const OUT_DIR = process.env.CODEX_REF_DIR || "/tmp/codex-ref";

const asarPath = process.argv[2] || DEFAULT_ASAR;
if (!fs.existsSync(asarPath)) {
  console.error(`asar not found: ${asarPath}`);
  process.exit(1);
}

const fd = fs.openSync(asarPath, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString("utf8"));
const base = 8 + head.readUInt32LE(4);

/** @type {{p:string,size:number,off:number}[]} */
const index = [];
(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`;
    if (v.files) walk(v, p);
    else index.push({ p, size: Number(v.size || 0), off: Number(v.offset || 0) });
  }
})(header, "");

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "index.json");
fs.writeFileSync(out, JSON.stringify({ asarPath, base, index }));

const assets = index.filter((e) => e.p.startsWith("/webview/assets/") && e.p.endsWith(".js"));
const modules = new Set(assets.map((e) => moduleName(e.p)));
console.log(`asar      : ${asarPath}`);
console.log(`files     : ${index.length}`);
console.log(`asset js  : ${assets.length} (${modules.size} unique modules)`);
console.log(`index     : ${out}`);

/** `/webview/assets/foo-bar-0123abcd4567.js` -> `foo-bar` */
export function moduleName(p) {
  return p.split("/").pop().replace(/-[0-9a-f]{8,}\.(js|css|map)$/, "");
}
