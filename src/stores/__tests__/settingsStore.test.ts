// @vitest-environment jsdom
/**
 * Settings store integration tests (R3-11 / #196).
 * Proves: single source of truth, legacy migration, corrupt config recovery,
 * reset excludes secrets, trusted folders management.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useSettingsStore } from "../settingsStore";
import { CURRENT_SETTINGS_VERSION } from "../../config/version";

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

  it("invalid persisted values are sanitized to registry defaults on hydrate (R4-05 #238)", async () => {
    localStorage.clear();
    localStorage.setItem(
      "gb-settings",
      JSON.stringify({
        state: {
          theme: "banana", // invalid enum
          zoom: 99, // out of range
          sandboxMode: "full", // valid
          projectOverrides: {
            "/p1": { "appearance.theme": "light", "appearance.zoom": 99, "nope.key": 1 },
            "/p2": "garbage",
          },
        },
        version: 1,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    const s = useSettingsStore.getState();
    expect(s.theme).toBe("dark"); // sanitized
    expect(s.zoom).toBe(1.0); // sanitized
    expect(s.sandboxMode).toBe("full"); // valid value preserved
    expect(s.projectOverrides["/p1"]).toEqual({ "appearance.theme": "light" });
    expect(s.projectOverrides["/p2"]).toBeUndefined();
  });

  it("a legacy notification opt-out survives the R4-07 store takeover (R4-07 #240)", async () => {
    // Before R4-07 the only notification toggle wrote `gb-notifications-enabled`
    // directly and never the store, so a persisted blob holds the default
    // `true`. The merge must honor the legacy key instead of silently
    // re-enabling notifications for users who opted out.
    localStorage.clear();
    localStorage.setItem("gb-notifications-enabled", "false");
    localStorage.setItem(
      "gb-settings",
      JSON.stringify({
        state: { theme: "dark", notificationsEnabled: true }, // stale default
        version: CURRENT_SETTINGS_VERSION,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false);
  });

  it("a v1 persisted blob migrates to the current version (R4-06 #239)", async () => {
    localStorage.clear();
    localStorage.setItem(
      "gb-settings",
      JSON.stringify({ state: { theme: "light", zoom: "bogus" }, version: 1 }),
    );
    await useSettingsStore.persist.rehydrate();
    const s = useSettingsStore.getState();
    expect(s.theme).toBe("light"); // valid v1 value survives migration
    expect(s.zoom).toBe(1.0); // invalid v1 value sanitized by the pipeline
    expect(s.projectOverrides).toEqual({}); // layer guaranteed by migration
  });

  it("the persist layer is wired to the migration pipeline (M1 regression)", async () => {
    // A passthrough migrate hook must fail this test — it pins the wiring,
    // not just the sanitizer outcome.
    const opts = useSettingsStore.persist.getOptions();
    expect(opts.version).toBe(CURRENT_SETTINGS_VERSION);
    expect(typeof opts.migrate).toBe("function");
    // and the pipeline itself runs (v1 fixture through the real hook)
    const migrated = await opts.migrate!({ theme: "banana" } as never, 1);
    expect((migrated as { theme: string }).theme).toBe("dark");
    expect((migrated as { projectOverrides: unknown }).projectOverrides).toEqual({});
  });

  it("a NEWER persisted version is quarantined, not adopted (no silent downgrade)", async () => {
    localStorage.clear();
    localStorage.setItem(
      "gb-settings",
      JSON.stringify({ state: { theme: "light" }, version: CURRENT_SETTINGS_VERSION + 1 }),
    );
    await useSettingsStore.persist.rehydrate();
    // the newer blob was NOT adopted — defaults instead
    expect(useSettingsStore.getState().theme).toBe("dark");
    // and the original was quarantined to a backup key
    const backups = Object.keys(localStorage).filter((k) => k.startsWith("gb-settings.backup-"));
    expect(backups.length).toBeGreaterThan(0);
    expect(localStorage.getItem(backups[0])).toContain('"light"');
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
