// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendJournal,
  readJournal,
  queueJournal,
  flushJournal,
  flushAllJournals,
  flushAllJournalsSync,
} from "../journal";

let tmp = "";
const savedDir = process.env.GB_JOURNAL_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-journal-test-"));
  process.env.GB_JOURNAL_DIR = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.GB_JOURNAL_DIR;
  else process.env.GB_JOURNAL_DIR = savedDir;
});

describe("journal", () => {
  it("round-trips a full turn: user prompt, streamed reply, boundary", () => {
    const id = "01a0af53-fae8-7e00-9726-a57c9e66f096";
    appendJournal(id, "user", "帮我看看这个");
    appendJournal(id, "assistant", "好的，");
    appendJournal(id, "assistant", "我先看一下。");
    appendJournal(id, "turn_end", "");
    appendJournal(id, "user", "继续");
    appendJournal(id, "assistant", "第二回合的回复");
    appendJournal(id, "turn_end", "");

    const entries = readJournal(id);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ role: "user", content: "帮我看看这个" });
    // Consecutive assistant deltas merge into ONE message per turn.
    expect(entries[1]).toMatchObject({ role: "assistant", content: "好的，我先看一下。" });
    expect(entries[2]).toMatchObject({ role: "user", content: "继续" });
    // turn_end closed the first reply — the second reply stays separate.
    expect(entries[3]).toMatchObject({ role: "assistant", content: "第二回合的回复" });
  });

  it("returns [] for an unknown session instead of throwing", () => {
    expect(readJournal("01a0b7fc-cce1-7f01-b00e-4ac23e74207d")).toEqual([]);
  });

  it("rejects session ids that could traverse paths", () => {
    expect(() => appendJournal("../escape", "user", "x")).toThrow(/invalid session id/);
    expect(() => appendJournal("a/b", "user", "x")).toThrow(/invalid session id/);
    // Reads stay lenient — an unknown/invalid id is just "no journal".
    expect(readJournal("../../etc")).toEqual([]);
  });

  it("survives corrupted lines and trailing whitespace", () => {
    const id = "01a0b702-2f88-73b0-9a3a-0c6166ffb386";
    appendJournal(id, "user", "one");
    const file = path.join(tmp, `${id}.jsonl`);
    fs.appendFileSync(file, "{not json}\n\n");
    appendJournal(id, "assistant", "reply");
    const entries = readJournal(id);
    expect(entries.map((e) => [e.role, e.content])).toEqual([
      ["user", "one"],
      ["assistant", "reply"],
    ]);
  });
});

// The buffered path exists because one sync append per TextDelta stalled the
// Electron main process for the whole turn. These guard its ordering contract.
describe("buffered journal", () => {
  it("coalesces queued deltas into one write, preserving order", async () => {
    const id = "01a0c001-0000-4000-8000-000000000001";
    queueJournal(id, "user", "prompt");
    for (const d of ["a", "b", "c", "d"]) queueJournal(id, "assistant", d);

    // Nothing is on disk until the flush — that is the whole point.
    expect(fs.existsSync(path.join(tmp, `${id}.jsonl`))).toBe(false);

    await flushJournal(id);
    const entries = readJournal(id);
    expect(entries.map((e) => [e.role, e.content])).toEqual([
      ["user", "prompt"],
      ["assistant", "abcd"],
    ]);

    // One coalesced append, not five.
    const lines = fs
      .readFileSync(path.join(tmp, `${id}.jsonl`), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(5);
  });

  it("an immediate appendJournal drains the buffer first, keeping line order", () => {
    const id = "01a0c002-0000-4000-8000-000000000002";
    queueJournal(id, "assistant", "streamed");
    // turn_end is written immediately for durability — it must land AFTER the
    // buffered delta, or the reply is cut off at the turn boundary.
    appendJournal(id, "turn_end", "");

    expect(readJournal(id).map((e) => e.content)).toEqual(["streamed"]);
  });

  it("readJournal sees buffered deltas without an explicit flush", () => {
    const id = "01a0c003-0000-4000-8000-000000000003";
    queueJournal(id, "assistant", "in-flight");
    // A resume racing the live stream must not silently lose the tail.
    expect(readJournal(id).map((e) => e.content)).toEqual(["in-flight"]);
  });

  it("flushAllJournals drains every dirty session", async () => {
    const a = "01a0c004-0000-4000-8000-000000000004";
    const b = "01a0c005-0000-4000-8000-000000000005";
    queueJournal(a, "assistant", "aaa");
    queueJournal(b, "assistant", "bbb");
    await flushAllJournals();
    expect(readJournal(a).map((e) => e.content)).toEqual(["aaa"]);
    expect(readJournal(b).map((e) => e.content)).toEqual(["bbb"]);
  });

  it("flushAllJournalsSync drains on the quit path", () => {
    const id = "01a0c006-0000-4000-8000-000000000006";
    queueJournal(id, "assistant", "last-partial-turn");
    flushAllJournalsSync();
    expect(readJournal(id).map((e) => e.content)).toEqual(["last-partial-turn"]);
  });

  it("rejects traversal ids at queue time, like appendJournal", () => {
    expect(() => queueJournal("../escape", "assistant", "x")).toThrow(/invalid session id/);
  });

  it("flushing an idle session is a no-op", async () => {
    await expect(flushJournal("01a0c007-0000-4000-8000-000000000007")).resolves.toBeUndefined();
  });
});
