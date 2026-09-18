/**
 * Persist a seeded transcript into the grok sessions tree (review P1:
 * fork/import previously copied messages into renderer memory only — they
 * evaporated on restart/session-load). Written in the same updates.jsonl
 * shape session-history already replays, so the standard resume fallback
 * restores seeded threads.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TranscriptEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function sessionDir(acpSessionId: string, cwd: string): string {
  const root = path.join(grokHome(), "sessions");
  const dir = path.resolve(root, encodeURIComponent(cwd || "/"), acpSessionId);
  if (!dir.startsWith(root + path.sep)) {
    throw new Error("transcript path escaped the sessions root");
  }
  return dir;
}

/** Write updates.jsonl (+ summary.json) for a seeded thread. Atomic per
 *  file (tmp+rename); refuses path escapes; never touches other sessions. */
export function persistTranscript(opts: {
  acpSessionId: string;
  cwd: string;
  title: string;
  entries: TranscriptEntry[];
}): { written: number } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.acpSessionId)) {
    throw new Error("invalid session id");
  }
  if (opts.entries.length === 0) return { written: 0 };

  const dir = sessionDir(opts.acpSessionId, opts.cwd);
  fs.mkdirSync(dir, { recursive: true });

  const lines = opts.entries.map((e) =>
    JSON.stringify({
      timestamp: e.timestamp || Date.now(),
      params: {
        update: {
          sessionUpdate: e.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: [{ type: "text", text: e.content }],
        },
      },
    })
  );
  const updatesTmp = path.join(dir, ".updates.jsonl.tmp");
  fs.writeFileSync(updatesTmp, lines.join("\n") + "\n", "utf-8");
  fs.renameSync(updatesTmp, path.join(dir, "updates.jsonl"));

  const summary = {
    info: { id: opts.acpSessionId, cwd: opts.cwd },
    generated_title: opts.title,
    num_messages: opts.entries.length,
    last_active_at: new Date().toISOString(),
  };
  const summaryTmp = path.join(dir, ".summary.json.tmp");
  fs.writeFileSync(summaryTmp, JSON.stringify(summary, null, 2), "utf-8");
  fs.renameSync(summaryTmp, path.join(dir, "summary.json"));

  return { written: opts.entries.length };
}
