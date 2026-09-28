import { describe, expect, it } from "vitest";
import { CURRENT_SETTINGS_VERSION } from "../version";
import { MIGRATIONS, migratePersisted } from "../migrations";

describe("settings migrations (R4-06 #239)", () => {
  it("current version is above the legacy v1", () => {
    expect(CURRENT_SETTINGS_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("migration chain is ordered and contiguous", () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].from).toBe(MIGRATIONS[i - 1].to);
    }
    expect(MIGRATIONS[MIGRATIONS.length - 1].to).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("v1 → current: sanitizes invalid values and guarantees projectOverrides", () => {
    const v1 = {
      state: { theme: "banana", zoom: 1.25, sandboxMode: "full" },
      version: 1,
    };
    const r = migratePersisted(v1);
    expect(r.ok).toBe(true);
    expect(r.fromVersion).toBe(1);
    expect(r.applied.length).toBeGreaterThan(0);
    const state = r.state as Record<string, unknown>;
    expect(state.theme).toBe("dark"); // invalid → registry default
    expect(state.zoom).toBe(1.25); // valid → preserved
    expect(state.sandboxMode).toBe("full"); // valid → preserved
    expect(state.projectOverrides).toEqual({});
  });

  it("is idempotent at the current version (no steps applied)", () => {
    const current = { state: { theme: "light", projectOverrides: {} }, version: CURRENT_SETTINGS_VERSION };
    const r = migratePersisted(current);
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.state).toEqual(current.state);
  });

  it("unversioned payloads are treated as v1", () => {
    const r = migratePersisted({ state: { theme: "light" } });
    expect(r.ok).toBe(true);
    expect(r.fromVersion).toBe(1);
  });

  it("a failing step never destroys the original — backup is returned", () => {
    // a non-object state forces a step failure path
    const r = migratePersisted({ state: "garbage", version: 1 });
    expect(r.ok).toBe(false);
    expect(r.backup).toEqual({ state: "garbage", version: 1 });
    expect(r.error).toBeTruthy();
  });

  it("a NEWER version is refused, not mangled", () => {
    const r = migratePersisted({ state: { theme: "light" }, version: CURRENT_SETTINGS_VERSION + 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/newer/i);
  });
});
