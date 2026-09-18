/**
 * Voice session state machine (ISS-082).
 *
 * Capability probe (2026-09-19, ADR 0003): no realtime/voice session
 * capability exists in the agent, no realtime endpoint is configured or
 * reachable, and the app ships no WebRTC stack — so realtime conversation
 * mode is OFF and the machine runs in DICTATION mode (Web Speech), the
 * issue-sanctioned degradation. Set GROK_REALTIME_URL when a realtime
 * endpoint lands to flip capability on.
 *
 * States: idle → connecting → live ⇄ muted → ended → idle.
 * Dictation-mode semantics: "connecting" spans start() → first audio event;
 * "muted" pauses capture while the session stays open (Web Speech instance
 * kept, recognition stopped); every terminal path lands in ended → idle.
 */

export type VoiceState = "idle" | "connecting" | "live" | "muted" | "ended";

export type VoiceEvent =
  | { type: "start-requested"; supported: boolean }
  | { type: "engine-started" }
  | { type: "first-audio" }
  | { type: "mute-requested" }
  | { type: "unmute-requested" }
  | { type: "stop-requested" }
  | { type: "engine-error"; reason: string }
  | { type: "dismissed" };

/** Realtime conversation capability flag (probe result, ADR 0003). */
const REALTIME_URL =
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_GROK_REALTIME_URL as
    | string
    | undefined) ?? "";
export function realtimeVoiceAvailable(): boolean {
  return /^https:\/\//.test(REALTIME_URL);
}

export function next(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "start-requested":
      return state === "idle" || state === "ended" ? (event.supported ? "connecting" : "idle") : state;
    case "engine-started":
      return state === "connecting" ? "live" : state;
    case "first-audio":
      return state === "connecting" || state === "live" ? "live" : state;
    case "mute-requested":
      return state === "live" ? "muted" : state;
    case "unmute-requested":
      return state === "muted" ? "connecting" : state;
    case "stop-requested":
      return state === "live" || state === "muted" || state === "connecting" ? "ended" : state;
    case "engine-error":
      return state === "idle" ? "idle" : "ended";
    case "dismissed":
      return "idle";
    default:
      return state;
  }
}

/** Which engine failures mean "degrade back to typing" vs transient. */
export function isDegradedReason(reason: string): boolean {
  return /not-allowed|service-not-allowed|audio-capture|not-supported|network/i.test(reason);
}
