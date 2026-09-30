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
import { AcpTransport } from "../acp-transport";

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

afterEach(async () => {
  for (const w of watchdogs) {
    try {
      if (w.connected) {
        // Graceful teardown: trigger the watchdog's reap of the stub agent via
        // disconnect(), then await the watchdog's exit. SIGKILLing the watchdog
        // directly would orphan the stub (the class this suite guards against);
        // force-kill only as a stuck fallback (Codex review P3).
        w.disconnect();
        await new Promise<void>((resolve) => {
          const force = setTimeout(
            () => {
              try { w.kill("SIGKILL"); } catch { /* dead */ }
              resolve();
            },
            4000
          );
          w.once("exit", () => { clearTimeout(force); resolve(); });
        });
      }
    } catch {
      /* already dead */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}, 15_000);

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
  // Cross-platform: IPC disconnect (the hard-kill mechanism) and exit-code
  // forwarding. These run on every CI leg including windows-latest.
  it("reaps the agent child when the parent IPC disconnects (hard-kill analog)", async () => {
    const pidFile = path.join(tmp, "agent.pid");
    const stub = writeStubAgent(pidFile);
    const w = forkWatchdog(process.execPath, [stub]);

    const pid = await waitForPid(pidFile);
    expect(pidAlive(pid)).toBe(true);

    // Simulate the owning app being hard-killed: close the IPC channel. The
    // kernel closes the parent's fds the same way on a real SIGKILL; this is
    // the cross-platform mechanism (works on win32 too).
    w.disconnect();

    // The watchdog SIGTERMs the agent, then SIGKILLs after a grace.
    const reaped = await waitForReap(pid, 8000);
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

  it("transport kill() reaps the agent via IPC disconnect (cross-platform, no SIGTERM dependency)", async () => {
    // Inject a real watchdog (running a stub agent) as the transport's proc,
    // then dispose() — which calls kill(). kill() must reach the watchdog's
    // reap via disconnect(), NOT kill("SIGTERM") (which force-terminates on
    // win32 without running handlers — the #272 P1 regression). Runs on win32.
    const pidFile = path.join(tmp, "agent.pid");
    const stub = writeStubAgent(pidFile);
    const w = forkWatchdog(process.execPath, [stub]);

    const pid = await waitForPid(pidFile);
    expect(pidAlive(pid)).toBe(true);

    const transport = new AcpTransport();
    // Simulate spawnServe having installed the watchdog as the live proc.
    (transport as unknown as { proc: typeof w }).proc = w;
    (transport as unknown as { ready: boolean }).ready = true;
    watchdogs.push(w);

    await transport.dispose(); // → kill() → disconnect() the watchdog → reap

    // The watchdog reaps the agent via the cross-platform disconnect path.
    const reaped = await waitForReap(pid, 4000);
    expect(reaped).toBe(true);
  }, 15_000);

  it("does not leak ELECTRON_RUN_AS_NODE into the agent process", async () => {
    // The watchdog is forked with ELECTRON_RUN_AS_NODE=1 (so Electron runs it
    // as Node); that must NOT propagate into the agent or its children, or an
    // Electron-based tool the agent launches would boot as plain Node (P2).
    const envFile = path.join(tmp, "env-flag");
    const stub = path.join(tmp, "env-stub.cjs");
    fs.writeFileSync(
      stub,
      `"use strict";\nrequire("fs").writeFileSync(${JSON.stringify(
        envFile
      )}, process.env.ELECTRON_RUN_AS_NODE === "1" ? "LEAKED" : "clean");\nsetInterval(() => {}, 60000);`
    );
    const w = forkWatchdog(process.execPath, [stub]);

    // Wait for the stub to record its env flag.
    const flag = await new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const tick = () => {
        if (fs.existsSync(envFile)) return resolve(fs.readFileSync(envFile, "utf-8").trim());
        if (Date.now() > deadline) reject(new Error("env flag not written"));
        else setTimeout(tick, 50);
      };
      tick();
    });
    expect(flag).toBe("clean");
  }, 10_000);

  // POSIX-only: SIGTERM-driven dispose and signal-number semantics. On win32,
  // child.kill("SIGTERM") force-terminates via TerminateProcess (handlers
  // never run) and self-signal exits with code 1, so these would fail
  // deterministically on the windows-latest CI leg — gate them out.
  describe.skipIf(process.platform === "win32")("POSIX signal paths", () => {
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
});
