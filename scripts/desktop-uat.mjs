#!/usr/bin/env node
/**
 * Isolated desktop UAT launcher (R5-04 / #260).
 *
 *   node scripts/desktop-uat.mjs prepare [--with-credentials] [--run <id>]
 *   node scripts/desktop-uat.mjs run --run <id>
 *   node scripts/desktop-uat.mjs record --run <id> --item UAT-NN --status pass|fail|partial [--note "…"] [--issue URL]
 *   node scripts/desktop-uat.mjs report --run <id> [--strict]
 *   node scripts/desktop-uat.mjs clean --run <id>
 *
 * prepare creates an isolated run dir (`.uat/runs/<id>/`) holding a temp
 * GROK_HOME, GB_JOURNAL_DIR, Electron userData, and a fixture workspace;
 * --with-credentials copies the real API key/auth files READ-ONLY into the
 * run dir (mode 0600) so real-account matrix items execute against the real
 * account without ever writing to the real home.
 *
 * run launches THIS checkout's packed app (release/mac-arm64) with the
 * isolated env. report --strict exits non-zero while any matrix item is
 * unexecuted, partial, or failed without a linked GitHub issue.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  UAT_ITEMS,
  appendResult,
  buildReport,
  collectResults,
  readManifest,
  runDir,
  writeManifest,
} from "./lib/uat-state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function pkgVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")).version;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Copy credential files read-only from the real GROK_HOME into the run dir. */
function seedCredentials(grokHome) {
  const realHome = process.env.GROK_HOME || path.join(process.env.HOME ?? "", ".grok");
  const copied = [];
  for (const name of ["api_keys.json", "auth.json"]) {
    const src = path.join(realHome, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(grokHome, name);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o600);
    copied.push(name);
  }
  return copied;
}

/** The agent's `serve` fetches the model catalog from the network when the
 *  home lacks a fresh one — on a slow/blocked network that hangs startup
 *  (observed: fresh home never listens, seeded home listens in ~0.5s). Seed
 *  the non-sensitive catalog files read-only so the isolated env boots
 *  offline. Not credentials — always seeded when available. */
function seedModelCatalog(grokHome) {
  const realHome = process.env.GROK_HOME || path.join(process.env.HOME ?? "", ".grok");
  const copied = [];
  for (const name of ["default_models.json", "version.json"]) {
    const src = path.join(realHome, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(grokHome, name));
    copied.push(name);
  }
  return copied;
}

function cmdPrepare(args) {
  const id = args.run ?? `r${Date.now().toString(36)}`;
  const dir = runDir(repoRoot, id);
  const paths = {
    grokHome: path.join(dir, "grok-home"),
    journalDir: path.join(dir, "journal"),
    userData: path.join(dir, "user-data"),
    workspace: path.join(dir, "workspace"),
  };
  for (const p of Object.values(paths)) {
    fs.mkdirSync(p, { recursive: true });
  }
  fs.mkdirSync(path.join(paths.grokHome, "sessions"), { recursive: true });
  fs.chmodSync(dir, 0o700);

  // The agent's serve blocks its listener on the update check (x.ai); on a
  // slow/blocked network the first boot never becomes ready. UAT tests the
  // desktop app, not the agent's self-update — pin auto_update=false in the
  // isolated home (the agent preserves existing config keys at boot).
  // Managed/system MCP layers ignore GROK_HOME by design; a managed server
  // with an expired token (observed: Notion) fatally kills sessions in the
  // isolated env. Disable it for UAT hermeticity.
  const configPath = path.join(paths.grokHome, "config.toml");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      // disabled_mcp_servers is a TOP-LEVEL key (under [cli] it is ignored).
      'disabled_mcp_servers = ["Notion"]\n\n[cli]\nauto_update = false\n'
    );
  }

  const catalogSeeded = seedModelCatalog(paths.grokHome);

  let withCredentials = false;
  if (args["with-credentials"]) {
    const copied = seedCredentials(paths.grokHome);
    withCredentials = copied.length > 0;
    if (!withCredentials) {
      console.error("warning: --with-credentials given but no real credentials found to copy");
    }
  }

  const manifest = {
    id,
    startedAt: new Date().toISOString(),
    appVersion: pkgVersion(),
    commit: gitCommit(),
    paths,
    withCredentials,
  };
  writeManifest(repoRoot, manifest);
  console.log(JSON.stringify({ ...manifest, catalogSeeded }, null, 2));
  return 0;
}

