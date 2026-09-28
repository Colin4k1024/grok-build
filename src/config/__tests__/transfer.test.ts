import { beforeEach, describe, expect, it, vi } from "vitest";
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
    // trustedFolders is sensitive — it must NOT survive export
    useSettingsStore.getState().addTrustedFolder("/Users/alice/secret-project");
    useSettingsStore.getState().setProjectOverride("/p", "general.trustedFolders", ["/x/secret"]);
    const doc = exportSettings();
    expect(doc.kind).toBe("gb-settings-export");
    expect(doc.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(doc.global["appearance.theme"]).toBe("light");
    expect(doc.global["general.trustedFolders"]).toBeUndefined();
    expect(JSON.stringify(doc)).not.toMatch(/api[_-]?key|token|secret|password/i);
    expect(JSON.stringify(doc)).not.toContain("secret-project");
    expect(JSON.stringify(doc)).not.toContain("/x/secret");
  });

  it("import ignores sensitive keys (never written back)", () => {
    const doc = {
      kind: "gb-settings-export",
      settingsVersion: CURRENT_SETTINGS_VERSION,
      exportedAt: "",
      global: { "general.trustedFolders": ["/attacker"] },
      projects: {},
    };
    const p = previewImport(JSON.stringify(doc));
    expect(p.ok).toBe(true);
    expect(p.ignored.join(" ")).toMatch(/trustedFolders/);
    applyImport(p);
    expect(useSettingsStore.getState().trustedFolders).toEqual([]);
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
    expect(preview.ignored.join(" ")).toContain("nope.key");
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

  it("preview classifies project entries with scope tags (preview == apply surface)", () => {
    const doc = {
      kind: "gb-settings-export",
      settingsVersion: CURRENT_SETTINGS_VERSION,
      exportedAt: "",
      global: {},
      projects: { "/evil": { "agent.mode": "debug" } },
    };
    const p = previewImport(JSON.stringify(doc));
    expect(p.ok).toBe(true);
    // project entries ARE classified (not silently applied later)
    expect(p.added).toContain("/evil:agent.mode");
  });

  it("replace mode previews resets and applyImport applies them", () => {
    useSettingsStore.getState().setTheme("light");
    useSettingsStore.getState().setZoom(1.5);
    const doc = {
      kind: "gb-settings-export",
      settingsVersion: CURRENT_SETTINGS_VERSION,
      exportedAt: "",
      global: { "agent.mode": "debug" }, // theme/zoom absent
      projects: {},
    };
    const p = previewImport(JSON.stringify(doc), { mode: "replace" });
    expect(p.ok).toBe(true);
    expect(p.reset).toContain("appearance.theme");
    expect(p.reset).toContain("appearance.zoom");
    const r = applyImport(p, { mode: "replace" });
    expect(r.ok).toBe(true);
    expect(useSettingsStore.getState().theme).toBe("dark"); // reset to default
    expect(useSettingsStore.getState().zoom).toBe(1.0); // reset to default
    expect(useSettingsStore.getState().agentMode).toBe("debug"); // applied
  });

  it("applyImport rolls back EVERYTHING when a write fails mid-apply", () => {
    useSettingsStore.getState().setTheme("light");
    const doc: SettingsExportDoc = {
      kind: "gb-settings-export",
      settingsVersion: CURRENT_SETTINGS_VERSION,
      exportedAt: "",
      global: { "appearance.theme": "auto", "agent.mode": "debug" },
      projects: {},
    };
    const preview = previewImport(JSON.stringify(doc));
    expect(preview.ok).toBe(true);
    // force the SECOND write to fail
    const state = useSettingsStore.getState();
    const original = state.setGlobalByKey;
    let calls = 0;
    const spy = vi.spyOn(state, "setGlobalByKey").mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return original(...args);
    });
    try {
      const r = applyImport(preview);
      expect(r.ok).toBe(false);
      expect(r.rolledBack).toBe(true);
      // the first write was rolled back — pre-apply state restored
      expect(useSettingsStore.getState().theme).toBe("light");
      expect(useSettingsStore.getState().agentMode).toBe("code");
    } finally {
      spy.mockRestore();
    }
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
