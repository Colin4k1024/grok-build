// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeClaudeSources,
  listClaudeSessions,
  parseClaudeSession,
  importClaudeSession,
  importClaudeInstructions,
} from "../claude-import";

let claudeTmp = "";
let grokTmp = "";
let projectTmp = "";
const savedClaude = process.env.CLAUDE_HOME;
const savedGrok = process.env.GROK_HOME;

function writeSessionFile(projectDirName: string, id: string, lines: string[]) {
  const dir = path.join(claudeTmp, "projects", projectDirName);
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.resolve(dir, `${id}.jsonl`);
  if (!safe.startsWith(dir + path.sep)) throw new Error("test fixture escaped");
  fs.writeFileSync(safe, lines.join("\n"), "utf-8");
}

function claudeLine(type: string, text: string, ts = "2026-09-01T00:00:00Z") {
  return JSON.stringify({ type, message: { content: text }, timestamp: ts });
}

beforeEach(() => {
  claudeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-claude-"));
  grokTmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-grok-"));
  projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-proj-"));
  process.env.CLAUDE_HOME = claudeTmp;
  process.env.GROK_HOME = grokTmp;
});

afterEach(() => {
  for (const d of [claudeTmp, grokTmp, projectTmp]) fs.rmSync(d, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = savedClaude;
  if (savedGrok === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrok;
});

describe("probe / listing", () => {
  it("unavailable source reports zeroed counts, never throws", () => {
    process.env.CLAUDE_HOME = path.join(claudeTmp, "does-not-exist");
    const p = probeClaudeSources();
    expect(p.available).toBe(false);
    expect(p.sessions).toBe(0);
    expect(listClaudeSessions()).toEqual([]);
  });

  it("counts sessions/projects/instructions/docs and lists newest first", () => {
    fs.writeFileSync(path.join(claudeTmp, "CLAUDE.md"), "# instructions\n");
    writeSessionFile("-Users-x-alpha", "aaa11111-1111", [claudeLine("user", "q1")]);
    const newer = path.join(claudeTmp, "projects", "-Users-x-beta");
    writeSessionFile("-Users-x-beta", "bbb22222-2222", [claudeLine("user", "q2")]);
    // touch newer later
    const t = Date.now() + 5000;
    fs.utimesSync(path.join(newer, "bbb22222-2222.jsonl"), new Date(t), new Date(t));

    const p = probeClaudeSources();
    expect(p).toMatchObject({ available: true, sessions: 2, projects: 2, hasInstructions: true });

    const list = listClaudeSessions();
    expect(list[0].sourceId).toBe("bbb22222-2222");
    expect(list[0].cwd).toBe("/Users/x/beta");
    expect(list).toHaveLength(2);
  });
});

describe("parsing (defensive)", () => {
  it("parses user/assistant lines with string and block content", () => {
    writeSessionFile("-p", "s1", [
      claudeLine("user", "hello"),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "block answer" }] },
        timestamp: "2026-09-01T00:00:01Z",
      }),
      JSON.stringify({ type: "system", message: { content: "skipped" } }),
      "{corrupted line",
    ]);
    const r = parseClaudeSession("s1");
    expect(r.entries).toEqual([
      { role: "user", content: "hello", timestamp: Date.parse("2026-09-01T00:00:00Z") },
      { role: "assistant", content: "block answer", timestamp: Date.parse("2026-09-01T00:00:01Z") },
    ]);
    expect(r.skippedLines).toBe(1);
  });

  it("rejects traversal-shaped session ids before any path join", () => {
    expect(parseClaudeSession("../../etc/passwd").error).toBe("invalid session id");
    expect(parseClaudeSession("a..b").error).toBe("invalid session id");
  });

  it("unknown ids report a clean error", () => {
    fs.mkdirSync(path.join(claudeTmp, "projects", "-p"), { recursive: true });
    expect(parseClaudeSession("nope").error).toContain("not found");
  });
});

describe("importClaudeSession (idempotency + conflicts)", () => {
  function seed() {
    writeSessionFile("-p", "s1", [claudeLine("user", "q"), claudeLine("assistant", "a")]);
  }

  it("imports once; a repeat is already-imported (no duplicates)", () => {
    seed();
    const first = importClaudeSession("s1");
    expect(first.status).toBe("imported");
    if (first.status === "imported") {
      expect(first.entries).toHaveLength(2);
    }
    const second = importClaudeSession("s1");
    expect(second.status).toBe("already-imported");
  });

  it("collisions with live grok session ids are reported as conflicts", () => {
    seed();
    const r = importClaudeSession("s1", { existingGrokSessionIds: ["s1"] });
    expect(r.status).toBe("conflict");
  });

  it("empty/corrupted sources partially report instead of failing the batch", () => {
    writeSessionFile("-p", "empty", ["{broken", "also broken"]);
    const r = importClaudeSession("empty");
    expect(r.status).toBe("error");
    expect((r as { message: string }).message).toContain("corrupted or empty");
  });
});

describe("importClaudeInstructions (write path)", () => {
  it("merges under a marker once; repeats are no-ops", () => {
    fs.writeFileSync(path.join(claudeTmp, "CLAUDE.md"), "RULE: be terse\n");

    const r1 = importClaudeInstructions(projectTmp);
    expect(r1.status).toBe("merged");
    const merged = fs.readFileSync(path.join(projectTmp, "AGENTS.md"), "utf-8");
    expect(merged).toContain("imported from ~/.claude/CLAUDE.md");
    expect(merged).toContain("RULE: be terse");

    const r2 = importClaudeInstructions(projectTmp);
    expect(r2.status).toBe("already");
    expect(fs.readFileSync(path.join(projectTmp, "AGENTS.md"), "utf-8")).toBe(merged);
  });

  it("missing CLAUDE.md reports a clean error", () => {
    const r = importClaudeInstructions(projectTmp);
    expect(r.status).toBe("error");
  });

  it("the target filename is fixed — only <root>/AGENTS.md is ever written", () => {
    fs.writeFileSync(path.join(claudeTmp, "CLAUDE.md"), "X\n");
    const root = path.join(projectTmp, "nested");
    const r = importClaudeInstructions(root);
    expect(r.status).toBe("merged");
    const files = fs.readdirSync(root);
    expect(files).toEqual(["AGENTS.md"]); // exactly one file, fixed name
  });
});
