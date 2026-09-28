import { describe, expect, it } from "vitest";
import {
  getSetting,
  listCategories,
  listSettings,
  registryErrors,
  searchSettings,
} from "../registry";

describe("configuration registry (R4-05 #238)", () => {
  it("every registered setting passes registry validation", () => {
    expect(registryErrors()).toEqual([]);
  });

  it("every setting has a unique id, default, category, scopes and validator", () => {
    for (const def of listSettings()) {
      expect(def.id).toMatch(/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/i);
      expect(def.category).toBeTruthy();
      expect(def.label).toBeTruthy();
      expect(def.scopes.length).toBeGreaterThan(0);
      expect(def.validate(def.defaultValue)).toBe(true);
      expect(Array.isArray(def.keywords)).toBe(true);
      expect(["immediate", "staged"]).toContain(def.saveMode);
    }
  });

  it("ids are unique", () => {
    const ids = listSettings().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lookup by id", () => {
    expect(getSetting("appearance.theme")?.defaultValue).toBeDefined();
    expect(getSetting("nonexistent.key")).toBeUndefined();
  });

  it("groups by category in registration order", () => {
    const categories = listCategories();
    expect(categories.length).toBeGreaterThan(2);
    const all = categories.flatMap((c) => c.settings.map((s) => s.id));
    expect(all.length).toBe(listSettings().length);
  });

  it("search matches label, description and keywords", () => {
    expect(searchSettings("主题").map((d) => d.id)).toContain("appearance.theme");
    expect(searchSettings("sandbox").map((d) => d.id)).toContain("permissions.sandboxMode");
    expect(searchSettings("voice").length).toBeGreaterThan(1);
    expect(searchSettings("zzz-no-such-thing")).toEqual([]);
  });

  it("sensitive settings are marked non-exportable by flag", () => {
    const sensitive = listSettings().filter((d) => d.sensitive);
    // No API keys may live in this registry — only flags about them.
    for (const def of sensitive) {
      expect(def.id).not.toMatch(/apikey|api_key|token|secret/i);
    }
  });
});
