// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { parseSemver, semverGreater } from "../semver";
import {
  UpdaterMachine,
  readPersistedState,
  stateFilePath,
  verifyPackageIntegrity,
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

// ---- loopback HTTP feed integration (R5-07 / #263) -------------------------
//
// A real HTTP server serves a real electron-builder-style feed (manifest +
// artifact) from a temp dir; a test-local adapter polls and downloads over
// real HTTP and gates the download on the production verifyPackageIntegrity
// helper. This exercises the update DECISION pipeline end-to-end — version
// gating, missing files, corrupt hashes — without standing up Electron.

describe("loopback HTTP feed integration (R5-07 #263)", () => {
  let server: http.Server;
  let feedDir: string;
  let baseUrl: string;

  function sha512Base64(buf: Buffer): string {
    return crypto.createHash("sha512").update(buf).digest("base64");
  }

  function httpGet(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        })
        .on("error", reject);
    });
  }

  /** Write an artifact + latest-mac.yml manifest; overrides can corrupt either. */
  function publishFeed(opts: {
    version: string;
    fileName?: string | null;
    contents?: Buffer;
    sha512?: string;
    size?: number;
  }): void {
    const contents = opts.contents ?? Buffer.from(`package-${opts.version}`);
    const fileName = opts.fileName === undefined ? `Grok-Build-${opts.version}-arm64.zip` : opts.fileName;
    if (fileName !== null) fs.writeFileSync(path.join(feedDir, fileName), contents);
    const refName = fileName ?? `Grok-Build-${opts.version}-arm64.zip`;
    const manifest = {
      version: opts.version,
      files: [
        {
          url: refName,
          sha512: opts.sha512 ?? sha512Base64(contents),
          size: opts.size ?? contents.length,
        },
      ],
      path: refName,
      sha512: opts.sha512 ?? sha512Base64(contents),
      releaseDate: "2026-09-29T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(feedDir, "latest-mac.yml"), yaml.dump(manifest));
  }

  /** Adapter backed by the loopback feed: real HTTP, real YAML, real hashing. */
  class HttpFeedAdapter implements UpdaterAdapter {
    private feed: { files: { url: string; sha512: string; size: number }[] } | null = null;
    async pollFeed(): Promise<UpdateManifest | null> {
      const raw = await httpGet(`${baseUrl}/latest-mac.yml`);
      const parsed = yaml.load(raw.toString("utf-8")) as {
        version: string;
        files: { url: string; sha512: string; size: number }[];
      };
      this.feed = parsed;
      return { version: parsed.version, releaseNotes: null, releaseDate: null };
    }
    async fetchPackage(): Promise<void> {
      if (!this.feed) throw new Error("pollFeed must run before fetchPackage");
      const entry = this.feed.files[0];
      const buf = await httpGet(`${baseUrl}/${entry.url}`);
      const target = path.join(feedDir, "downloaded-package.bin");
      fs.writeFileSync(target, buf);
      await verifyPackageIntegrity(target, { sha512: entry.sha512, size: entry.size });
    }
    onProgress(): void {}
    applyAndRestart(): boolean {
      return true;
    }
  }

  beforeEach(async () => {
    feedDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-feed-http-"));
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
      const file = path.resolve(feedDir, rel || "latest-mac.yml");
      if (file !== feedDir && !file.startsWith(feedDir + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
        } else {
          res.writeHead(200);
          res.end(data);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(feedDir, { recursive: true, force: true });
  });

  it("a same-version offer over real HTTP is refused", async () => {
    publishFeed({ version: "1.0.0" });
    const m = new UpdaterMachine(new HttpFeedAdapter(), "1.0.0", stateFilePath());
    expect(await m.poll()).toBeNull();
    expect(m.getStatus()).toMatchObject({ status: "idle", version: null });
  });

  it("a downgrade offer over real HTTP is refused", async () => {
    publishFeed({ version: "0.9.0" });
    const m = new UpdaterMachine(new HttpFeedAdapter(), "1.0.0", stateFilePath());
    expect(await m.poll()).toBeNull();
    expect(m.getStatus()).toMatchObject({ status: "idle", version: null });
  });

  it("a manifest referencing a missing file fails the fetch and never reaches ready", async () => {
    publishFeed({ version: "2.0.0", fileName: null }); // manifest points at a file we never wrote
    const m = new UpdaterMachine(new HttpFeedAdapter(), "1.0.0", stateFilePath());
    expect((await m.poll())?.version).toBe("2.0.0");
    await expect(m.fetch()).rejects.toThrow(/HTTP 404/);
    expect(m.getStatus()).toMatchObject({ status: "available", version: "2.0.0" });
    expect(() => m.apply()).toThrow(/ready/);
  });

  it("a corrupt sha512 in the downloaded package fails verification and never reaches ready", async () => {
    publishFeed({ version: "2.0.0", sha512: sha512Base64(Buffer.from("different-contents")) });
    const m = new UpdaterMachine(new HttpFeedAdapter(), "1.0.0", stateFilePath());
    expect((await m.poll())?.version).toBe("2.0.0");
    await expect(m.fetch()).rejects.toThrow(/sha512 mismatch/);
    expect(m.getStatus()).toMatchObject({ status: "available", version: "2.0.0" });
    expect(() => m.apply()).toThrow(/ready/);
  });

  it("a size mismatch in the downloaded package fails verification", async () => {
    publishFeed({ version: "2.0.0", size: 999_999 });
    const m = new UpdaterMachine(new HttpFeedAdapter(), "1.0.0", stateFilePath());
    await m.poll();
    await expect(m.fetch()).rejects.toThrow(/size mismatch/);
    expect(m.getStatus().status).toBe("available");
  });

  it("a consistent feed downloads, verifies, reaches ready, and applies", async () => {
    publishFeed({ version: "2.0.0" });
    const m = new UpdaterMachine(new HttpFeedAdapter(), "1.0.0", stateFilePath());
    expect((await m.poll())?.version).toBe("2.0.0");
    await m.fetch();
    expect(m.getStatus()).toMatchObject({ status: "ready", version: "2.0.0" });
    m.apply();
    expect(m.getStatus().status).toBe("relaunch");
  });
});
