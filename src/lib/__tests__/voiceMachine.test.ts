import { describe, it, expect } from "vitest";
import { next, isDegradedReason, realtimeVoiceAvailable } from "../voiceMachine";

describe("voice session state machine (ISS-082, ADR 0003)", () => {
  it("happy path: idle→connecting→live→ended→idle", () => {
    let s = next("idle", { type: "start-requested", supported: true });
    expect(s).toBe("connecting");
    s = next(s, { type: "engine-started" });
    expect(s).toBe("live");
    s = next(s, { type: "first-audio" });
    expect(s).toBe("live");
    s = next(s, { type: "stop-requested" });
    expect(s).toBe("ended");
    s = next(s, { type: "dismissed" });
    expect(s).toBe("idle");
  });

  it("mute cycle: live→muted→connecting (recapture) →live", () => {
    let s = next("live", { type: "mute-requested" });
    expect(s).toBe("muted");
    s = next(s, { type: "unmute-requested" });
    expect(s).toBe("connecting");
    s = next(s, { type: "first-audio" });
    expect(s).toBe("live");
  });

  it("unsupported engine never leaves idle (explicit degradation path)", () => {
    expect(next("idle", { type: "start-requested", supported: false })).toBe("idle");
  });

  it("engine errors terminate any active state to ended", () => {
    for (const st of ["connecting", "live", "muted"] as const) {
      expect(next(st, { type: "engine-error", reason: "network" })).toBe("ended");
    }
    // errors while idle stay idle — no phantom sessions
    expect(next("idle", { type: "engine-error", reason: "network" })).toBe("idle");
  });

  it("illegal transitions are no-ops (no dead states)", () => {
    expect(next("idle", { type: "mute-requested" })).toBe("idle");
    expect(next("idle", { type: "first-audio" })).toBe("idle");
    expect(next("ended", { type: "first-audio" })).toBe("ended");
    expect(next("muted", { type: "mute-requested" })).toBe("muted");
    // ended can restart (dismiss or direct start)
    expect(next("ended", { type: "start-requested", supported: true })).toBe("connecting");
  });
});

describe("degradation classification", () => {
  it("mic/network failures degrade; transient aborts do not", () => {
    expect(isDegradedReason("not-allowed")).toBe(true);
    expect(isDegradedReason("audio-capture")).toBe(true);
    expect(isDegradedReason("network")).toBe(true);
    expect(isDegradedReason("not-supported")).toBe(true);
    expect(isDegradedReason("aborted")).toBe(false);
    expect(isDegradedReason("no-speech")).toBe(false);
  });
});

describe("realtime capability flag (ADR 0003)", () => {
  it("is OFF until a realtime URL is configured at build time", () => {
    // No VITE_GROK_REALTIME_URL in the test env — dictation mode only.
    expect(realtimeVoiceAvailable()).toBe(false);
  });
});
