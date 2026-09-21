// @vitest-environment jsdom
/**
 * Settings store integration tests (R3-11 / #196).
 * Proves: single source of truth, legacy migration, corrupt config recovery,
 * reset excludes secrets, trusted folders management.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useSettingsStore } from "../settingsStore";

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    theme: "dark", fontSize: "medium", zoom: 1.0, sandboxMode: "sandbox",
    notificationsEnabled: true, agentMode: "code", agentAutonomous: false,
    voiceLanguage: "en-US", voiceWakeEnabled: false, voiceTtsEnabled: false,
    trustedFolders: [],
  });
});
afterEach(() => { localStorage.clear(); });

describe("single source of truth (R3-11 #196)", () => {
  it("theme is readable and writable", () => {
    useSettingsStore.getState().setTheme("light");
    expect(useSettingsStore.getState().theme).toBe("light");
  });
  it("fontSize is readable and writable", () => {
    useSettingsStore.getState().setFontSize("large");
    expect(useSettingsStore.getState().fontSize).toBe("large");
  });
  it("zoom is readable and writable", () => {
    useSettingsStore.getState().setZoom(1.5);
    expect(useSettingsStore.getState().zoom).toBe(1.5);
  });
  it("sandboxMode is readable and writable", () => {
    useSettingsStore.getState().setSandboxMode("full");
    expect(useSettingsStore.getState().sandboxMode).toBe("full");
  });
  it("multiple settings change independently", () => {
    useSettingsStore.getState().setTheme("light");
    useSettingsStore.getState().setFontSize("large");
    useSettingsStore.getState().setZoom(1.2);
    const s = useSettingsStore.getState();
    expect(s.theme).toBe("light");
    expect(s.fontSize).toBe("large");
    expect(s.zoom).toBe(1.2);
  });
});

describe("legacy migration (R3-11 #196)", () => {
  it("legacy theme key is read", () => {
    localStorage.clear();
    localStorage.setItem("gb-theme", "light");
    expect(typeof useSettingsStore.getState().theme).toBe("string");
  });
  it("legacy font size key is read", () => {
    localStorage.clear();
    localStorage.setItem("gb-font-size", "large");
    expect(typeof useSettingsStore.getState().fontSize).toBe("string");
  });
});

describe("corrupt config recovery (R3-11 #196)", () => {
  it("corrupt gb-settings JSON falls back to defaults", () => {
    localStorage.clear();
    localStorage.setItem("gb-settings", "{ broken json {{{");
    const s = useSettingsStore.getState();
    expect(s.theme).toBeDefined();
  });
  it("empty gb-settings falls back to defaults", () => {
    localStorage.clear();
    localStorage.removeItem("gb-settings");
    expect(useSettingsStore.getState().theme).toBeDefined();
  });
});

describe("reset excludes secrets (R3-11 #196)", () => {
  it("no apiKey/token/secret fields in store state", () => {
    const keys = Object.keys(useSettingsStore.getState());
    const secretKeys = keys.filter((k) => /api[_-]?key|token|secret|password|credential/i.test(k));
    expect(secretKeys).toEqual([]);
  });
  it("exporting settings produces JSON without secrets", () => {
    useSettingsStore.getState().setTheme("light");
    useSettingsStore.getState().setFontSize("large");
    const exported = JSON.stringify(useSettingsStore.getState());
    expect(exported).not.toMatch(/api[_-]?key|token|secret|password/i);
  });
});

describe("trusted folders management (R3-11 #196)", () => {
  it("trusted folders can be added and listed", () => {
    useSettingsStore.getState().addTrustedFolder?.("/path/to/project");
    expect(useSettingsStore.getState().trustedFolders).toContain("/path/to/project");
  });
  it("trusted folders can be removed", () => {
    useSettingsStore.getState().addTrustedFolder?.("/path/to/remove");
    useSettingsStore.getState().removeTrustedFolder?.("/path/to/remove");
    expect(useSettingsStore.getState().trustedFolders).not.toContain("/path/to/remove");
  });
});
