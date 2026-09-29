import { describe, expect, it } from "vitest";
import { resolveSetting } from "../resolve";
import { getSetting } from "../registry";

describe("scope resolver (R4-05 #238)", () => {
  const theme = getSetting("appearance.theme")!;

  it("falls back to the product default when nothing overrides", () => {
    const r = resolveSetting(theme, {});
    expect(r).toEqual({ value: "dark", source: "default", invalidSources: [], overridden: false });
  });

  it("resolution order is session > project > global > default", () => {
    // No production setting currently exposes session scope — use a
    // synthetic definition to pin the resolver's ordering.
    const synthetic = {
      id: "test.synthetic",
      category: "test",
      label: "t",
      description: "d",
      type: "string",
      defaultValue: "d0",
      scopes: ["global", "project", "session"],
      keywords: [],
      saveMode: "immediate",
      validate: (v: unknown): v is string => typeof v === "string",
    } as const;
    expect(
      resolveSetting(synthetic as never, { global: "g", project: "p", session: "s" }).source,
    ).toBe("session");
    expect(resolveSetting(synthetic as never, { global: "g", project: "p" }).source).toBe("project");
    expect(resolveSetting(synthetic as never, { global: "g" }).source).toBe("global");
    expect(resolveSetting(synthetic as never, {}).source).toBe("default");
  });

  it("marks overridden=true whenever a non-default source wins", () => {
    expect(resolveSetting(theme, { global: "light" }).overridden).toBe(true);
    expect(resolveSetting(theme, {}).overridden).toBe(false);
  });

  it("an invalid override is ignored and reported, falling through", () => {
    const r = resolveSetting(theme, { global: "light", project: "banana" });
    expect(r.value).toBe("light");
    expect(r.source).toBe("global");
    expect(r.invalidSources).toEqual(["project"]);
  });

  it("ignores overrides for scopes the setting does not allow", () => {
    const zoom = getSetting("appearance.zoom")!;
    // zoom allows project scope; session is not in its scope list
    const r = resolveSetting(zoom, { session: 1.8, global: 1.2 });
    expect(r.source).toBe("global");
    expect(r.invalidSources).toEqual(["session"]);
  });

  it("never mutates its inputs", () => {
    const layers = { global: "light", project: "banana" };
    const frozen = Object.freeze({ ...layers });
    resolveSetting(theme, frozen);
    expect(frozen).toEqual({ global: "light", project: "banana" });
  });

  it("undefined layers are absent; explicit null is a corrupted (invalid) value", () => {
    const r = resolveSetting(theme, { global: undefined, project: null });
    expect(r.source).toBe("default");
    expect(r.invalidSources).toEqual(["project"]);
  });

  it("invalid LOWER layers are still reported after a higher layer wins", () => {
    // theme allows global + project
    const r = resolveSetting(theme, { project: "light", global: "nonsense" });
    expect(r.source).toBe("project");
    expect(r.invalidSources).toEqual(["global"]);
    // and when only lower layers are invalid, default wins
    const r2 = resolveSetting(theme, { global: "nonsense" });
    expect(r2.source).toBe("default");
    expect(r2.invalidSources).toEqual(["global"]);
  });

  it("validates array-typed settings element-wise", () => {
    const trusted = getSetting("general.trustedFolders")!;
    const ok = resolveSetting(trusted, { global: ["/a", "/b"] });
    expect(ok.value).toEqual(["/a", "/b"]);
    const bad = resolveSetting(trusted, { global: ["/a", 42] });
    expect(bad.source).toBe("default");
    expect(bad.invalidSources).toEqual(["global"]);
  });
});
