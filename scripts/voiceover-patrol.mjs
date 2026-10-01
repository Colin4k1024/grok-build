#!/usr/bin/env node
/**
 * VoiceOver live-speech patrol (R4 matrix §2.4 / UAT-22 follow-up, #274).
 *
 * Runs the "method itself" a human runs at the release window, scripted and
 * auditable: with VoiceOver REALLY enabled, focus the app, hop the VoiceOver
 * cursor with VoiceOver's own navigation semantics, and capture what
 * VoiceOver ACTUALLY SPEAKS at every stop (`content of last phrase`). Falls
 * back to — and always also records — the AX focused element per keyboard
 * hop (role+title+description+value is exactly what VoiceOver speaks at that
 * stop), so the run leaves a complete station-by-station transcript.
 *
 * Design rules (from #274):
 *   - This script NEVER toggles VoiceOver on or off. VoiceOver is a
 *     system-level switch; the executor enables it (⌘F5) at the release
 *     window. If VO is off, the script exits non-zero with instructions.
 *   - It never types into or clicks the app beyond focus + keyboard hops.
 *
 * Usage:
 *   scripts/voiceover-patrol.mjs [--app-name GrokPatrol] [--vo-stops 8]
 *                                [--tab-stops 12] [--out run.log]
 *
 * Exit: 0 = patrol completed (report written); 1 = preflight failed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Run an AppleScript; return trimmed stdout. Throws on osascript failure. */
export function osa(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf-8", timeout: 30_000 }).trim();
}

/** CLI flag parser, aliased for tests. */
export const parseArgsAlias = (argv) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
};

/** Detect whether VoiceOver is running (speech daemon `scrod` is a reliable
 *  proxy: it stays resident only while VoiceOver is active). Exported for
 *  tests (the shell `pgrep` is faked there). */
export function detectVoiceOver({ pgrep = runPgrep } = {}) {
  const safe = (...args) => {
    try {
      return Boolean(pgrep(...args));
    } catch {
      // A missing probe binary is "cannot tell" — patrol requires a positive
      // detection, so it degrades to NOT running instead of crashing.
      return false;
    }
  };
  const overMain = safe("-x", "VoiceOver");
  const scrod = safe("-x", "scrod");
  return { running: overMain || scrod, evidence: { voiceOverProcess: overMain, speechDaemon: scrod } };
}

function runPgrep(...args) {
  try {
    const r = execFileSync("pgrep", args, { encoding: "utf-8" });
    return r.trim().length > 0;
  } catch {
    // pgrep exits 1 when nothing matches — that is "not running", not an error.
    return false;
  }
}

/** The AppleScript block executed for every VO-navigation station: move the
 *  VO cursor, then read what VoiceOver actually SPOKE (last phrase). Kept as
 *  exported data so tests pin the real runtime query, not a lookalike. */
export const VO_PHRASE_QUERY = `with timeout of 12 seconds
  tell application "VoiceOver"
    tell vo cursor to MOVE_PLACEHOLDER
    delay 0.45
    return content of last phrase
  end tell
end timeout`;

function logLine(out, line) {
  fs.appendFileSync(out, line + "\n");
  console.log(line);
}

