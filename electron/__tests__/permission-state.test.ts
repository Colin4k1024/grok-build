// @vitest-environment node
/**
 * Permission state machine tests (R3-01 / #186).
 *
 * The state machine is the enforcement record for tool-call approvals. These
 * tests prove the invariants the issue demands:
 *
 *   - "未批准永不执行": an operation not in the "approved" state never
 *     reaches "executed".
 *   - "重复请求不重复副作用": a double-approve or double-execute of the
 *     same request id does not fire the side effect twice.
 *   - "崩溃后未决批准作废": a fresh process (a new PermissionStateMachine
 *     instance) starts with an empty store — a pending approval from the
 *     predecessor cannot authorize execution.
 *   - SideChat no-Deny auto-allow regression: the negative path that used to
 *     silently grant tool access to the side-session agent.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PermissionStateMachine } from "../permission-state";

let machine: PermissionStateMachine;

beforeEach(() => {
  // A fresh instance per test — this is exactly the crash-restart scenario:
  // the predecessor's in-memory store is gone, and nothing carries over.
  machine = new PermissionStateMachine();
});

describe("state machine lifecycle: requested → approved → executed", () => {
  it("registers a new request in the requested state", () => {
    const rec = machine.request({
      requestId: "r1",
      sessionId: "s1",
      toolName: "bash",
      command: "cargo build",
    });
    expect(rec.state).toBe("requested");
    expect(rec.requestId).toBe("r1");
    expect(rec.toolName).toBe("bash");
  });

  it("approves a requested request and records the transition", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "ls" });
    const res = machine.approve("r1");
    expect(res.changed).toBe(true);
    expect(res.outcome).toBe("approved");
    expect(res.record.state).toBe("approved");
  });

  it("records execution only for an approved request, exactly once", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "ls" });
    machine.approve("r1");
    const exec1 = machine.recordExecution("r1");
    expect(exec1.changed).toBe(true);
    expect(exec1.outcome).toBe("executed");
    expect(exec1.record.state).toBe("executed");

    // A second execution attempt is a no-op — the side effect cannot fire twice.
    const exec2 = machine.recordExecution("r1");
    expect(exec2.changed).toBe(false);
    expect(exec2.outcome).toBe("no-op");
  });

  it("未批准永不执行 — a requested (not approved) request cannot be executed", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "rm -rf x" });
    const exec = machine.recordExecution("r1");
    expect(exec.changed).toBe(false);
    expect(exec.outcome).toBe("no-op");
    expect(exec.record.state).toBe("requested");
  });

  it("a denied request cannot be executed", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "rm -rf x" });
    machine.deny("r1");
    const exec = machine.recordExecution("r1");
    expect(exec.changed).toBe(false);
    expect(exec.record.state).toBe("denied");
  });

  it("a cancelled request cannot be executed", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "rm -rf x" });
    machine.cancel("r1");
    const exec = machine.recordExecution("r1");
    expect(exec.changed).toBe(false);
    expect(exec.record.state).toBe("cancelled");
  });
});

describe("dedup — 重复请求不重复副作用", () => {
  it("a re-sent request with the same id returns the existing record unchanged", () => {
    const r1 = machine.request({ requestId: "dup", sessionId: "s", toolName: "bash", command: "ls" });
    const r2 = machine.request({ requestId: "dup", sessionId: "s", toolName: "bash", command: "ls" });
    expect(r2).toBe(r1);
    expect(r2.createdAt).toBe(r1.createdAt);
  });

  it("approving an already-approved request is idempotent (no double-fire)", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "ls" });
    const a1 = machine.approve("r1");
    const a2 = machine.approve("r1");
    expect(a1.changed).toBe(true);
    // The second approve does not transition the state again — no double-fire.
    expect(a2.changed).toBe(false);
    // The request is still in the approved state (idempotent).
    expect(a2.record.state).toBe("approved");
  });

  it("denying an already-denied request is idempotent", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "ls" });
    machine.deny("r1");
    const d2 = machine.deny("r1");
    expect(d2.changed).toBe(false);
  });

  it("a request in a terminal state rejects further transitions", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "ls" });
    machine.approve("r1");
    machine.recordExecution("r1");
    // Try to deny after execution — must be a no-op
    const deny = machine.deny("r1");
    expect(deny.changed).toBe(false);
    expect(deny.record.state).toBe("executed");
  });
});

describe("crash-invalidation — 崩溃后未决批准作废", () => {
  it("a fresh machine instance (post-crash) starts empty — no pending approvals", () => {
    // Simulate the predecessor process: create a machine, leave a pending approval.
    const predecessor = new PermissionStateMachine();
    predecessor.request({ requestId: "stale", sessionId: "s", toolName: "bash", command: "ls" });
    predecessor.approve("stale");
    expect(predecessor.pending()).toHaveLength(1);

    // The process crashes and restarts — a new machine is constructed.
    const successor = new PermissionStateMachine();
    expect(successor.pending()).toHaveLength(0);
    expect(successor.get("stale")).toBeUndefined();

    // The stale approval cannot authorize execution in the new process.
    const exec = successor.recordExecution("stale");
    expect(exec.changed).toBe(false);
    expect(exec.outcome).toBe("unknown");
  });

  it("pending() lists only non-terminal requests", () => {
    machine.request({ requestId: "r1", sessionId: "s", toolName: "bash", command: "ls" });
    machine.request({ requestId: "r2", sessionId: "s", toolName: "bash", command: "ls" });
    machine.approve("r2");
    machine.request({ requestId: "r3", sessionId: "s", toolName: "bash", command: "ls" });
    machine.deny("r3");
    machine.request({ requestId: "r4", sessionId: "s", toolName: "bash", command: "ls" });
    machine.cancel("r4");

    const pending = machine.pending();
    const ids = pending.map((r) => r.requestId).sort();
    expect(ids).toEqual(["r1", "r2"]); // r3 and r4 are terminal
  });
});

describe("SideChat no-Deny auto-allow regression (negative test)", () => {
  // The bug (ISS-162 / R3-01): ApprovalCard's 30s timeout used to fall back
  // to sending the "allow" option id when no Deny option was present. The
  // state machine must never auto-approve: an approval only happens when
  // session_respond_permission explicitly sends an allow option id. A
  // missing/cancelled/timeout response must leave the request in a
  // non-approved state, so it can never be executed.
  it("a request with no explicit approve() never reaches the approved state", () => {
    machine.request({ requestId: "side1", sessionId: "side-sess", toolName: "bash", command: "rm -rf build" });
    // The side-chat path: no deny option found → no response sent at all.
    // The request stays "requested". It must not be auto-approved.
    const rec = machine.get("side1");
    expect(rec?.state).toBe("requested");

    // And therefore cannot be executed.
    const exec = machine.recordExecution("side1");
    expect(exec.changed).toBe(false);
    expect(exec.record.state).toBe("requested");
  });

  it("a cancelled request (timeout) is cancelled, not approved", () => {
    machine.request({ requestId: "side2", sessionId: "side-sess", toolName: "bash", command: "rm -rf build" });
    machine.cancel("side2"); // simulates the 30s timeout cancelling
    expect(machine.get("side2")?.state).toBe("cancelled");
    const exec = machine.recordExecution("side2");
    expect(exec.changed).toBe(false);
  });

  it("an explicit allow option id approves; an explicit deny option id denies", () => {
    // This mirrors the main-process session_respond_permission handler logic:
    // /reject|deny|cancel/i → deny, /allow/i → approve.
    machine.request({ requestId: "r-allow", sessionId: "s", toolName: "bash", command: "ls" });
    machine.approve("r-allow");
    expect(machine.get("r-allow")?.state).toBe("approved");

    machine.request({ requestId: "r-deny", sessionId: "s", toolName: "bash", command: "ls" });
    machine.deny("r-deny");
    expect(machine.get("r-deny")?.state).toBe("denied");
  });
});

describe("unknown request ids are safe", () => {
  it("approving an unknown id returns unknown, does not throw", () => {
    const res = machine.approve("does-not-exist");
    expect(res.changed).toBe(false);
    expect(res.outcome).toBe("unknown");
  });

  it("executing an unknown id is safe (no-op, no phantom record)", () => {
    const res = machine.recordExecution("ghost");
    expect(res.changed).toBe(false);
    expect(machine.get("ghost")).toBeUndefined();
  });
});
