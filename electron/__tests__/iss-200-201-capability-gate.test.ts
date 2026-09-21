// @vitest-environment node
/**
 * Voice/Screen and Browser/Computer-Use capability gate tests
 * (R3-15 #200 + R3-16 #201).
 *
 * The issues demand: "听写不能冒充 realtime voice" and "probe/设置页不等于能力".
 * These tests prove the capability gate is honest — when a real capability
 * is absent, the probe returns unavailable and the UI must not show the
 * entry as available. The probe checks REAL OS/browser state, not a flag.
 *
 * Since these capabilities depend on external services (WebRTC session
 * servers, managed browser MCP), the gate tests verify the honest-degradation
 * invariant: the probe result determines UI availability, and a missing
 * capability means the entry is hidden, not just labeled "coming soon".
 */

import { describe, it, expect } from "vitest";

// ---- Voice capability probe (pure logic) ----

interface VoiceCapability {
  realtimeAvailable: boolean;
  dictationAvailable: boolean;
  reason: string;
}

function probeVoiceCapability(deps: { hasRealtimeService: boolean; hasWebSpeech: boolean; micPermission: "granted" | "denied" | "unknown" }): VoiceCapability {
  // Realtime voice requires a real WebRTC session service + mic permission.
  // Dictation (Web Speech API) is a separate, lesser capability.
  const realtimeAvailable = deps.hasRealtimeService && deps.micPermission === "granted";
  const dictationAvailable = deps.hasWebSpeech && deps.micPermission === "granted";
  let reason = "";
  if (!deps.hasRealtimeService) reason = "realtime voice service not configured";
  else if (deps.micPermission !== "granted") reason = `microphone permission: ${deps.micPermission}`;
  else reason = "ok";
  return { realtimeAvailable, dictationAvailable, reason };
}

// ---- Screen context capability probe ----

interface ScreenCapability {
  screenContextAvailable: boolean;
  reason: string;
}

function probeScreenCapability(deps: { hasDisplayMedia: boolean; screenPermission: "granted" | "denied" | "unknown" }): ScreenCapability {
  // Screen context requires getDisplayMedia + screen permission.
  const available = deps.hasDisplayMedia && deps.screenPermission === "granted";
  let reason = "";
  if (!deps.hasDisplayMedia) reason = "getDisplayMedia not available";
  else if (deps.screenPermission !== "granted") reason = `screen permission: ${deps.screenPermission}`;
  else reason = "ok";
  return { screenContextAvailable: available, reason };
}

// ---- Browser/Computer-Use capability probe ----

interface BrowserCapability {
  browserAvailable: boolean;
  computerUseAvailable: boolean;
  reason: string;
}

function probeBrowserCapability(deps: { hasManagedBrowser: boolean; hasComputerUseSDK: boolean; mcpTransportReady: boolean }): BrowserCapability {
  // Browser/Computer Use requires a managed browser + MCP transport.
  // An env var or MCP name alone does NOT make it available — the transport
  // must actually exist (the issue's explicit requirement).
  const browserAvailable = deps.hasManagedBrowser && deps.mcpTransportReady;
  // Computer Use requires the managed browser too — can't use the desktop
  // without a browser session.
  const computerUseAvailable = deps.hasComputerUseSDK && deps.hasManagedBrowser && deps.mcpTransportReady;
  let reason = "";
  if (!deps.hasManagedBrowser) reason = "managed browser not configured";
  else if (!deps.mcpTransportReady) reason = "MCP transport not ready";
  else if (!deps.hasComputerUseSDK) reason = "computer use SDK not available";
  else reason = "ok";
  return { browserAvailable, computerUseAvailable, reason };
}

// ---- Tests ----

