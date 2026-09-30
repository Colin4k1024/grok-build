// @vitest-environment node
//
// Parent-death watchdog for the `agent serve` subprocess (R5-08 / #272).
// The watchdog is forked WITH an IPC channel; when the channel breaks
// (owning app hard-killed/crashed — the kernel closes the parent's fds, so
// 'disconnect' fires even on SIGKILL) it reaps the agent child. These tests
// use a stub "agent" (a tiny Node script that records its pid and idles) so
// they run anywhere Node does — no real agent binary required.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WATCHDOG = path.resolve(__dirname, "..", "agent-serve-watchdog.cjs");

let tmp = "";
let watchdogs: ReturnType<typeof fork>[] = [];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-watchdog-"));
  watchdogs = [];
});

afterEach(() => {
  for (const w of watchdogs) {
    try {
      w.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A stub "agent" that records its pid and stays alive until signalled. */
function writeStubAgent(pidFile: string): string {
  const stub = path.join(tmp, "stub-agent.cjs");
  fs.writeFileSync(
    stub,
    `"use strict";\nrequire("fs").writeFileSync(${JSON.stringify(
      pidFile
    )}, String(process.pid));\nsetInterval(() => {}, 60000);`
  );
  return stub;
}

function waitForPid(file: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8").trim();
        const pid = parseInt(raw, 10);
        if (pid) return resolve(pid);
      }
      if (Date.now() > deadline) reject(new Error(`pid file not written: ${file}`));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

async function waitForReap(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

function forkWatchdog(agentBin: string, agentArgs: string[]): ReturnType<typeof fork> {
  const w = fork(WATCHDOG, [agentBin, JSON.stringify(agentArgs)], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  watchdogs.push(w);
  return w;
}

describe("agent-serve parent-death watchdog (R5-08 #272)", () => {
  it("reaps the agent child when the parent IPC disconnects (hard-kill analog)", async () => {
    const pidFile = path.join(tmp, "agent.pid");
    const stub = writeStubAgent(pidFile);
    const w = forkWatchdog(process.execPath, [stub]);

    const pid = await waitForPid(pidFile);
    expect(pidAlive(pid)).toBe(true);

    // Simulate the owning app being hard-killed: close the IPC channel. The
    // kernel closes the parent's fds the same way on a real SIGKILL.
    w.disconnect();

    // The watchdog SIGTERMs the agent, then SIGKILLs after a grace.
    const reaped = await waitForReap(pid, 8000);
    expect(reaped).toBe(true);
  }, 15_000);

  it("reaps the agent on an explicit SIGTERM dispose (graceful, then escalate)", async () => {
    const pidFile = path.join(tmp, "agent.pid");
    const stub = writeStubAgent(pidFile);
    const w = forkWatchdog(process.execPath, [stub]);

    const pid = await waitForPid(pidFile);
    expect(pidAlive(pid)).toBe(true);

    w.kill("SIGTERM"); // the transport's explicit dispose path

    // The watchdog SIGTERMs the agent first (graceful flush); the stub exits
    // on SIGTERM, so it is reaped well before the SIGKILL escalation.
    const reaped = await waitForReap(pid, 3000);
    expect(reaped).toBe(true);
  }, 15_000);

  it("escalates to SIGKILL if the agent ignores SIGTERM", async () => {
    const pidFile = path.join(tmp, "agent.pid");
    // A stub that traps SIGTERM and stays alive — the watchdog must escalate.
    const stub = path.join(tmp, "stub-agent-stubborn.cjs");
    fs.writeFileSync(
      stub,
      `"use strict";\nprocess.on("SIGTERM", () => {});\nrequire("fs").writeFileSync(${JSON.stringify(
        pidFile
      )}, String(process.pid));\nsetInterval(() => {}, 60000);`
    );
    const w = forkWatchdog(process.execPath, [stub]);

    const pid = await waitForPid(pidFile);
    expect(pidAlive(pid)).toBe(true);

    w.kill("SIGTERM"); // explicit dispose

    // SIGTERM is ignored; the watchdog escalates to SIGKILL after the grace.
    const reaped = await waitForReap(pid, 4000);
    expect(reaped).toBe(true);
  }, 15_000);

  it("forwards the agent's exit code to the transport", async () => {
    const stub = path.join(tmp, "exit-agent.cjs");
    fs.writeFileSync(stub, `"use strict"; process.exit(7);`);
    const w = forkWatchdog(process.execPath, [stub]);

    const code = await new Promise<number>((resolve) => {
      w.on("exit", (c) => resolve(c ?? -1));
    });
    expect(code).toBe(7);
  }, 10_000);

  it("preserves the signal number when the agent dies by signal (not a fixed 129)", async () => {
    // A stub that kills itself with SIGTERM — the watchdog must forward
    // 128 + signum (143), not collapse every signal to 129 (Codex P3).
    const stub = path.join(tmp, "sigterm-agent.cjs");
    fs.writeFileSync(stub, `"use strict"; process.kill(process.pid, "SIGTERM");`);
    const w = forkWatchdog(process.execPath, [stub]);

    const code = await new Promise<number>((resolve) => {
      w.on("exit", (c) => resolve(c ?? -1));
    });
    expect(code).toBe(128 + 15); // SIGTERM
  }, 10_000);
});