async function main() {
  const args = parseArgsAlias(process.argv.slice(2));
  const appName = args["app-name"] ?? "Grok Build";
  const voStops = Number(args["vo-stops"] ?? 8);
  const tabStops = Number(args["tab-stops"] ?? 12);
  const settingsStops = Number(args["settings-stops"] ?? 7);
  const reverseStops = Number(args["reverse-stops"] ?? 7);
  const out = args.out ?? path.join(repoRoot, ".uat", "voiceover-patrol.log");

  if (process.platform !== "darwin") {
    console.error(`[voiceover-patrol] darwin-only tool (VoiceOver is a macOS screen reader); refusing on ${process.platform}.`);
    process.exit(1);
  }

  // 1. Preflight: VoiceOver must ALREADY be on (executor toggles ⌘F5, not us).
  const vo = detectVoiceOver();
  if (!vo.running) {
    console.error(
      "[voiceover-patrol] VoiceOver is not running. Enable it first (⌘F5, or `open " +
        '"/System/Library/CoreServices/VoiceOver.app"`), then re-run. ' +
        "This script never flips system accessibility state itself (#274)."
    );
    process.exit(1);
  }
  console.error(`[voiceover-patrol] VoiceOver detected (process=${vo.evidence.voiceOverProcess} speech=${vo.evidence.speechDaemon})`);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "");
  logLine(out, `=== VoiceOver live patrol — ${new Date().toISOString()} — app: ${appName} ===`);

  // 2. Focus the app (raise + frontmost, one script so no other window steals it).
  try {
    osa(`tell application "System Events" to tell (first process whose name is "${appName}")
  perform action "AXRaise" of window 1
  set frontmost to true
end tell`);
  } catch (e) {
    console.error(`[voiceover-patrol] could not focus app "${appName}": ${e.message}`);
    process.exit(1);
  }

  // 3. VoiceOver's own navigation: first item, then move right, capturing the
  //    spoken phrase at every stop. Timeouts are per-stop: a busy VO just
  //    yields "(vo timeout)" for that stop instead of killing the patrol.
  logLine(out, "V00 first-item | " + safeVOPhrase("tell vo cursor to move to first item"));
  for (let i = 1; i <= voStops; i++) {
    const tag = `V${String(i).padStart(2, "0")} vo-right`;
    logLine(out, `${tag} | ` + safeVOPhrase("tell vo cursor to move right"));
  }

  // 4. Keyboard station walk (what VO speaks per focus move is the AX focused
  //    element's role+name+value) — Tab forward, ⌘, settings, Shift-Tab back.
  const axStop = () => {
    try {
      return osa(`tell application "System Events"
  set f to value of attribute "AXFocusedUIElement" of (first process whose name is "${appName}")
  if f is missing value then return "(no focus)"
  set r to "?"
  try
    set r to value of attribute "AXRole" of f as text
  end try
  set t to ""
  try
    set t to value of attribute "AXTitle" of f as text
  end try
  set d to ""
  try
    set d to value of attribute "AXDescription" of f as text
  end try
  set v to ""
  try
    set v to value of attribute "AXValue" of f as text
    if (count of v) > 70 then set v to text 1 thru 70 of v
  end try
  return r & " | " & t & " | " & d & " | " & v
end tell`);
    } catch (e) {
      return "(ax error) " + e.message.split("\n")[0];
    }
  };
  let hopFailures = 0;
  const hop = (keyStmt, delayMs) => {
    try {
      osa(`tell application "System Events" to ${keyStmt}`);
      hopFailures = 0;
    } catch (e) {
      // A blip is fine; a STREAK means System Events cannot send events at all
      // (e.g. missing Accessibility permission) — every further "station"
      // would be a stale re-read, so fail the patrol instead of faking one.
      hopFailures += 1;
      if (hopFailures >= 3) {
        logLine(out, `FATAL ${hopFailures} consecutive keystroke failures — System Events cannot send keys (Accessibility permission?)`);
        console.error("[voiceover-patrol] aborting: keystroke channel is down");
        process.exit(1);
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  };

  for (let i = 1; i <= tabStops; i++) {
    hop("key code 48", 900);
    logLine(out, `K${String(i).padStart(2, "0")} Tab | ` + axStop());
  }
  hop('keystroke "," using command down', 1500);
  logLine(out, "S01 settings | " + axStop());
  for (let i = 2; i <= settingsStops; i++) {
    hop("key code 48", 900);
    logLine(out, `S${String(i).padStart(2, "0")} Tab | ` + axStop());
  }
  hop("key code 53", 1200);
  for (let i = 1; i <= reverseStops; i++) {
    hop("key code 48 using shift down", 900);
    logLine(out, `R${String(i).padStart(2, "0")} ShiftTab | ` + axStop());
  }

  logLine(out, `=== patrol complete ===`);
  console.error(`[voiceover-patrol] transcript: ${out}`);
  process.exit(0);
}

function safeVOPhrase(move) {
  try {
    return osa(VO_PHRASE_QUERY.replace("MOVE_PLACEHOLDER", move));
  } catch (e) {
    return "(vo timeout/unavailable) " + e.message.split("\n")[0].slice(0, 60);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((e) => {
    console.error(`[voiceover-patrol] ${e?.message ?? e}`);
    process.exit(1);
  });
}