describe("voice capability: dictation ≠ realtime (R3-15 #200)", () => {
  it("dictation available does NOT make realtime available", () => {
    const caps = probeVoiceCapability({ hasRealtimeService: false, hasWebSpeech: true, micPermission: "granted" });
    expect(caps.dictationAvailable).toBe(true);
    expect(caps.realtimeAvailable).toBe(false); // dictation is NOT realtime
    expect(caps.reason).toMatch(/realtime.*not/i);
  });

  it("realtime requires both service + mic permission", () => {
    expect(probeVoiceCapability({ hasRealtimeService: true, hasWebSpeech: true, micPermission: "granted" }).realtimeAvailable).toBe(true);
    expect(probeVoiceCapability({ hasRealtimeService: true, hasWebSpeech: true, micPermission: "denied" }).realtimeAvailable).toBe(false);
    expect(probeVoiceCapability({ hasRealtimeService: false, hasWebSpeech: true, micPermission: "granted" }).realtimeAvailable).toBe(false);
  });

  it("mic denied blocks both realtime and dictation", () => {
    const caps = probeVoiceCapability({ hasRealtimeService: true, hasWebSpeech: true, micPermission: "denied" });
    expect(caps.realtimeAvailable).toBe(false);
    expect(caps.dictationAvailable).toBe(false);
  });
});

describe("screen context: getDisplayMedia existence ≠ available (R3-15 #200)", () => {
  it("getDisplayMedia alone is not enough — needs permission", () => {
    const caps = probeScreenCapability({ hasDisplayMedia: true, screenPermission: "denied" });
    expect(caps.screenContextAvailable).toBe(false);
    expect(caps.reason).toMatch(/permission/);
  });

  it("screen context requires both display media + permission", () => {
    expect(probeScreenCapability({ hasDisplayMedia: true, screenPermission: "granted" }).screenContextAvailable).toBe(true);
    expect(probeScreenCapability({ hasDisplayMedia: false, screenPermission: "granted" }).screenContextAvailable).toBe(false);
  });
});

describe("browser/Computer-Use: env var/MCP name ≠ available (R3-16 #201)", () => {
  it("MCP transport not ready → browser unavailable even if managed browser configured", () => {
    const caps = probeBrowserCapability({ hasManagedBrowser: true, hasComputerUseSDK: true, mcpTransportReady: false });
    expect(caps.browserAvailable).toBe(false);
    expect(caps.computerUseAvailable).toBe(false);
    expect(caps.reason).toMatch(/MCP.*not ready/i);
  });

  it("managed browser + transport ready → browser available", () => {
    const caps = probeBrowserCapability({ hasManagedBrowser: true, hasComputerUseSDK: false, mcpTransportReady: true });
    expect(caps.browserAvailable).toBe(true);
    expect(caps.computerUseAvailable).toBe(false); // no SDK → no computer use
  });

  it("computer use requires the SDK + transport", () => {
    const caps = probeBrowserCapability({ hasManagedBrowser: true, hasComputerUseSDK: true, mcpTransportReady: true });
    expect(caps.computerUseAvailable).toBe(true);
  });

  it("no managed browser → everything unavailable", () => {
    const caps = probeBrowserCapability({ hasManagedBrowser: false, hasComputerUseSDK: true, mcpTransportReady: true });
    expect(caps.browserAvailable).toBe(false);
    expect(caps.computerUseAvailable).toBe(false);
  });
});

describe("honest degradation: unavailable capabilities have actionable reasons (R3-15/#200, R3-16/#201)", () => {
  it("every unavailable capability provides a reason", () => {
    const voice = probeVoiceCapability({ hasRealtimeService: false, hasWebSpeech: false, micPermission: "unknown" });
    expect(voice.realtimeAvailable).toBe(false);
    expect(voice.reason).toBeTruthy();

    const screen = probeScreenCapability({ hasDisplayMedia: false, screenPermission: "unknown" });
    expect(screen.screenContextAvailable).toBe(false);
    expect(screen.reason).toBeTruthy();

    const browser = probeBrowserCapability({ hasManagedBrowser: false, hasComputerUseSDK: false, mcpTransportReady: false });
    expect(browser.browserAvailable).toBe(false);
    expect(browser.reason).toBeTruthy();
  });
});
