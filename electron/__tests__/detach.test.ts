// @vitest-environment node
import { describe, it, expect } from "vitest";
import { DetachRegistry, DetachError, type DetachHandle } from "../detach";

interface FakeWindow {
  handle: DetachHandle;
  state: { focusCalls: number; closeCalls: number; destroyed: boolean };
  sent: Array<[string, unknown]>;
}

function fakeWindow(): FakeWindow {
  const state = { focusCalls: 0, closeCalls: 0, destroyed: false };
  const sent: Array<[string, unknown]> = [];
  return {
    state,
    sent,
    handle: {
      focus: () => {
        state.focusCalls += 1;
      },
      close: () => {
        state.closeCalls += 1;
        state.destroyed = true;
      },
      isDestroyed: () => state.destroyed,
      send: (channel, payload) => {
        sent.push([channel, payload]);
      },
    },
  };
}

describe("write-lock invariant (one writable window at any moment)", () => {
  it("main owns writes until a window is detached; ownership returns on close", () => {
    const r = new DetachRegistry();

    expect(r.canWrite("s1", "main")).toBe(true);
    r.assertWritable("s1", "main"); // no throw

    r.acquire("s1", () => fakeWindow().handle);
    expect(r.isDetached("s1")).toBe(true);
    expect(r.canWrite("s1", "main")).toBe(false);
    expect(r.canWrite("s1", "detached")).toBe(true);
    expect(() => r.assertWritable("s1", "main")).toThrow(DetachError);

    r.release("s1");
    expect(r.canWrite("s1", "main")).toBe(true);
    expect(() => r.assertWritable("s1", "main")).not.toThrow();
  });

  it("a second detach for the same session focuses the existing window", () => {
    const r = new DetachRegistry();
    const first = fakeWindow();
    const { existed } = r.acquire("s1", () => first.handle);
    expect(existed).toBe(false);

    const { existed: again } = r.acquire("s1", () => fakeWindow().handle);
    expect(again).toBe(true);
    expect(first.state.focusCalls).toBe(1);
  });

  it("different sessions detach independently", () => {
    const r = new DetachRegistry();
    r.acquire("s1", () => fakeWindow().handle);
    r.acquire("s2", () => fakeWindow().handle);

    expect(r.isDetached("s1")).toBe(true);
    expect(r.isDetached("s2")).toBe(true);
    r.release("s1");
    expect(r.isDetached("s1")).toBe(false);
    expect(r.isDetached("s2")).toBe(true);
  });
});

describe("event fan-out", () => {
  it("events reach every live detached window", () => {
    const r = new DetachRegistry();
    const w1 = fakeWindow();
    const w2 = fakeWindow();
    r.acquire("s1", () => w1.handle);
    r.acquire("s2", () => w2.handle);

    for (const w of r.eventTargets()) w.send("acp_event", { hello: 1 });

    expect(w1.sent).toEqual([["acp_event", { hello: 1 }]]);
    expect(w2.sent).toEqual([["acp_event", { hello: 1 }]]);
  });

  it("prune drops destroyed windows from routing and releases their lock", () => {
    const r = new DetachRegistry();
    const w = fakeWindow();
    r.acquire("s1", () => w.handle);

    w.handle.close(); // user closes the detached window
    expect(r.prune()).toEqual(["s1"]);
    expect(r.eventTargets()).toEqual([]);
    expect(r.canWrite("s1", "main")).toBe(true);
    expect(r.prune()).toEqual([]);
  });
});

describe("window lifecycle side effects", () => {
  it("closeAll closes every detached window exactly once — the agent session is NOT killed", () => {
    const r = new DetachRegistry();
    const w1 = fakeWindow();
    const w2 = fakeWindow();
    r.acquire("s1", () => w1.handle);
    r.acquire("s2", () => w2.handle);

    expect(r.closeAll()).toBe(2);
    expect(w1.state.closeCalls).toBe(1);
    expect(w2.state.closeCalls).toBe(1);
    expect(r.isDetached("s1")).toBe(false);
    expect(r.isDetached("s2")).toBe(false);
    // No session-handle interactions exist in this registry at all — closing
    // windows can never reach the agent sessions by construction.
    expect(r.closeAll()).toBe(0);
  });

  it("destroyed windows are ignored by closeAll (no double-close)", () => {
    const r = new DetachRegistry();
    const w = fakeWindow();
    r.acquire("s1", () => w.handle);
    w.handle.close();
    expect(r.closeAll()).toBe(0);
    expect(w.state.closeCalls).toBe(1);
  });
});
