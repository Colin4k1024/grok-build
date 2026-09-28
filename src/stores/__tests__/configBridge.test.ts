import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../settingsStore";
import {
  SettingWriteError,
  listStoreBindings,
  resolveFromStore,
  resetScopedValue,
  setScopedValue,
} from "../../config/storeBridge";
import { listSettings, registryErrors } from "../../config/registry";

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

  it("completeness: every global-scoped setting has a store binding, and vice versa", () => {
    const bindings = listStoreBindings();
    for (const def of listSettings()) {
      if (def.scopes.includes("global")) {
        expect(bindings[def.id], `${def.id} is global-scoped but unbound`).toBeTruthy();
      }
    }
    for (const id of Object.keys(bindings)) {
      expect(listSettings().some((d) => d.id === id), `binding ${id} has no schema entry`).toBe(true);
    }
  });

  it("every binding round-trips a distinct NON-default value to the exact field", () => {
    const probes: Array<[string, unknown, (s: ReturnType<typeof useSettingsStore.getState>) => unknown]> = [
      ["appearance.theme", "light", (s) => s.theme],
      ["appearance.fontSize", "large", (s) => s.fontSize],
      ["appearance.zoom", 1.5, (s) => s.zoom],
      ["permissions.sandboxMode", "full", (s) => s.sandboxMode],
      ["agent.mode", "debug", (s) => s.agentMode],
      ["agent.autonomous", true, (s) => s.agentAutonomous],
      ["voice.language", "zh-CN", (s) => s.voiceLanguage],
      ["voice.wakeEnabled", true, (s) => s.voiceWakeEnabled],
      ["voice.ttsEnabled", true, (s) => s.voiceTtsEnabled],
      ["notifications.enabled", false, (s) => s.notificationsEnabled],
      ["general.trustedFolders", ["/x"], (s) => s.trustedFolders],
    ];
    for (const [settingId, value, read] of probes) {
      const def = listSettings().find((d) => d.id === settingId)!;
      expect(def.validate(value)).toBe(true);
      useSettingsStore.getState().setGlobalByKey(def.storeKey!, value);
      expect(read(useSettingsStore.getState()), settingId).toEqual(value);
      expect(resolveFromStore(settingId).value).toEqual(value);
    }
  });

  it("provenance: a project override equal to the default still reports project", () => {
    setScopedValue("appearance.theme", "light", "global");
    // project deliberately pins "dark" — equal to the product default but
    // an intentional override: resetting the project must reveal "light".
    setScopedValue("appearance.theme", "dark", "project", "/proj/a");
    const r = resolveFromStore("appearance.theme", "/proj/a");
    expect(r.value).toBe("dark");
    expect(r.source).toBe("project");
    expect(r.overridden).toBe(true);
  });

  it("provenance: a global value equal to the default reports as default (flat-store compat)", () => {
    // untouched store: flat field holds the default
    expect(resolveFromStore("appearance.theme").source).toBe("default");
    // after a REAL change, source is global
    setScopedValue("appearance.theme", "light", "global");
    expect(resolveFromStore("appearance.theme").source).toBe("global");
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

  it("direct store actions validate too (no bypass path)", () => {
    expect(() => useSettingsStore.getState().setGlobalByKey("theme", "banana")).toThrow(/invalid value/);
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(() =>
      useSettingsStore.getState().setProjectOverride("/p", "appearance.theme", "banana"),
    ).toThrow(/invalid value/);
    expect(() =>
      useSettingsStore.getState().setProjectOverride("/p", "unknown.id", 1),
    ).toThrow(/unknown setting id/);
    expect(useSettingsStore.getState().projectOverrides["/p"]).toBeUndefined();
  });

  it("project overrides persist through the store's persist layer", () => {
    setScopedValue("appearance.theme", "light", "project", "/proj/x");
    const raw = localStorage.getItem("gb-settings");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.projectOverrides["/proj/x"]["appearance.theme"]).toBe("light");
  });

  it("typed setters reject invalid values (direct UI path is validated too)", () => {
    expect(() => useSettingsStore.getState().setTheme("banana" as never)).toThrow(/invalid value/);
    expect(() => useSettingsStore.getState().setZoom(99)).toThrow(/invalid value/);
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  it("remote file reset resets live state to registry defaults", async () => {
    const { syncFromFileDoc } = await import("../settingsStore");
    useSettingsStore.getState().setTheme("light");
    useSettingsStore.getState().setProjectOverride("/p", "appearance.theme", "auto");
    expect(useSettingsStore.getState().theme).toBe("light");
    // the canonical file no longer carries the blob → local reset
    syncFromFileDoc({ version: 1, values: {} });
    const s = useSettingsStore.getState();
    expect(s.theme).toBe("dark");
    expect(s.projectOverrides).toEqual({});
    // persist re-writes the reset state — the blob now holds defaults
    const blob = JSON.parse(localStorage.getItem("gb-settings")!);
    expect(blob.state.theme).toBe("dark");
    expect(blob.state.projectOverrides).toEqual({});
  });
});
