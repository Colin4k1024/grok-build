// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSemver, semverGreater } from "../semver";
import {
  UpdaterMachine,
  readPersistedState,
  stateFilePath,
  type UpdaterAdapter,
  type UpdateManifest,
} from "../updater";

let tmp = "";
const savedGrokHome = process.env.GROK_HOME;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-updater-"));
  process.env.GROK_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
});

/** Scripted fake feed for full control over poll/download outcomes. */
function fakeAdapter(
  overrides: {
    poll?: () => Promise<UpdateManifest | null>;
    fetch?: () => Promise<void>;
  } = {}
): UpdaterAdapter & {
  calls: { polls: number; fetched: number; applied: number };
} {
  const calls = { polls: 0, fetched: 0, applied: 0 };
  return {
    calls,
    pollFeed: async () => {
      calls.polls += 1;
      return overrides.poll?.() ?? manifest("9.9.9");
    },
    fetchPackage: async () => {
      calls.fetched += 1;
      return overrides.fetch?.();
    },
    onProgress: () => {},
    applyAndRestart: (): boolean => {
      calls.applied += 1;
      return true;
    },
  };
}

const manifest = (v: string): UpdateManifest => ({
  version: v,
  releaseNotes: null,
  releaseDate: null,
});

describe("semver", () => {
  it("parses triples and pre-releases", () => {
    expect(parseSemver("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, pre: "" });
    expect(parseSemver("0.10.0-beta.1")).toMatchObject({ minor: 10, patch: 0, pre: "beta.1" });
  });

  it("rejects garbage versions", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("v1.2.3")).toBeNull();
    expect(parseSemver("1.2.x")).toBeNull();
    expect(parseSemver("1.2.3; rm -rf /")).toBeNull();
  });

  it("orders versions correctly, including pre-release rules", () => {
    expect(semverGreater("1.2.3", "1.2.2")).toBe(true);
    expect(semverGreater("1.2.2", "1.2.3")).toBe(false);
    expect(semverGreater("1.10.0", "1.9.9")).toBe(true);
    expect(semverGreater("1.0.0", "1.0.0")).toBe(false);
    // release outranks pre-release at the same triple
    expect(semverGreater("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(semverGreater("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    // unparseable never greater → downgrade protection refuses junk feeds
    expect(semverGreater("garbage", "1.0.0")).toBe(false);
  });
});

describe("UpdaterMachine state machine", () => {
  it("happy path: idle→checking→available→downloading→ready→relaunch", async () => {
    const a = fakeAdapter();
    const m = new UpdaterMachine(a, "1.0.0", stateFilePath());

    expect(m.getStatus().status).toBe("idle");
    const offer = await m.poll();
    expect(offer?.version).toBe("9.9.9");
    expect(m.getStatus()).toMatchObject({ status: "available", version: "9.9.9" });

    await m.fetch();
    expect(m.getStatus().status).toBe("ready");

    m.apply();
    expect(m.getStatus().status).toBe("relaunch");
    expect(a.calls.applied).toBe(1);
  });

  it("no adapter → disabled, poll returns null (rollback surface)", async () => {
    const m = new UpdaterMachine(null, "1.0.0", stateFilePath());
    expect(m.getStatus().status).toBe("disabled");
    expect(await m.poll()).toBeNull();
    await expect(m.fetch()).rejects.toThrow(/available/);
    expect(() => m.apply()).toThrow(/ready/);
  });

  it("downgrade and same-version offers are refused, current version kept", async () => {
    for (const offer of ["0.9.9", "1.0.0", "0.1.0-beta"]) {
      const a = fakeAdapter({ poll: async () => manifest(offer) });
      const m = new UpdaterMachine(a, "1.0.0", stateFilePath());
      expect(await m.poll()).toBeNull();
      expect(m.getStatus()).toMatchObject({ status: "idle", version: null });
    }
  });

  it("garbage feed version strings are refused (never greater)", async () => {
    const a = fakeAdapter({ poll: async () => manifest("latest") });
    const m = new UpdaterMachine(a, "1.0.0", stateFilePath());
    expect(await m.poll()).toBeNull();
  });

  it("network failure → error propagates, machine back to idle, offer lost", async () => {
    const a = fakeAdapter({
      poll: async () => {
        throw new Error("ENETUNREACH");
      },
    });
    const m = new UpdaterMachine(a, "1.0.0", stateFilePath());
    await expect(m.poll()).rejects.toThrow(/ENETUNREACH/);
    expect(m.getStatus()).toMatchObject({ status: "idle", version: null });
  });

  it("bad package during download → back to available, nothing applied", async () => {
    let fail = true;
    const a = fakeAdapter({
      poll: async () => manifest("2.0.0"),
      fetch: async () => {
        if (fail) throw new Error("sha512 mismatch");
      },
    });
    const m = new UpdaterMachine(a, "1.0.0", stateFilePath());
    await m.poll();
    await expect(m.fetch()).rejects.toThrow(/sha512/);
    expect(m.getStatus()).toMatchObject({ status: "available", version: "2.0.0" });

    fail = false; // retry succeeds
    await m.fetch();
    expect(m.getStatus().status).toBe("ready");
  });

  it("apply with no cached installer falls back to available (review r2: quitAndInstall does not throw)", async () => {
    // A persisted ready restored after restart: the adapter reports false
    // (electron-updater has no in-memory installer) instead of throwing.
    const a = fakeAdapter({ poll: async () => manifest("2.0.0") });
    (a as unknown as { applyAndRestart: () => boolean }).applyAndRestart = () => false;
    const m = new UpdaterMachine(a, "1.0.0", stateFilePath());
    await m.poll();
    await m.fetch();
    expect(m.getStatus().status).toBe("ready");

    expect(() => m.apply()).toThrow(/retry the download/);
    expect(m.getStatus()).toMatchObject({ status: "available", version: "2.0.0" });
    expect(a.calls.applied).toBe(0); // nothing was even attempted
  });

  it("apply exception also reverts to available (adapter contract guards both paths)", async () => {
    const a = fakeAdapter({ poll: async () => manifest("2.0.0") });
    (a as unknown as { applyAndRestart: () => boolean }).applyAndRestart = () => {
      throw new Error("spawn quit failed");
    };
    const m = new UpdaterMachine(a, "1.0.0", stateFilePath());
    await m.poll();
    await m.fetch();
    expect(() => m.apply()).toThrow(/apply failed/);
    expect(m.getStatus()).toMatchObject({ status: "available", version: "2.0.0" });
  });

  it("illegal transitions are rejected (no skip-ahead apply)", async () => {
    const a = fakeAdapter();
    const m = new UpdaterMachine(a, "1.0.0", stateFilePath());
    expect(() => m.apply()).toThrow(/ready/);
    await expect(m.fetch()).rejects.toThrow(/available/);
  });
});

describe("power-loss recovery (persisted state)", () => {
  it("a persisted ready state re-arms after restart without re-downloading", async () => {
    const file = stateFilePath();
    const a1 = fakeAdapter();
    const m1 = new UpdaterMachine(a1, "1.0.0", file);
    await m1.poll();
    await m1.fetch();
    expect(readPersistedState(file)).toMatchObject({ status: "ready", version: "9.9.9" });

    // "restart": new machine over the same state file
    const a2 = fakeAdapter();
    const m2 = new UpdaterMachine(a2, "1.0.0", file);
    expect(m2.getStatus()).toMatchObject({ status: "ready", version: "9.9.9" });
    expect(a2.calls.polls).toBe(0); // no re-poll needed

    m2.apply();
    expect(a2.calls.applied).toBe(1);
  });

  it("a persisted downloading state resets to idle — half-downloads never install", async () => {
    const file = stateFilePath();
    fs.writeFileSync(
      file,
      JSON.stringify({ status: "downloading", version: "9.9.9", since: Date.now() })
    );

    const a = fakeAdapter();
    const m = new UpdaterMachine(a, "1.0.0", file);
    expect(m.getStatus().status).toBe("idle");
    // must re-offer + re-download + re-verify before any apply
    expect(() => m.apply()).toThrow(/ready/);
  });

  it("a torn/corrupt state file boots as idle", async () => {
    const file = stateFilePath();
    fs.writeFileSync(file, "{not json");
    const m = new UpdaterMachine(fakeAdapter(), "1.0.0", file);
    expect(m.getStatus().status).toBe("idle");
  });
});
