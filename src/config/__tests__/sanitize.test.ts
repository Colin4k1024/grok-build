import { describe, expect, it } from "vitest";
import { sanitizePersistedState } from "../sanitize";

describe("sanitizePersistedState (R4-06 #239)", () => {
  it("drops unknown keys and sanitizes invalid flat values", () => {
    const out = sanitizePersistedState({
      theme: "banana",
      zoom: 1.5,
      rogue: "x",
      setTheme: "evil", // never hydrate action names
    });
    expect(out.theme).toBe("dark");
    expect(out.zoom).toBe(1.5);
    expect(out).not.toHaveProperty("rogue");
    expect(out).not.toHaveProperty("setTheme");
  });

  it("drops invalid preset ENTRIES but keeps valid siblings", () => {
    const out = sanitizePersistedState({
      userPresets: {
        mine: {
          label: "混合",
          values: { "agent.mode": "debug", "appearance.zoom": 99, "unknown.key": 1 },
        },
        allbad: { label: "全坏", values: { "appearance.zoom": 99 } },
        malformed: "not-an-object",
      },
    });
    const presets = out.userPresets as Record<string, { label: string; values: Record<string, unknown> }>;
    expect(presets.mine.values).toEqual({ "agent.mode": "debug" });
    expect(presets.allbad).toBeUndefined();
    expect(presets.malformed).toBeUndefined();
  });

  it("never assigns reserved keys (__proto__ etc.) into accumulators", () => {
    const out = sanitizePersistedState({
      projectOverrides: {
        __proto__: { "appearance.theme": "light" },
        "/real": { "appearance.theme": "light" },
      },
      userPresets: {
        __proto__: { label: "x", values: { "agent.mode": "debug" } },
      },
    });
    const projects = out.projectOverrides as Record<string, unknown>;
    expect(Object.keys(projects)).toEqual(["/real"]);
    // accumulators are prototype-free (Object.create(null))
    expect(Object.getPrototypeOf(projects)).toBeNull();
    expect((out.userPresets as Record<string, unknown>).__proto__).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
