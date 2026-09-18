/**
 * Detached-session window registry (ISS-077).
 *
 * Write-lock invariant: a session has exactly ONE writable window at any
 * moment — the main window by default, or the single detached window while
 * one is open. Sends from any other surface are refused with a structured
 * error; event routing fans out to every live surface so the losing side
 * follows read-only.
 *
 * Pure bookkeeping — Electron window objects are injected as opaque handles,
 * which keeps the invariants unit-testable.
 */

export class DetachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetachError";
  }
}

export interface DetachHandle {
  /** Focus an already-open window. */
  focus(): void;
  /** Close the window (resource回收; never touches the agent session). */
  close(): void;
  /** true once the window is gone. */
  isDestroyed(): boolean;
  /** Deliver a session event to this window's renderer. */
  send(channel: string, payload: unknown): void;
}

export type Surface = "main" | "detached";

export class DetachRegistry {
  private detached = new Map<string, DetachHandle>();

  /** Open (or focus) the detached window for a session. */
  acquire(sessionId: string, openWindow: () => DetachHandle): { existed: boolean } {
    const existing = this.detached.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return { existed: true };
    }
    this.detached.set(sessionId, openWindow());
    return { existed: false };
  }

  /** The session's window died (or was closed) — write ownership returns
   *  to the main window; the agent session itself is untouched. */
  release(sessionId: string): void {
    this.detached.delete(sessionId);
  }

  isDetached(sessionId: string): boolean {
    const w = this.detached.get(sessionId);
    return !!w && !w.isDestroyed();
  }

  /** May this surface write (send prompts) to the session? */
  canWrite(sessionId: string, surface: Surface): boolean {
    if (surface === "detached") return this.isDetached(sessionId);
    return !this.isDetached(sessionId);
  }

  /** Enforce the write lock for a send attempt. */
  assertWritable(sessionId: string, surface: Surface): void {
    if (!this.canWrite(sessionId, surface)) {
      throw new DetachError(
        `session ${sessionId} is detached to another window (read-only follow)`
      );
    }
  }

  /** Live detached windows that should receive session events. */
  eventTargets(): DetachHandle[] {
    const out: DetachHandle[] = [];
    for (const w of this.detached.values()) {
      if (!w.isDestroyed()) out.push(w);
    }
    return out;
  }

  /** Close every detached window — used when the main window closes so no
   *  orphan chrome lingers. Agent sessions survive (tabs resume on relaunch). */
  closeAll(): number {
    let n = 0;
    for (const [id, w] of [...this.detached.entries()]) {
      if (!w.isDestroyed()) {
        w.close();
        n += 1;
      }
      this.detached.delete(id);
    }
    return n;
  }

  /** Drop windows that destroyed themselves (e.g. user closed one). */
  prune(): string[] {
    const released: string[] = [];
    for (const [id, w] of [...this.detached.entries()]) {
      if (w.isDestroyed()) {
        this.detached.delete(id);
        released.push(id);
      }
    }
    return released;
  }
}
