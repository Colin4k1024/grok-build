// @vitest-environment node
//
// Unit tests for the VoiceOver patrol harness (#274). The GUI parts (osascript
// against a live VoiceOver + app, and main()'s exit paths) are human-window
// tooling exercised by running the script; what IS testable headless is the
// VO-detection contract and the exact runtime speech query the patrol sends.
import { describe, it, expect } from "vitest";
import { detectVoiceOver, parseArgsAlias as parseArgs, VO_PHRASE_QUERY } from "../voiceover-patrol.mjs";

// The script keeps parseArgs internal for the CLI; re-exported under an alias
// for tests. If that alias is missing the test fails loudly rather than
// silently testing nothing.
describe("detectVoiceOver (pgrep injected)", () => {
  it("reports running when the speech daemon scrod is resident", () => {
    const r = detectVoiceOver({ pgrep: (flag, name) => name === "scrod" });
    expect(r.running).toBe(true);
    expect(r.evidence.speechDaemon).toBe(true);
    expect(r.evidence.voiceOverProcess).toBe(false);
  });

  it("reports running when the VoiceOver process itself is up", () => {
    const r = detectVoiceOver({ pgrep: (flag, name) => name === "VoiceOver" });
    expect(r.running).toBe(true);
    expect(r.evidence.voiceOverProcess).toBe(true);
  });

  it("reports NOT running when neither process exists — pgrep exit-1 is a state, not an error", () => {
    const r = detectVoiceOver({ pgrep: () => false });
    expect(r.running).toBe(false);
  });

  it("pgrep throwing (missing binary) degrades to NOT running, not a crash", () => {
    const r = detectVoiceOver({ pgrep: () => { throw new Error("no pgrep"); } });
    expect(r.running).toBe(false);
  });
});

describe("VO speech capture contract", () => {
  it("the runtime query is the one safeVOPhrase executes: a VO-cursor move + last-phrase read inside a timeout", () => {
    // MOVE_PLACEHOLDER is where safeVOPhrase splices the move ("tell vo cursor to move right");
    // asserting the placeholder pins that the exported constant is the LIVE template,
    // not a lookalike nobody runs.
    expect(VO_PHRASE_QUERY).toContain("MOVE_PLACEHOLDER");
    expect(VO_PHRASE_QUERY).toContain("tell application \"VoiceOver\"");
    expect(VO_PHRASE_QUERY).toContain("content of last phrase");
    expect(VO_PHRASE_QUERY).toContain("with timeout of");
  });
});

describe("parseArgs", () => {
  it("parses --flags with values and bare flags", () => {
    const a = parseArgs(["--app-name", "Grok Build", "--vo-stops", "8", "--dry"]);
    expect(a["app-name"]).toBe("Grok Build");
    expect(a["vo-stops"]).toBe("8");
    expect(a.dry).toBe(true);
  });

  it("defaults to nothing positional lost", () => {
    const a = parseArgs(["x"]);
    expect(a._).toEqual(["x"]);
  });
});
