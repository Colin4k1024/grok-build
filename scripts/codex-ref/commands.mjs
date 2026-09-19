#!/usr/bin/env node
// Extract the Codex desktop command registry (command palette + keybindings).
//
// The renderer declares commands as object literals:
//   {id:`stepWorkspaceLayout`, titleIntlId:`codex.command.stepWorkspaceLayout`,
//    descriptionIntlId:`…`, availableIn:[`electron`], shortcutScope:`app`,
//    commandMenuGroupKey:`panels`, commandMenuFeature:`codex`,
//    electron:{defaultKeybindings:[{key:`CmdOrCtrl+Shift+F`}]}}
//
// This walks the bundle, brace-matches each literal, and pulls the fields we
// care about. Output: $CODEX_REF_DIR/commands.tsv (+ stdout table).
//
//   node scripts/codex-ref/commands.mjs                 # all commands
//   node scripts/codex-ref/commands.mjs --group panels   # one command-menu group
//   node scripts/codex-ref/commands.mjs --keys           # only commands with keybindings
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.CODEX_REF_DIR || "/tmp/codex-ref";
const srcDir = path.join(OUT_DIR, "out");
if (!fs.existsSync(srcDir)) {
  console.error(`no extracted bundles in ${srcDir} — run scripts/codex-ref/get.mjs app-initial first`);
  process.exit(1);
}

const FIELDS = [
  "titleIntlId",
  "descriptionIntlId",
  "availableIn",
  "shortcutScope",
  "commandMenuGroupKey",
  "commandMenuFeature",
];

/** Brace-match the object literal starting at the `{` preceding `id:`. */
function sliceLiteral(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function field(lit, name) {
  const m = lit.match(new RegExp(`(?:^|[{,])${name}:((?:\\[[^\\]]*\\])|\`[^\`]*\`)`));
  if (!m) return "";
  const raw = m[1];
  return raw.startsWith("`") ? raw.slice(1, -1) : raw.replace(/[`[\]]/g, "");
}

function keys(lit) {
  return [...lit.matchAll(/key:`([^`]+)`/g)].map((m) => m[1]);
}

/** @type {Map<string,object>} */
const cmds = new Map();
for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(srcDir, f), "utf8");
  const re = /\{id:`([a-zA-Z0-9._-]+)`,titleIntlId:/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index;
    const lit = sliceLiteral(text, open);
    if (!lit) continue;
    const id = m[1];
    const rec = { id, keys: keys(lit), bundle: f };
    for (const fl of FIELDS) rec[fl] = field(lit, fl);
    // Keep the richest record if a command is declared in several bundles.
    const prev = cmds.get(id);
    if (!prev || JSON.stringify(prev).length < JSON.stringify(rec).length) cmds.set(id, rec);
  }
}

const rows = [...cmds.values()].sort((a, b) =>
  (a.commandMenuGroupKey || "~").localeCompare(b.commandMenuGroupKey || "~") || a.id.localeCompare(b.id)
);

fs.writeFileSync(
  path.join(OUT_DIR, "commands.tsv"),
  ["id\tgroup\tscope\tkeys\tavailableIn\ttitle\tbundle",
   ...rows.map((r) =>
     [r.id, r.commandMenuGroupKey, r.shortcutScope, r.keys.join(" "), r.availableIn, r.titleIntlId, r.bundle].join("\t")
   )].join("\n")
);

const args = process.argv.slice(2);
const group = args[0] === "--group" ? args[1] : null;
const keysOnly = args.includes("--keys");
const shown = rows.filter(
  (r) => (!group || r.commandMenuGroupKey === group) && (!keysOnly || r.keys.length > 0)
);

const pad = (s, n) => String(s || "").slice(0, n).padEnd(n);
console.log(`${pad("group", 12)}${pad("id", 38)}${pad("keys", 26)}scope`);
for (const r of shown) {
  console.log(`${pad(r.commandMenuGroupKey, 12)}${pad(r.id, 38)}${pad(r.keys.join(" "), 26)}${r.shortcutScope}`);
}
const groups = [...new Set(rows.map((r) => r.commandMenuGroupKey || "(none)"))];
console.error(
  `${shown.length}/${rows.length} commands -> ${path.join(OUT_DIR, "commands.tsv")}\ngroups: ${groups.join(", ")}`
);