function resolveAppBinary() {
  const candidates = [
    path.join(repoRoot, "release", "mac-arm64", "Grok Build.app", "Contents", "MacOS", "Grok Build"),
    path.join(repoRoot, "release", "mac", "Grok Build.app", "Contents", "MacOS", "Grok Build"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error("packed app not found — run npm run electron:pack first");
  }
  return found;
}

function cmdRun(args) {
  const manifest = readManifest(repoRoot, String(args.run));
  // A modified/stale manifest must never point the app at paths outside the
  // run dir — that would defeat the isolation the harness exists for.
  const root = path.resolve(runDir(repoRoot, manifest.id));
  for (const [key, p] of Object.entries(manifest.paths)) {
    const resolved = path.resolve(p);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`manifest path ${key} escapes the run dir: ${p}`);
    }
  }
  const bin = resolveAppBinary();
  const child = spawn(bin, ["."], {
    cwd: manifest.paths.workspace,
    env: {
      ...process.env,
      GROK_HOME: manifest.paths.grokHome,
      GB_JOURNAL_DIR: manifest.paths.journalDir,
      GB_UAT_USER_DATA_DIR: manifest.paths.userData,
    },
    stdio: "inherit",
  });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        // A signal exit is a crash/kill, not a deliberate quit — fail loudly.
        console.error(`uat app died via signal ${signal}`);
        resolve(1);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

function cmdRecord(args) {
  const runId = String(args.run ?? "");
  const item = String(args.item ?? "");
  const status = String(args.status ?? "");
  if (!runId || !item || !status) {
    throw new Error("record requires --run, --item, --status");
  }
  appendResult(repoRoot, runId, {
    item,
    status,
    at: new Date().toISOString(),
    executor: process.env.USER ?? "unknown",
    note: typeof args.note === "string" ? args.note : undefined,
    issueUrl: typeof args.issue === "string" ? args.issue : undefined,
  });
  console.log(`recorded ${item}: ${status}`);
  return 0;
}

/** Splice the result cell of each matrix row `| <n> | … | … | old |`. */
function spliceMatrix(doc, report) {
  const symbol = { pass: "✅", fail: "❌", partial: "⚠️" };
  const byRow = new Map(report.rows.map((r, idx) => [idx + 1, r.record]));
  return doc.split("\n").map((line) => {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (!m) return line;
    const n = Number(m[1]);
    if (n < 1 || n > UAT_ITEMS.length) return line;
    const rec = byRow.get(n);
    if (!rec) return line;
    const cells = line.split("|");
    if (cells.length < 5) return line;
    // Notes are free text — a pipe would become a phantom cell (and a second
    // splice would then split the evidence itself). Normalize to a safe form.
    const safeNote = (rec.note ?? "").replaceAll("|", "/").replaceAll("\n", " ");
    const note = safeNote ? `${symbol[rec.status]} ${safeNote}` : symbol[rec.status];
    const linked = rec.issueUrl ? `${note}（${rec.issueUrl}）` : note;
    // Idempotent: if a previous splice corrupted the row (extra cells from an
    // unsanitized note), rebuild the row from the first 4 cells + result.
    const head = cells.slice(0, 4).join("|");
    return `${head}| ${linked} |`;
  });
}

function cmdReport(args) {
  const runId = String(args.run ?? "");
  const report = buildReport(repoRoot, runId);

  const { counts } = report;
  console.log(`UAT run ${runId}: pass=${counts.pass} fail=${counts.fail} partial=${counts.partial} missing=${counts.missing}`);
  for (const row of report.rows) {
    const mark = row.record
      ? row.record.status === "pass" ? "✅" : row.record.status === "fail" ? "❌" : "⚠️"
      : "☐";
    console.log(`  ${mark} ${row.item.id} ${row.item.title}${row.record?.issueUrl ? ` (${row.record.issueUrl})` : ""}`);
  }

  if (args.write) {
    const docPath = path.join(repoRoot, "docs", "design", "r4-release-acceptance.md");
    const doc = fs.readFileSync(docPath, "utf-8");
    fs.writeFileSync(docPath, spliceMatrix(doc, report).join("\n"));
    console.log(`matrix results written into ${path.relative(repoRoot, docPath)}`);
  }

  if (args.strict && report.strictFailures.length > 0) {
    console.error("strict report FAILED:");
    for (const f of report.strictFailures) console.error(`  - ${f}`);
    return 1;
  }
  return 0;
}

function cmdClean(args) {
  const dir = runDir(repoRoot, String(args.run ?? ""));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${path.relative(repoRoot, dir)}`);
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "prepare":
      return cmdPrepare(args);
    case "run":
      return await cmdRun(args);
    case "record":
      return cmdRecord(args);
    case "report":
      return cmdReport(args);
    case "clean":
      return cmdClean(args);
    default:
      console.error("usage: desktop-uat.mjs prepare|run|record|report|clean …");
      return 2;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`desktop-uat: ${e.message}`);
      process.exit(1);
    }
  );
}

// Exported for tests.
export { spliceMatrix, parseArgs };
export { collectResults };
