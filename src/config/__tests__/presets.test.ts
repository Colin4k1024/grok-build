import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, presetErrors } from "../presets";
import { applyPreset } from "../storeBridge";
import { useSettingsStore } from "../../stores/settingsStore";
import { getSetting, listSettings } from "../registry";

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    theme: "dark", fontSize: "medium", zoom: 1.0, sandboxMode: "sandbox",
    notificationsEnabled: true, agentMode: "code", agentAutonomous: false,
    voiceLanguage: "auto", voiceWakeEnabled: false, voiceTtsEnabled: false,
    trustedFolders: [], projectOverrides: {}, userPresets: {},
  });
});

describe("configuration presets (R4-06 #239)", () => {
  it("ships safe / balanced / high-autonomy built-ins", () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id);
    expect(ids).toContain("safe");
    expect(ids).toContain("balanced");
    expect(ids).toContain("high-autonomy");
  });

  it("every preset value passes registry validation", () => {
    expect(presetErrors()).toEqual([]);
    for (const preset of BUILTIN_PRESETS) {
      for (const [id, value] of Object.entries(preset.values)) {
        const def = getSetting(id);
        expect(def, `${preset.id} references unknown ${id}`).toBeDefined();
        expect(def!.validate(value), `${preset.id}.${id}`).toBe(true);
      }
    }
  });

  it("presets never touch sensitive or unsetting-shaped keys", () => {
    for (const preset of BUILTIN_PRESETS) {
      for (const id of Object.keys(preset.values)) {
        const def = getSetting(id)!;
        expect(def.sensitive ?? false).toBe(false);
      }
    }
  });

  it("applying a builtin preset at global scope writes through the typed path", () => {
    const r = applyPreset("high-autonomy", "global");
    expect(r.failed).toEqual([]);
    expect(r.applied.length).toBeGreaterThan(0);
    expect(useSettingsStore.getState().agentAutonomous).toBe(true);
  });

  it("applying at project scope does NOT touch global values", () => {
    const r = applyPreset("high-autonomy", "project", "/proj/a");
    expect(r.failed).toEqual([]);
    expect(useSettingsStore.getState().agentAutonomous).toBe(false); // global untouched
    const ov = useSettingsStore.getState().projectOverrides["/proj/a"];
    expect(ov["agent.autonomous"]).toBe(true);
  });

  it("user presets: save validates, rename/delete work, unknown id fails loudly", () => {
    const store = useSettingsStore.getState();
    store.saveUserPreset("mine", "我的预设", { "agent.mode": "debug" });
    expect(useSettingsStore.getState().userPresets["mine"].label).toBe("我的预设");

    expect(() =>
      useSettingsStore.getState().saveUserPreset("bad", "坏", { "agent.mode": "nope" }),
    ).toThrow(/invalid/i);

    useSettingsStore.getState().renameUserPreset("mine", "改名");
    expect(useSettingsStore.getState().userPresets["mine"].label).toBe("改名");
    useSettingsStore.getState().deleteUserPreset("mine");
    expect(useSettingsStore.getState().userPresets["mine"]).toBeUndefined();

    expect(() => applyPreset("does-not-exist", "global")).toThrow(/unknown preset/i);
  });

  it("builtin preset ids are reserved — a user preset cannot shadow them", () => {
    expect(() =>
      useSettingsStore.getState().saveUserPreset("safe", "假冒安全", { "agent.mode": "debug" }),
    ).toThrow(/reserved/i);
    // and deleting a (nonexistent) user preset named 'safe' must not touch
    // the builtin
    expect(() => useSettingsStore.getState().deleteUserPreset("safe")).toThrow(/unknown preset/);
    expect(BUILTIN_PRESETS.find((p) => p.id === "safe")).toBeDefined();
  });

  it("user presets reject sensitive settings", () => {
    expect(() =>
      useSettingsStore.getState().saveUserPreset("s", "敏感", {
        "general.trustedFolders": ["/x"],
      }),
    ).toThrow(/sensitive/i);
  });

  it("applying a user preset applies its values", () => {
    useSettingsStore.getState().saveUserPreset("dbg", "调试", { "agent.mode": "debug" });
    const r = applyPreset("dbg", "global");
    expect(r.applied).toContain("agent.mode");
    expect(useSettingsStore.getState().agentMode).toBe("debug");
  });

  it("preset application reports per-key failure instead of partial-silent success", () => {
    // a value that validates at save time but whose scope is disallowed at apply time
    useSettingsStore.getState().saveUserPreset("scoped", "域", { "appearance.fontSize": "large" });
    const r = applyPreset("scoped", "project", "/p"); // fontSize is global-only
    expect(r.failed.length).toBeGreaterThan(0);
    expect(r.failed[0]).toMatch(/fontSize|scope/i);
  });

  it("no-op preset applications are not counted as applied", () => {
    // defaults already match 'safe' (sandbox + not autonomous + code)
    const r = applyPreset("safe", "global");
    expect(r.failed).toEqual([]);
    expect(r.applied).toEqual([]);
  });
});

describe("registry coverage", () => {
  it("listSettings is stable for tests above", () => {
    expect(listSettings().length).toBeGreaterThan(5);
  });
});
