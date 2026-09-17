// Throwaway harness: drives AcpSession.load against a real persisted session
// to verify the session/load resume path and replay event stream.
// Run: GROK_AGENT_BIN=<bin> node scripts/test-session-resume.mjs <sessionId> <cwd>
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [sessionId, cwd] = process.argv.slice(2);
if (!sessionId || !cwd) {
  console.error("usage: test-session-resume.mjs <sessionId> <cwd>");
  process.exit(1);
}

const { AcpSession } = require("../dist-electron/acp-session.cjs");

const events = [];
const t0 = Date.now();
try {
  const session = await AcpSession.load("test-resume", sessionId, cwd, (e) => events.push(e));
  console.log("acpSessionId:", session.acpSessionId, "models:", session.models.length);
  // Replay drains before session/load resolves; give a short tail window for
  // any late events, then dispose.
  await new Promise((r) => setTimeout(r, 500));
  session.dispose();

  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  console.log("event counts:", JSON.stringify(counts));
  const replays = events.filter((e) => e.replay).length;
  console.log("events flagged replay:", replays);
  const userMsgs = events.filter((e) => e.type === "UserMessage").map((e) => e.text?.slice(0, 40));
  console.log("replayed user messages:", JSON.stringify(userMsgs));
  const textLen = events
    .filter((e) => e.type === "TextDelta" && e.replay)
    .reduce((acc, e) => acc + (e.delta?.length || 0), 0);
  console.log("replayed assistant chars:", textLen);
  console.log("elapsed ms:", Date.now() - t0);
  console.log("RESUME TEST DONE");
} catch (e) {
  console.error("RESUME TEST FAILED:", e);
  process.exit(1);
}
