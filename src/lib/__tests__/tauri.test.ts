import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  invoke,
  listen,
  safeListen,
  onAcpEvent,
  onAuthMessage,
} from "../tauri";

describe("transport without an Electron bridge (ACP disconnect analog)", () => {
  beforeEach(() => {
    // jsdom has no preload script — window.electron is absent, which is
    // exactly what a renderer sees when the bridge is gone.
    delete (window as { electron?: unknown }).electron;
  });

  it("invoke rejects instead of throwing synchronously", async () => {
    await expect(invoke("session_list")).rejects.toThrow(/bridge not available/i);
  });

  it("listen throws on a missing bridge (safeListen turns it into a no-op)", async () => {
    // listen() is synchronous around bridge() — the error escapes as a throw,
    // which is exactly what safeListen's try/catch is there to absorb.
    expect(() => listen("acp_event", () => {})).toThrow(/bridge not available/i);
  });

  it("safeListen swallows the failure and returns a no-op unlisten", async () => {
    const un = await safeListen("acp_event", () => {});
    expect(typeof un).toBe("function");
    expect(() => un()).not.toThrow();
  });

  it("onAcpEvent / onAuthMessage degrade to no-op subscriptions (no crash)", async () => {
    const un1 = await onAcpEvent(() => {});
    const un2 = await onAuthMessage(() => {});
    expect(() => {
      un1();
      un2();
    }).not.toThrow();
  });
});

describe("transport over a mock bridge", () => {
  const calls: { channel: string; args: unknown[] }[] = [];
  const listeners = new Map<string, (p: unknown) => void>();

  beforeEach(() => {
    calls.length = 0;
    listeners.clear();
    (window as { electron?: unknown }).electron = {
      invoke: async <T,>(channel: string, ...args: unknown[]) => {
        calls.push({ channel, args });
        return { ok: true } as T;
      },
      on: (channel: string, handler: (p: unknown) => void) => {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      },
      platform: "darwin",
    };
  });

  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  it("invoke routes the channel and args through the bridge", async () => {
    await invoke("session_send", { session_id: "s1", message: "hi" });

    expect(calls).toEqual([
      { channel: "session_send", args: [{ session_id: "s1", message: "hi" }] },
    ]);
  });

  it("listen delivers payloads to the handler and unsubscribes cleanly", async () => {
    const seen: string[] = [];
    const un = await listen<string>("acp_event", (p) => seen.push(p));

    listeners.get("acp_event")!("payload-1");
    expect(seen).toEqual(["payload-1"]);

    un();
    expect(listeners.has("acp_event")).toBe(false);
  });
});
