// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listHistorySessions,
  getSessionHistory,
} from "../session-history";

let tmp = "";
const savedGrokHome = process.env.GROK_HOME;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-hist-test-"));
  process.env.GROK_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
});

/** Resolve a session dir inside the tmp sessions root, refusing escapes. */
function sessionDir(encodedCwd: string, sid: string): string {
  const root = path.resolve(tmp, "sessions");
  const target = path.resolve(root, encodedCwd, sid);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("test path escaped the sessions tmp root");
  }
  return target;
}

function writeSession(encodedCwd: string, sid: string, files: Record<string, string>) {
  const dir = sessionDir(encodedCwd, sid);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep)) {
      throw new Error("test filename escaped the session dir");
    }
    fs.writeFileSync(file, content);
  }
  return dir;
}

function summaryJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    info: { id: "sid-1", cwd: "/w/alpha" },
    generated_title: "My thread",
    session_summary: "fallback summary",
    current_model_id: "grok-4",
    last_active_at: "2026-09-18T10:00:00Z",
    updated_at: "2026-09-18T09:00:00Z",
    num_messages: 7,
    ...overrides,
  });
}

describe("listHistorySessions", () => {
  it("returns [] when the sessions root does not exist", () => {
    expect(listHistorySessions()).toEqual([]);
  });

  it("returns [] for an empty sessions directory", () => {
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    expect(listHistorySessions()).toEqual([]);
  });

  it("parses summary.json with title/model/message defaults", () => {
    writeSession(encodeURIComponent("/w/alpha"), "sid-1", { "summary.json": summaryJson() });

    const [s] = listHistorySessions();
    expect(s).toMatchObject({
      id: "sid-1",
      session_id: "sid-1",
      title: "My thread",
      cwd: "/w/alpha",
      model: "grok-4",
      num_messages: 7,
    });
    expect(s.updated_at).toBe(Date.parse("2026-09-18T10:00:00Z"));
  });

  it("falls back: session_summary → 'Untitled', info.id → dir name, updated_at → last_active", () => {
    writeSession(encodeURIComponent("/w/alpha"), "dir-id", {
      "summary.json": JSON.stringify({
        info: { cwd: "/w/alpha" },
        session_summary: "the summary",
        last_active_at: "2026-09-18T08:00:00Z",
      }),
    });

    const [s] = listHistorySessions();
    expect(s).toMatchObject({ id: "dir-id", title: "the summary" });

    writeSession(encodeURIComponent("/w/beta"), "bare", {
      "summary.json": JSON.stringify({ generated_title: "t" }),
    });

    const [, bare] = listHistorySessions();
    expect(bare).toMatchObject({ title: "t", cwd: "", model: "", num_messages: 0, updated_at: 0 });
  });

  it("skips directories without a parseable summary.json", () => {
    writeSession(encodeURIComponent("/w/alpha"), "ok", { "summary.json": summaryJson() });
    writeSession(encodeURIComponent("/w/alpha"), "broken", { "summary.json": "{not json" });
    writeSession(encodeURIComponent("/w/alpha"), "empty-dir", {});

    // Non-directory entries in the root are ignored too
    fs.writeFileSync(path.join(tmp, "sessions", "stray.txt"), "x");

    const list = listHistorySessions();
    // summary.json's info.id wins over the directory name; broken and
    // summary-less dirs are skipped entirely
    expect(list.map((s) => s.id)).toEqual(["sid-1"]);
  });

  it("sorts by recency, most recent first", () => {
    writeSession(encodeURIComponent("/w/a"), "old", {
      "summary.json": summaryJson({ info: { id: "old", cwd: "/w/a" }, last_active_at: "2026-09-01T00:00:00Z" }),
    });
    writeSession(encodeURIComponent("/w/b"), "new", {
      "summary.json": summaryJson({ info: { id: "new", cwd: "/w/b" }, last_active_at: "2026-09-17T00:00:00Z" }),
    });

    expect(listHistorySessions().map((s) => s.id)).toEqual(["new", "old"]);
  });
});

describe("getSessionHistory", () => {
  it("prefers the authoritative updates.jsonl stream", () => {
    writeSession(encodeURIComponent("/w/alpha"), "sid-1", {
      "summary.json": summaryJson(),
      "updates.jsonl": [
        JSON.stringify({
          timestamp: 1,
          params: { update: { sessionUpdate: "user_message_chunk", content: [{ type: "text", text: "hello" }] } },
        }),
        "{malformed line",
        JSON.stringify({
          timestamp: 2,
          params: { update: { sessionUpdate: "agent_message_chunk", content: "hi there" } },
        }),
        JSON.stringify({
          timestamp: 3,
          params: { update: { sessionUpdate: "tool_call", content: "must be ignored" } },
        }),
      ].join("\n"),
      "chat_history.jsonl": [
        JSON.stringify({ type: "user", content: "from chat_history" }),
      ].join("\n"),
    });

    const entries = getSessionHistory("sid-1", "/w/alpha");
    expect(entries).toEqual([
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: "hi there", timestamp: 2 },
    ]);
  });

  it("falls back to chat_history.jsonl when updates.jsonl is absent", () => {
    writeSession(encodeURIComponent("/w/alpha"), "sid-1", {
      "summary.json": summaryJson(),
      "chat_history.jsonl": [
        JSON.stringify({ type: "user", content: "question" }),
        JSON.stringify({ type: "assistant", content: { type: "text", text: "answer" } }),
        JSON.stringify({ type: "assistant", content: [{ type: "text", text: "multi" }, { type: "text", text: "block" }] }),
        JSON.stringify({ type: "system", content: "system prompt hidden" }),
        "{broken json",
      ].join("\n"),
    });

    const entries = getSessionHistory("sid-1", "/w/alpha");
    expect(entries).toEqual([
      { role: "user", content: "question", timestamp: 0 },
      { role: "assistant", content: "answer", timestamp: 0 },
      { role: "assistant", content: "multi\nblock", timestamp: 0 },
    ]);
  });

  it("empty updates.jsonl yields an empty transcript (not a crash, not a fallback)", () => {
    writeSession(encodeURIComponent("/w/alpha"), "sid-1", {
      "summary.json": summaryJson(),
      "updates.jsonl": "",
      "chat_history.jsonl": JSON.stringify({ type: "user", content: "stale" }),
    });

    expect(getSessionHistory("sid-1", "/w/alpha")).toEqual([]);
  });

  it("finds the session by scanning groups when the encoded cwd misses", () => {
    // Directory stored under an encoding the caller can't reproduce
    writeSession("some%2Fother%2Fencoding", "sid-1", {
      "summary.json": summaryJson(),
      "chat_history.jsonl": JSON.stringify({ type: "user", content: "found by scan" }),
    });

    expect(getSessionHistory("sid-1", "/w/alpha")).toEqual([
      { role: "user", content: "found by scan", timestamp: 0 },
    ]);
  });

  it("throws a clean error for an unknown session", () => {
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    expect(() => getSessionHistory("ghost", "/w/alpha")).toThrow(/No history found/);
  });
});
