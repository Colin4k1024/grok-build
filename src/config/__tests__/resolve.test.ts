import { describe, expect, it } from "vitest";
import { resolveSetting } from "../resolve";
import { getSetting } from "../registry";

describe("scope resolver (R4-05 #238)", () => {
  const theme = getSetting("appearance.theme")!;

  it("falls back to the product default when nothing overrides", () => {
    const r = resolveSetting(theme, {});
    expect(r).toEqual({ value: "dark", source: "default", invalidSources: [], overridden: false });
  });

  it("resolution order is session -> project -> global -> default", () => {
    // agent.mode allows all three override scopes
    const mode = getSetting("agent.mode")!;
    expect(resolveSetting(mode, { global: "architect", project: "debug", session: "code" }).source).toBe("session");
    expect(resolveSetting(mode, { global: "architect", project: "debug" }).source).toBe("project");
    expect(resolveSetting(mode, { global: "debug" }).source).toBe("global");
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
    const mode = getSetting("agent.mode")!;
    const r = resolveSetting(mode, { project: "debug", global: "nonsense" });
    expect(r.source).toBe("project");
    expect(r.invalidSources).toEqual(["global"]);
    // and when only lower layers are invalid, default wins
    const r2 = resolveSetting(mode, { global: "nonsense" });
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
