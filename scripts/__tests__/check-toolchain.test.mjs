// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  parseRustToolchainChannel,
  parseRustcVersion,
  parseProtocVersion,
  checkNode,
  checkLockfile,
  checkProtoc,
  checkRust,
  checkAll,
  computeFailures,
} from "../check-toolchain.mjs";

describe("check-toolchain parsers + checks (R6-02 #280)", () => {
  it("parseRustToolchainChannel extracts the channel version", () => {
    const toml = `[toolchain]\n# comment\nchannel = "1.94.0"\ncomponents = ["rustfmt"]\n`;
    expect(parseRustToolchainChannel(toml)).toBe("1.94.0");
    expect(parseRustToolchainChannel("")).toBeNull();
    expect(parseRustToolchainChannel(null)).toBeNull();
  });

  it("parseRustcVersion extracts the version from rustc output", () => {
    expect(parseRustcVersion("rustc 1.94.0 (abc123 2026-01-01)\n")).toBe("1.94.0");
    expect(parseRustcVersion("rustc 1.80.1")).toBe("1.80.1");
    expect(parseRustcVersion("no rustc here")).toBeNull();
  });

  it("parseProtocVersion extracts the version from protoc output", () => {
    expect(parseProtocVersion("libprotoc 29.3")).toBe("29.3");
    expect(parseProtocVersion("libprotoc 25.1\n")).toBe("25.1");
    expect(parseProtocVersion("protoc: not found")).toBeNull();
  });

  it("checkNode passes when version satisfies the range", () => {
    expect(checkNode("22.16.0", ">=22.12.0").ok).toBe(true);
    expect(checkNode("22.12.0", ">=22.12.0").ok).toBe(true); // boundary
  });

  it("checkNode fails with an actionable message when below the floor", () => {
    const r = checkNode("20.18.0", ">=22.12.0");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/20.18.0/);
    expect(r.reason).toMatch(/Electron 44/);
    expect(r.reason).toMatch(/\.nvmrc/);
  });

  it("checkNode fails when no engines range is declared", () => {
    expect(checkNode("22.16.0", "").ok).toBe(false);
  });

  it("checkLockfile passes on lockfileVersion 3", () => {
    expect(checkLockfile({ lockfileVersion: 3 }).ok).toBe(true);
  });

  it("checkLockfile fails on wrong version or missing file", () => {
    expect(checkLockfile({ lockfileVersion: 2 }).ok).toBe(false);
    expect(checkLockfile(null).ok).toBe(false);
  });

  it("checkProtoc passes when protoc is present", () => {
    expect(checkProtoc("libprotoc 29.3").ok).toBe(true);
  });

  it("checkProtoc fails with an actionable message when protoc is missing", () => {
    const r = checkProtoc(null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/protoc not found/);
  });

  it("checkRust passes when rustc matches the pinned channel", () => {
    expect(checkRust("rustc 1.94.0 (abc)", "1.94.0").ok).toBe(true);
  });

  it("checkRust fails when rustc drifts from the pin", () => {
    const r = checkRust("rustc 1.95.0 (abc)", "1.94.0");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/1.95.0/);
    expect(r.reason).toMatch(/1.94.0/);
  });

  it("checkRust accepts a named channel (stable) without version rejection", () => {
    const r = checkRust("rustc 1.94.0 (abc)", "stable");
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/named channel/);
  });

  it("checkRust fails when rustc is missing", () => {
    expect(checkRust(null, "1.94.0").ok).toBe(false);
  });

  it("checkAll returns results + versions for computeFailures to scope", () => {
    const { results, versions } = checkAll({
      nodeVersion: "20.18.0", nodeRange: ">=22.12.0",
      lockfile: { lockfileVersion: 2 },
      protocOutput: "libprotoc 29.3",
      rustcOutput: "rustc 1.95.0 (x)", rustChannel: "1.94.0",
      npmVersion: "10.9.0", electronVersion: "^44.4.1", electronBuilderVersion: "^26.15.3",
    });
    // node fails, lockfile fails, rust fails; protoc passes
    expect(results.node.ok).toBe(false);
    expect(results.lockfile.ok).toBe(false);
    expect(results.rust.ok).toBe(false);
    expect(results.protoc.ok).toBe(true);
    expect(versions.protoc).toBe("29.3");
    expect(versions.rustc).toBe("1.95.0");
  });

  it("computeFailures defaults to requiring node + lockfile (so a job without protoc/rust isn't failed for their absence)", () => {
    const { results } = checkAll({
      nodeVersion: "22.16.0", nodeRange: ">=22.12.0",
      lockfile: { lockfileVersion: 3 },
      protocOutput: null, // missing — but not required by default
      rustcOutput: null,  // missing — but not required by default
      rustChannel: "1.94.0",
    });
    // default require = node, lockfile → both ok → no failures, even though
    // protoc/rust are missing (a frontend-only job doesn't need them).
    expect(computeFailures(results, [])).toEqual([]);
  });

  it("computeFailures with --require protoc,rust fails on missing protoc", () => {
    const { results } = checkAll({
      nodeVersion: "22.16.0", nodeRange: ">=22.12.0",
      lockfile: { lockfileVersion: 3 },
      protocOutput: null,
      rustcOutput: "rustc 1.94.0 (x)", rustChannel: "1.94.0",
    });
    const failures = computeFailures(results, ["protoc", "rust"]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/^\[protoc\]/);
  });

  it("computeFailures with --require rust fails on rust drift", () => {
    const { results } = checkAll({
      nodeVersion: "22.16.0", nodeRange: ">=22.12.0",
      lockfile: { lockfileVersion: 3 },
      protocOutput: "libprotoc 29.3",
      rustcOutput: "rustc 1.95.0 (x)", rustChannel: "1.94.0",
    });
    const failures = computeFailures(results, ["protoc", "rust"]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/^\[rust\].*1.95.0/);
  });

  it("computeFailures passes when all required checks are satisfied", () => {
    const { results } = checkAll({
      nodeVersion: "22.16.0", nodeRange: ">=22.12.0",
      lockfile: { lockfileVersion: 3 },
      protocOutput: "libprotoc 29.3",
      rustcOutput: "rustc 1.94.0 (x)", rustChannel: "1.94.0",
      npmVersion: "10.9.0", electronVersion: "^44.4.1", electronBuilderVersion: "^26.15.3",
    });
    expect(computeFailures(results, ["protoc", "rust"])).toEqual([]);
  });
});
