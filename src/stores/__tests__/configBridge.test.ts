import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../settingsStore";
import {
  SettingWriteError,
  listStoreBindings,
  resolveFromStore,
  resetScopedValue,
  setScopedValue,
} from "../../config/storeBridge";
import { registryErrors } from "../../config/registry";

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    theme: "dark", fontSize: "medium", zoom: 1.0, sandboxMode: "sandbox",
    notificationsEnabled: true, agentMode: "code", agentAutonomous: false,
    voiceLanguage: "auto", voiceWakeEnabled: false, voiceTtsEnabled: false,
    trustedFolders: [], projectOverrides: {},
  });
});

describe("registry ↔ store bridge (R4-05 #238)", () => {
  it("registry is healthy", () => {
    expect(registryErrors()).toEqual([]);
  });

  it("every schema setting with a store binding resolves to the store default", () => {
    for (const [settingId, storeKey] of Object.entries(listStoreBindings())) {
      const r = resolveFromStore(settingId);
      expect(r.source).toBe("default");
      expect(r.value).toBeDefined();
      expect(storeKey).toBeTruthy();
    }
  });

  it("global writes go through the typed path and resolve back", () => {
    setScopedValue("appearance.theme", "light", "global");
    expect(useSettingsStore.getState().theme).toBe("light");
    const r = resolveFromStore("appearance.theme");
    expect(r.value).toBe("light");
    expect(r.source).toBe("global");
    expect(r.overridden).toBe(true);
  });

  it("project overrides win over global for that project only", () => {
    setScopedValue("appearance.theme", "light", "global");
    setScopedValue("appearance.theme", "auto", "project", "/proj/a");
    expect(resolveFromStore("appearance.theme", "/proj/a").value).toBe("auto");
    expect(resolveFromStore("appearance.theme", "/proj/a").source).toBe("project");
    // another project sees the global value
    expect(resolveFromStore("appearance.theme", "/proj/b").value).toBe("light");
    expect(resolveFromStore("appearance.theme", "/proj/b").source).toBe("global");
  });

  it("project reset removes only the project layer", () => {
    setScopedValue("appearance.theme", "light", "global");
    setScopedValue("appearance.theme", "auto", "project", "/proj/a");
    resetScopedValue(null, "/proj/a");
    expect(useSettingsStore.getState().projectOverrides["/proj/a"]).toBeUndefined();
    expect(useSettingsStore.getState().theme).toBe("light");
    expect(resolveFromStore("appearance.theme", "/proj/a").value).toBe("light");
  });

  it("clearing a single override reveals the global value", () => {
    setScopedValue("appearance.zoom", 1.5, "global");
    setScopedValue("appearance.zoom", 2.0, "project", "/p");
    resetScopedValue("appearance.zoom", "/p");
    const r = resolveFromStore("appearance.zoom", "/p");
    expect(r.value).toBe(1.5);
    expect(r.source).toBe("global");
  });

  it("rejects invalid values BEFORE touching persisted state", () => {
    expect(() => setScopedValue("appearance.theme", "banana", "global")).toThrow(SettingWriteError);
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(() => setScopedValue("appearance.zoom", 99, "global")).toThrow(/invalid_value/);
    expect(useSettingsStore.getState().zoom).toBe(1.0);
  });

  it("rejects disallowed scopes", () => {
    // fontSize is global-only
    expect(() => setScopedValue("appearance.fontSize", "large", "project", "/p")).toThrow(
      /scope_not_allowed/,
    );
  });

  it("rejects unknown setting ids and unknown store keys", () => {
    expect(() => setScopedValue("nope.nope", 1, "global")).toThrow(/unknown_key/);
    expect(() => useSettingsStore.getState().setGlobalByKey("nope", 1)).toThrow(/unknown settings store key/);
  });

  it("project overrides persist through the store's persist layer", () => {
    setScopedValue("appearance.theme", "light", "project", "/proj/x");
    const raw = localStorage.getItem("gb-settings");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.projectOverrides["/proj/x"]["appearance.theme"]).toBe("light");
  });
});
