// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistTranscript } from "../transcript-store";
import { getSessionHistory } from "../session-history";

let tmp = "";
const savedGrokHome = process.env.GROK_HOME;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-transcript-"));
  process.env.GROK_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
});

describe("persistTranscript (review P1: fork/import durability)", () => {
  it("writes updates.jsonl + summary.json in the replay format", () => {
    const r = persistTranscript({
      acpSessionId: "acp-abc123",
      cwd: "/w/alpha",
      title: "Forked thread",
      entries: [
        { role: "user", content: "hello", timestamp: 1 },
        { role: "assistant", content: "world", timestamp: 2 },
      ],
    });
    expect(r.written).toBe(2);

    const dir = path.join(tmp, "sessions", encodeURIComponent("/w/alpha"), "acp-abc123");
    expect(fs.existsSync(path.join(dir, "updates.jsonl"))).toBe(true);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf-8"));
    expect(summary).toMatchObject({
      info: { id: "acp-abc123", cwd: "/w/alpha" },
      generated_title: "Forked thread",
      num_messages: 2,
    });
  });

  it("the persisted transcript replays through the standard history reader", () => {
    persistTranscript({
      acpSessionId: "acp-abc123",
      cwd: "/w/alpha",
      title: "t",
      entries: [
        { role: "user", content: "question", timestamp: 5 },
        { role: "assistant", content: "answer", timestamp: 6 },
      ],
    });
    // This is the exact path restart/session-load uses to restore a thread.
    expect(getSessionHistory("acp-abc123", "/w/alpha")).toEqual([
      { role: "user", content: "question", timestamp: 5 },
      { role: "assistant", content: "answer", timestamp: 6 },
    ]);
  });

  it("atomic writes: no tmp residue", () => {
    persistTranscript({
      acpSessionId: "acp-abc123",
      cwd: "/w/alpha",
      title: "t",
      entries: [{ role: "user", content: "x", timestamp: 1 }],
    });
    const dir = path.join(tmp, "sessions", encodeURIComponent("/w/alpha"), "acp-abc123");
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("invalid session ids and empty transcripts are refused", () => {
    expect(() =>
      persistTranscript({ acpSessionId: "../escape", cwd: "/w", title: "t", entries: [] })
    ).toThrow(/invalid session id/);
    expect(
      persistTranscript({ acpSessionId: "valid-id", cwd: "/w", title: "t", entries: [] })
    ).toEqual({ written: 0 });
  });
});
