// @vitest-environment node
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolveUatUserDataDir, UAT_USER_DATA_ENV } from "../uat-paths";

describe("resolveUatUserDataDir (R5-04 #260)", () => {
  it("returns null when the override is unset — production unchanged", () => {
    expect(resolveUatUserDataDir({})).toBeNull();
    expect(resolveUatUserDataDir({ [UAT_USER_DATA_ENV]: "" })).toBeNull();
  });

  it("returns the absolute path unchanged", () => {
    const abs = path.join(os.tmpdir(), "gb-uat-userdata");
    expect(resolveUatUserDataDir({ [UAT_USER_DATA_ENV]: abs })).toBe(abs);
  });

  it("rejects a relative override outright — a relative path would scatter state into cwd", () => {
    expect(() => resolveUatUserDataDir({ [UAT_USER_DATA_ENV]: "relative/dir" })).toThrow(/absolute/);
    expect(() => resolveUatUserDataDir({ [UAT_USER_DATA_ENV]: "./x" })).toThrow(/absolute/);
  });
});
