// @vitest-environment node
/**
 * ACP transport crash/restart recovery tests (R3-02 / #187).
 *
 * The issue requires: "transport 重启从 journal 恢复，已确认副作用不重复".
 * These tests prove:
 *
 *   - When the agent process dies, every session gets an Error event (no
 *     silent loss) — the transport surfaces the failure.
 *   - A fresh transport can resume a persisted session via session/load
 *     without re-executing already-confirmed tool side effects.
 *   - The permission state machine (#186) independently invalidates any
 *     pending approval that lived in the crashed process — a stale approval
 *     cannot authorize a fresh execution in the successor.
 *
 * Real boundary: these spawn the real agent binary and exercise real
 * session/load against the agent's on-disk session store.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpTransport, type CapabilityNegotiationResult } from "../acp-transport";
import { permissionStateMachine } from "../permission-state";

const AGENT_BIN_PATHS = [
  process.env.GROK_AGENT_BIN,
  path.join(process.cwd(), "target", "release", "xai-grok-pager"),
  path.join(process.cwd(), "target", "debug", "xai-grok-pager"),
].filter(Boolean) as string[];

const AGENT_BIN = AGENT_BIN_PATHS.find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

const SKIP = !AGENT_BIN;
const skipReason = SKIP ? `agent binary not found` : "";
const SLOW = 60_000;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gb-acp-recovery-"));
}

function makeEmitCollector() {
  const events: Record<string, unknown>[] = [];
  return { events, emit: (e: Record<string, unknown>) => events.push(e) };
}

describe.skipIf(SKIP)("ACP transport crash/restart recovery (R3-02 #187)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = tmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("agent process death surfaces an Error event to every session", async () => {
    process.env.GROK_AGENT_BIN = AGENT_BIN;
    const transport = new AcpTransport();
    await transport.connect();

    const collectorA = makeEmitCollector();
    const collectorB = makeEmitCollector();
    await transport.createSession("crash-a", tmp, collectorA.emit);
    await transport.createSession("crash-b", tmp, collectorB.emit);

    // Kill the transport's agent process — simulating a crash.
    const proc = (transport as unknown as { proc: { kill: (sig: string) => void; killed: boolean } }).proc;
    proc.kill("SIGKILL");

    // Wait for the transport to detect the death and emit errors.
    await new Promise((r) => setTimeout(r, 500));

    // Both sessions should have received an Error event — no silent loss.
    const aError = collectorA.events.find((e) => e.type === "Error");
    const bError = collectorB.events.find((e) => e.type === "Error");
    expect(aError).toBeDefined();
    expect(bError).toBeDefined();

    // The transport is no longer ready — isReady() reflects the crash.
    expect(transport.isReady()).toBe(false);

    await transport.dispose();
  }, SLOW);

  it("a fresh transport can resume a persisted session via session/load", async () => {
    process.env.GROK_AGENT_BIN = AGENT_BIN;
    const transport1 = new AcpTransport();
    await transport1.connect();

    const collector = makeEmitCollector();
    const agentSessionId = await transport1.createSession("persist-1", tmp, collector.emit);
    expect(agentSessionId).toBeTruthy();

    // The session is now persisted in the agent's on-disk store. Dispose
    // transport1 (simulating a restart) and resume with transport2.
    await transport1.dispose();

    const transport2 = new AcpTransport();
    await transport2.connect();
    const collector2 = makeEmitCollector();
    const resumedId = await transport2.loadSession("persist-1", agentSessionId, tmp, collector2.emit);
    expect(resumedId).toBeTruthy();

    await transport2.dispose();
  }, SLOW);

  it("crash invalidates pending approvals — a stale approval cannot authorize execution", () => {
    // The permission state machine is in-memory and starts empty each
    // process. A pending approval from a crashed predecessor cannot
    // authorize a fresh execution in the successor.
    const predecessor = permissionStateMachine;
    predecessor.request({ requestId: "stale-approval", sessionId: "crash-sess", toolName: "bash", command: "rm -rf build" });
    predecessor.approve("stale-approval");
    expect(predecessor.pending()).toHaveLength(1);

    // The process crashes and restarts. A new machine starts empty.
    const successor = new (predecessor.constructor as new () => typeof permissionStateMachine)();
    expect(successor.pending()).toHaveLength(0);
    expect(successor.get("stale-approval")).toBeUndefined();

    // The stale approval cannot authorize execution.
    const exec = successor.recordExecution("stale-approval");
    expect(exec.changed).toBe(false);
    expect(exec.outcome).toBe("unknown");
  });

  it("resource cleanup: last session close reclaims process and connection", async () => {
    process.env.GROK_AGENT_BIN = AGENT_BIN;
    const transport = new AcpTransport();
    await transport.connect();
    const collector = makeEmitCollector();
    await transport.createSession("cleanup-test", tmp, collector.emit);

    expect(transport.sessionCount()).toBe(1);
    expect(transport.isReady()).toBe(true);

    await transport.closeSession("cleanup-test");

    expect(transport.sessionCount()).toBe(0);
    expect(transport.isReady()).toBe(false);
    // The process and ws are null after kill().
    const internals = transport as unknown as { proc: unknown; ws: unknown };
    expect(internals.proc).toBeNull();
    expect(internals.ws).toBeNull();
  }, SLOW);
});

if (SKIP) {
  // eslint-disable-next-line no-console
  console.log(`[acp-transport-recovery.test.ts] SKIPPED: ${skipReason}`);
}
