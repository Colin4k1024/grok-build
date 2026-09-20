import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  invoke,
  listen,
  safeListen,
  onAcpEvent,
  onAuthMessage,
  sendMessage,
  SessionGoneError,
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

describe("sendMessage SessionGoneError mapping", () => {
  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  function mockBridgeRejects(rawMessage: string) {
    (window as { electron?: unknown }).electron = {
      invoke: async () => {
        throw new Error(rawMessage);
      },
      on: () => () => {},
      platform: "darwin",
    };
  }

  it("maps 'Session <id> not found' to SessionGoneError", async () => {
    // The exact text Electron produces when main's handler throws
    // "Session <id> not found" — ipcRenderer wraps it in
    // "Error invoking remote method '<channel>': Error: <original>".
    mockBridgeRejects(
      "Error invoking remote method 'session_send': Error: Session session-mu96wmtl-mkj9o5 not found"
    );

    const err = await sendMessage("session-mu96wmtl-mkj9o5", "hi", []).catch((e) => e);
    expect(err).toBeInstanceOf(SessionGoneError);
    expect((err as SessionGoneError).sessionId).toBe("session-mu96wmtl-mkj9o5");
    expect((err as Error).message).not.toMatch(/Error invoking remote method/);
  });

  it("matches the bare main-process text too (no Electron wrap)", async () => {
    mockBridgeRejects("Session session-abc-def not found");
    await expect(sendMessage("session-abc-def", "hi", [])).rejects.toBeInstanceOf(
      SessionGoneError
    );
  });

  it("does not swallow unrelated errors", async () => {
    mockBridgeRejects("Session session-abc has no live agent");
    const err = await sendMessage("session-abc", "hi", []).catch((e) => e);
    expect(err).not.toBeInstanceOf(SessionGoneError);
    expect(String(err)).toContain("no live agent");
  });

  it("does not swallow permission / validation errors", async () => {
    mockBridgeRejects("user denied permission");
    await expect(sendMessage("s1", "hi", [])).rejects.not.toBeInstanceOf(SessionGoneError);
  });
});
