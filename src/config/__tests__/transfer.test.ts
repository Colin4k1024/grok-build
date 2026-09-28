import { beforeEach, describe, expect, it } from "vitest";
import {
  applyImport,
  exportSettings,
  previewImport,
  type SettingsExportDoc,
} from "../transfer";
import { useSettingsStore } from "../../stores/settingsStore";
import { CURRENT_SETTINGS_VERSION } from "../version";

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    theme: "dark", fontSize: "medium", zoom: 1.0, sandboxMode: "sandbox",
    notificationsEnabled: true, agentMode: "code", agentAutonomous: false,
    voiceLanguage: "auto", voiceWakeEnabled: false, voiceTtsEnabled: false,
    trustedFolders: [], projectOverrides: {}, userPresets: {},
  });
});

describe("settings transfer (R4-06 #239)", () => {
  it("export produces a versioned document with global values and no sensitive fields", () => {
    useSettingsStore.getState().setTheme("light");
    const doc = exportSettings();
    expect(doc.kind).toBe("gb-settings-export");
    expect(doc.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(doc.global["appearance.theme"]).toBe("light");
    expect(JSON.stringify(doc)).not.toMatch(/api[_-]?key|token|secret|password/i);
  });

  it("export includes project overrides", () => {
    useSettingsStore.getState().setProjectOverride("/p", "appearance.theme", "light");
    const doc = exportSettings();
    expect(doc.projects["/p"]["appearance.theme"]).toBe("light");
  });

  it("preview reports added/changed/reset/ignored WITHOUT mutating state", () => {
    useSettingsStore.getState().setTheme("light");
    const doc: SettingsExportDoc = {
      kind: "gb-settings-export",
      settingsVersion: CURRENT_SETTINGS_VERSION,
      exportedAt: new Date().toISOString(),
      global: {
        "appearance.theme": "auto", // changed (light → auto)
        "agent.mode": "debug", // added (store is default "code")
        "nope.key": 1, // ignored (unknown)
      },
      projects: {},
    };
    const before = useSettingsStore.getState().theme;
    const preview = previewImport(JSON.stringify(doc));
    expect(preview.ok).toBe(true);
    expect(preview.changed).toContain("appearance.theme");
    expect(preview.added).toContain("agent.mode");
    expect(preview.ignored).toContain("nope.key");
    expect(useSettingsStore.getState().theme).toBe(before); // untouched
  });

  it("rejects structurally invalid documents entirely", () => {
    expect(previewImport("not json").ok).toBe(false);
    expect(previewImport("{}").ok).toBe(false);
    expect(previewImport(JSON.stringify({ kind: "wrong", settingsVersion: 2 })).ok).toBe(false);
  });

  it("refuses documents from a newer settings version", () => {
    const doc = {
      kind: "gb-settings-export",
      settingsVersion: CURRENT_SETTINGS_VERSION + 1,
      exportedAt: "",
      global: {},
      projects: {},
    };
    const p = previewImport(JSON.stringify(doc));
    expect(p.ok).toBe(false);
    expect(p.errors.join(" ")).toMatch(/newer|版本/i);
  });

  it("refuses documents with invalid values (nothing is applied)", () => {
    const doc = {
      kind: "gb-settings-export",
      settingsVersion: CURRENT_SETTINGS_VERSION,
      exportedAt: "",
      global: { "appearance.theme": "banana", "agent.mode": "debug" },
      projects: {},
    };
    const p = previewImport(JSON.stringify(doc));
    expect(p.ok).toBe(false);
    expect(p.errors.join(" ")).toMatch(/appearance\.theme/);
    // and apply of a broken preview is a no-op
    const r = applyImport(p);
    expect(r.ok).toBe(false);
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(useSettingsStore.getState().agentMode).toBe("code");
  });

  it("applyImport applies a valid preview atomically", () => {
    const doc: SettingsExportDoc = {
      kind: "gb-settings-export",
      settingsVersion: CURRENT_SETTINGS_VERSION,
      exportedAt: "",
      global: { "appearance.theme": "auto", "agent.mode": "debug" },
      projects: { "/p": { "appearance.zoom": 1.5 } },
    };
    const preview = previewImport(JSON.stringify(doc));
    expect(preview.ok).toBe(true);
    const r = applyImport(preview);
    expect(r.ok).toBe(true);
    const s = useSettingsStore.getState();
    expect(s.theme).toBe("auto");
    expect(s.agentMode).toBe("debug");
    expect(s.projectOverrides["/p"]["appearance.zoom"]).toBe(1.5);
  });

  it("round-trips: export → preview → apply preserves values", () => {
    useSettingsStore.getState().setTheme("light");
    useSettingsStore.getState().setProjectOverride("/a", "appearance.zoom", 1.25);
    const doc = exportSettings();
    useSettingsStore.getState().setTheme("dark");
    useSettingsStore.getState().resetProjectOverrides("/a");
    const preview = previewImport(JSON.stringify(doc));
    expect(preview.ok).toBe(true);
    applyImport(preview);
    expect(useSettingsStore.getState().theme).toBe("light");
    expect(useSettingsStore.getState().projectOverrides["/a"]["appearance.zoom"]).toBe(1.25);
  });
});
