/**
 * Permission state machine (R3-01 / #186).
 *
 * The renderer's approvalMode only controls whether the renderer auto-responds
 * to a PermissionRequest. The main process must independently enforce the
 * state machine invariant: an operation is never executed until the
 * corresponding approval is in the "approved" state, and approvals do not
 * survive a crash.
 *
 * State machine:
 *
 *   requested ─┬─> approved ─> executed
 *              ├─> denied    (terminal)
 *              └─> cancelled (terminal)
 *
 * Invariants enforced here:
 *   - An operation with no approval record (or one not in "approved") never
 *     reaches "executed".
 *   - The same request id cannot be approved/denied twice — the second
 *     responder is a no-op. This prevents a double-click on the approval
 *     card from executing the side effect twice.
 *   - On construction (process restart), the store starts empty. Any
 *     "requested" approval that lived in the previous process is gone —
 *     the agent re-requests it. This is crash-invalidation: a stale
 *     approval from a dead process cannot authorize a fresh execution.
 *   - `recordExecution` only succeeds for an approved request and flips it
 *     to "executed" exactly once; a second attempt is rejected so a
 *     replayed/hung request cannot re-fire the side effect.
 *
 * This module is intentionally storage-free: persistence would re-introduce
 * the crash-replay hazard. In-memory only, cleared on restart.
 */

export type PermissionState = "requested" | "approved" | "denied" | "cancelled" | "executed";

export interface PermissionRecord {
  requestId: string;
  sessionId: string;
  toolName: string;
  command: string;
  state: PermissionState;
  createdAt: number;
  /** When the state last transitioned. */
  transitionedAt: number;
}

export interface TransitionResult {
  record: PermissionRecord;
  /** Whether this call actually transitioned the state. */
  changed: boolean;
  /** Human-readable outcome for the audit log. */
  outcome: "approved" | "denied" | "cancelled" | "executed" | "no-op" | "unknown";
}

export class PermissionStateMachine {
  private records = new Map<string, PermissionRecord>();

  /** Register a new permission request. Idempotent on the request id:
   *  if the same request id arrives twice (agent resend, dedup), the
   *  existing record is returned unchanged — the agent is not given a
   *  second approval slot for the same request. */
  request(record: Omit<PermissionRecord, "state" | "createdAt" | "transitionedAt">): PermissionRecord {
    const existing = this.records.get(record.requestId);
    if (existing) {
      // Dedup: a re-sent request for the same id does not reset state or
      // timestamp — the original request's lifecycle stands.
      return existing;
    }
    const now = Date.now();
    const rec: PermissionRecord = {
      ...record,
      state: "requested",
      createdAt: now,
      transitionedAt: now,
    };
    this.records.set(record.requestId, rec);
    return rec;
  }

  /** Transition a request to "approved". Idempotent: re-approving an
   *  already-approved request is a no-op (returns changed:false). Any
   *  attempt to approve a request in a terminal state is rejected. */
  approve(requestId: string): TransitionResult {
    return this.transition(requestId, "approved");
  }

  /** Transition a request to "denied". Idempotent. */
  deny(requestId: string): TransitionResult {
    return this.transition(requestId, "denied");
  }

  /** Transition a request to "cancelled". Idempotent. */
  cancel(requestId: string): TransitionResult {
    return this.transition(requestId, "cancelled");
  }

  /** Mark an approved request as executed. Only succeeds for an approved
   *  request; rejects any attempt to execute a request that is not
   *  approved, or to execute one that has already been executed. This is
   *  the line that prevents a double-fire of a side effect. */
  recordExecution(requestId: string): TransitionResult {
    const rec = this.records.get(requestId);
    if (!rec) {
      return { record: this.placeholder(requestId), changed: false, outcome: "unknown" };
    }
    if (rec.state === "executed") {
      // Critical invariant: an already-executed request cannot execute again.
      return { record: rec, changed: false, outcome: "no-op" };
    }
    if (rec.state !== "approved") {
      // A request that was not approved (denied/cancelled/still-requested)
      // cannot be marked executed.
      return { record: rec, changed: false, outcome: "no-op" };
    }
    const updated: PermissionRecord = {
      ...rec,
      state: "executed",
      transitionedAt: Date.now(),
    };
    this.records.set(requestId, updated);
    return { record: updated, changed: true, outcome: "executed" };
  }

  /** Look up a record without transitioning it. */
  get(requestId: string): PermissionRecord | undefined {
    return this.records.get(requestId);
  }

  /** All records — for inspection/testing only. */
  all(): PermissionRecord[] {
    return Array.from(this.records.values());
  }

  /** Pending (non-terminal) records — used at startup to confirm the
   *  store is empty (crash-invalidation: nothing carried over). */
  pending(): PermissionRecord[] {
    return this.all().filter((r) => r.state === "requested" || r.state === "approved");
  }

  /** Clear all records. Used by tests and on a hard session reset. */
  clear(): void {
    this.records.clear();
  }

  private transition(requestId: string, target: PermissionState): TransitionResult {
    const rec = this.records.get(requestId);
    if (!rec) {
      return { record: this.placeholder(requestId), changed: false, outcome: "unknown" };
    }
    if (rec.state === target) {
      // Idempotent re-transition to the same state.
      return { record: rec, changed: false, outcome: target as TransitionResult["outcome"] };
    }
    if (this.isTerminal(rec.state)) {
      // Once a request is in a terminal state (denied/cancelled/executed),
      // no further transitions are allowed.
      return { record: rec, changed: false, outcome: "no-op" };
    }
    // "approved" is intermediate: it can still be denied/cancelled before
    // execution (user changes their mind). But "executed" is reachable only
    // from "approved" — enforced in recordExecution.
    if (target === "executed" && rec.state !== "approved") {
      return { record: rec, changed: false, outcome: "no-op" };
    }
    const updated: PermissionRecord = {
      ...rec,
      state: target,
      transitionedAt: Date.now(),
    };
    this.records.set(requestId, updated);
    return { record: updated, changed: true, outcome: target as TransitionResult["outcome"] };
  }

  private isTerminal(state: PermissionState): boolean {
    return state === "denied" || state === "cancelled" || state === "executed";
  }

  private placeholder(requestId: string): PermissionRecord {
    return {
      requestId,
      sessionId: "",
      toolName: "",
      command: "",
      state: "requested",
      createdAt: 0,
      transitionedAt: 0,
    };
  }
}

/**
 * The shared, process-wide state machine. Every session's permission requests
 * funnel through this one instance so cross-session dedup and crash-invalidation
 * are uniform. A fresh process starts with an empty machine — there is no
 * persistence, by design (see module docstring).
 */
export const permissionStateMachine = new PermissionStateMachine();
