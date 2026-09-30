#!/usr/bin/env node
/**
 * Parent-death watchdog for the `agent serve` subprocess (R5-08 / #272).
 *
 * AcpTransport forks this module with an IPC channel and re-execs the agent
 * serve binary as its own child, forwarding stderr. When the IPC channel
 * breaks (Electron main hard-killed/crashed — the kernel closes the parent's
 * fds, so 'disconnect' fires even on SIGKILL), the watchdog reaps the agent
 * serve (SIGTERM → SIGKILL after a grace) and exits. An explicit SIGTERM from
 * the transport reaps the child immediately (the transport is disposing in a
 * hurry).
 *
 * This mirrors the ptyctl parent-death watcher (#265) but on the owning-app
 * side: ptyctl polls getppid()==1; here the IPC channel's kernel-level
 * liveness is the trigger — immediate, and needs no change to the agent binary
 * (which is why it works for a hard-killed parent that can never run cleanup).
 *
 * argv: <agentBin> <agentArgsJSON>
 * env is inherited from the fork (AcpTransport passes the merged env there).
 */
"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");

const [agentBin, agentArgsJson] = process.argv.slice(2);
if (!agentBin) {
  console.error("[agent-serve-watchdog] missing agent bin arg");
  process.exit(2);
}

let agentArgs = [];
try {
  agentArgs = agentArgsJson ? JSON.parse(agentArgsJson) : [];
} catch (e) {
  console.error(`[agent-serve-watchdog] bad args payload: ${e.message}`);
  process.exit(2);
}

const child = spawn(agentBin, agentArgs, {
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});

let shuttingDown = false;
/** @param {boolean} immediate — true on an explicit transport SIGTERM (kill
 *  fast); false on parent-disconnect (we have time, no one is killing us). */
function reapThenExit(immediate) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { child.kill(immediate ? "SIGKILL" : "SIGTERM"); } catch { /* already dead */ }
  if (immediate) {
    setTimeout(() => process.exit(0), 50);
  } else {
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* dead */ } }, 2000);
    setTimeout(() => process.exit(0), 2200);
  }
}

// Parent gone (IPC closed) — the primary signal for hard-kill/crash. Fires
// even when the parent was SIGKILLed, because the kernel closes its fds.
process.on("disconnect", () => reapThenExit(false));
// Explicit dispose from the transport — reap immediately.
process.on("SIGTERM", () => reapThenExit(true));
process.on("SIGINT", () => reapThenExit(true));

child.on("error", (e) => {
  console.error(`[agent-serve-watchdog] child spawn error: ${e.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  // Forward the agent's exit so the transport's crash/restart path surfaces
  // correctly (it watches this process's exit). Preserve the signal number
  // (128 + signum, the shell convention) so an OOM-kill (137) is distinct from
  // a SIGTERM reap (143) or a segfault (139) — not collapsed to a fixed 129.
  let exitCode;
  if (typeof code === "number") {
    exitCode = code;
  } else if (signal) {
    const signum = os.constants.signals[signal];
    exitCode = typeof signum === "number" ? 128 + signum : 1;
  } else {
    exitCode = 0;
  }
  process.exit(exitCode);
});
